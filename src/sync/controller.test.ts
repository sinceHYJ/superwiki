import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import type { WorkspaceSyncCredentials, WorkspaceSyncSettings } from "./config";
import { loadWorkspaceSyncCredentials, loadWorkspaceSyncSettings } from "./config";
import {
  deleteLocalEntry,
  loadBaseline,
  localReader,
  localWriter,
  saveBaseline,
  scanLocalWorkspace,
  startWorkspaceWatcher,
  stopWorkspaceWatcher,
  temporaryHashWriter,
} from "./localStore";
import type { ChunkWriter, RemoteEntry, SyncEntry, SyncManifest, SyncSnapshot } from "./types";
import { InitialSyncConflictError, syncController } from "./controller";

const remote = vi.hoisted(() => ({
  acquireLease: vi.fn(),
  renewLease: vi.fn(),
  releaseLease: vi.fn(),
  loadManifest: vi.fn(),
  saveManifest: vi.fn(),
  list: vi.fn(),
  download: vi.fn(),
  upload: vi.fn(),
  createDirectory: vi.fn(),
  remove: vi.fn(),
  testConnection: vi.fn(),
}));

vi.mock("./config", () => ({
  loadWorkspaceSyncSettings: vi.fn(),
  loadWorkspaceSyncCredentials: vi.fn(),
}));
vi.mock("./localStore", () => ({
  copyLocalEntry: vi.fn(),
  createLocalDirectory: vi.fn(),
  deleteLocalEntry: vi.fn(),
  loadBaseline: vi.fn(),
  localReader: vi.fn(),
  localWriter: vi.fn(),
  saveBaseline: vi.fn(),
  scanLocalWorkspace: vi.fn(),
  startWorkspaceWatcher: vi.fn(),
  stopWorkspaceWatcher: vi.fn(),
  temporaryHashWriter: vi.fn(),
}));
vi.mock("./providers/oss", () => ({ OssSyncProvider: vi.fn(function OssSyncProvider() { return remote; }) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const ROOT = "D:\\wiki";
const ID = "0b1a2c3d-1111-2222-3333-444455556666";
const settings: WorkspaceSyncSettings = {
  bindingId: ID,
  bindingRoot: ROOT,
  openedRoot: ROOT,
  relativeScope: "",
  effectiveRemotePath: "",
  inherited: false,
  provider: "oss",
  region: "oss-cn-test",
  endpoint: "https://oss.example.com",
  bucket: "wiki",
  prefix: "",
  accessKeyId: "ak",
  hasAccessKeySecret: true,
  enabled: true,
  deviceId: "device-a",
};
const credentials: WorkspaceSyncCredentials = { ...settings, workspaceId: ID, accessKeySecret: "sk" };

const file = (path: string, hash: string): SyncEntry => ({ path, kind: "file", hash, size: 1 });
const remoteFile = (path: string, etag: string): RemoteEntry => ({ path, kind: "file", size: 1, modifiedAt: 0, revision: etag, hash: `remote:${etag}` });
const snapshot = (...entries: SyncEntry[]): SyncSnapshot => Object.fromEntries(entries.map((entry) => [entry.path, entry]));
const chunkWriter = (): ChunkWriter => ({ write: async () => undefined, commit: async () => undefined, cancel: async () => undefined });

beforeEach(() => {
  vi.stubGlobal("window", { setTimeout: () => 0, clearTimeout: () => {}, addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal("navigator", { onLine: true });
  vi.resetAllMocks();
  vi.mocked(listen).mockResolvedValue(() => undefined);
  vi.mocked(loadWorkspaceSyncSettings).mockResolvedValue(settings);
  vi.mocked(loadWorkspaceSyncCredentials).mockResolvedValue(credentials);
  vi.mocked(scanLocalWorkspace).mockResolvedValue({ snapshot: {}, skipped: [] });
  vi.mocked(loadBaseline).mockResolvedValue(null);
  vi.mocked(saveBaseline).mockResolvedValue(undefined);
  vi.mocked(temporaryHashWriter).mockResolvedValue({ writer: chunkWriter(), hash: async () => "cloud-hash", dispose: async () => undefined });
  vi.mocked(localReader).mockReturnValue({ size: 1, read: async () => new Uint8Array() });
  vi.mocked(localWriter).mockResolvedValue(chunkWriter());
  vi.mocked(deleteLocalEntry).mockResolvedValue(undefined);
  vi.mocked(startWorkspaceWatcher).mockResolvedValue(undefined);
  vi.mocked(stopWorkspaceWatcher).mockResolvedValue(undefined);
  remote.acquireLease.mockResolvedValue({ id: "lease", expiresAt: Date.now() + 600_000 });
  remote.renewLease.mockResolvedValue({ id: "lease", expiresAt: Date.now() + 600_000 });
  remote.releaseLease.mockResolvedValue(undefined);
  remote.loadManifest.mockResolvedValue(null);
  remote.list.mockResolvedValue([]);
  remote.download.mockImplementation(async (_path: string, target: ChunkWriter) => {
    await target.commit();
  });
  remote.upload.mockResolvedValue({ value: "etag-new" });
  remote.createDirectory.mockResolvedValue(undefined);
  remote.remove.mockResolvedValue(undefined);
  remote.saveManifest.mockResolvedValue(undefined);
});

afterEach(async () => {
  await syncController.close();
  vi.unstubAllGlobals();
});

describe("SyncController 远端删除推断", () => {
  it("manifest 缺失时本地多出的文件上传而不是删除", async () => {
    vi.mocked(scanLocalWorkspace).mockResolvedValue({ snapshot: snapshot(file("extra.md", "local-hash")), skipped: [] });
    vi.mocked(loadBaseline).mockResolvedValue(snapshot(file("extra.md", "local-hash"), file("cloud.md", "cloud-hash")));
    remote.loadManifest.mockResolvedValue(null);
    remote.list.mockResolvedValue([remoteFile("cloud.md", "etag-c")]);

    await syncController.open(ROOT);

    expect(deleteLocalEntry).not.toHaveBeenCalled();
    expect(remote.upload).toHaveBeenCalledWith("extra.md", expect.anything(), expect.anything(), expect.anything());
    expect(localWriter).toHaveBeenCalledWith(ROOT, "cloud.md");
    expect(saveBaseline).toHaveBeenCalledTimes(1);
  });

  it("manifest 记录在案的远端删除仍会传播到本地", async () => {
    const gone = file("gone.md", "same-hash");
    vi.mocked(scanLocalWorkspace).mockResolvedValue({ snapshot: snapshot(gone), skipped: [] });
    vi.mocked(loadBaseline).mockResolvedValue(snapshot(gone));
    const manifest: SyncManifest = { schemaVersion: 1, workspaceId: ID, revision: 3, entries: snapshot(gone) };
    remote.loadManifest.mockResolvedValue(manifest);
    remote.list.mockResolvedValue([]);

    await syncController.open(ROOT);

    expect(deleteLocalEntry).toHaveBeenCalledWith(ROOT, "gone.md");
  });

  it("manifest 缺失且内容冲突时要求用户选择而不是静默覆盖", async () => {
    vi.mocked(scanLocalWorkspace).mockResolvedValue({ snapshot: snapshot(file("note.md", "local-hash")), skipped: [] });
    vi.mocked(loadBaseline).mockResolvedValue(snapshot(file("note.md", "old-hash")));
    remote.loadManifest.mockResolvedValue(null);
    remote.list.mockResolvedValue([remoteFile("note.md", "etag-r")]);

    await expect(syncController.open(ROOT)).rejects.toBeInstanceOf(InitialSyncConflictError);
    expect(syncController.getSnapshot().phase).toBe("conflicts");
    expect(syncController.getSnapshot().conflicts[0]?.initial).toBe(true);
    expect(deleteLocalEntry).not.toHaveBeenCalled();
    expect(remote.upload).not.toHaveBeenCalled();
  });
});
