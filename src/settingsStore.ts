/**
 * 设置 IPC 门面：统一初始化和写入状态，并将前端类型与 Rust 的 Serde 输出对齐。
 * 所有持久化配置必须经由本模块调用 Tauri 命令，前端不得直接读写 SQLite。
 */
import { invoke } from "@tauri-apps/api/core";
import type { ContentWidth } from "./contentWidth";
import type { OssSyncSettings } from "./ossSync";
import { readShortcutBindings, SHORTCUT_DEFINITIONS, type ShortcutId } from "./shortcuts";

/** 可持久化的主题色标识。 */
export type ThemeColor = "yellow" | "sky" | "mint" | "coral" | "lavender";

/** 应用启动时恢复的界面偏好。 */
export type AppPreferences = {
  /** 可同时打开的页签上限，始终为正整数。 */
  openTabLimit: number;
  /** 是否自动保存 Markdown 编辑内容。 */
  autoSave: boolean;
  /** 当前界面主题色。 */
  themeColor: ThemeColor;
  /** 当前内容区宽度模式。 */
  contentWidth: ContentWidth;
  /** 是否启用新版主题色设计。 */
  themeColorRedesignV1: boolean;
  /** 最近打开工作区的数据库 ID；无工作区时为 `null`。 */
  lastWorkspaceId: number | null;
};

/** 工作区的数据库主键和规范化绝对路径。 */
export type WorkspaceRecord = { /** 用于关联偏好的数据库 ID。 */ id: number; /** 工作区绝对路径。 */ path: string };

/** 前端展示的收藏 Markdown 文档及其收藏时间。 */
export type FavoriteDocument = {
  /** 所属工作区根目录。 */
  root: string;
  /** 文档绝对路径。 */
  path: string;
  /** 展示文件名。 */
  name: string;
  /** 工作区内相对路径。 */
  relativePath: string;
  /** 收藏时间的 Unix 毫秒时间戳。 */
  favoritedAt: number;
};

/** 前端展示的最近编辑 Markdown 文档及其编辑时间。 */
export type RecentEditedDocument = {
  /** 所属工作区根目录。 */
  root: string;
  /** 文档绝对路径。 */
  path: string;
  /** 展示文件名。 */
  name: string;
  /** 工作区内相对路径。 */
  relativePath: string;
  /** 最近编辑时间的 Unix 毫秒时间戳。 */
  editedAt: number;
};

/** 单个工作区的收藏和最近编辑偏好快照。 */
export type WorkspacePreferences = {
  /** 工作区数据库主键。 */
  workspaceId: number;
  /** 工作区规范化绝对路径。 */
  root: string;
  /** 当前有效的收藏文档。 */
  favorites: FavoriteDocument[];
  /** 当前有效的最近编辑文档。 */
  recent: RecentEditedDocument[];
};

/** Rust 文件服务返回的完整工作区目录树。 */
export type WorkspaceTree = {
  /** 工作区根目录绝对路径。 */
  root: string;
  /** 工作区展示名称。 */
  name: string;
  /** 目录根下的直接子节点。 */
  children: Array<{
    /** 节点展示名称。 */
    name: string;
    /** 节点绝对路径。 */
    path: string;
    /** 是否为目录。 */
    isDir: boolean;
    /** 是否为可编辑 Markdown 文件。 */
    isMarkdown: boolean;
    /** 是否为只读图片文件。 */
    isImage: boolean;
    /** 是否为 Office 预览文件。 */
    isOffice: boolean;
    /** 目录的直接子节点；文件为空数组。 */
    children: WorkspaceTree["children"];
  }>;
};

/** 设置数据库初始化后供应用启动使用的完整快照。 */
export type BootstrapSettings = {
  /** 应用级界面偏好。 */
  preferences: AppPreferences;
  /** 非默认快捷键的动作 ID 到组合键映射。 */
  shortcutOverrides: Partial<Record<ShortcutId, string>>;
  /** 脱敏 OSS 设置；未配置时为 `null`。 */
  ossSync: OssSyncSettings | null;
  /** 历史打开过的工作区。 */
  workspaces: WorkspaceRecord[];
};

/** 打开工作区后返回的目录树、持久化 ID 和相关偏好。 */
export type OpenWorkspaceResult = {
  /** 新打开工作区的数据库记录。 */
  workspace: WorkspaceRecord;
  /** 文件系统扫描得到的目录树。 */
  tree: WorkspaceTree;
  /** 工作区关联的收藏和最近编辑偏好。 */
  preferences: WorkspacePreferences;
};

/** 可写入 SQLite 的单项应用偏好及其严格类型。 */
export type PreferenceChange =
  | { key: "openTabLimit"; value: number }
  | { key: "autoSave"; value: boolean }
  | { key: "themeColor"; value: ThemeColor }
  | { key: "contentWidth"; value: ContentWidth };

/** 当前初始化请求的单例 Promise；失败后重置以允许用户重试。 */
let initialization: Promise<BootstrapSettings> | null = null;
/** 尚未完成的设置写入数量，用于阻止关闭或更新时丢失配置。 */
let pendingWrites = 0;

/**
 * 初始化 SQLite 设置并校验数据库中的快捷键动作均仍受当前版本支持。
 *
 * @returns 单例启动 Promise，成功时解析为 `BootstrapSettings`；并发调用共享同一请求。
 * @throws 初始化 IPC 失败、数据库含未知动作或快捷键覆盖无效时拒绝；失败后允许重试。
 */
