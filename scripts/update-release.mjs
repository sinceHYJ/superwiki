import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const repository = "sinceHYJ/superwiki";
const placeholder = "请填写本版本更新日志，然后运行 Publish update 工作流。";
const platforms = ["windows-x86_64", "darwin-x86_64", "darwin-aarch64"];

export function stableVersion(tag) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? "")) throw new Error("必须使用稳定版标签 vX.Y.Z");
  return tag.slice(1);
}

export function validateManifest(manifest, tag, assetNames) {
  if (manifest.version !== stableVersion(tag)) throw new Error("更新清单版本与标签不一致");
  for (const platform of platforms) {
    const entry = manifest.platforms?.[platform];
    if (!entry?.signature?.trim()) throw new Error(`缺少 ${platform} 签名`);
    const prefix = `https://github.com/${repository}/releases/download/${tag}/`;
    if (!entry.url?.startsWith(prefix)) throw new Error(`更新包地址不属于当前版本：${platform}`);
    const name = decodeURIComponent(entry.url.slice(prefix.length));
    if (!assetNames.includes(name) || !assetNames.includes(`${name}.sig`)) throw new Error(`缺少更新包或签名附件：${name}`);
  }
}

function gh(...args) {
  const result = spawnSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
  return result.stdout;
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

function draft(tag) {
  const version = stableVersion(tag);
  const files = walk("update-artifacts");
  const select = (suffix) => {
    const matches = files.filter((file) => file.endsWith(suffix));
    if (matches.length !== 1) throw new Error(`预期一个 ${suffix}，实际 ${matches.length}`);
    return matches[0];
  };
  const windows = select("-setup.exe");
  const mac = select(".app.tar.gz");
  select(".dmg");
  select(".msi");
  const entry = (file) => ({
    url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(path.basename(file))}`,
    signature: fs.readFileSync(`${file}.sig`, "utf8").trim(),
  });
  const manifest = { version, notes: placeholder, platforms: {
    "windows-x86_64": entry(windows), "darwin-x86_64": entry(mac), "darwin-aarch64": entry(mac),
  } };
  const names = files.map((file) => path.basename(file));
  if (new Set(names).size !== names.length) throw new Error("产物存在重名文件");
  validateManifest(manifest, tag, names);
  fs.writeFileSync("update-artifacts/latest.json", JSON.stringify(manifest, null, 2) + "\n");
  // Do not overwrite an existing release on reruns; its notes/assets may have been reviewed.
  gh("release", "create", tag, "--repo", repository, "--verify-tag", "--draft", "--title", `SuperWiki ${tag}`, "--notes", placeholder);
  gh("release", "upload", tag, "--repo", repository, ...files, "update-artifacts/latest.json");
}

function publish(tag) {
  stableVersion(tag);
  const release = JSON.parse(gh("release", "view", tag, "--repo", repository, "--json", "isDraft,isPrerelease,body,assets"));
  if (!release.isDraft || release.isPrerelease) throw new Error("只能发布稳定版草稿");
  if (!release.body?.trim() || release.body.includes(placeholder)) throw new Error("请先填写草稿更新日志");
  fs.mkdirSync("update-artifacts", { recursive: true });
  gh("release", "download", tag, "--repo", repository, "--pattern", "latest.json", "--pattern", "*.sig", "--dir", "update-artifacts");
  const manifestPath = "update-artifacts/latest.json";
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  validateManifest(manifest, tag, release.assets.map((asset) => asset.name));
  for (const platform of platforms) {
    const entry = manifest.platforms[platform];
    const name = decodeURIComponent(new URL(entry.url).pathname.split("/").at(-1));
    if (fs.readFileSync(path.join("update-artifacts", `${name}.sig`), "utf8").trim() !== entry.signature) {
      throw new Error(`签名附件与清单不一致：${platform}`);
    }
  }
  manifest.notes = release.body;
  manifest.pub_date = new Date().toISOString();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  gh("release", "upload", tag, "--repo", repository, manifestPath, "--clobber");
  gh("release", "edit", tag, "--repo", repository, "--draft=false", "--latest");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const tag = process.env.UPDATE_TAG || process.env.GITHUB_REF_NAME;
  const command = process.argv[2];
  if (command === "check-tag") {
    const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
    if (stableVersion(tag) !== version) throw new Error("标签与 package.json 版本不一致");
  } else if (command === "draft") draft(tag);
  else if (command === "publish") publish(tag);
  else throw new Error("用法：update-release.mjs check-tag|draft|publish");
}
