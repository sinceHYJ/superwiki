import type { SyncEntry, SyncOperation, SyncPlan, SyncSnapshot } from "./types";

function content(entry?: SyncEntry) {
  return entry?.kind === "deleted" ? undefined : entry;
}

function equal(left?: SyncEntry, right?: SyncEntry) {
  const a = content(left);
  const b = content(right);
  if (!a || !b) return !a && !b;
  if (a.kind !== b.kind) return false;
  return a.kind === "directory" || (a.hash === b.hash && a.size === b.size);
}

function operationForLocal(path: string, entry?: SyncEntry): SyncOperation {
  const value = content(entry);
  if (!value) return { kind: "deleteLocal", path, entry: entry ?? { path, kind: "deleted" } };
  return value.kind === "directory"
    ? { kind: "createLocalDirectory", path, entry: value }
    : { kind: "download", path, entry: value };
}

function operationForRemote(path: string, entry?: SyncEntry): SyncOperation {
  const value = content(entry);
  if (!value) return { kind: "deleteRemote", path, entry: entry ?? { path, kind: "deleted" } };
  return value.kind === "directory"
    ? { kind: "createRemoteDirectory", path, entry: value }
    : { kind: "upload", path, entry: value };
}

export function filterSnapshot(snapshot: SyncSnapshot, scope: string) {
  const prefix = scope.replace(/^\/+|\/+$/g, "");
  if (!prefix) return { ...snapshot };
  const scoped: SyncSnapshot = {};
  for (const [path, entry] of Object.entries(snapshot)) {
    if (path === prefix || path.startsWith(`${prefix}/`)) scoped[path] = entry;
  }
  return scoped;
}

export function planSync(base: SyncSnapshot | null, local: SyncSnapshot, remote: SyncSnapshot): SyncPlan {
  const operations: SyncOperation[] = [];
  const conflicts: SyncPlan["conflicts"] = [];
  const paths = new Set([...Object.keys(base ?? {}), ...Object.keys(local), ...Object.keys(remote)]);

  for (const path of [...paths].sort()) {
    const baseEntry = base?.[path];
    const localEntry = local[path];
    const remoteEntry = remote[path];

    if (!base) {
      if (remoteEntry?.kind === "deleted") {
        if (localEntry) operations.push(operationForLocal(path, remoteEntry));
      } else if (!localEntry && remoteEntry) {
        operations.push(operationForLocal(path, remoteEntry));
      } else if (localEntry && !remoteEntry) {
        operations.push(operationForRemote(path, localEntry));
      } else if (equal(localEntry, remoteEntry)) {
        operations.push({ kind: "confirm", path, entry: remoteEntry ?? localEntry });
      } else {
        conflicts.push({ path, local: localEntry, remote: remoteEntry, initial: true });
      }
      continue;
    }

    const localChanged = !equal(baseEntry, localEntry);
    const remoteChanged = !equal(baseEntry, remoteEntry);
    if (!localChanged && !remoteChanged) continue;
    if (equal(localEntry, remoteEntry)) {
      operations.push({ kind: "confirm", path, entry: remoteEntry ?? localEntry });
    } else if (localChanged && !remoteChanged) {
      operations.push(operationForRemote(path, localEntry));
    } else if (!localChanged && remoteChanged) {
      operations.push(operationForLocal(path, remoteEntry));
    } else {
      conflicts.push({ path, base: baseEntry, local: localEntry, remote: remoteEntry, initial: false });
    }
  }

  return { operations, conflicts };
}

export function snapshotFromEntries(entries: SyncEntry[]) {
  return Object.fromEntries(entries.map((entry) => [entry.path, entry]));
}