export function initializeSettings() {
  initialization ??= invoke<BootstrapSettings>("initialize_settings")
    .then((settings) => {
      // 拒绝已删除动作的历史配置，避免前端静默忽略损坏或过期数据。
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

/**
 * 执行会修改 SQLite 的 Tauri 命令，并在执行期间维护全局未完成写入计数。
 *
 * @param command Rust 注册的设置写入命令名称。
 * @param args 可选 IPC 参数对象；缺省时不传参数。
 * @returns IPC 成功结果的 `Promise<T>`。
 * @throws Tauri IPC 或 Rust 设置校验/写入失败时拒绝；无论成败都会递减待写入计数。
 */
export async function invokeSettingsWrite<T>(command: string, args?: Record<string, unknown>) {
  pendingWrites += 1;
  try {
    return await invoke<T>(command, args);
  } finally {
    pendingWrites -= 1;
  }
}

/**
 * 返回是否存在未完成的设置写入，供关闭、切换工作区和安装更新前检查。
 *
 * @returns `true` 表示至少一个 `invokeSettingsWrite` 尚未完成。
 */
export function hasPendingSettingsWrite() {
  return pendingWrites > 0;
}

/**
 * 持久化一个经类型约束的应用偏好。
 *
 * @param change 偏好键和值；联合类型限制其可写字段与值类型。
 * @returns 数据库写入完成后解析为 `void` 的 Promise。
 * @throws IPC、键白名单或值范围校验失败时拒绝。
 */
export function updateAppPreference(change: PreferenceChange) {
  return invokeSettingsWrite<void>("update_app_preference", { change });
}

/**
 * 原子保存非默认快捷键覆盖；缺失动作将恢复其默认组合键。
 *
 * @param overrides 动作 ID 到 chord 的覆盖映射；空对象表示恢复全部默认值。
 * @returns 写入完成后解析为 `void` 的 Promise。
 * @throws IPC 或服务端快捷键校验失败时拒绝。
 */
export function saveShortcutOverrides(overrides: Partial<Record<ShortcutId, string>>) {
  return invokeSettingsWrite<void>("save_shortcut_overrides", { overrides });
}

/**
 * 打开 `root` 工作区并返回其目录树、数据库 ID 与文档偏好。
 *
 * @param root 用户选择的工作区目录绝对路径。
 * @returns 登记后的工作区、文件树和收藏/最近编辑偏好。
 * @throws 路径无效、目录扫描或 SQLite 读写失败时拒绝。
 */
export function openWorkspace(root: string) {
  return invoke<OpenWorkspaceResult>("open_workspace", { root });
}

/**
 * 清除最近打开工作区标记，不删除已保存的工作区记录。
 *
 * @returns 写入完成后解析为 `void` 的 Promise。
 * @throws IPC 或 SQLite 更新失败时拒绝。
 */
export function closeWorkspaceSettings() {
  return invokeSettingsWrite<void>("close_workspace");
}

/**
 * 设置工作区内文档的收藏状态，并返回更新后的文档偏好。
 *
 * @param workspaceId 已登记工作区的数据库 ID。
 * @param path 工作区内 Markdown 文档绝对路径。
 * @param favorite `true` 添加收藏，`false` 移除收藏。
 * @returns 清理失效记录后的完整工作区偏好。
 * @throws 工作区/路径无效或 SQLite 写入失败时拒绝。
 */
export function setDocumentFavorite(workspaceId: number, path: string, favorite: boolean) {
  return invokeSettingsWrite<WorkspacePreferences>("set_document_favorite", { workspaceId, path, favorite });
}

/**
 * 记录一次文档编辑，并返回已裁剪的最近编辑列表。
 *
 * @param workspaceId 已登记工作区的数据库 ID。
 * @param path 工作区内存在的 Markdown 文档绝对路径。
 * @returns 按数量上限裁剪后的完整工作区偏好。
 * @throws 工作区/文件无效或 SQLite 写入失败时拒绝。
 */
export function recordRecentEdit(workspaceId: number, path: string) {
  return invokeSettingsWrite<WorkspacePreferences>("record_recent_edit", { workspaceId, path });
}

/**
 * 在文件或目录重命名后迁移对应的收藏和最近编辑路径。
 *
 * @param workspaceId 已登记工作区的数据库 ID。
 * @param oldPath 重命名前文件或目录的工作区内绝对路径。
 * @param newPath 重命名后文件或目录的工作区内绝对路径。
 * @returns 合并冲突并清理失效记录后的完整工作区偏好。
 * @throws 路径越界或 SQLite 写入失败时拒绝。
 */
export function remapWorkspaceDocuments(workspaceId: number, oldPath: string, newPath: string) {
  return invokeSettingsWrite<WorkspacePreferences>("remap_workspace_documents", { workspaceId, oldPath, newPath });
}

/**
 * 在文件或目录删除后清理对应的收藏和最近编辑路径。
 *
 * @param workspaceId 已登记工作区的数据库 ID。
 * @param path 已删除或将删除的工作区内文件/目录绝对路径。
 * @returns 清理该路径及目录后代后的完整工作区偏好。
 * @throws 路径越界或 SQLite 写入失败时拒绝。
 */
export function removeWorkspaceDocuments(workspaceId: number, path: string) {
  return invokeSettingsWrite<WorkspacePreferences>("remove_workspace_documents", { workspaceId, path });
}
