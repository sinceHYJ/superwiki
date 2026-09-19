import { invoke } from "@tauri-apps/api/core";

export type WorkspaceSyncSettings = {
  bindingId: string;
  bindingRoot: string;
  openedRoot: string;
  relativeScope: string;
  effectiveRemotePath: string;
  inherited: boolean;
  provider: "oss";
  region: string;
  endpoint: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  hasAccessKeySecret: boolean;
  enabled: boolean;
  deviceId: string;
};

export type WorkspaceSyncCredentials = WorkspaceSyncSettings & {
  workspaceId: string;
  accessKeySecret: string;
};

export type SyncSettingsInput = {
  region: string;
  endpoint: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  accessKeySecret?: string;
  enabled: boolean;
};

export function loadWorkspaceSyncSettings(root: string) {
  return invoke<WorkspaceSyncSettings | null>("load_workspace_sync_settings", { root });
}

export function saveWorkspaceSyncSettings(root: string, settings: SyncSettingsInput) {
  return invoke<void>("save_workspace_sync_settings", { root, settings });
}

export function loadWorkspaceSyncCredentials(root: string) {
  return invoke<WorkspaceSyncCredentials>("load_workspace_sync_credentials", { root });
}

export function removeWorkspaceSyncBinding(root: string) {
  return invoke<void>("remove_workspace_sync_binding", { root });
}
