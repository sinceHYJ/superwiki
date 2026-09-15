export type SyncEntryKind = "file" | "directory" | "deleted";

export type SyncEntry = {
  path: string;
  kind: SyncEntryKind;
  hash?: string;
  size?: number;
  modifiedAt?: number;
  revision?: string;
};

export type SyncSnapshot = Record<string, SyncEntry>;

export type SyncManifest = {
  schemaVersion: 1;
  workspaceId: string;
  revision: number;
  entries: SyncSnapshot;
};

export type SyncConflict = {
  path: string;
  base?: SyncEntry;
  local?: SyncEntry;
  remote?: SyncEntry;
  initial: boolean;
};

export type SyncOperation =
  | { kind: "upload"; path: string; entry: SyncEntry }
  | { kind: "download"; path: string; entry: SyncEntry }
  | { kind: "createLocalDirectory"; path: string; entry: SyncEntry }
  | { kind: "createRemoteDirectory"; path: string; entry: SyncEntry }
  | { kind: "deleteLocal"; path: string; entry: SyncEntry }
  | { kind: "deleteRemote"; path: string; entry: SyncEntry }
  | { kind: "confirm"; path: string; entry?: SyncEntry };

export type SyncPlan = {
  operations: SyncOperation[];
  conflicts: SyncConflict[];
};

export type ConflictChoice = "local" | "remote" | "both";

export type RemoteRevision = { value?: string };

export type ChunkReader = {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
};

export type ChunkWriter = {
  write(offset: number, content: Uint8Array): Promise<void>;
  commit(): Promise<void>;
  cancel(): Promise<void>;
};

export type RemoteEntry = SyncEntry & { revision?: string };

export type SyncLease = {
  id: string;
  expiresAt: number;
};

export interface SyncProvider {
  testConnection(): Promise<void>;
  list(scope: string): Promise<RemoteEntry[]>;
  download(path: string, target: ChunkWriter, signal: AbortSignal, onProgress?: (completed: number, total: number) => void): Promise<void>;
  upload(path: string, source: ChunkReader, signal: AbortSignal, onProgress?: (completed: number, total: number) => void): Promise<RemoteRevision>;
  createDirectory(path: string): Promise<void>;
  remove(path: string, expectedRevision?: string): Promise<void>;
  acquireLease(workspaceId: string): Promise<SyncLease>;
  renewLease(lease: SyncLease): Promise<SyncLease>;
  releaseLease(lease: SyncLease): Promise<void>;
  loadManifest(): Promise<SyncManifest | null>;
  saveManifest(manifest: SyncManifest, lease: SyncLease): Promise<void>;
}

export type SyncPhase = "disabled" | "checking" | "syncing" | "synced" | "offline" | "conflicts" | "paused" | "error";

export type SyncProgress = {
  completed: number;
  total: number;
  currentPath?: string;
  transferredBytes?: number;
  totalBytes?: number;
};

export type SyncActivity = {
  action: "upload" | "download" | "delete" | "directory" | "skip" | "conflict";
  path: string;
  message: string;
};

export type SyncStatus = {
  phase: SyncPhase;
  message: string;
  progress?: SyncProgress;
  activities: SyncActivity[];
  conflicts: SyncConflict[];
  inheritedFrom?: string;
  remotePath?: string;
};
