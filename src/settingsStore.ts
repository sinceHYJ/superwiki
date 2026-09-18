import { invoke } from "@tauri-apps/api/core";
import type { ContentWidth } from "./contentWidth";
import type { OssSyncSettings } from "./ossSync";
import { readShortcutBindings, SHORTCUT_DEFINITIONS, type ShortcutId } from "./shortcuts";

export type ThemeColor = "yellow" | "sky" | "mint" | "coral" | "lavender";

export type AppPreferences = {
  openTabLimit: number;
  autoSave: boolean;
  themeColor: ThemeColor;
  contentWidth: ContentWidth;
  themeColorRedesignV1: boolean;
  lastWorkspaceId: number | null;
};

export type WorkspaceRecord = { id: number; path: string };

export type FavoriteDocument = {
  root: string;
  path: string;
  name: string;
  relativePath: string;
  favoritedAt: number;
};

export type RecentEditedDocument = {
  root: string;
  path: string;
  name: string;
  relativePath: string;
  editedAt: number;
};

export type WorkspacePreferences = {
  workspaceId: number;
  root: string;
  favorites: FavoriteDocument[];
  recent: RecentEditedDocument[];
};

export type WorkspaceTree = {
  root: string;
  name: string;
  children: Array<{
    name: string;
    path: string;
    isDir: boolean;
    isMarkdown: boolean;
    isImage: boolean;
    isOffice: boolean;
    children: WorkspaceTree["children"];
  }>;
};

export type BootstrapSettings = {
  preferences: AppPreferences;
  shortcutOverrides: Partial<Record<ShortcutId, string>>;
  ossSync: OssSyncSettings | null;
  workspaces: WorkspaceRecord[];
};

export type OpenWorkspaceResult = {
  workspace: WorkspaceRecord;
  tree: WorkspaceTree;
  preferences: WorkspacePreferences;
};

export type PreferenceChange =
  | { key: "openTabLimit"; value: number }
  | { key: "autoSave"; value: boolean }
  | { key: "themeColor"; value: ThemeColor }
  | { key: "contentWidth"; value: ContentWidth };

let initialization: Promise<BootstrapSettings> | null = null;
let pendingWrites = 0;

export function initializeSettings() {
  initialization ??= invoke<BootstrapSettings>("initialize_settings")
    .then((settings) => {
      const knownShortcutIds = new Set(SHORTCUT_DEFINITIONS.map(({ id }) => id));
      if (Object.keys(settings.shortcutOverrides).some((id) => !knownShortcutIds.has(id as ShortcutId))) {
        throw new Error("配置数据库包含未知快捷键");
      }
      readShortcutBindings(settings.shortcutOverrides);
      return settings;
    })
    .catch((error) => {
      initialization = null;
      throw error;
    });
  return initialization;
}

export async function invokeSettingsWrite<T>(command: string, args?: Record<string, unknown>) {
  pendingWrites += 1;
  try {
    return await invoke<T>(command, args);
  } finally {
    pendingWrites -= 1;
  }
}

export function hasPendingSettingsWrite() {
  return pendingWrites > 0;
}

export function updateAppPreference(change: PreferenceChange) {
  return invokeSettingsWrite<void>("update_app_preference", { change });
}

export function saveShortcutOverrides(overrides: Partial<Record<ShortcutId, string>>) {
  return invokeSettingsWrite<void>("save_shortcut_overrides", { overrides });
}

export function openWorkspace(root: string) {
  return invoke<OpenWorkspaceResult>("open_workspace", { root });
}

export function closeWorkspaceSettings() {
  return invokeSettingsWrite<void>("close_workspace");
}

export function setDocumentFavorite(workspaceId: number, path: string, favorite: boolean) {
  return invokeSettingsWrite<WorkspacePreferences>("set_document_favorite", { workspaceId, path, favorite });
}

export function recordRecentEdit(workspaceId: number, path: string) {
  return invokeSettingsWrite<WorkspacePreferences>("record_recent_edit", { workspaceId, path });
}

export function remapWorkspaceDocuments(workspaceId: number, oldPath: string, newPath: string) {
  return invokeSettingsWrite<WorkspacePreferences>("remap_workspace_documents", { workspaceId, oldPath, newPath });
}

export function removeWorkspaceDocuments(workspaceId: number, path: string) {
  return invokeSettingsWrite<WorkspacePreferences>("remove_workspace_documents", { workspaceId, path });
}
