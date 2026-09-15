import { invoke } from "@tauri-apps/api/core";
import type { ChunkReader, ChunkWriter, SyncSnapshot } from "./types";
import { snapshotFromEntries } from "./engine";

type LocalSnapshotResult = {
  entries: Array<{ path: string; kind: "file" | "directory"; hash?: string; size?: number; modifiedAt?: number }>;
  skipped: string[];
};

export async function scanLocalWorkspace(root: string) {
  const result = await invoke<LocalSnapshotResult>("scan_workspace_sync", { root });
  return { snapshot: snapshotFromEntries(result.entries), skipped: result.skipped };
}

export function localReader(root: string, path: string, size: number): ChunkReader {
  return {
    size,
    read: (offset, length) => invoke<ArrayBuffer>("read_workspace_sync_chunk", { root, path, offset, length })
      .then((content) => new Uint8Array(content)),
  };
}

export async function localWriter(root: string, path: string): Promise<ChunkWriter> {
  const token = await invoke<string>("begin_workspace_sync_write");
  return {
    write: async (offset, content) => {
      await invoke("write_workspace_sync_chunk", { token, offset, content: Array.from(content) });
    },
    commit: () => invoke("commit_workspace_sync_write", { root, path, token }),
    cancel: () => invoke("cancel_workspace_sync_write", { token }),
  };
}

export async function temporaryHashWriter() {
  const token = await invoke<string>("begin_workspace_sync_write");
  const writer: ChunkWriter = {
    write: async (offset, content) => {
      await invoke("write_workspace_sync_chunk", { token, offset, content: Array.from(content) });
    },
    commit: async () => undefined,
    cancel: () => invoke("cancel_workspace_sync_write", { token }),
  };
  return {
    writer,
    hash: () => invoke<string>("hash_workspace_sync_temp", { token }),
    dispose: () => invoke<void>("cancel_workspace_sync_write", { token }),
  };
}

export function createLocalDirectory(root: string, path: string) {
  return invoke<void>("create_workspace_sync_directory", { root, path });
}

export function deleteLocalEntry(root: string, path: string) {
  return invoke<void>("delete_workspace_sync_entry", { root, path });
}

export function copyLocalEntry(root: string, source: string, destination: string) {
  return invoke<void>("copy_workspace_sync_entry", { root, source, destination });
}

export function loadBaseline(bindingId: string) {
  return invoke<SyncSnapshot | null>("load_sync_baseline", { bindingId });
}

export function saveBaseline(bindingId: string, baseline: SyncSnapshot) {
  return invoke<void>("save_sync_baseline", { bindingId, baseline });
}

export function startWorkspaceWatcher(root: string) {
  return invoke<void>("start_workspace_watcher", { root });
}

export function stopWorkspaceWatcher() {
  return invoke<void>("stop_workspace_watcher");
}
