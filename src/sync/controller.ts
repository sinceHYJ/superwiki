import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { filterSnapshot, planSync, snapshotFromEntries } from "./engine";
import { loadWorkspaceSyncCredentials, loadWorkspaceSyncSettings, type WorkspaceSyncSettings } from "./config";
import {
  copyLocalEntry,
  createLocalDirectory,
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
import { OssSyncProvider } from "./providers/oss";
import type { ConflictChoice, SyncActivity, SyncConflict, SyncEntry, SyncManifest, SyncOperation, SyncProvider, SyncSnapshot, SyncStatus } from "./types";

const RETRY_DELAYS = [5_000, 15_000, 30_000, 60_000, 300_000];
const INITIAL_STATUS: SyncStatus = { phase: "disabled", message: "未启用同步", activities: [], conflicts: [] };
const STATUS_NOTIFY_INTERVAL = 200;
const MAX_ACTIVITIES = 100;
const MANIFEST_CHECKPOINT_INTERVAL = 100;

export class InitialSyncConflictError extends Error {
  constructor(readonly conflicts: SyncConflict[]) {
    super("首次同步需要处理冲突");
  }
}

function joinPath(...parts: string[]) {
  return parts.map((part) => part.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
}

function localPath(scope: string, path: string) {
  const prefix = scope.replace(/^\/+|\/+$/g, "");
  if (!prefix) return path;
  return path === prefix ? "" : path.slice(prefix.length).replace(/^\//, "");
}

function globalSnapshot(snapshot: SyncSnapshot, scope: string) {
  return Object.fromEntries(Object.values(snapshot).map((entry) => {
    const path = joinPath(scope, entry.path);
    return [path, { ...entry, path }];
  }));
}

function conflictPath(path: string, deviceId: string) {
  const slash = path.lastIndexOf("/");
  const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  const time = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${directory}${stem}（本地冲突-${deviceId.slice(0, 8)}-${time}）${extension}`;
}

function remoteOperation(path: string, entry?: SyncEntry): SyncOperation {
  if (!entry || entry.kind === "deleted") return { kind: "deleteRemote", path, entry: entry ?? { path, kind: "deleted" } };
  return entry.kind === "directory"
    ? { kind: "createRemoteDirectory", path, entry }
    : { kind: "upload", path, entry };
}

function localOperation(path: string, entry?: SyncEntry): SyncOperation {
  if (!entry || entry.kind === "deleted") return { kind: "deleteLocal", path, entry: entry ?? { path, kind: "deleted" } };
  return entry.kind === "directory"
    ? { kind: "createLocalDirectory", path, entry }
    : { kind: "download", path, entry };
}

function mergeRemoteState(manifest: SyncManifest, listed: SyncEntry[], scope: string) {
  const current = snapshotFromEntries(listed);
  const scopedManifest = filterSnapshot(manifest.entries, scope);
  const merged: SyncSnapshot = {};
  const paths = new Set([...Object.keys(scopedManifest), ...Object.keys(current)]);
  for (const path of paths) {
    const recorded = scopedManifest[path];
    const actual = current[path];
    if (recorded?.kind === "deleted" && !actual) merged[path] = recorded;
    else if (!actual && recorded) merged[path] = { path, kind: "deleted" };
    else if (actual && recorded?.revision === actual.revision) merged[path] = recorded;
    else if (actual) merged[path] = actual;
  }
  return merged;
}

export class SyncController {
  private status: SyncStatus = INITIAL_STATUS;
  private listeners = new Set<() => void>();
  private abortController?: AbortController;
  private retryIndex = 0;
  private retryTimer?: number;
  private watchTimer?: number;
  private unlisten?: UnlistenFn;
  private activeRoot?: string;
  private paused = false;
  private running?: Promise<void>;
  private handleOnline = () => {
    if (!this.paused) void this.syncNow().catch(() => undefined);
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.status;

  private notifyTimer?: number;

  private update(next: Partial<SyncStatus>) {
    this.status = { ...this.status, ...next };
    if (this.notifyTimer !== undefined) return;
    this.notifyTimer = window.setTimeout(() => {
      this.notifyTimer = undefined;
      this.listeners.forEach((listener) => listener());
    }, STATUS_NOTIFY_INTERVAL);
  }

  private pushActivity(activity: SyncActivity) {
    this.status.activities.push(activity);
    if (this.status.activities.length > MAX_ACTIVITIES) this.status.activities.splice(0, this.status.activities.length - MAX_ACTIVITIES);
    this.update({ activities: [...this.status.activities] });
  }

  async settings(root: string) {
    return loadWorkspaceSyncSettings(root);
  }

  async testConnection(root: string) {
    const credentials = await loadWorkspaceSyncCredentials(root);
    await new OssSyncProvider(credentials).testConnection();
  }

  async open(root: string, choices?: Record<string, ConflictChoice>) {
    if (this.activeRoot && this.activeRoot !== root) {
      await stopWorkspaceWatcher().catch(() => undefined);
      this.unlisten?.();
      this.unlisten = undefined;
    }
    this.activeRoot = root;
    const settings = await loadWorkspaceSyncSettings(root);
    if (!settings?.enabled) {
      this.update({ phase: "disabled", message: settings ? "同步已关闭" : "未配置同步", inheritedFrom: settings?.inherited ? settings.bindingRoot : undefined, remotePath: settings?.effectiveRemotePath });
      await this.watch(root);
      return;
    }
    await this.run(root, settings, choices);
    await this.watch(root);
  }

  async openOffline(root: string) {
    this.activeRoot = root;
    this.update({ phase: "offline", message: "当前离线，恢复连接后将自动重试" });
    await this.watch(root);
    this.scheduleRetry();
  }

  async syncNow(choices?: Record<string, ConflictChoice>) {
    if (!this.activeRoot) return;
    const settings = await loadWorkspaceSyncSettings(this.activeRoot);
    if (!settings?.enabled) return;
    await this.run(this.activeRoot, settings, choices);
  }

  private async run(root: string, settings: WorkspaceSyncSettings, choices: Record<string, ConflictChoice> | undefined) {
    if (this.running) return this.running;
    this.paused = false;
    this.running = this.perform(root, settings, choices)
      .finally(() => { this.running = undefined; });
    return this.running;
  }

  private async perform(root: string, settings: WorkspaceSyncSettings, choices: Record<string, ConflictChoice> | undefined) {
    this.abortController = new AbortController();
    this.update({ phase: "checking", message: "正在比较本地与云端…", progress: undefined, conflicts: [], inheritedFrom: settings.inherited ? settings.bindingRoot : undefined, remotePath: settings.effectiveRemotePath });
    let provider: SyncProvider | undefined;
    let lease;
    try {
      const credentials = await loadWorkspaceSyncCredentials(root);
      provider = new OssSyncProvider(credentials);
      lease = await provider.acquireLease(credentials.workspaceId);
      const localResult = await scanLocalWorkspace(root);
      this.update({ activities: localResult.skipped.slice(-MAX_ACTIVITIES).map((path) => ({ action: "skip", path, message: "已跳过符号链接或特殊文件" })) });
      const local = globalSnapshot(localResult.snapshot, settings.relativeScope);
      let manifest = await provider.loadManifest();
      const listed = await provider.list(settings.relativeScope);
      for (const entry of listed) {
        if (entry.kind !== "file" || manifest?.entries[entry.path]?.revision === entry.revision) continue;
        const temporary = await temporaryHashWriter();
        try {
          await provider.download(entry.path, temporary.writer, this.abortController.signal);
          entry.hash = await temporary.hash();
        } finally {
          await temporary.dispose().catch(() => undefined);
        }
      }
      const remote = manifest
        ? mergeRemoteState(manifest, listed, settings.relativeScope)
        : snapshotFromEntries(listed);
      const baseline = await loadBaseline(settings.bindingId);
      const scopedBaseline = baseline ? filterSnapshot(baseline, settings.relativeScope) : null;
      const plan = planSync(scopedBaseline, local, remote);

      if (!baseline && plan.conflicts.length && !choices) {
        this.update({ phase: "conflicts", message: `需要处理 ${plan.conflicts.length} 个首次同步冲突`, conflicts: plan.conflicts });
        throw new InitialSyncConflictError(plan.conflicts);
      }

      if (!manifest) {
        manifest = { schemaVersion: 1, workspaceId: credentials.workspaceId, revision: 0, entries: { ...remote } };
      }
      let operations = [...plan.operations];
      const coveredConflictPaths: string[] = [];
      for (const conflict of [...plan.conflicts].sort((left, right) => left.path.length - right.path.length)) {
        if (coveredConflictPaths.some((path) => conflict.path.startsWith(`${path}/`))) continue;
        const choice = choices?.[conflict.path] ?? (conflict.initial ? undefined : "both");
        if (!choice) continue;
        const typeConflict = conflict.local && conflict.remote
          && conflict.local.kind !== "deleted" && conflict.remote.kind !== "deleted"
          && conflict.local.kind !== conflict.remote.kind;
        if (typeConflict) {
          coveredConflictPaths.push(conflict.path);
          operations = operations.filter((operation) => !operation.path.startsWith(`${conflict.path}/`));
          const localSubtree = Object.values(local).filter((entry) => entry.path.startsWith(`${conflict.path}/`));
          const remoteSubtree = Object.values(remote).filter((entry) => entry.path.startsWith(`${conflict.path}/`));
          if (choice === "local") {
            operations.push(...remoteSubtree.map((entry) => remoteOperation(entry.path, undefined)));
            operations.push(remoteOperation(conflict.path, conflict.local), ...localSubtree.map((entry) => remoteOperation(entry.path, entry)));
          } else if (choice === "remote") {
            operations.push(...localSubtree.map((entry) => localOperation(entry.path, undefined)));
            operations.push(localOperation(conflict.path, conflict.remote), ...remoteSubtree.map((entry) => localOperation(entry.path, entry)));
          } else {
            await this.preserveBoth(root, settings, provider, manifest, lease, conflict, credentials.deviceId);
            operations.push(...remoteSubtree.map((entry) => localOperation(entry.path, entry)));
          }
        } else if (choice === "local") operations.push(remoteOperation(conflict.path, conflict.local));
        else if (choice === "remote") operations.push(localOperation(conflict.path, conflict.remote));
        else await this.preserveBoth(root, settings, provider, manifest, lease, conflict, credentials.deviceId);
      }
      operations.sort((left, right) => {
        const leftDelete = left.kind === "deleteLocal" || left.kind === "deleteRemote";
        const rightDelete = right.kind === "deleteLocal" || right.kind === "deleteRemote";
        if (leftDelete !== rightDelete) return leftDelete ? 1 : -1;
        if (leftDelete) return right.path.split("/").length - left.path.split("/").length;
        const leftDirectory = left.kind === "createLocalDirectory" || left.kind === "createRemoteDirectory";
        const rightDirectory = right.kind === "createLocalDirectory" || right.kind === "createRemoteDirectory";
        if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
        return left.path.localeCompare(right.path);
      });

      const total = operations.length;
      this.update({ phase: "syncing", message: total ? `正在同步 0/${total}` : "正在确认同步状态…", progress: { completed: 0, total } });
      let completed = 0;
      for (const operation of operations) {
        if (this.abortController.signal.aborted) throw new DOMException("同步已取消", "AbortError");
        if (lease.expiresAt - Date.now() < 30_000) lease = await provider.renewLease(lease);
        await this.executeOperation(root, settings, provider, operation, (done, size) => {
          this.update({ progress: { completed, total, currentPath: operation.path, transferredBytes: done, totalBytes: size } });
        });
        const affectsRemote = operation.kind === "upload" || operation.kind === "createRemoteDirectory" || operation.kind === "deleteRemote";
        if (affectsRemote) {
          const manifestEntry = operation.kind === "deleteRemote"
            ? { path: operation.path, kind: "deleted" as const, modifiedAt: Date.now() }
            : operation.entry;
          manifest.entries[operation.path] = manifestEntry;
          manifest.revision += 1;
        }
        completed += 1;
        if (completed % MANIFEST_CHECKPOINT_INTERVAL === 0) await provider.saveManifest(manifest, lease);
        this.update({ message: `正在同步 ${completed}/${total}`, progress: { completed, total, currentPath: operation.path } });
      }

      const finalLocal = globalSnapshot((await scanLocalWorkspace(root)).snapshot, settings.relativeScope);
      for (const [path, entry] of Object.entries(finalLocal)) {
        if (manifest.entries[path]?.kind !== "deleted") manifest.entries[path] = { ...manifest.entries[path], ...entry };
      }
      manifest.revision += 1;
      await provider.saveManifest(manifest, lease);
      await saveBaseline(settings.bindingId, { ...filterSnapshot(manifest.entries, settings.relativeScope), ...finalLocal });
      this.retryIndex = 0;
      const preservedConflicts = plan.conflicts.filter((item) => !item.initial);
      this.update({
        phase: preservedConflicts.length ? "conflicts" : "synced",
        message: preservedConflicts.length ? `已同步，保留 ${preservedConflicts.length} 个冲突副本` : total ? `已同步 ${total} 项` : "已同步",
        progress: total ? { completed: total, total } : undefined,
        conflicts: preservedConflicts,
      });
    } catch (error) {
      if (error instanceof InitialSyncConflictError) throw error;
      if ((error as { name?: string }).name === "AbortError") {
        this.paused = true;
        this.update({ phase: "paused", message: "同步已暂停" });
      } else {
        const offline = !navigator.onLine || /network|timeout|connect|socket/i.test(String(error));
        this.update({ phase: offline ? "offline" : "error", message: offline ? "当前离线，恢复连接后将自动重试" : `同步失败：${String(error)}` });
        this.scheduleRetry();
        throw error;
      }
    } finally {
      if (provider && lease) await provider.releaseLease(lease).catch(() => undefined);
      this.abortController = undefined;
    }
  }

  private async preserveBoth(root: string, settings: WorkspaceSyncSettings, provider: SyncProvider, manifest: SyncManifest, lease: NonNullable<Awaited<ReturnType<SyncProvider["acquireLease"]>>>, conflict: SyncConflict, deviceId: string) {
    if (conflict.local && conflict.local.kind !== "deleted") {
      const copyPath = conflictPath(conflict.path, deviceId);
      await copyLocalEntry(root, localPath(settings.relativeScope, conflict.path), localPath(settings.relativeScope, copyPath));
      const local = globalSnapshot((await scanLocalWorkspace(root)).snapshot, settings.relativeScope);
      const copiedEntries = Object.values(local).filter((entry) => entry.path === copyPath || entry.path.startsWith(`${copyPath}/`));
      for (const copiedEntry of copiedEntries) {
        if (copiedEntry.kind === "directory") await provider.createDirectory(copiedEntry.path);
        else await provider.upload(copiedEntry.path, localReader(root, localPath(settings.relativeScope, copiedEntry.path), copiedEntry.size ?? 0), this.abortController!.signal);
        manifest.entries[copiedEntry.path] = copiedEntry;
      }
      manifest.revision += 1;
      await provider.saveManifest(manifest, lease);
      this.pushActivity({ action: "conflict", path: copyPath, message: "已保留本地冲突副本" });
    }
    if (conflict.local && conflict.remote && conflict.local.kind !== conflict.remote.kind) {
      await deleteLocalEntry(root, localPath(settings.relativeScope, conflict.path));
    }
    await this.executeOperation(root, settings, provider, localOperation(conflict.path, conflict.remote));
  }

  private async executeOperation(root: string, settings: WorkspaceSyncSettings, provider: SyncProvider, operation: SyncOperation, progress?: (completed: number, total: number) => void) {
    const path = localPath(settings.relativeScope, operation.path);
    if (!path && operation.kind !== "confirm") throw new Error("不能同步覆盖工作区根目录");
    switch (operation.kind) {
      case "upload": {
        const revision = await provider.upload(operation.path, localReader(root, path, operation.entry.size ?? 0), this.abortController!.signal, progress);
        operation.entry.revision = revision.value;
        this.pushActivity({ action: "upload", path: operation.path, message: "已上传" });
        break;
      }
      case "download":
        await provider.download(operation.path, await localWriter(root, path), this.abortController!.signal, progress);
        this.pushActivity({ action: "download", path: operation.path, message: "已下载" });
        break;
      case "createLocalDirectory":
        await createLocalDirectory(root, path);
        this.pushActivity({ action: "directory", path: operation.path, message: "已创建本地文件夹" });
        break;
      case "createRemoteDirectory":
        await provider.createDirectory(operation.path);
        this.pushActivity({ action: "directory", path: operation.path, message: "已创建云端文件夹" });
        break;
      case "deleteLocal":
        await deleteLocalEntry(root, path);
        this.pushActivity({ action: "delete", path: operation.path, message: "已删除本地内容" });
        break;
      case "deleteRemote":
        await provider.remove(operation.path, operation.entry.revision);
        this.pushActivity({ action: "delete", path: operation.path, message: "已删除云端内容" });
        break;
      case "confirm":
        break;
    }
  }

  cancel() {
    this.paused = true;
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    this.abortController?.abort();
    this.update({ phase: "paused", message: "同步已暂停" });
  }

  async resume() {
    this.paused = false;
    await this.syncNow().catch(() => undefined);
  }

  private scheduleRetry() {
    if (this.paused || !this.activeRoot || this.retryTimer) return;
    const delay = RETRY_DELAYS[Math.min(this.retryIndex, RETRY_DELAYS.length - 1)];
    this.retryIndex += 1;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined;
      void this.syncNow().catch(() => undefined);
    }, delay);
  }

  private async watch(root: string) {
    window.addEventListener("online", this.handleOnline);
    await stopWorkspaceWatcher().catch(() => undefined);
    this.unlisten?.();
    this.unlisten = await listen<string[]>("workspace-sync-changed", () => {
      if (this.paused) return;
      if (this.watchTimer) window.clearTimeout(this.watchTimer);
      this.watchTimer = window.setTimeout(() => void this.syncNow().catch(() => undefined), 1_000);
    });
    await startWorkspaceWatcher(root);
  }

  async close() {
    this.cancel();
    this.activeRoot = undefined;
    this.unlisten?.();
    this.unlisten = undefined;
    window.removeEventListener("online", this.handleOnline);
    if (this.notifyTimer !== undefined) {
      window.clearTimeout(this.notifyTimer);
      this.notifyTimer = undefined;
    }
    await stopWorkspaceWatcher().catch(() => undefined);
    this.status = INITIAL_STATUS;
    this.listeners.forEach((listener) => listener());
  }
}

export const syncController = new SyncController();
