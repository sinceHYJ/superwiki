import test from "node:test";
import assert from "node:assert/strict";
import { createUpdateController } from "../src/updateController.ts";
import { collectUpdateDocuments, createSaveQueue } from "../src/updateSave.ts";
import { stableVersion, validateManifest } from "../scripts/update-release.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
function pending(overrides = {}) {
  return { version: "0.8.0", body: "## 新功能\n- 更新", download: async () => {}, install: async () => {}, close: async () => {}, ...overrides };
}

test("startup checks once across remounts and supports manual checks", async () => {
  let checks = 0;
  const response = deferred();
  const controller = createUpdateController(async () => { checks++; await response.promise; return null; });
  controller.start();
  controller.start();
  await controller.check();
  assert.equal(checks, 1);
  response.resolve();
  await tick();
  const unsubscribe = controller.subscribe(() => {});
  unsubscribe();
  controller.start();
  assert.equal(controller.getSnapshot().phase, "latest");
  assert.equal(checks, 1);
  await controller.check();
  assert.equal(checks, 2);
});

test("check errors are retryable and prereleases are rejected", async () => {
  let checks = 0;
  const controller = createUpdateController(async () => {
    checks++;
    if (checks === 1) throw new Error("offline");
    return pending({ version: checks === 2 ? "0.8.0-beta.1" : "0.8.0" });
  });
  await controller.check();
  assert.match(controller.getSnapshot().error, /offline/);
  await controller.check();
  assert.equal(controller.getSnapshot().version, undefined);
  await controller.check();
  assert.equal(controller.getSnapshot().version, "0.8.0");
});

test("download survives no subscribers; duplicate actions are ignored and progress may omit total", async () => {
  const response = deferred();
  let downloads = 0;
  const controller = createUpdateController(async () => pending({ download: async (event) => {
    downloads++;
    event({ event: "Started", data: {} });
    event({ event: "Progress", data: { chunkLength: 123 } });
    await response.promise;
  } }));
  await controller.check();
  const download = controller.download();
  await controller.download();
  await controller.check();
  assert.equal(downloads, 1);
  assert.equal(controller.getSnapshot().downloaded, 123);
  assert.equal(controller.getSnapshot().total, undefined);
  response.resolve();
  await download;
  assert.equal(controller.getSnapshot().phase, "ready");
});

test("failed signature/download cannot be installed and can be retried", async () => {
  let downloads = 0;
  let installs = 0;
  const controller = createUpdateController(async () => pending({
    download: async () => { if (++downloads === 1) throw new Error("signature verification failed"); },
    install: async () => { installs++; },
  }));
  await controller.check();
  await controller.download();
  await controller.install(async () => {}, async () => {});
  assert.equal(installs, 0);
  assert.equal(controller.getSnapshot().phase, "available");
  await controller.download();
  assert.equal(controller.getSnapshot().phase, "ready");
});

test("all saves must succeed before installation and restart; failed save keeps ready state", async () => {
  const calls = [];
  const controller = createUpdateController(async () => pending({ install: async () => { calls.push("install"); } }));
  await controller.check();
  await controller.download();
  await controller.install(async () => { throw new Error("disk full"); }, async () => { calls.push("restart"); });
  assert.deepEqual(calls, []);
  assert.equal(controller.getSnapshot().phase, "ready");
  const gate = deferred();
  const install = controller.install(async () => { await gate.promise; calls.push("save"); }, async () => { calls.push("restart"); });
  await controller.install(async () => { calls.push("duplicate"); }, async () => {});
  assert.deepEqual(calls, []);
  gate.resolve();
  await install;
  assert.deepEqual(calls, ["save", "install", "restart"]);
});

test("installation snapshot includes inactive drafts and immediate editor input on Windows paths", () => {
  const a = { root: "D:/notes", path: "D:/notes/a.md", kind: "markdown" };
  const b = { ...a, path: "D:/notes/b.md" };
  const drafts = { "D:/notes:D:/notes/a.md": "stale listener", "D:/notes:D:/notes/b.md": "unsaved tab" };
  const documents = collectUpdateDocuments([a, b], drafts, a, "last keystroke");
  assert.deepEqual(documents.map((file) => file.content), ["unsaved tab", "last keystroke"]);
  assert.equal(drafts["D:/notes:D:/notes/a.md"], "stale listener");
  assert.deepEqual(collectUpdateDocuments([], {}, { ...a, kind: "image" }, ""), []);
  assert.throws(() => collectUpdateDocuments([], drafts, null, ""), /无法定位/);
});

test("older in-flight save finishes before update snapshots; failure aborts remaining writes", async () => {
  const response = deferred();
  const writes = [];
  const queue = createSaveQueue(async (document) => {
    if (document.content === "old") await response.promise;
    if (document.content === "failure") throw new Error("disk full");
    writes.push(document.content);
  });
  const document = { root: "/notes", path: "/notes/a.md", content: "old" };
  const old = queue.write(document);
  const save = queue.saveBeforeUpdate([{ ...document, content: "latest" }]);
  await tick();
  assert.deepEqual(writes, []);
  response.resolve();
  await Promise.all([old, save]);
  assert.deepEqual(writes, ["old", "latest"]);
  await assert.rejects(queue.saveBeforeUpdate([{ ...document, content: "failure" }, { ...document, content: "never" }]), /disk full/);
  await queue.saveBeforeUpdate([{ ...document, content: "retry" }]);
  assert.deepEqual(writes, ["old", "latest", "retry"]);
});

test("release validation rejects missing platforms, wrong versions and foreign asset URLs", () => {
  assert.equal(stableVersion("v1.2.3"), "1.2.3");
  assert.throws(() => stableVersion("v1.2.3-beta.1"));
  const entry = { signature: "signed", url: "https://github.com/sinceHYJ/superwiki/releases/download/v1.2.3/app.exe" };
  const manifest = { version: "1.2.3", platforms: Object.fromEntries(["windows-x86_64", "darwin-x86_64", "darwin-aarch64"].map((key) => [key, { ...entry }])) };
  const names = ["app.exe", "app.exe.sig"];
  validateManifest(manifest, "v1.2.3", names);
  assert.throws(() => validateManifest(manifest, "v1.2.4", names), /版本/);
  assert.throws(() => validateManifest(manifest, "v1.2.3", []), /缺少/);
  manifest.platforms["windows-x86_64"].url = "https://example.com/app.exe";
  assert.throws(() => validateManifest(manifest, "v1.2.3", names), /地址/);
  delete manifest.platforms["windows-x86_64"];
  assert.throws(() => validateManifest(manifest, "v1.2.3", names), /签名/);
});
