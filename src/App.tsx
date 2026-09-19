/**
 * SuperWiki 主界面：协调工作区树、编辑器、预览、自动保存及设置持久化后的界面状态。
 * 本文件不直接读写浏览器持久化存储；应用设置、工作区偏好均通过 settingsStore 的 Tauri IPC 保存。
 */
import { Children, isValidElement, lazy, memo, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ChevronRight,
  Clock3,
  Copy,
  Eye,
  File,
  FileCode2,
  Folder,
  Image as ImageIcon,
  Minus,
  FolderOpen,
  Info,
  Keyboard,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  Pencil,
  RefreshCw,
  Save,
  Scan,
  Search,
  Square,
  Settings,
  Star,
  Trash2,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import MermaidDiagram from "./MermaidDiagram";
import { isMermaidLanguage } from "./mermaidRenderer";
import PlantUmlDiagram from "./PlantUmlDiagram";
import VideoEmbedPreview from "./VideoEmbedPreview";
import { isPlantUmlLanguage } from "./plantumlRenderer";
import { remarkLineBreak } from "./remarkLineBreak";
import { remarkVideoEmbed } from "./remarkVideoEmbed";
import { DEFAULT_CODE_BLOCK_TITLE, extractCodeBlockTitles } from "./codeBlockMetadata";
import {
  DEFAULT_SHORTCUT_BINDINGS,
  SHORTCUT_DEFINITIONS,
  chordFromKeyboardEvent,
  displayShortcut,
  readShortcutBindings,
  shortcutOverrides,
  setShortcutBinding,
  shortcutTitle,
  type EditorShortcutId,
  type ShortcutBindings,
  type ShortcutId,
} from "./shortcuts";
import type { EditorHandle, EditorShortcutCommand } from "./WysiwygEditor";
import { imageMimeType, proxyWorkspaceImage, resolveWorkspacePath } from "./workspaceImages";
import {
  loadOssSyncSettings,
  saveOssSyncSettings,
  syncWorkspace,
  syncWorkspaceFile,
  testOssSyncConnection,
  type OssSyncSettings,
} from "./ossSync";
import "./App.css";
import AppUpdater from "./AppUpdater";
import { collectUpdateDocuments, createSaveQueue } from "./updateSave";
import type { ContentWidth } from "./contentWidth";
import {
  closeWorkspaceSettings,
  hasPendingSettingsWrite,
  openWorkspace,
  recordRecentEdit as saveRecentEdit,
  remapWorkspaceDocuments,
  removeWorkspaceDocuments,
  saveShortcutOverrides,
  setDocumentFavorite,
  updateAppPreference,
  type BootstrapSettings,
} from "./settingsStore";

/** 工作区目录树节点，字段与 Rust `FileTreeNode` 的 camelCase 序列化保持一致。 */
type FileTreeNode = {
  /** 节点展示名称。 */
  name: string;
  /** 节点绝对路径。 */
  path: string;
  /** 是否为目录；目录节点才可展开 `children`。 */
  isDir: boolean;
  /** 是否为可编辑 Markdown 文件。 */
  isMarkdown: boolean;
  /** 是否为只读图片文件。 */
  isImage: boolean;
  /** 是否为 Office 预览文件。 */
  isOffice: boolean;
  /** 直接子节点；文件节点为空数组。 */
  children: FileTreeNode[];
};

/** 用户当前打开工作区的根信息和目录树。 */
type WorkspaceTree = {
  /** 工作区根目录绝对路径。 */
  root: string;
  /** 工作区展示名称。 */
  name: string;
  /** 根目录直接子节点。 */
  children: FileTreeNode[];
};

/** 编辑器、图片预览或 Office 预览中当前激活的文件。 */
type ActiveFile = {
  /** 所属工作区根目录。 */
  root: string;
  /** 文件绝对路径。 */
  path: string;
  /** 界面显示的文件名。 */
  name: string;
  /** 文件处理模式，决定可编辑或只读预览。 */
  kind: "markdown" | "image" | "office";
};

/** 文档区显示模式。 */
type ViewMode = "editor" | "preview";
/** 左侧工作区当前展示的文档、最近编辑或收藏页。 */
type WorkspaceView = "document" | "recent" | "favorites";
/** 当前文件保存状态。 */
type SaveState = "saved" | "saving" | "error";
/** 应用可选择的主题色标识。 */
type ThemeColor = "yellow" | "sky" | "mint" | "coral" | "lavender";
/** OSS 同步任务状态。 */
type SyncState = "idle" | "syncing" | "error";

/** 设置面板中暂存的 OSS 表单；密钥只在当前内存中存在。 */
type OssSyncForm = {
  /** OSS 区域标识。 */
  region: string;
  /** OSS Endpoint。 */
  endpoint: string;
  /** 目标 Bucket。 */
  bucket: string;
  /** Bucket 内对象前缀。 */
  prefix: string;
  /** AccessKey ID。 */
  accessKeyId: string;
  /** 待提交的新密钥；空值表示保留已存密钥。 */
  accessKeySecret: string;
};

/** 编辑器光标的 1 基行列位置。 */
type CursorPosition = {
  /** 当前行号，从 1 开始。 */
  line: number;
  /** 当前列号，从 1 开始。 */
  column: number;
};

/** 文档大纲中的一个标题。 */
type DocumentHeading = {
  /** Markdown 标题等级，取值 1 至 6。 */
  level: number;
  /** 去除 Markdown 标记后的标题文本。 */
  text: string;
};

/** 目录右键菜单的位置和目标节点。 */
type DirectoryContextMenu = {
  /** 被操作的目录树节点。 */
  node: FileTreeNode;
  /** 是否为工作区根，根目录不允许部分操作。 */
  isWorkspaceRoot: boolean;
  /** 菜单视口 X 坐标，单位为 CSS 像素。 */
  x: number;
  /** 菜单视口 Y 坐标，单位为 CSS 像素。 */
  y: number;
};

/** 新建条目的种类。 */
type CreateEntryKind = "file" | "directory";

/** 正在创建的条目的父目录和类型。 */
type CreatingEntry = {
  /** 新条目的父目录绝对路径。 */
  parentPath: string;
  /** 新建 Markdown 文件或目录。 */
  kind: CreateEntryKind;
};

/** 最近编辑列表展示的 Markdown 文档。 */
type RecentEditedDocument = {
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

/** 收藏列表展示的 Markdown 文档。 */
type FavoriteDocument = {
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

/** 以 `root:path` 为 key 的未落盘 Markdown 草稿映射；缺少 key 表示无草稿。 */
type DocumentDrafts = Record<string, string>;

const THEME_COLORS: { id: ThemeColor; name: string; color: string }[] = [
  { id: "yellow", name: "明亮黄", color: "#d9ed72" },
  { id: "sky", name: "天蓝色", color: "oklch(0.6331 0.0643 238.60)" },
  { id: "mint", name: "薄荷绿", color: "#86efac" },
  { id: "coral", name: "珊瑚粉", color: "#fda4af" },
  { id: "lavender", name: "薰衣草紫", color: "#c4b5fd" },
];
/** 未配置 OSS 时显示的表单初始值；密钥始终保持空字符串，绝不回显。 */
const EMPTY_OSS_SYNC_FORM: OssSyncForm = {
  region: "",
  endpoint: "",
  bucket: "",
  prefix: "superwiki",
  accessKeyId: "",
  accessKeySecret: "",
};

/** 将工作区根与绝对文件路径组合为唯一草稿 key。 */
function documentDraftKey(file: Pick<ActiveFile, "root" | "path">) {
  return `${file.root}:${file.path}`;
}
const DEFAULT_SIDEBAR_WIDTH = 286;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 480;
const MIN_WORKSPACE_WIDTH = 360;
const IS_MACOS = /Macintosh|Mac OS X/i.test(navigator.userAgent);
const IS_WINDOWS = /Windows/i.test(navigator.userAgent);
const HAS_OVERLAY_TITLEBAR = IS_MACOS || IS_WINDOWS;
const OPEN_IN_FILE_MANAGER_LABEL = IS_MACOS
  ? "在 Finder 中打开"
  : "在文件管理器打开";
const WysiwygEditor = lazy(() => import("./WysiwygEditor"));
const OfficePreview = lazy(() => import("./OfficePreview"));

/**
 * 渲染已完成设置初始化的应用主界面。
 *
 * `initialSettings` 是 SettingsGate 从 SQLite 读取的启动快照；组件内后续修改必须先持久化再更新界面状态。
 */
function App({ initialSettings }: { initialSettings: BootstrapSettings }) {
  const [updateOpen, setUpdateOpen] = useState(false);
  const installingUpdateRef = useRef(false);
  const openingFilesRef = useRef(0);
  const [saveQueue] = useState(() => createSaveQueue((document) => invoke<void>("save_workspace_file", document)));
  const [workspace, setWorkspace] = useState<WorkspaceTree | null>(null);
  // 仅在工作区已通过 SQLite 登记后存在，用于收藏、最近编辑、重命名和删除记录。
  const [workspaceId, setWorkspaceId] = useState<number | null>(null);
  const [activeFile, setActiveFile] = useState<ActiveFile | null>(null);
  const [openTabs, setOpenTabs] = useState<ActiveFile[]>([]);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("document");
  const [recentEditedDocuments, setRecentEditedDocuments] = useState<RecentEditedDocument[]>([]);
  const [favoriteDocuments, setFavoriteDocuments] = useState<FavoriteDocument[]>([]);
  const [documentSearchQuery, setDocumentSearchQuery] = useState("");
  const [content, setContent] = useState("");
  const [documentDrafts, setDocumentDrafts] = useState<DocumentDrafts>({});
  const [cursorPosition, setCursorPosition] = useState<CursorPosition>({ line: 1, column: 1 });
  const [editorVersion, setEditorVersion] = useState(0);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [officeData, setOfficeData] = useState<ArrayBuffer | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("editor");
  const [, setSaveState] = useState<SaveState>("saved");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [documentFullscreen, setDocumentFullscreen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [windowMaximized, setWindowMaximized] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"basic" | "appearance" | "shortcuts" | "sync" | "about">("basic");
  const [shortcutBindings, setShortcutBindings] = useState<ShortcutBindings>(() => readShortcutBindings(initialSettings.shortcutOverrides));
  const [shortcutRecording, setShortcutRecording] = useState<ShortcutId | null>(null);
  const [shortcutError, setShortcutError] = useState("");
  // 三类异步设置写入分别控制交互禁用，避免后写入覆盖先写入或关闭窗口时中断保存。
  const [shortcutSaving, setShortcutSaving] = useState(false);
  const [preferenceSaving, setPreferenceSaving] = useState(false);
  const [favoriteSaving, setFavoriteSaving] = useState(false);
  const [openTabLimit, setOpenTabLimit] = useState(initialSettings.preferences.openTabLimit);
  const [autoSave, setAutoSave] = useState(initialSettings.preferences.autoSave);
  const [contentWidth, setContentWidth] = useState<ContentWidth>(initialSettings.preferences.contentWidth);
  const [ossSyncSettings, setOssSyncSettings] = useState<OssSyncSettings | null>(initialSettings.ossSync);
  const [ossSyncForm, setOssSyncForm] = useState<OssSyncForm>(() => initialSettings.ossSync ? {
    region: initialSettings.ossSync.region,
    endpoint: initialSettings.ossSync.endpoint,
    bucket: initialSettings.ossSync.bucket,
    prefix: initialSettings.ossSync.prefix,
    accessKeyId: initialSettings.ossSync.accessKeyId,
    accessKeySecret: "",
  } : EMPTY_OSS_SYNC_FORM);
  const [syncState, setSyncState] = useState<SyncState>("idle");
  const [syncMessage, setSyncMessage] = useState("");
  const [appVersion, setAppVersion] = useState("");
  const [themeColor, setThemeColor] = useState<ThemeColor>(initialSettings.preferences.themeColor);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [directoryContextMenu, setDirectoryContextMenu] = useState<DirectoryContextMenu | null>(null);
  const [pathCopiedNotice, setPathCopiedNotice] = useState(false);
  const [creatingEntry, setCreatingEntry] = useState<CreatingEntry | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [error, setError] = useState("");
  const loadedContent = useRef("");
  const activeFileRef = useRef<ActiveFile | null>(null);
  const contentRef = useRef("");
  const imageUrlRef = useRef<string | null>(null);
  const editorHandleRef = useRef<EditorHandle | null>(null);
  const activeTabRef = useRef<HTMLButtonElement>(null);
  const editorPaneRef = useRef<HTMLElement>(null);
  const previewPaneRef = useRef<HTMLElement>(null);
  const saveTimerRef = useRef<number | null>(null);
  const syncTimerRef = useRef<number | null>(null);
  const pathCopiedNoticeTimerRef = useRef<number | null>(null);
  const pendingSyncFilesRef = useRef(new Map<string, Set<string>>());
  const sidebarResizingRef = useRef(false);

  /** @param url 新 Blob URL，`null` 表示清空。@returns 无。@sideEffect 释放旧 URL 并更新图片预览状态。 */
  const replaceImageUrl = useCallback((url: string | null) => {
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    imageUrlRef.current = url;
    setImageUrl(url);
  }, []);

  /** @returns 编辑器当前 Markdown；编辑器未就绪时返回内容引用快照。@sideEffect 用最新编辑器值同步 React 状态。 */
  const syncEditorContent = useCallback(() => {
    const latestMarkdown = editorHandleRef.current?.getMarkdown();
    if (latestMarkdown === undefined) return contentRef.current;

    contentRef.current = latestMarkdown;
    setContent(latestMarkdown);
    return latestMarkdown;
  }, []);

  /** 将已保存的 Markdown 文件记录到 SQLite，并用服务端清理后的偏好刷新两类快捷访问列表。 */
  const recordRecentEdit = useCallback(async (file: ActiveFile) => {
    if (file.kind !== "markdown" || workspaceId === null) return;
    try {
      const preferences = await saveRecentEdit(workspaceId, file.path);
      setRecentEditedDocuments(preferences.recent);
      setFavoriteDocuments(preferences.favorites);
    } catch (reason) {
      setError(`最近编辑记录保存失败，请再次编辑后重试：${String(reason)}`);
    }
  }, [workspaceId]);

  /** @param root 工作区根路径。@param path 已保存文件路径。@returns 无。@sideEffect 按根目录去重并延迟提交 OSS 单文件同步。 */
  const queueWorkspaceFileSync = useCallback((root: string, path: string) => {
    if (!ossSyncSettings?.enabled || !ossSyncSettings.hasAccessKeySecret) return;

    const pendingFiles = pendingSyncFilesRef.current.get(root) ?? new Set<string>();
    pendingFiles.add(path);
    pendingSyncFilesRef.current.set(root, pendingFiles);
    if (syncTimerRef.current !== null) window.clearTimeout(syncTimerRef.current);

    syncTimerRef.current = window.setTimeout(() => {
      syncTimerRef.current = null;
      const files = [...(pendingSyncFilesRef.current.get(root) ?? [])];
      pendingSyncFilesRef.current.delete(root);
      if (!files.length) return;

      setSyncState("syncing");
      setSyncMessage(`正在同步 ${files.length} 个文件…`);
      void Promise.all(files.map((filePath) => syncWorkspaceFile(root, filePath)))
        .then(() => {
          setSyncState("idle");
          setSyncMessage(`已同步 ${files.length} 个文件`);
        })
        .catch((reason) => {
          setSyncState("error");
          setSyncMessage(`同步失败：${String(reason)}`);
        });
    }, 2000);
  }, [ossSyncSettings?.enabled, ossSyncSettings?.hasAccessKeySecret]);

  /** @param force 为 `true` 时忽略关闭自动保存设置。@returns 保存完成后的 Promise。@throws 写盘失败时拒绝。@sideEffect 清除定时器、写文件并更新最近编辑及同步队列。 */
  const flushPendingSave = useCallback(async (force = false) => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    if (!force && !autoSave) return;

    const file = activeFileRef.current;
    if (!file || file.kind !== "markdown") return;

    const latestContent = syncEditorContent();
    if (latestContent === loadedContent.current) return;

    await saveQueue.write({
      root: file.root,
      path: file.path,
      content: latestContent,
    });
    loadedContent.current = latestContent;
    setDocumentDrafts((drafts) => {
      const nextDrafts = { ...drafts };
      delete nextDrafts[documentDraftKey(file)];
      return nextDrafts;
    });
    await recordRecentEdit(file);
    queueWorkspaceFileSync(file.root, file.path);
  }, [autoSave, queueWorkspaceFileSync, recordRecentEdit, saveQueue, syncEditorContent]);

  /**
   * 在安装更新前保存所有草稿，并拒绝配置写入或文件切换中的更新。
   *
   * 任一文档保存失败时恢复完整草稿快照，避免部分成功后丢失未保存内容。
   */
  const prepareUpdateInstall = async () => {
    if (openingFilesRef.current) throw new Error("文档正在切换，请稍后重试安装。");
    // 更新会销毁当前进程，必须等待 SQLite 写事务结束。
    if (hasPendingSettingsWrite()) throw new Error("配置正在保存，请稍后重试安装。");
    installingUpdateRef.current = true;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const currentFile = activeFileRef.current;
    const latest = syncEditorContent();
    const documents = collectUpdateDocuments(openTabs, documentDrafts, currentFile, latest);
    // Keep all drafts until the entire save gate succeeds, including on partial failure.
    try {
      await saveQueue.saveBeforeUpdate(documents);
    } catch (reason) {
      setDocumentDrafts((drafts) => ({ ...drafts, ...Object.fromEntries(documents.map((file) => [documentDraftKey(file), file.content])) }));
      setSaveState("error");
      throw reason;
    }
    if (currentFile?.kind === "markdown") loadedContent.current = latest;
    setDocumentDrafts({});
    setSaveState("saved");
  };

  /** @returns 手动保存流程的 Promise。@sideEffect 强制刷新当前 Markdown，并更新保存或错误状态。 */
  const saveCurrentFile = useCallback(async () => {
    try {
      setError("");
      setSaveState("saving");
      await flushPendingSave(true);
      setSaveState("saved");
    } catch (reason) {
      setSaveState("error");
      setError(String(reason));
    }
  }, [flushPendingSave]);

  /** @param file 待打开的工作区文件及其预览类别。@returns 打开成功为 `true`。@sideEffect 保存当前文件、读取目标内容并更新页签、编辑器或预览状态。 */
  const openFile = useCallback(async (file: ActiveFile) => {
    if (installingUpdateRef.current) return false;
    openingFilesRef.current += 1;
    try {
      setError("");
      const currentFile = activeFileRef.current;
      if (currentFile?.root === file.root && currentFile.path === file.path) {
        setWorkspaceView("document");
        return true;
      }
      await flushPendingSave();

      if (file.kind === "image") {
        const imageData = await invoke<ArrayBuffer>("read_workspace_image", {
          root: file.root,
          path: file.path,
        });
        replaceImageUrl(URL.createObjectURL(new Blob([imageData], { type: imageMimeType(file.name) })));
        setOfficeData(null);
        loadedContent.current = "";
        contentRef.current = "";
        setContent("");
      } else if (file.kind === "office") {
        const data = await invoke<ArrayBuffer>("read_workspace_office", {
          root: file.root,
          path: file.path,
        });
        replaceImageUrl(null);
        setOfficeData(data);
        loadedContent.current = "";
        contentRef.current = "";
        setContent("");
      } else {
        const fileContent = await invoke<string>("read_workspace_file", {
          root: file.root,
          path: file.path,
        });
        replaceImageUrl(null);
        setOfficeData(null);
        const draft = documentDrafts[documentDraftKey(file)];
        loadedContent.current = fileContent;
        contentRef.current = draft ?? fileContent;
        setContent(draft ?? fileContent);
        setCursorPosition({ line: 1, column: 1 });
        setEditorVersion((version) => version + 1);
        setViewMode("editor");
        setSaveState("saved");
      }

      activeFileRef.current = file;
      setActiveFile(file);
      setOpenTabs((current) => current.some((tab) => tab.root === file.root && tab.path === file.path)
        ? current
        : [...current, file].slice(-openTabLimit));
      setWorkspaceView("document");
      return true;
    } catch (reason) {
      setError(String(reason));
      return false;
    } finally {
      openingFilesRef.current -= 1;
    }
  }, [documentDrafts, flushPendingSave, openTabLimit, replaceImageUrl]);

  /** 打开并登记工作区，同时用 Rust 返回的偏好快照替换当前快捷访问数据。 */
  const loadWorkspace = useCallback(async (root: string) => {
    setWorkspaceLoading(true);
    try {
      setError("");
      const result = await openWorkspace(root);
      setWorkspace(result.tree);
      setWorkspaceId(result.workspace.id);
      setRecentEditedDocuments(result.preferences.recent);
      setFavoriteDocuments(result.preferences.favorites);
    } catch (reason) {
      setWorkspace(null);
      setWorkspaceId(null);
      setRecentEditedDocuments([]);
      setFavoriteDocuments([]);
      setError(`无法打开文件夹：${String(reason)}`);
    } finally {
      setWorkspaceLoading(false);
    }
  }, []);

  /** 请求用户选择新工作区；切换前会等待配置写入并保存当前 Markdown。 */
  const selectWorkspace = async () => {
    // 防止切换后工作区状态已改变、旧工作区相关偏好仍在写入。
    if (hasPendingSettingsWrite()) {
      setError("配置正在保存，请稍候再切换工作区。");
      return;
    }
    const selected = await open({ directory: true, multiple: false, title: "打开笔记文件夹" });
    if (!selected) return;

    try {
      await flushPendingSave();
      activeFileRef.current = null;
      setDirectoryContextMenu(null);
      setCreatingEntry(null);
      setRenamingPath(null);
      setWorkspaceView("document");
      setDocumentSearchQuery("");
      loadedContent.current = "";
      contentRef.current = "";
      setActiveFile(null);
      setOpenTabs([]);
      setDocumentDrafts({});
      setContent("");
      replaceImageUrl(null);
      setOfficeData(null);
      await loadWorkspace(selected);
    } catch (reason) {
      setError(String(reason));
    }
  };

  useEffect(() => () => {
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
  }, []);

  useEffect(() => () => {
    if (syncTimerRef.current !== null) window.clearTimeout(syncTimerRef.current);
  }, []);

  useEffect(() => () => {
    if (pathCopiedNoticeTimerRef.current !== null) window.clearTimeout(pathCopiedNoticeTimerRef.current);
  }, []);

  useEffect(() => {
    if (!directoryContextMenu) return;

    /** @returns 无。@sideEffect 关闭当前目录右键菜单。 */
    const closeMenu = () => setDirectoryContextMenu(null);
    /** @param event 全局键盘事件。@returns 无。@sideEffect Escape 时关闭目录菜单。 */
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [directoryContextMenu]);

  useEffect(() => {
    if (!documentFullscreen) return;

    /** @param event 全局键盘事件。@returns 无。@sideEffect Escape 时退出文档全屏。 */
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDocumentFullscreen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [documentFullscreen]);

  useEffect(() => {
    if (activeFile?.kind !== "markdown") setDocumentFullscreen(false);
  }, [activeFile?.kind]);

  useEffect(() => {
    if (workspaceView !== "document" || !activeFile) return;
    activeTabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeFile, workspaceView]);

  useEffect(() => {
    let cancelled = false;
    void getVersion()
      .then((version) => {
        if (!cancelled) setAppVersion(version);
      })
      .catch(() => {
        // 获取版本号失败时保持为空，不影响其他功能
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;

    /** @param event 全局键盘事件。@returns 无。@sideEffect Escape 时关闭设置对话框。 */
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [settingsOpen]);

  useEffect(() => {
    const lastWorkspace = initialSettings.workspaces.find(({ id }) => id === initialSettings.preferences.lastWorkspaceId);
    if (lastWorkspace) void loadWorkspace(lastWorkspace.path);
  }, [initialSettings.preferences.lastWorkspaceId, initialSettings.workspaces, loadWorkspace]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested((event) => {
      if (hasPendingSettingsWrite()) {
        event.preventDefault();
        setError("配置正在保存，请稍候再关闭应用。");
      }
    }).then((dispose) => { unlisten = dispose; });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (installingUpdateRef.current || !autoSave || !activeFile || activeFile.kind !== "markdown" || content === loadedContent.current) return;

    setSaveState("saving");
    saveTimerRef.current = window.setTimeout(async () => {
      if (installingUpdateRef.current) return;
      try {
        await saveQueue.write({
          root: activeFile.root,
          path: activeFile.path,
          content,
        });
        loadedContent.current = content;
        setDocumentDrafts((drafts) => {
          const nextDrafts = { ...drafts };
          delete nextDrafts[documentDraftKey(activeFile)];
          return nextDrafts;
        });
        await recordRecentEdit(activeFile);
        queueWorkspaceFileSync(activeFile.root, activeFile.path);
        saveTimerRef.current = null;
        setSaveState("saved");
      } catch (reason) {
        saveTimerRef.current = null;
        setSaveState("error");
        setError(String(reason));
      }
    }, 1000);

    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    };
  }, [activeFile, autoSave, content, queueWorkspaceFileSync, recordRecentEdit, saveQueue]);

  /** @returns 关闭工作区流程的 Promise。@sideEffect 等待写入、保存当前文档、清空界面状态并清除最近工作区标记。 */
  const closeWorkspace = async () => {
    if (hasPendingSettingsWrite()) {
      setError("配置正在保存，请稍候再关闭工作区。");
      return;
    }
    try {
      await flushPendingSave();
      await closeWorkspaceSettings();
      activeFileRef.current = null;
      setDirectoryContextMenu(null);
      setCreatingEntry(null);
      setRenamingPath(null);
      setWorkspaceView("document");
      setDocumentSearchQuery("");
      setRecentEditedDocuments([]);
      setFavoriteDocuments([]);
      loadedContent.current = "";
      contentRef.current = "";
      setActiveFile(null);
      setOpenTabs([]);
      setDocumentDrafts({});
      setContent("");
      replaceImageUrl(null);
      setOfficeData(null);
      setWorkspace(null);
      setWorkspaceId(null);
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  };

  /** @param value 编辑器最新 Markdown 文本。@returns 无。@sideEffect 更新草稿、内容引用和 React 内容状态。 */
  const handleEditorChange = useCallback((value: string) => {
    const file = activeFileRef.current;
    if (file?.kind === "markdown") {
      setDocumentDrafts((drafts) => {
        const nextDrafts = { ...drafts };
        const key = documentDraftKey(file);
        if (value === loadedContent.current) delete nextDrafts[key];
        else nextDrafts[key] = value;
        return nextDrafts;
      });
    }
    contentRef.current = value;
    setContent(value);
  }, []);

  /** @param handle 编辑器暴露的同步读取句柄；卸载时为 `null`。@returns 无。@sideEffect 保存句柄引用。 */
  const handleEditorReady = useCallback((handle: EditorHandle | null) => {
    editorHandleRef.current = handle;
  }, []);

  /** @param position 编辑器报告的 1 基光标位置。@returns 无。@sideEffect 更新状态栏位置。 */
  const handleCursorPositionChange = useCallback((position: CursorPosition) => {
    setCursorPosition(position);
  }, []);

  /** @param source 可选的已上传资源相对路径。@returns 无。@sideEffect 排队同步资源并重新读取目录树。 */
  const handleAssetUploaded = useCallback((source?: string) => {
    const file = activeFileRef.current;
    if (!file) return;
    const { root } = file;
    if (source) queueWorkspaceFileSync(root, resolveWorkspacePath(root, file.path, source));

    void invoke<WorkspaceTree>("list_workspace", { root })
      .then(setWorkspace)
      .catch((reason) => setError(`无法刷新目录：${String(reason)}`));
  }, [queueWorkspaceFileSync]);

  /** @param file 目录树中待打开文件节点。@returns 无。@sideEffect 按节点类型调用打开流程。 */
  const openTreeFile = useCallback((file: FileTreeNode) => {
    if (!workspace) return;
    void openFile({
      root: workspace.root,
      path: file.path,
      name: file.name,
      kind: file.isImage ? "image" : file.isOffice ? "office" : "markdown",
    });
  }, [openFile, workspace]);

  /** @param tab 待关闭页签。@returns 关闭流程 Promise。@sideEffect 保存活动页、更新页签与激活文件状态。 */
  const closeTab = useCallback(async (tab: ActiveFile) => {
    const tabIndex = openTabs.findIndex((item) => item.root === tab.root && item.path === tab.path);
    if (tabIndex === -1) return;

    const currentFile = activeFileRef.current;
    const closesActiveFile = currentFile?.root === tab.root && currentFile.path === tab.path;
    if (!closesActiveFile) {
      setOpenTabs((current) => current.filter((item) => item.root !== tab.root || item.path !== tab.path));
      setDocumentDrafts((drafts) => {
        const nextDrafts = { ...drafts };
        delete nextDrafts[documentDraftKey(tab)];
        return nextDrafts;
      });
      return;
    }

    try {
      setError("");
      await flushPendingSave();
      setDocumentDrafts((drafts) => {
        const nextDrafts = { ...drafts };
        delete nextDrafts[documentDraftKey(tab)];
        return nextDrafts;
      });
      const remainingTabs = openTabs.filter((item) => item.root !== tab.root || item.path !== tab.path);
      const nextActiveFile = remainingTabs[tabIndex] ?? remainingTabs[tabIndex - 1] ?? null;

      if (nextActiveFile && !(await openFile(nextActiveFile))) return;

      setOpenTabs(remainingTabs);
      if (nextActiveFile) return;

      activeFileRef.current = null;
      editorHandleRef.current = null;
      loadedContent.current = "";
      contentRef.current = "";
      setActiveFile(null);
      setContent("");
      replaceImageUrl(null);
      setOfficeData(null);
      setSaveState("saved");
      setWorkspaceView("document");
    } catch (reason) {
      setError(String(reason));
    }
  }, [flushPendingSave, openFile, openTabs, replaceImageUrl]);

  /** 持久化页签上限；减少上限时先保存当前文档再裁剪多余页签。 */
  const changeOpenTabLimit = useCallback(async (limit: number) => {
    if (!Number.isInteger(limit) || limit < 1) return;

    setPreferenceSaving(true);
    try {
      await updateAppPreference({ key: "openTabLimit", value: limit });
      setOpenTabLimit(limit);
    } catch (reason) {
      setError(`打开页签数量保存失败，请重新提交：${String(reason)}`);
      return;
    } finally {
      setPreferenceSaving(false);
    }
    if (openTabs.length <= limit) return;

    try {
      setError("");
      await flushPendingSave();
      const remainingTabs = openTabs.slice(-limit);
      const currentFile = activeFileRef.current;
      const activeFileRemainsOpen = currentFile && remainingTabs.some((tab) => (
        tab.root === currentFile.root && tab.path === currentFile.path
      ));

      if (!activeFileRemainsOpen) {
        const nextActiveFile = remainingTabs[remainingTabs.length - 1];
        if (nextActiveFile && !(await openFile(nextActiveFile))) return;
      }
      setOpenTabs(remainingTabs);
    } catch (reason) {
      setError(String(reason));
    }
  }, [flushPendingSave, openFile, openTabs]);

  /** 持久化自动保存开关；关闭时取消尚未触发的自动保存定时器。 */
  const changeAutoSave = async (enabled: boolean) => {
    setPreferenceSaving(true);
    try {
      await updateAppPreference({ key: "autoSave", value: enabled });
      setAutoSave(enabled);
      if (!enabled && saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        setSaveState("saved");
      }
    } catch (reason) {
      setError(`自动保存配置失败，请重新提交：${String(reason)}`);
    } finally {
      setPreferenceSaving(false);
    }
  };

  /** 持久化主题色；仅在数据库写入成功后更新当前界面。 */
  const changeThemeColor = async (value: ThemeColor) => {
    setPreferenceSaving(true);
    try {
      await updateAppPreference({ key: "themeColor", value });
      setThemeColor(value);
    } catch (reason) {
      setError(`主题色保存失败，请重新提交：${String(reason)}`);
    } finally {
      setPreferenceSaving(false);
    }
  };

  /** 持久化内容宽度；仅在数据库写入成功后更新当前界面。 */
  const changeContentWidth = async (value: ContentWidth) => {
    setPreferenceSaving(true);
    try {
      await updateAppPreference({ key: "contentWidth", value });
      setContentWidth(value);
    } catch (reason) {
      setError(`内容宽度保存失败，请重新提交：${String(reason)}`);
    } finally {
      setPreferenceSaving(false);
    }
  };

  /** @param view 待显示的快捷访问页。@returns 切换流程 Promise。@sideEffect 保存当前文件后更新工作区视图。 */
  const showQuickAccessView = useCallback(async (view: "recent" | "favorites") => {
    if (!workspace) return;

    try {
      setError("");
      await flushPendingSave();
      setSaveState("saved");
      setWorkspaceView(view);
    } catch (reason) {
      setError(`无法打开${view === "recent" ? "最近编辑" : "我的收藏"}：${String(reason)}`);
    }
  }, [flushPendingSave, workspace]);

  /** 切换当前 Markdown 的收藏状态，并用 SQLite 返回的完整偏好快照更新界面。 */
  const toggleActiveFileFavorite = useCallback(async () => {
    const file = activeFileRef.current;
    if (!file || file.kind !== "markdown" || workspaceId === null || favoriteSaving) return;

    const favorite = !favoriteDocuments.some((document) => document.path === file.path);
    setFavoriteSaving(true);
    try {
      const preferences = await setDocumentFavorite(workspaceId, file.path, favorite);
      setFavoriteDocuments(preferences.favorites);
      setRecentEditedDocuments(preferences.recent);
    } catch (reason) {
      setError(`收藏状态保存失败，请重新提交：${String(reason)}`);
    } finally {
      setFavoriteSaving(false);
    }
  }, [favoriteDocuments, favoriteSaving, workspaceId]);

  /** @param document 最近编辑记录。@returns 打开流程 Promise。@sideEffect 打开失败时移除失效的本地展示项。 */
  const openRecentEditedDocument = useCallback(async (document: RecentEditedDocument) => {
    const opened = await openFile({
      root: document.root,
      path: document.path,
      name: document.name,
      kind: "markdown",
    });

    if (!opened) {
      setRecentEditedDocuments((current) => current.filter((item) => item.path !== document.path));
    }
  }, [openFile]);

  /** @param document 收藏记录。@returns 打开流程 Promise。@sideEffect 打开失败时移除失效的本地展示项。 */
  const openFavoriteDocument = useCallback(async (document: FavoriteDocument) => {
    const opened = await openFile({
      root: document.root,
      path: document.path,
      name: document.name,
      kind: "markdown",
    });

    if (!opened) {
      setFavoriteDocuments((current) => current.filter((item) => item.path !== document.path));
    }
  }, [openFile]);

  /** @param event 触发菜单的鼠标事件。@param node 目标节点。@param isWorkspaceRoot 是否根目录。@returns 无。@sideEffect 阻止默认菜单并记录菜单位置。 */
  const openDirectoryContextMenu = useCallback((
    event: React.MouseEvent,
    node: FileTreeNode,
    isWorkspaceRoot = false,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setCreatingEntry(null);
    setDirectoryContextMenu({
      node,
      isWorkspaceRoot,
      x: Math.min(event.clientX, window.innerWidth - 170),
      y: Math.min(event.clientY, window.innerHeight - (node.isDir && !isWorkspaceRoot ? 196 : 136)),
    });
  }, []);

  /** @param node 待复制绝对路径的节点。@returns 复制流程 Promise。@sideEffect 写入系统剪贴板并显示短暂提示。 */
  const copyAbsolutePath = useCallback(async (node: FileTreeNode) => {
    setDirectoryContextMenu(null);
    try {
      setError("");
      await writeText(node.path);
      setPathCopiedNotice(true);
      if (pathCopiedNoticeTimerRef.current !== null) window.clearTimeout(pathCopiedNoticeTimerRef.current);
      pathCopiedNoticeTimerRef.current = window.setTimeout(() => {
        pathCopiedNoticeTimerRef.current = null;
        setPathCopiedNotice(false);
      }, 1000);
    } catch (reason) {
      setError(`无法复制绝对路径：${String(reason)}`);
    }
  }, []);

  /** @param node 待在系统文件管理器中显示的节点。@returns 打开流程 Promise。@sideEffect 调用 Rust 系统打开命令。 */
  const openInFileManager = useCallback(async (node: FileTreeNode) => {
    if (!workspace) return;

    setDirectoryContextMenu(null);
    try {
      setError("");
      await invoke("open_workspace_entry_in_file_manager", {
        root: workspace.root,
        path: node.path,
      });
    } catch (reason) {
      setError(`无法在文件管理器中打开：${String(reason)}`);
    }
  }, [workspace]);

  /** @param parentPath 新条目的父目录。@param kind 新建文件或目录。@param inputName 用户输入名称。@returns 成功为 `true`。@sideEffect 保存当前文件、创建条目、刷新树并可能打开新文件。 */
  const createWorkspaceEntry = useCallback(async (
    parentPath: string,
    kind: CreateEntryKind,
    inputName: string,
  ) => {
    if (!workspace) return false;
    const name = inputName.trim();
    if (!name) {
      setError("名称不能为空");
      return false;
    }

    let createdPath: string;
    try {
      setError("");
      await flushPendingSave();
      setSaveState("saved");
      createdPath = await invoke<string>(
        kind === "file" ? "create_workspace_markdown_file" : "create_workspace_directory",
        { root: workspace.root, parentPath, name },
      );
    } catch (reason) {
      setError(`无法创建${kind === "file" ? "文件" : "文件夹"}：${String(reason)}`);
      return false;
    }

    setCreatingEntry(null);
    try {
      const tree = await invoke<WorkspaceTree>("list_workspace", { root: workspace.root });
      setWorkspace(tree);
    } catch (reason) {
      setError(`已创建，但无法刷新目录：${String(reason)}`);
    }

    if (kind === "file") {
      await openFile({
        root: workspace.root,
        path: createdPath,
        name: pathFileName(createdPath),
        kind: "markdown",
      });
    }
    return true;
  }, [flushPendingSave, openFile, workspace]);

  /**
   * 重命名文件或目录，并同步内存页签及 SQLite 中受影响的收藏、最近编辑路径。
   *
   * 工作区 ID 缺失时只更新文件系统与内存状态，避免向未知工作区写入偏好。
   */
  const renameTreeNode = useCallback(async (node: FileTreeNode, inputName: string) => {
    if (!workspace) return false;
    const newName = inputName.trim();
    const entryLabel = node.isDir ? "文件夹" : "文件";
    if (!newName) {
      setError(`${entryLabel}名称不能为空`);
      return false;
    }
    if (newName === node.name) {
      setRenamingPath(null);
      return true;
    }

    try {
      setError("");
      await flushPendingSave();
      setSaveState("saved");
      const renamedPath = await invoke<string>(
        node.isDir ? "rename_workspace_directory" : "rename_workspace_file",
        { root: workspace.root, path: node.path, newName },
      );

      const currentFile = activeFileRef.current;
      if (currentFile && node.isDir && isPathInsideDirectory(currentFile.path, node.path)) {
        const updatedFile = {
          ...currentFile,
          path: replaceDirectoryPath(currentFile.path, node.path, renamedPath),
        };
        activeFileRef.current = updatedFile;
        setActiveFile(updatedFile);
      } else if (currentFile?.path === node.path) {
        const updatedFile = {
          ...currentFile,
          path: renamedPath,
          name: pathFileName(renamedPath),
        };
        activeFileRef.current = updatedFile;
        setActiveFile(updatedFile);
      }

      setOpenTabs((current) => current.map((file) => {
        const affected = node.isDir
          ? isPathInsideDirectory(file.path, node.path)
          : file.path === node.path;
        if (!affected) return file;

        const nextPath = node.isDir
          ? replaceDirectoryPath(file.path, node.path, renamedPath)
          : renamedPath;
        return {
          ...file,
          path: nextPath,
          name: pathFileName(nextPath),
        };
      }));

      // 设置表保存的是相对路径，目录重命名必须连同全部后代一次迁移。
      if (workspaceId !== null) {
        const preferences = await remapWorkspaceDocuments(workspaceId, node.path, renamedPath);
        setRecentEditedDocuments(preferences.recent);
        setFavoriteDocuments(preferences.favorites);
      }

      const tree = await invoke<WorkspaceTree>("list_workspace", { root: workspace.root });
      setWorkspace(tree);
      setRenamingPath(null);
      return true;
    } catch (reason) {
      setError(`无法重命名${entryLabel}：${String(reason)}`);
      return false;
    }
  }, [flushPendingSave, workspace, workspaceId]);

  /**
   * 经用户确认后永久删除文件或目录，并清理内存页签和 SQLite 中对应的文档偏好。
   *
   * 删除当前文档前先刷新待保存内容；删除成功后再清理偏好，避免记录指向不存在文件。
   */
  const deleteTreeNode = useCallback(async (node: FileTreeNode) => {
    if (!workspace) return;
    const entryLabel = node.isDir ? "文件夹" : "文件";
    const message = node.isDir
      ? `确定永久删除文件夹“${node.name}”及其中的所有内容吗？此操作不可恢复。`
      : `确定永久删除文件“${node.name}”吗？此操作不可恢复。`;
    setDirectoryContextMenu(null);
    if (!window.confirm(message)) return;

    try {
      setError("");
      const currentFile = activeFileRef.current;
      const deletesCurrentFile = currentFile
        && (currentFile.path === node.path || (node.isDir && isPathInsideDirectory(currentFile.path, node.path)));
      const currentTabIndex = currentFile
        ? openTabs.findIndex((tab) => tab.root === currentFile.root && tab.path === currentFile.path)
        : -1;
      const remainingTabs = openTabs.filter((tab) => (
        node.isDir
          ? !isPathInsideDirectory(tab.path, node.path)
          : tab.path !== node.path
      ));
      const nextActiveFile = deletesCurrentFile
        ? remainingTabs[currentTabIndex] ?? remainingTabs[currentTabIndex - 1] ?? null
        : null;
      if (deletesCurrentFile) await flushPendingSave();

      await invoke(node.isDir ? "delete_workspace_directory" : "delete_workspace_file", {
        root: workspace.root,
        path: node.path,
      });

      // 目录删除要连同后代的收藏和最近编辑记录一并清理。
      if (workspaceId !== null) {
        const preferences = await removeWorkspaceDocuments(workspaceId, node.path);
        setRecentEditedDocuments(preferences.recent);
        setFavoriteDocuments(preferences.favorites);
      }

      if (deletesCurrentFile) {
        activeFileRef.current = null;
        editorHandleRef.current = null;
        loadedContent.current = "";
        contentRef.current = "";
        setActiveFile(null);
        setContent("");
        replaceImageUrl(null);
        setOfficeData(null);
        setSaveState("saved");
        setWorkspaceView("document");
      }
      setOpenTabs(remainingTabs);

      if (nextActiveFile) await openFile(nextActiveFile);

      setCreatingEntry(null);
      setRenamingPath(null);
    } catch (reason) {
      setError(`无法删除${entryLabel}：${String(reason)}`);
      return;
    }

    try {
      const tree = await invoke<WorkspaceTree>("list_workspace", { root: workspace.root });
      setWorkspace(tree);
    } catch (reason) {
      setError(`已删除${entryLabel}，但无法刷新目录：${String(reason)}`);
    }
  }, [flushPendingSave, openFile, openTabs, replaceImageUrl, workspace, workspaceId]);

  /** 保存当前 OSS 表单并重新读取脱敏配置，以清空内存中的密钥输入值。 */
  const saveCurrentOssSyncSettings = async (enabled = ossSyncSettings?.enabled ?? false) => {
    setSyncState("syncing");
    setSyncMessage("正在保存 OSS 配置…");
    try {
      await saveOssSyncSettings({ ...ossSyncForm, enabled });
      const settings = await loadOssSyncSettings();
      if (!settings) throw new Error("保存后未找到 OSS 配置");
      setOssSyncSettings(settings);
      setOssSyncForm({
        region: settings.region,
        endpoint: settings.endpoint,
        bucket: settings.bucket,
        prefix: settings.prefix,
        accessKeyId: settings.accessKeyId,
        accessKeySecret: "",
      });
      setSyncState("idle");
      setSyncMessage("OSS 配置已保存");
      return true;
    } catch (reason) {
      setSyncState("error");
      setSyncMessage(`保存失败：${String(reason)}`);
      return false;
    }
  };

  /** @returns OSS 连通性测试 Promise。@sideEffect 临时上传/删除测试对象，并更新同步状态提示。 */
  const testCurrentOssSyncConnection = async () => {
    if (!await saveCurrentOssSyncSettings()) return;
    setSyncState("syncing");
    setSyncMessage("正在测试 OSS 连接…");
    try {
      await testOssSyncConnection();
      setSyncState("idle");
      setSyncMessage("OSS 连接正常");
    } catch (reason) {
      setSyncState("error");
      setSyncMessage(`连接失败：${String(reason)}`);
    }
  };

  /** @returns 全工作区同步 Promise。@sideEffect 上传树内文件并更新同步状态提示。 */
  const syncCurrentWorkspace = async () => {
    if (!workspace) {
      setSyncState("error");
      setSyncMessage("请先打开一个笔记文件夹");
      return;
    }
    if (!ossSyncSettings?.hasAccessKeySecret && !await saveCurrentOssSyncSettings()) return;

    setSyncState("syncing");
    setSyncMessage("正在准备同步…");
    try {
      await flushPendingSave();
      const tree = await invoke<WorkspaceTree>("list_workspace", { root: workspace.root });
      const fileCount = await syncWorkspace(tree.root, tree.children);
      setSyncState("idle");
      setSyncMessage(`已同步 ${fileCount} 个文件`);
    } catch (reason) {
      setSyncState("error");
      setSyncMessage(`同步失败：${String(reason)}`);
    }
  };

  /** @param enabled 是否启用 OSS 自动同步。@returns 保存流程 Promise。@sideEffect 通过当前表单持久化启用状态。 */
  const changeOssSyncEnabled = async (enabled: boolean) => {
    if (!enabled) {
      await saveCurrentOssSyncSettings(false);
      return;
    }
    if (!workspace) {
      setSyncState("error");
      setSyncMessage("请先打开一个笔记文件夹后再启用同步");
      return;
    }
    if (!await saveCurrentOssSyncSettings(true)) return;
    setSyncState("syncing");
    setSyncMessage("正在同步现有文件…");
    try {
      await flushPendingSave();
      const tree = await invoke<WorkspaceTree>("list_workspace", { root: workspace.root });
      const fileCount = await syncWorkspace(tree.root, tree.children);
      setSyncState("idle");
      setSyncMessage(`同步完成，已同步 ${fileCount} 个文件`);
    } catch (reason) {
      setSyncState("error");
      setSyncMessage(`同步失败：${String(reason)}`);
    }
  };

  const previewContent = useDeferredValue(content);
  const documentHeadings = useMemo(() => extractDocumentHeadings(previewContent), [previewContent]);
  const documentStatistics = useMemo(() => getDocumentStatistics(content), [content]);

  /** @param index 大纲标题在预览 DOM 中的索引。@returns 无。@sideEffect 将预览滚动到对应标题。 */
  const scrollToHeading = useCallback((index: number) => {
    const selector = "h1, h2, h3, h4, h5, h6";
    /** @param pane 待滚动的预览容器，`null` 时不操作。@returns 无。@sideEffect 平滑滚动指定标题到容器顶部。 */
    const scrollInPane = (pane: HTMLElement | null) => {
      pane?.querySelectorAll<HTMLElement>(selector)[index]?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    };

    // 编辑器滚动容器上禁用了标题的 scroll-margin-top（会放大原生选区滚动导致编辑时页面上滑），
    // 因此编辑器侧手动计算目标位置以避开置顶工具栏。
    if (viewMode !== "preview") {
      const pane = editorPaneRef.current;
      const heading = pane?.querySelectorAll<HTMLElement>(selector)[index];
      const scroller = pane?.querySelector<HTMLElement>(".wysiwyg-editor");
      if (heading && scroller) {
        const target = heading.getBoundingClientRect().top
          - scroller.getBoundingClientRect().top
          + scroller.scrollTop
          - 48;
        scroller.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
      }
    }
    if (viewMode !== "editor") scrollInPane(previewPaneRef.current);
  }, [viewMode]);

  /** @param mode 待切换的编辑或预览模式。@returns 无。@sideEffect 必要时保存当前文档并更新视图模式。 */
  const changeViewMode = (mode: ViewMode) => {
    if (mode === "preview") syncEditorContent();
    setViewMode(mode);
  };

  /** @returns 进入只读全屏的 Promise。@sideEffect 保存当前文件并将文档设为全屏展示。 */
  const enterDocumentFullscreen = async () => {
    try {
      setError("");
      await flushPendingSave();
      setSaveState("saved");
      setDocumentFullscreen(true);
    } catch (reason) {
      setSaveState("error");
      setError(String(reason));
    }
  };

  const editorShortcutLabels = useMemo(() => ({
    bold: displayShortcut(shortcutBindings.bold),
    italic: displayShortcut(shortcutBindings.italic),
    inlineCode: displayShortcut(shortcutBindings.inlineCode),
    codeBlock: displayShortcut(shortcutBindings.codeBlock),
    link: displayShortcut(shortcutBindings.link),
    image: displayShortcut(shortcutBindings.image),
  }) satisfies Record<EditorShortcutCommand, string>, [shortcutBindings]);

  /** 校验并保存一项快捷键覆盖；持久化失败时保留现有绑定，避免界面与数据库不一致。 */
  /** @param id 待更新的快捷键动作。@param chord 候选标准组合键。@returns 保存流程 Promise。@sideEffect 校验并持久化成功绑定，或更新错误状态。 */
  const updateShortcutBinding = useCallback(async (id: ShortcutId, chord: string) => {
    const result = setShortcutBinding(shortcutBindings, id, chord);
    if (result.error) {
      setShortcutError(result.error);
      return;
    }
    setShortcutSaving(true);
    try {
      await saveShortcutOverrides(shortcutOverrides(result.bindings));
      setShortcutBindings(result.bindings);
      setShortcutError("");
      setShortcutRecording(null);
    } catch (reason) {
      setShortcutError(`快捷键保存失败，请重新提交：${String(reason)}`);
    } finally {
      setShortcutSaving(false);
    }
  }, [shortcutBindings]);

  /** @param event 快捷键录制按钮的键盘事件。@param id 正在录制的动作 ID。@returns 无。@sideEffect 阻止默认行为，并可能保存绑定或更新错误状态。 */
  const handleShortcutRecording = (event: ReactKeyboardEvent<HTMLButtonElement>, id: ShortcutId) => {
    if (shortcutRecording !== id) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setShortcutRecording(null);
      setShortcutError("");
      return;
    }
    const chord = chordFromKeyboardEvent(event.nativeEvent);
    if (!chord) {
      setShortcutError("请按下包含 Ctrl/⌘ 或 Alt 的组合键，或单独按 F1–F12。");
      return;
    }
    void updateShortcutBinding(id, chord);
  };

  useEffect(() => {
    const editorDefaultChords = SHORTCUT_DEFINITIONS
      .filter((definition) => definition.scope === "editor")
      .map((definition) => definition.defaultChord);

    /** @param event 应用级键盘事件。@returns 无。@sideEffect 根据快捷键触发操作并阻止编辑器默认组合键冲突。 */
    const handleKeyDown = (event: KeyboardEvent) => {
      if (settingsOpen || updateOpen || installingUpdateRef.current) return;
      const chord = chordFromKeyboardEvent(event);
      if (!chord) return;
      const target = event.target instanceof Element ? event.target : null;
      const inEditor = Boolean(target?.closest(".wysiwyg-editor"));
      const definition = SHORTCUT_DEFINITIONS.find((item) => shortcutBindings[item.id] === chord);

      if (!definition) {
        if (inEditor && editorDefaultChords.includes(chord)) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (definition.scope === "editor" && !inEditor) return;

      event.preventDefault();
      event.stopPropagation();
      if (definition.scope === "editor") {
        editorHandleRef.current?.runShortcut(definition.id as EditorShortcutId);
        return;
      }

      if (definition.id === "save") void saveCurrentFile();
      if (definition.id === "favorite") toggleActiveFileFavorite();
      if (definition.id === "toggleSidebar") setSidebarOpen((value) => !value);
      if (definition.id === "toggleOutline" && activeFileRef.current?.kind === "markdown") {
        setOutlineOpen((value) => !value);
      }
      if (definition.id === "toggleView" && activeFileRef.current?.kind === "markdown" && !documentFullscreen) {
        changeViewMode(viewMode === "editor" ? "preview" : "editor");
      }
      if (definition.id === "toggleFullscreen" && activeFileRef.current?.kind === "markdown") {
        if (documentFullscreen) setDocumentFullscreen(false);
        else void enterDocumentFullscreen();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [changeViewMode, documentFullscreen, enterDocumentFullscreen, saveCurrentFile, settingsOpen, shortcutBindings, toggleActiveFileFavorite, updateOpen, viewMode]);

  /** @param width 候选侧栏宽度，单位 CSS 像素。@returns 限制在工作区可用范围内的宽度。 */
  const clampSidebarWidth = useCallback((width: number) => {
    const availableWidth = Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - MIN_WORKSPACE_WIDTH);
    return Math.min(Math.max(width, MIN_SIDEBAR_WIDTH), Math.max(MIN_SIDEBAR_WIDTH, availableWidth));
  }, []);

  /** @returns 无。@sideEffect 结束侧栏拖拽并清除全局鼠标状态。 */
  const stopSidebarResize = useCallback(() => {
    sidebarResizingRef.current = false;
    setSidebarResizing(false);
  }, []);

  /** @param event 侧栏分隔条指针按下事件。@returns 无。@sideEffect 捕获指针并开启调整状态。 */
  const handleSidebarResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    sidebarResizingRef.current = true;
    setSidebarResizing(true);
  };

  /** @param event 侧栏分隔条指针移动事件。@returns 无。@sideEffect 拖拽中按指针坐标更新侧栏宽度。 */
  const handleSidebarResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!sidebarResizingRef.current) return;
    setSidebarWidth(clampSidebarWidth(event.clientX));
  };

  /** @param event 侧栏分隔条指针结束事件。@returns 无。@sideEffect 释放指针并停止拖拽。 */
  const handleSidebarResizeEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    stopSidebarResize();
  };

  /** @param event 分隔条键盘事件。@returns 无。@sideEffect 方向键以 10px 步长调整宽度。 */
  const handleSidebarResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -10 : 10;
    setSidebarWidth((width) => clampSidebarWidth(width + direction));
  };

  /** @param event 标题栏鼠标按下事件。@returns 无。@sideEffect 主键按下时请求 Tauri 开始拖动窗口。 */
  const handleTitlebarMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.buttons !== 1) return;
    void getCurrentWindow().startDragging();
  };

  /** 关闭桌面窗口前确认不存在未完成的 SQLite 写入，避免进程退出截断配置保存。 */
  const closeWindow = useCallback(async () => {
    if (hasPendingSettingsWrite()) {
      setError("配置正在保存，请稍候再关闭应用。");
      return;
    }
    try {
      await getCurrentWindow().destroy();
    } catch (reason) {
      setError(`无法关闭窗口：${String(reason)}`);
    }
  }, []);

  /** @param event 页签列表滚轮事件。@returns 无。@sideEffect 有横向溢出时将滚轮转换为受限的横向滚动。 */
  const handleTabListWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const tabList = event.currentTarget;
    if (tabList.scrollWidth <= tabList.clientWidth) return;

    const delta = event.shiftKey ? event.deltaX || event.deltaY : event.deltaY;
    if (!delta) return;

    const maxScrollLeft = tabList.scrollWidth - tabList.clientWidth;
    const nextScrollLeft = Math.min(maxScrollLeft, Math.max(0, tabList.scrollLeft + delta));
    if (nextScrollLeft === tabList.scrollLeft) return;

    tabList.scrollLeft = nextScrollLeft;
    event.preventDefault();
  }, []);

  const documentViewActivePath = workspaceView === "document" ? activeFile?.path ?? null : null;
  const normalizedDocumentSearchQuery = documentSearchQuery.trim().toLocaleLowerCase();
  const documentSearchResults = useMemo(
    () => workspace && normalizedDocumentSearchQuery
      ? collectMatchingMarkdownDocuments(workspace.children, normalizedDocumentSearchQuery)
      : [],
    [normalizedDocumentSearchQuery, workspace],
  );
  const activeFileFavorited = activeFile?.kind === "markdown"
    && favoriteDocuments.some((document) => document.path === activeFile.path);
  const sidebarToggleTitle = shortcutTitle(sidebarOpen ? "收起目录" : "展开目录", shortcutBindings.toggleSidebar);
  const outlineToggleTitle = shortcutTitle(outlineOpen ? "隐藏右侧目录" : "显示右侧目录", shortcutBindings.toggleOutline);
  const fullscreenTitle = shortcutTitle(documentFullscreen ? "退出只读全屏" : "只读全屏", shortcutBindings.toggleFullscreen);
  const titlebarDocumentActions = workspaceView === "document" && activeFile?.kind === "markdown" && (
    <div className="titlebar-document-actions">
      <button
        className={`icon-button favorite-toggle ${activeFileFavorited ? "active" : ""}`}
        onClick={toggleActiveFileFavorite}
        disabled={favoriteSaving}
        title={shortcutTitle(activeFileFavorited ? "取消收藏" : "收藏文档", shortcutBindings.favorite)}
        aria-label={shortcutTitle(activeFileFavorited ? "取消收藏" : "收藏文档", shortcutBindings.favorite)}
        aria-pressed={activeFileFavorited}
      >
        <Star size={17} fill={activeFileFavorited ? "currentColor" : "none"} />
      </button>
      <div className="view-switcher" aria-label="视图模式">
        <button className={viewMode === "editor" ? "active" : ""} onClick={() => changeViewMode("editor")} title={shortcutTitle("切换到编辑", shortcutBindings.toggleView)} aria-label={shortcutTitle("切换到编辑", shortcutBindings.toggleView)}>
          <Pencil size={15} />
        </button>
        <button className={viewMode === "preview" ? "active" : ""} onClick={() => changeViewMode("preview")} title={shortcutTitle("切换到预览", shortcutBindings.toggleView)} aria-label={shortcutTitle("切换到预览", shortcutBindings.toggleView)}>
          <Eye size={16} />
        </button>
      </div>
      <button
        className="icon-button document-fullscreen-toggle"
        onClick={() => void enterDocumentFullscreen()}
        title={`${fullscreenTitle}；Esc 退出`}
        aria-label={`${fullscreenTitle}；Esc 退出`}
      >
        <Scan size={19} />
      </button>
      <button
        className={`icon-button outline-toggle ${outlineOpen ? "" : "collapsed"}`}
        onClick={() => setOutlineOpen((value) => !value)}
        title={outlineToggleTitle}
        aria-label={outlineToggleTitle}
        aria-pressed={!outlineOpen}
      >
        <PanelRightClose size={18} />
      </button>
    </div>
  );

  return (
    <main
      className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"} ${sidebarResizing ? "sidebar-resizing" : ""} ${documentFullscreen ? "document-fullscreen" : ""} ${HAS_OVERLAY_TITLEBAR ? `overlay-window ${IS_WINDOWS ? "windows-window" : ""}` : ""}`}
      data-theme={themeColor}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      {IS_MACOS && (
        <>
          <div className="window-titlebar-drag-region" onMouseDown={handleTitlebarMouseDown} />
          <div className="window-titlebar-actions">
            {titlebarDocumentActions}
            <AppUpdater currentVersion={appVersion} prepareInstall={prepareUpdateInstall}
              finishInstall={() => { installingUpdateRef.current = false; }} onOpenChange={setUpdateOpen} />
            <button
              className="settings-button"
              onClick={() => setSettingsOpen(true)}
              title="设置"
              aria-label="打开设置"
            >
              <Settings size={15} />
            </button>
          </div>
        </>
      )}

      {IS_WINDOWS && (
        <div className="windows-titlebar">
          <div
            className="windows-titlebar-drag-region"
            onMouseDown={handleTitlebarMouseDown}
            onDoubleClick={() => {
              void getCurrentWindow().toggleMaximize();
              setWindowMaximized((value) => !value);
            }}
          />
          <div className="windows-titlebar-brand">
            <img src="/superwiki-logo.png" alt="" />
            <span>SuperWiki</span>
            <button
              className="windows-titlebar-sidebar-toggle"
              onClick={() => setSidebarOpen((value) => !value)}
              title={sidebarToggleTitle}
              aria-label={sidebarToggleTitle}
            >
              {sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
            </button>
            <button
              className="windows-titlebar-save"
              onClick={() => void saveCurrentFile()}
              title={shortcutTitle("保存当前文档", shortcutBindings.save)}
              aria-label={shortcutTitle("保存当前文档", shortcutBindings.save)}
              disabled={workspaceView !== "document" || activeFile?.kind !== "markdown"}
            >
              <Save size={15} />
            </button>
          </div>
          <div className="windows-titlebar-actions">
            {titlebarDocumentActions}
            <AppUpdater currentVersion={appVersion} prepareInstall={prepareUpdateInstall}
              finishInstall={() => { installingUpdateRef.current = false; }} onOpenChange={setUpdateOpen} />
            <button
              className="windows-titlebar-settings"
              onClick={() => setSettingsOpen(true)}
              title="设置"
              aria-label="打开设置"
            >
              <Settings size={15} />
            </button>
            <button
              className="windows-titlebar-control"
              onClick={() => void getCurrentWindow().minimize()}
              title="最小化"
              aria-label="最小化窗口"
            >
              <Minus size={16} />
            </button>
            <button
              className="windows-titlebar-control"
              onClick={() => {
                void getCurrentWindow().toggleMaximize();
                setWindowMaximized((value) => !value);
              }}
              title={windowMaximized ? "还原" : "最大化"}
              aria-label={windowMaximized ? "还原窗口" : "最大化窗口"}
            >
              {windowMaximized ? <Copy size={14} /> : <Square size={14} />}
            </button>
            <button
              className="windows-titlebar-control windows-titlebar-close"
              onClick={() => void closeWindow()}
              title="关闭"
              aria-label="关闭窗口"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="library-identity">
            <span className="brand-mark"><img src="/superwiki-logo.png" alt="" /></span>
            <span className="library-name">
              SuperWiki
              <small>{workspace ? "本地工作区" : "尚未选择文件夹"}</small>
            </span>
          </div>
          {!IS_WINDOWS && (
            <button className="icon-button sidebar-head-toggle" onClick={() => setSidebarOpen((value) => !value)} title={sidebarToggleTitle} aria-label={sidebarToggleTitle}>
              <PanelLeftClose size={17} />
            </button>
          )}
        </div>

        <div className="document-search-wrap">
          <Search size={15} aria-hidden="true" />
          <input
            className="document-search"
            type="search"
            value={documentSearchQuery}
            placeholder="搜索文档名称"
            aria-label="搜索 Markdown 文档名称"
            disabled={!workspace}
            onChange={(event) => setDocumentSearchQuery(event.target.value)}
          />
          {documentSearchQuery && (
            <button
              className="document-search-clear"
              type="button"
              title="清空搜索"
              aria-label="清空搜索"
              onClick={() => setDocumentSearchQuery("")}
            >
              <X size={13} />
            </button>
          )}
        </div>

        <button className="open-folder primary" onClick={() => void selectWorkspace()}>
          <FolderOpen size={16} /> {workspace ? "更换文件夹" : "打开文件夹"}
        </button>

        <div className="sidebar-content folder-only">
          {workspace && (
            <div className="quick-access-section">
              <div className="section-heading">快捷访问</div>
              <button
                className={`tree-row quick-access-row ${workspaceView === "recent" ? "active" : ""}`}
                onClick={() => void showQuickAccessView("recent")}
                aria-current={workspaceView === "recent" ? "page" : undefined}
              >
                <Clock3 size={15} />
                <span>最近编辑</span>
                {recentEditedDocuments.length > 0 && <span className="tree-count">{recentEditedDocuments.length}</span>}
              </button>
              <button
                className={`tree-row quick-access-row ${workspaceView === "favorites" ? "active" : ""}`}
                onClick={() => void showQuickAccessView("favorites")}
                aria-current={workspaceView === "favorites" ? "page" : undefined}
              >
                <Star size={15} />
                <span>我的收藏</span>
                {favoriteDocuments.length > 0 && <span className="tree-count">{favoriteDocuments.length}</span>}
              </button>
            </div>
          )}

          <div className="section-heading">
            <span>本地目录</span>
            {workspace && (
              <span className="section-actions">
                <button onClick={() => void loadWorkspace(workspace.root)} title="刷新目录"><RefreshCw size={13} /></button>
                <button onClick={() => void closeWorkspace()} title="关闭目录"><X size={14} /></button>
              </span>
            )}
          </div>

          {workspaceLoading && <div className="folder-placeholder">正在读取目录…</div>}
          {!workspaceLoading && !workspace && (
            <button className="folder-placeholder folder-empty" onClick={() => void selectWorkspace()}>
              <FolderOpen size={18} />
              <span><strong>尚未打开文件夹</strong><small>点击选择本地文件夹</small></span>
            </button>
          )}
          {!workspaceLoading && workspace && normalizedDocumentSearchQuery && (
            <div className="file-tree document-search-results" role="tree" aria-label="文档搜索结果">
              <div className="document-search-summary">找到 {documentSearchResults.length} 个文档</div>
              {documentSearchResults.map((node) => (
                <button
                  key={node.path}
                  role="treeitem"
                  className={`tree-row file search-result ${documentViewActivePath === node.path ? "active" : ""}`}
                  title={node.path}
                  onClick={() => openTreeFile(node)}
                >
                  <FileCode2 size={14} />
                  <span className="tree-name">{node.name}</span>
                </button>
              ))}
              {documentSearchResults.length === 0 && (
                <div className="empty-directory document-search-empty">没有匹配的 Markdown 文档</div>
              )}
            </div>
          )}
          {!workspaceLoading && workspace && !normalizedDocumentSearchQuery && (
            <div className="file-tree" role="tree" aria-label={`${workspace.name} 文件目录`}>
              <div
                className="workspace-root"
                onContextMenu={(event) => openDirectoryContextMenu(event, {
                  name: workspace.name,
                  path: workspace.root,
                  isDir: true,
                  isMarkdown: false,
                  isImage: false,
                  isOffice: false,
                  children: workspace.children,
                }, true)}
              >
                <FolderOpen size={15} />
                <strong>{workspace.name}</strong>
              </div>
              {creatingEntry?.parentPath === workspace.root && (
                <CreateEntryInput
                  depth={0}
                  kind={creatingEntry.kind}
                  onCreate={(name) => createWorkspaceEntry(workspace.root, creatingEntry.kind, name)}
                  onCancel={() => setCreatingEntry(null)}
                />
              )}
              {workspace.children.map((node) => (
                <MemoizedTreeNode
                  key={node.path}
                  node={node}
                  depth={0}
                  activePath={documentViewActivePath}
                  renamingPath={renamingPath}
                  creatingEntry={creatingEntry}
                  onOpen={openTreeFile}
                  onContextMenu={openDirectoryContextMenu}
                  onRename={renameTreeNode}
                  onCreateEntry={createWorkspaceEntry}
                  onCancelRename={() => setRenamingPath(null)}
                  onCancelCreate={() => setCreatingEntry(null)}
                />
              ))}
              {workspace.children.length === 0 && creatingEntry?.parentPath !== workspace.root && (
                <div className="empty-directory">文件夹为空</div>
              )}
            </div>
          )}
        </div>

        {directoryContextMenu && (
          <div
            className="directory-context-menu"
            style={{ left: directoryContextMenu.x, top: directoryContextMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            {directoryContextMenu.node.isDir && (
              <>
                <button
                  onClick={() => {
                    setCreatingEntry({ parentPath: directoryContextMenu.node.path, kind: "file" });
                    setRenamingPath(null);
                    setDirectoryContextMenu(null);
                  }}
                >
                  <FileCode2 size={13} />新建文档
                </button>
                <button
                  onClick={() => {
                    setCreatingEntry({ parentPath: directoryContextMenu.node.path, kind: "directory" });
                    setRenamingPath(null);
                    setDirectoryContextMenu(null);
                  }}
                >
                  <Folder size={13} />新建文件夹
                </button>
              </>
            )}
            <button onClick={() => void openInFileManager(directoryContextMenu.node)}>
              <FolderOpen size={13} />{OPEN_IN_FILE_MANAGER_LABEL}
            </button>
            <button onClick={() => void copyAbsolutePath(directoryContextMenu.node)}>
              <Copy size={13} />复制绝对路径
            </button>
            {!directoryContextMenu.isWorkspaceRoot && (
              <>
                <button
                  onClick={() => {
                    setRenamingPath(directoryContextMenu.node.path);
                    setDirectoryContextMenu(null);
                  }}
                >
                  <Pencil size={13} />重命名
                </button>
                <button className="danger" onClick={() => void deleteTreeNode(directoryContextMenu.node)}>
                  <Trash2 size={13} />删除
                </button>
              </>
            )}
          </div>
        )}

        {pathCopiedNotice && <div className="path-copied-notice" role="status">已复制到剪切板</div>}

        {!HAS_OVERLAY_TITLEBAR && (
          <div className="sidebar-footer">
            <button
              className="settings-button"
              onClick={() => setSettingsOpen(true)}
              title="设置"
              aria-label="打开设置"
            >
              <Settings size={15} />
            </button>
          </div>
        )}
      </aside>

      {!sidebarOpen && (
        <button
          className="sidebar-reopen-button icon-button"
          onClick={() => setSidebarOpen(true)}
          title={sidebarToggleTitle}
          aria-label={sidebarToggleTitle}
        >
          <PanelLeftOpen size={18} />
        </button>
      )}

      {sidebarOpen && (
        <div
          className="sidebar-resizer"
          role="separator"
          aria-label="调整目录栏宽度"
          aria-orientation="vertical"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onPointerDown={handleSidebarResizeStart}
          onPointerMove={handleSidebarResizeMove}
          onPointerUp={handleSidebarResizeEnd}
          onPointerCancel={handleSidebarResizeEnd}
          onLostPointerCapture={stopSidebarResize}
          onKeyDown={handleSidebarResizeKeyDown}
        />
      )}

      <section className="workspace">
        {openTabs.length > 0 && (
          <nav className="tab-bar" aria-label="已打开文件">
            <div className="tab-list" role="tablist" onWheel={handleTabListWheel}>
              {openTabs.map((tab) => {
                const isActive = workspaceView === "document"
                  && activeFile?.root === tab.root
                  && activeFile.path === tab.path;
                const hasUnsavedChanges = tab.kind === "markdown" && documentDraftKey(tab) in documentDrafts;
                const tabPath = workspaceRelativePath(tab.root, tab.path, tab.name);
                return (
                  <div key={`${tab.root}:${tab.path}`} className={`file-tab ${isActive ? "active" : ""}`}>
                    <button
                      className="file-tab-select"
                      type="button"
                      ref={isActive ? activeTabRef : null}
                      role="tab"
                      aria-selected={isActive}
                      title={tabPath}
                      onClick={() => void openFile(tab)}
                    >
                      {tab.kind === "markdown"
                        ? <FileCode2 size={14} />
                        : tab.kind === "image"
                          ? <ImageIcon size={14} />
                          : <File size={14} />}
                      <span>{tab.name}</span>
                      {hasUnsavedChanges && <span className="file-tab-unsaved" aria-label="有未保存的修改" />}
                    </button>
                    <button
                      className="file-tab-close"
                      type="button"
                      title={`关闭 ${tab.name}`}
                      aria-label={`关闭 ${tab.name}`}
                      onClick={() => void closeTab(tab)}
                    >
                      <X size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          </nav>
        )}

        {error && <div className="error-banner">{error}</div>}

        {!workspace && !workspaceLoading && (
          <EmptyState
            icon={<img className="welcome-logo" src="/superwiki-logo.png" alt="SuperWiki" />}
            title="打开一个文件夹开始使用"
            description="选择包含 Markdown、图片、DOCX、XLSX 或 PPTX 文件的本地文件夹，目录会显示在左侧。"
            action="打开文件夹"
            onAction={() => void selectWorkspace()}
          />
        )}

        {workspaceLoading && (
          <EmptyState icon={<Folder size={32} />} title="正在读取文件夹" description="请稍候…" />
        )}

        {workspace && workspaceView === "document" && !activeFile && !workspaceLoading && (
          <EmptyState
            icon={<FileCode2 size={32} />}
            title="选择一个 Markdown 或图片文件"
            description="从左侧目录中选择 Markdown 文件进行编辑，或选择图片、DOCX、XLSX、PPTX 进行只读预览。"
          />
        )}

        {workspaceView === "recent" && workspace && !workspaceLoading && (
          <section className="recent-edited-view" aria-label="最近编辑">
            <div className="recent-edited-header">
              <div>
                <h2>最近编辑</h2>
                <p>最近成功编辑过的 Markdown 文档</p>
              </div>
              <span className="recent-edited-count">{recentEditedDocuments.length} 个文档</span>
            </div>
            {recentEditedDocuments.length > 0 ? (
              <div className="recent-edited-list">
                {recentEditedDocuments.map((document) => (
                  <button
                    key={`${document.root}:${document.path}`}
                    className="recent-edited-item"
                    onClick={() => void openRecentEditedDocument(document)}
                  >
                    <FileCode2 size={18} />
                    <span className="recent-edited-item-main">
                      <strong>{document.name}</strong>
                      <small>{document.relativePath}</small>
                    </span>
                    <time dateTime={new Date(document.editedAt).toISOString()}>
                      {formatRecentEditedTime(document.editedAt)}
                    </time>
                  </button>
                ))}
              </div>
            ) : (
              <div className="recent-edited-empty">
                <Clock3 size={28} />
                <strong>暂无最近编辑</strong>
                <p>修改并成功保存 Markdown 文档后，它会显示在这里。</p>
              </div>
            )}
          </section>
        )}

        {workspaceView === "favorites" && workspace && !workspaceLoading && (
          <section className="recent-edited-view" aria-label="我的收藏">
            <div className="recent-edited-header">
              <div>
                <h2>我的收藏</h2>
                <p>收藏的 Markdown 文档</p>
              </div>
              <span className="recent-edited-count">{favoriteDocuments.length} 个文档</span>
            </div>
            {favoriteDocuments.length > 0 ? (
              <div className="recent-edited-list">
                {favoriteDocuments.map((document) => (
                  <button
                    key={`${document.root}:${document.path}`}
                    className="recent-edited-item"
                    onClick={() => void openFavoriteDocument(document)}
                  >
                    <Star size={18} fill="currentColor" />
                    <span className="recent-edited-item-main">
                      <strong>{document.name}</strong>
                      <small>{document.relativePath}</small>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="recent-edited-empty">
                <Star size={28} />
                <strong>暂无收藏</strong>
                <p>打开 Markdown 文档后，点击顶部星标即可收藏。</p>
              </div>
            )}
          </section>
        )}

        {workspaceView === "document" && activeFile?.kind === "markdown" && (
          <div className={`editor-layout mode-${documentFullscreen ? "preview" : viewMode} content-width-${contentWidth} ${outlineOpen ? "" : "outline-hidden"}`}>
            {!documentFullscreen && viewMode !== "preview" && (
              <section ref={editorPaneRef} className="editor-pane" aria-label="Markdown 所见即所得编辑器">
                <Suspense fallback={<div className="editor-loading">正在加载所见即所得编辑器…</div>}>
                  <WysiwygEditor
                    key={`${activeFile.path}:${editorVersion}`}
                    documentId={`${activeFile.path}:${editorVersion}`}
                    workspaceRoot={activeFile.root}
                    documentPath={activeFile.path}
                    initialValue={content}
                    onChange={handleEditorChange}
                    onReady={handleEditorReady}
                    onCursorPositionChange={handleCursorPositionChange}
                    onAssetUploaded={handleAssetUploaded}
                    shortcutLabels={editorShortcutLabels}
                  />
                </Suspense>
              </section>
            )}

            {(documentFullscreen || viewMode !== "editor") && (
              <section ref={previewPaneRef} className="preview-pane" aria-label={documentFullscreen ? "Markdown 只读全屏" : "Markdown 预览"}>
                {!documentFullscreen && <div className="pane-label">预览</div>}
                <article className="markdown-body">
                  <MarkdownPreview
                    content={documentFullscreen ? content : previewContent}
                    workspaceRoot={activeFile.root}
                    documentPath={activeFile.path}
                  />
                </article>
              </section>
            )}

            {!documentFullscreen && outlineOpen && (
              <DocumentOutline headings={documentHeadings} onSelect={scrollToHeading} />
            )}
          </div>
        )}

        {workspaceView === "document" && activeFile?.kind === "markdown" && (
          <footer className="document-status-bar" aria-label="文档状态">
            <div className="document-status-summary">
              <span>行 {cursorPosition.line}，列 {cursorPosition.column}</span>
              <span>{documentStatistics.lineCount} 行</span>
              <span>字数 {documentStatistics.wordCount}</span>
              <span>{documentStatistics.characterCount} 字符</span>
            </div>
            <div className="document-status-format">
              <span>UTF-8</span>
              <span>Markdown</span>
            </div>
          </footer>
        )}

        {workspaceView === "document" && activeFile?.kind === "image" && imageUrl && (
          <section className="image-preview" aria-label="图片预览">
            <div className="image-preview-canvas">
              <img src={imageUrl} alt={activeFile.name} />
            </div>
          </section>
        )}

        {workspaceView === "document" && activeFile?.kind === "office" && officeData && (
          <Suspense fallback={<div className="editor-loading">正在加载 Office 预览器…</div>}>
            <OfficePreview data={officeData} name={activeFile.name} />
          </Suspense>
        )}
      </section>

      {settingsOpen && (
        <div className="settings-backdrop" onMouseDown={() => setSettingsOpen(false)}>
          <section
            className="settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="settings-header">
              <h2 id="settings-title">设置</h2>
              <button onClick={() => setSettingsOpen(false)} title="关闭设置" aria-label="关闭设置">
                <X size={18} />
              </button>
            </header>
            <div className="settings-layout">
              <nav className="settings-nav" aria-label="设置分类">
                <button
                  className={settingsSection === "basic" ? "active" : ""}
                  aria-current={settingsSection === "basic" ? "page" : undefined}
                  onClick={() => setSettingsSection("basic")}
                >
                  <FileCode2 size={16} />基础
                </button>
                <button
                  className={settingsSection === "appearance" ? "active" : ""}
                  aria-current={settingsSection === "appearance" ? "page" : undefined}
                  onClick={() => setSettingsSection("appearance")}
                >
                  <Settings size={16} />外观
                </button>
                <button
                  className={settingsSection === "shortcuts" ? "active" : ""}
                  aria-current={settingsSection === "shortcuts" ? "page" : undefined}
                  onClick={() => setSettingsSection("shortcuts")}
                >
                  <Keyboard size={16} />快捷键
                </button>
                <button
                  className={settingsSection === "sync" ? "active" : ""}
                  aria-current={settingsSection === "sync" ? "page" : undefined}
                  onClick={() => setSettingsSection("sync")}
                >
                  <RefreshCw size={16} />同步
                </button>
                <button
                  className={settingsSection === "about" ? "active" : ""}
                  aria-current={settingsSection === "about" ? "page" : undefined}
                  onClick={() => setSettingsSection("about")}
                >
                  <Info size={16} />关于
                </button>
              </nav>
              <div className="settings-content">
                {settingsSection === "basic" ? (
                  <>
                    <div className="settings-section-heading">
                      <h3>基础</h3>
                      <p>配置编辑器的基础使用方式。</p>
                    </div>
                    <section className="editor-settings" aria-labelledby="editor-settings-title">
                      <div className="editor-settings-heading">
                        <h4 id="editor-settings-title">编辑器</h4>
                      </div>
                      <label className="editor-setting-row">
                        <span>
                          <strong>打开的 Tab 数量</strong>
                          <small>超过此数量时，自动关闭最早打开的 Tab。</small>
                        </span>
                        <input
                          type="number"
                          min="1"
                          step="1"
                          value={openTabLimit}
                          aria-label="打开的 Tab 数量"
                          disabled={preferenceSaving}
                          onChange={(event) => void changeOpenTabLimit(event.currentTarget.valueAsNumber)}
                        />
                      </label>
                      <label className="editor-setting-row">
                        <span>
                          <strong>自动保存</strong>
                          <small>关闭后仅在点击顶部保存按钮时写入当前文档。</small>
                        </span>
                        <input
                          type="checkbox"
                          checked={autoSave}
                          aria-label="自动保存"
                          disabled={preferenceSaving}
                          onChange={(event) => void changeAutoSave(event.target.checked)}
                        />
                      </label>
                    </section>
                  </>
                ) : settingsSection === "appearance" ? (
                  <>
                    <div className="settings-section-heading">
                      <h3>外观</h3>
                      <p>选择应用的主色调与内容宽度，修改后会立即生效。</p>
                    </div>
                    <div className="theme-color-grid" role="group" aria-label="主色调">
                      {THEME_COLORS.map((theme) => (
                        <button
                          key={theme.id}
                          className={`theme-color-option ${themeColor === theme.id ? "active" : ""}`}
                          aria-pressed={themeColor === theme.id}
                          disabled={preferenceSaving}
                          onClick={() => void changeThemeColor(theme.id)}
                        >
                          <span className="theme-color-swatch" style={{ backgroundColor: theme.color }} />
                          <span>{theme.name}</span>
                          {themeColor === theme.id && <span className="theme-selected-mark">✓</span>}
                        </button>
                      ))}
                    </div>
                    <section className="content-width-settings" aria-labelledby="content-width-title">
                      <div className="editor-settings-heading">
                        <h4 id="content-width-title">内容宽度</h4>
                      </div>
                      <div className="content-width-options" role="group" aria-label="内容宽度">
                        <button
                          className={contentWidth === "default" ? "active" : ""}
                          aria-pressed={contentWidth === "default"}
                          disabled={preferenceSaving}
                          onClick={() => void changeContentWidth("default")}
                        >
                          <strong>默认</strong>
                          <small>限制正文宽度，便于长文阅读</small>
                        </button>
                        <button
                          className={contentWidth === "full" ? "active" : ""}
                          aria-pressed={contentWidth === "full"}
                          disabled={preferenceSaving}
                          onClick={() => void changeContentWidth("full")}
                        >
                          <strong>全宽</strong>
                          <small>占满正文面板，保留左右留白</small>
                        </button>
                      </div>
                    </section>
                  </>
                ) : settingsSection === "shortcuts" ? (
                  <>
                    <div className="settings-section-heading shortcut-settings-heading">
                      <div>
                        <h3>快捷键</h3>
                        <p>点击键位后直接按下新的组合键。重复和系统保留键无法保存。</p>
                      </div>
                      <button
                        className="shortcut-reset-all"
                        type="button"
                        disabled={shortcutSaving}
                        onClick={() => void (async () => {
                          setShortcutSaving(true);
                          try {
                            await saveShortcutOverrides({});
                            setShortcutBindings({ ...DEFAULT_SHORTCUT_BINDINGS });
                            setShortcutRecording(null);
                            setShortcutError("");
                          } catch (reason) {
                            setShortcutError(`快捷键保存失败，请重新提交：${String(reason)}`);
                          } finally {
                            setShortcutSaving(false);
                          }
                        })()}
                      >
                        恢复默认
                      </button>
                    </div>
                    {(["editor", "app"] as const).map((scope) => (
                      <section className="shortcut-settings" key={scope} aria-labelledby={`${scope}-shortcut-title`}>
                        <div className="editor-settings-heading">
                          <h4 id={`${scope}-shortcut-title`}>{scope === "editor" ? "编辑器" : "应用"}</h4>
                        </div>
                        {SHORTCUT_DEFINITIONS.filter((definition) => definition.scope === scope).map((definition) => {
                          const recording = shortcutRecording === definition.id;
                          const changed = shortcutBindings[definition.id] !== definition.defaultChord;
                          return (
                            <div className="shortcut-setting-row" key={definition.id}>
                              <span>
                                <strong>{definition.label}</strong>
                                <small>{changed ? `默认：${displayShortcut(definition.defaultChord)}` : "使用默认快捷键"}</small>
                              </span>
                              <button
                                className={`shortcut-recorder ${recording ? "recording" : ""}`}
                                type="button"
                                disabled={shortcutSaving}
                                aria-label={`修改${definition.label}快捷键`}
                                aria-pressed={recording}
                                onClick={() => {
                                  setShortcutRecording(definition.id);
                                  setShortcutError("");
                                }}
                                onKeyDown={(event) => handleShortcutRecording(event, definition.id)}
                              >
                                {recording ? "请按下快捷键…" : displayShortcut(shortcutBindings[definition.id])}
                              </button>
                            </div>
                          );
                        })}
                      </section>
                    ))}
                    {shortcutError && <p className="shortcut-error" role="alert">{shortcutError}</p>}
                  </>
                ) : settingsSection === "sync" ? (
                  <div className="oss-sync-section">
                    <div className="oss-sync-header">
                      <div className="settings-section-heading">
                        <h3>阿里云 OSS</h3>
                        <p>使用静态 AccessKey 将当前笔记文件夹单向上传到 OSS。密钥保存在本地 SQLite 配置数据库中。</p>
                      </div>
                      <label className="oss-sync-enabled">
                        <input
                          type="checkbox"
                          checked={ossSyncSettings?.enabled ?? false}
                          disabled={syncState === "syncing"}
                          onChange={(event) => void changeOssSyncEnabled(event.target.checked)}
                        />
                        启用
                      </label>
                    </div>
                    <div className="oss-sync-form">
                      <label>区域
                        <input value={ossSyncForm.region} disabled={syncState === "syncing"} placeholder="oss-cn-hangzhou" onChange={(event) => setOssSyncForm((form) => ({ ...form, region: event.target.value }))} />
                      </label>
                      <label>Endpoint
                        <input value={ossSyncForm.endpoint} disabled={syncState === "syncing"} placeholder="https://oss-cn-hangzhou.aliyuncs.com" onChange={(event) => setOssSyncForm((form) => ({ ...form, endpoint: event.target.value }))} />
                      </label>
                      <label>Bucket
                        <input value={ossSyncForm.bucket} disabled={syncState === "syncing"} placeholder="my-superwiki-backup" onChange={(event) => setOssSyncForm((form) => ({ ...form, bucket: event.target.value }))} />
                      </label>
                      <label>远端目录
                        <input value={ossSyncForm.prefix} disabled={syncState === "syncing"} placeholder="superwiki" onChange={(event) => setOssSyncForm((form) => ({ ...form, prefix: event.target.value }))} />
                      </label>
                      <label>AccessKey ID
                        <input value={ossSyncForm.accessKeyId} disabled={syncState === "syncing"} autoComplete="off" onChange={(event) => setOssSyncForm((form) => ({ ...form, accessKeyId: event.target.value }))} />
                      </label>
                      <label>AccessKey Secret
                        <input type="password" value={ossSyncForm.accessKeySecret} disabled={syncState === "syncing"} autoComplete="new-password" placeholder={ossSyncSettings?.hasAccessKeySecret ? "已保存；留空则不修改" : "请输入 AccessKey Secret"} onChange={(event) => setOssSyncForm((form) => ({ ...form, accessKeySecret: event.target.value }))} />
                      </label>
                    </div>
                    <div className="oss-sync-actions">
                      <button onClick={() => void saveCurrentOssSyncSettings()} disabled={syncState === "syncing"}>保存配置</button>
                      <button onClick={() => void testCurrentOssSyncConnection()} disabled={syncState === "syncing"}>测试连接</button>
                      <button className="primary" onClick={() => void syncCurrentWorkspace()} disabled={syncState === "syncing"}>立即同步</button>
                    </div>
                    <p className={`oss-sync-status ${syncState === "error" ? "error" : ""}`} aria-live="polite">
                      {syncMessage || "启用后会先同步现有文件，之后在本地写入后自动同步。"}
                    </p>
                  </div>
                ) : (
                  <div className="about-section">
                    <div className="settings-section-heading">
                      <h3>关于</h3>
                      <p>当前客户端的版本信息。</p>
                    </div>
                    <div className="about-card">
                      <img className="about-logo" src="/superwiki-logo.png" alt="SuperWiki" />
                      <div className="about-info">
                        <span className="about-name">SuperWiki</span>
                        <span className="about-version">{appVersion ? `v${appVersion}` : "版本号获取中…"}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

/** 空工作区引导组件的展示内容与可选操作。 */
type EmptyStateProps = {
  /** 空状态展示的图标节点。 */
  icon: React.ReactNode;
  /** 空状态主标题。 */
  title: string;
  /** 空状态说明文本。 */
  description: string;
  /** 可选操作按钮文案；缺失时不渲染按钮。 */
  action?: string;
  /** 可选操作回调；仅在 `action` 存在时使用。 */
  onAction?: () => void;
};

/** @param props 空状态图标、文本及可选操作。@returns 空状态 React 元素。 */
function EmptyState({ icon, title, description, action, onAction }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon">{icon}</span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action && <button onClick={onAction}><FolderOpen size={16} />{action}</button>}
    </div>
  );
}

/** 单个目录树节点渲染与文件操作回调。 */
type TreeNodeProps = {
  /** 当前渲染的树节点。 */
  node: FileTreeNode;
  /** 节点层级，用于计算缩进。 */
  depth: number;
  /** 当前活动文件路径；无活动文件时为 `null`。 */
  activePath: string | null;
  /** 正在重命名的路径；无重命名时为 `null`。 */
  renamingPath: string | null;
  /** 正在新建的条目上下文；无新建时为 `null`。 */
  creatingEntry: CreatingEntry | null;
  /** 打开文件节点的回调。 */
  onOpen: (node: FileTreeNode) => void;
  /** 显示节点右键菜单的回调。 */
  onContextMenu: (event: React.MouseEvent, node: FileTreeNode) => void;
  /** 提交重命名并以布尔值报告成功的异步回调。 */
  onRename: (node: FileTreeNode, name: string) => Promise<boolean>;
  /** 创建子条目并以布尔值报告成功的异步回调。 */
  onCreateEntry: (parentPath: string, kind: CreateEntryKind, name: string) => Promise<boolean>;
  /** 取消当前重命名。 */
  onCancelRename: () => void;
  /** 取消当前新建操作。 */
  onCancelCreate: () => void;
};

/** @param props 节点、展开层级和树操作回调。@returns 目录 `<details>` 或文件按钮。@sideEffect 管理节点展开与重命名输入状态。 */
function TreeNode({
  node,
  depth,
  activePath,
  renamingPath,
  creatingEntry,
  onOpen,
  onContextMenu,
  onRename,
  onCreateEntry,
  onCancelRename,
  onCancelCreate,
}: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [renameValue, setRenameValue] = useState(node.name);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const cancelledRenameRef = useRef(false);
  const renaming = renamingPath === node.path;
  const creatingHere = creatingEntry?.parentPath === node.path;
  const style = { paddingLeft: 10 + depth * 15 };

  useEffect(() => {
    if (!renaming) return;
    cancelledRenameRef.current = false;
    setRenameValue(node.name);
    requestAnimationFrame(() => renameInputRef.current?.select());
  }, [node.name, renaming]);

  useEffect(() => {
    if (!creatingHere || !detailsRef.current) return;
    detailsRef.current.open = true;
    setExpanded(true);
  }, [creatingHere]);

  const renameInput = (
    <input
      ref={renameInputRef}
      className="tree-rename-input"
      value={renameValue}
      aria-label={`重命名 ${node.name}`}
      onChange={(event) => setRenameValue(event.target.value)}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          cancelledRenameRef.current = true;
          onCancelRename();
        }
      }}
      onBlur={() => {
        if (cancelledRenameRef.current) return;
        void onRename(node, renameValue);
      }}
    />
  );

  if (node.isDir) {
    return (
      <details ref={detailsRef} className="tree-directory" onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary
          className="tree-row directory"
          style={style}
          onClick={(event) => {
            if (renaming || event.detail > 1) event.preventDefault();
          }}
          onContextMenu={(event) => onContextMenu(event, node)}
        >
          <ChevronRight className="tree-chevron" size={13} />
          <Folder className="folder-closed" size={15} />
          <FolderOpen className="folder-open" size={15} />
          {renaming ? renameInput : <span className="tree-name">{node.name}</span>}
        </summary>
        {creatingHere && creatingEntry && (
          <CreateEntryInput
            depth={depth + 1}
            kind={creatingEntry.kind}
            onCreate={(name) => onCreateEntry(node.path, creatingEntry.kind, name)}
            onCancel={onCancelCreate}
          />
        )}
        {expanded && node.children.map((child) => (
          <MemoizedTreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            activePath={activePath}
            renamingPath={renamingPath}
            creatingEntry={creatingEntry}
            onOpen={onOpen}
            onContextMenu={onContextMenu}
            onRename={onRename}
            onCreateEntry={onCreateEntry}
            onCancelRename={onCancelRename}
            onCancelCreate={onCancelCreate}
          />
        ))}
      </details>
    );
  }

  const fileRowClassName = `tree-row file ${activePath === node.path ? "active" : ""} ${node.isMarkdown || node.isImage || node.isOffice ? "" : "unsupported"}`;
  const fileIcon = node.isMarkdown
    ? <FileCode2 size={14} />
    : node.isImage
      ? <ImageIcon size={14} />
      : <File size={14} />;

  if (renaming) {
    return (
      <div className={fileRowClassName} style={style}>
        <span className="tree-spacer" />
        {fileIcon}
        {renameInput}
      </div>
    );
  }

  return (
    <button
      role="treeitem"
      className={fileRowClassName}
      style={style}
      aria-disabled={!node.isMarkdown && !node.isImage && !node.isOffice}
      title={node.isMarkdown || node.isImage || node.isOffice ? node.path : "当前仅支持 Markdown 编辑，以及图片、DOCX、XLSX、PPTX 预览，右键可在文件管理器中打开、重命名或删除"}
      onClick={() => {
        if (node.isMarkdown || node.isImage || node.isOffice) onOpen(node);
      }}
      onContextMenu={(event) => onContextMenu(event, node)}
    >
      <span className="tree-spacer" />
      {fileIcon}
      <span className="tree-name">{node.name}</span>
    </button>
  );
}

/** 目录树中新建文件或目录输入框的参数。 */
type CreateEntryInputProps = {
  /** 父目录层级，用于计算输入框缩进。 */
  depth: number;
  /** 新建文件或目录。 */
  kind: CreateEntryKind;
  /** 提交名称并以布尔值报告成功的异步回调。 */
  onCreate: (name: string) => Promise<boolean>;
  /** 取消新建的回调。 */
  onCancel: () => void;
};

/** @param props 父节点缩进、新建类型及提交/取消回调。@returns 新建条目输入控件。@sideEffect 管理输入焦点和防重复提交状态。 */
function CreateEntryInput({ depth, kind, onCreate, onCancel }: CreateEntryInputProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const cancelledRef = useRef(false);
  const style = { paddingLeft: 10 + depth * 15 };

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  /** @returns 提交流程 Promise。@sideEffect 调用创建回调，失败时重新选中输入文本。 */
  const submit = async () => {
    const name = value.trim();
    if (!name) {
      onCancel();
      return;
    }
    if (submittingRef.current) return;

    submittingRef.current = true;
    const success = await onCreate(name);
    submittingRef.current = false;
    if (!success) requestAnimationFrame(() => inputRef.current?.select());
  };

  return (
    <div className="tree-create-row" style={style}>
      <span className="tree-spacer" />
      {kind === "file" ? <FileCode2 size={14} /> : <Folder size={15} />}
      <input
        ref={inputRef}
        className="tree-rename-input"
        value={value}
        placeholder={kind === "file" ? "文件名（自动补充 .md）" : "文件夹名称"}
        aria-label={kind === "file" ? "新建 Markdown 文件" : "新建文件夹"}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            void submit();
          }
          if (event.key === "Escape") {
            cancelledRef.current = true;
            onCancel();
          }
        }}
        onBlur={() => {
          if (cancelledRef.current || submittingRef.current) return;
          void submit();
        }}
      />
    </div>
  );
}

/** 目录树节点的记忆化版本，避免编辑输入时重渲染整棵树。 */
const MemoizedTreeNode = memo(TreeNode);

/** 文档大纲组件的标题列表和选中回调。 */
type DocumentOutlineProps = {
  /** 当前文档解析得到的标题列表。 */
  headings: DocumentHeading[];
  /** 选择标题索引时的滚动回调。 */
  onSelect: (index: number) => void;
};

/** @param props 文档标题及滚动回调。@returns 记忆化大纲侧栏。 */
const DocumentOutline = memo(function DocumentOutline({ headings, onSelect }: DocumentOutlineProps) {
  return (
    <aside className="document-outline" aria-label="当前文档目录">
      <div className="document-outline-title">目录</div>
      {headings.length > 0 ? (
        <nav className="document-outline-list">
          {headings.map((heading, index) => (
            <button
              key={`${index}:${heading.level}:${heading.text}`}
              className={`document-outline-item outline-level-${heading.level}`}
              title={heading.text}
              onClick={() => onSelect(index)}
            >
              {heading.text}
            </button>
          ))}
        </nav>
      ) : (
        <div className="document-outline-empty">当前文档没有标题</div>
      )}
    </aside>
  );
});

/** Markdown 独立预览需要的内容及工作区路径上下文。 */
type MarkdownPreviewProps = {
  /** 待渲染的 Markdown 文本。 */
  content: string;
  /** 当前工作区根目录，用于读取相对图片。 */
  workspaceRoot: string;
  /** 当前 Markdown 文档绝对路径，用于解析相对图片路径。 */
  documentPath: string;
};

/** @param props Markdown 内容和资源解析上下文。@returns 记忆化 Markdown 预览。 */
const MarkdownPreview = memo(function MarkdownPreview({ content, workspaceRoot, documentPath }: MarkdownPreviewProps) {
  const codeBlockTitles = extractCodeBlockTitles(content);
  let codeBlockIndex = 0;

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkVideoEmbed, remarkLineBreak]}
      components={{
        pre: ({ children, ...props }) => {
          const title = codeBlockTitles[codeBlockIndex] ?? "";
          codeBlockIndex += 1;
          const codeChild = Children.toArray(children).find((child) => isValidElement(child));
          if (!isValidElement(codeChild)) return <pre {...props}>{children}</pre>;

          const codeProps = codeChild.props as { className?: string; children?: unknown };
          const language = /(?:^|\s)language-([^\s]+)/.exec(codeProps.className ?? "")?.[1];
          const source = String(codeProps.children ?? "").replace(/\n$/, "");
          if (isMermaidLanguage(language) || isPlantUmlLanguage(language)) {
            return <pre {...props}>{children}</pre>;
          }
          return <CodeBlockPreview language={language} title={title} source={source}>{children}</CodeBlockPreview>;
        },
        code: ({ className, children, ...props }) => {
          const language = /(?:^|\s)language-([^\s]+)/.exec(className ?? "")?.[1];
          const source = String(children).replace(/\n$/, "");
          if (isMermaidLanguage(language)) return <MermaidDiagram source={source} />;
          if (isPlantUmlLanguage(language)) return <PlantUmlDiagram source={source} />;

          return <code className={className} {...props}>{children}</code>;
        },
        img: ({ src, alt }) => (
          <WorkspaceMarkdownImage
            source={src}
            alt={alt ?? ""}
            workspaceRoot={workspaceRoot}
            documentPath={documentPath}
          />
        ),
        div: ({ node, children, ...props }) => {
          const videoUrl = node?.properties?.["data-video-url"];
          const isVideo = node?.properties?.["data-video-embed"] === "true";
          const videoLabel = node?.properties?.["data-video-label"];
          if (isVideo && typeof videoUrl === "string") {
            return (
              <VideoEmbedPreview
                url={videoUrl}
                label={typeof videoLabel === "string" ? videoLabel : undefined}
              />
            );
          }
          return <div {...props}>{children}</div>;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
});

/** @param props 代码语言、标题、源码和默认 Markdown 子节点。@returns 带换行与复制工具栏的代码块。@sideEffect 复制时写系统剪贴板。 */
function CodeBlockPreview({
  language,
  title,
  source,
  children,
}: {
  language?: string;
  title: string;
  source: string;
  children: React.ReactNode;
}) {
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);

  /** @returns 复制流程 Promise。@sideEffect 写剪贴板并在 1200ms 内显示已复制提示。 */
  const copyCode = async () => {
    await writeText(source);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className={`preview-code-block${wrap ? " is-wrapped" : ""}`}>
      <div className="preview-code-toolbar">
        <span className="preview-code-title">{title || DEFAULT_CODE_BLOCK_TITLE}</span>
        <div className="preview-code-actions">
          <span className="preview-code-language">{language || "纯文本"}</span>
          <button type="button" onClick={() => setWrap((value) => !value)} aria-pressed={wrap}>
            {wrap ? "取消换行" : "自动换行"}
          </button>
          <button type="button" onClick={() => void copyCode}>{copied ? "已复制" : "复制"}</button>
        </div>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

/** @param props Markdown 图片源、替代文本和资源解析上下文。@returns 已解析图片或加载提示。@sideEffect 异步创建并在卸载时释放 Blob URL。 */
function WorkspaceMarkdownImage({ source, alt, workspaceRoot, documentPath }: {
  source?: string;
  alt: string;
  workspaceRoot: string;
  documentPath: string;
}) {
  const [resolvedSource, setResolvedSource] = useState("");

  useEffect(() => {
    setResolvedSource("");
    if (!source) return;
    let cancelled = false;
    const cache = new Map<string, string>();
    void proxyWorkspaceImage(workspaceRoot, documentPath, source, cache)
      .then((url) => { if (!cancelled) setResolvedSource(url); })
      .catch(() => { if (!cancelled) setResolvedSource(""); });
    return () => {
      cancelled = true;
      for (const url of cache.values()) URL.revokeObjectURL(url);
    };
  }, [documentPath, source, workspaceRoot]);

  return resolvedSource
    ? <img src={resolvedSource} alt={alt} />
    : <span className="markdown-image-loading">图片加载中…</span>;
}

/** @param markdown 待解析 Markdown 文本。@returns 排除代码围栏、包含 ATX/Setext 标题的大纲列表。 */
function extractDocumentHeadings(markdown: string): DocumentHeading[] {
  const headings: DocumentHeading[] = [];
  const lines = markdown.split(/\r?\n/);
  let fenceCharacter = "";
  let fenceLength = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const marker = fence[1];
      if (!fenceCharacter) {
        fenceCharacter = marker[0];
        fenceLength = marker.length;
      } else if (marker[0] === fenceCharacter && marker.length >= fenceLength) {
        fenceCharacter = "";
        fenceLength = 0;
      }
      continue;
    }
    if (fenceCharacter) continue;

    const content = line.replace(/^(?: {0,3}>[ \t]?)+/, "");
    const atxHeading = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/.exec(content);
    if (atxHeading) {
      headings.push({
        level: atxHeading[1].length,
        text: cleanHeadingText(atxHeading[2].replace(/[ \t]+#+[ \t]*$/, "")),
      });
      continue;
    }

    const nextLine = lines[index + 1]?.replace(/^(?: {0,3}>[ \t]?)+/, "");
    const setextHeading = nextLine && /^ {0,3}(=+|-+)[ \t]*$/.exec(nextLine);
    if (content.trim() && setextHeading) {
      headings.push({
        level: setextHeading[1][0] === "=" ? 1 : 2,
        text: cleanHeadingText(content.trim()),
      });
      index += 1;
    }
  }

  return headings;
}

/** @param text 原始 Markdown 标题文本。@returns 去除链接、图片、HTML 与行内标记后的展示标题；空值回退“未命名标题”。 */
function cleanHeadingText(text: string) {
  const cleaned = text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/\\([\\`*{}\[\]()#+\-.!_>])/g, "$1")
    .trim();
  return cleaned || "未命名标题";
}

/** @param nodes 起始目录树节点。@param normalizedQuery 已小写化搜索词。@returns 文件名包含搜索词的 Markdown 节点。 */
function collectMatchingMarkdownDocuments(nodes: FileTreeNode[], normalizedQuery: string) {
  const matches: FileTreeNode[] = [];

  /** @param entries 当前层目录节点。@returns 无。@sideEffect 将匹配节点累积到外层数组。 */
  const collectMatches = (entries: FileTreeNode[]) => {
    for (const entry of entries) {
      if (entry.isDir) {
        collectMatches(entry.children);
      } else if (entry.isMarkdown && entry.name.toLocaleLowerCase().includes(normalizedQuery)) {
        matches.push(entry);
      }
    }
  };

  collectMatches(nodes);
  return matches;
}

/** @param timestamp Unix 毫秒时间戳。@returns 相对于当前时间的中文展示文本。 */
function formatRecentEditedTime(timestamp: number) {
  const date = new Date(timestamp);
  const now = new Date();
  const difference = Math.max(0, now.getTime() - date.getTime());
  const minutes = Math.floor(difference / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;

  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (isSameCalendarDay(date, now)) return `今天 ${time}`;

  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (isSameCalendarDay(date, yesterday)) return `昨天 ${time}`;
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/** @param left 第一个本地日期。@param right 第二个本地日期。@returns 年月日均相同则为 `true`。 */
function isSameCalendarDay(left: Date, right: Date) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

/** @param path 任意 Windows 或 POSIX 路径。@returns 最后一个路径段，无法分割时返回原字符串。 */
function pathFileName(path: string) {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

/** @param path 待判断绝对路径。@param directoryPath 目录绝对路径。@returns 路径等于目录或属于其后代时为 `true`。 */
function isPathInsideDirectory(path: string, directoryPath: string) {
  return path === directoryPath
    || path.startsWith(`${directoryPath}/`)
    || path.startsWith(`${directoryPath}\\`);
}

/** @param path 受影响路径。@param oldDirectoryPath 原目录前缀。@param newDirectoryPath 新目录前缀。@returns 替换前缀后的路径。 */
function replaceDirectoryPath(path: string, oldDirectoryPath: string, newDirectoryPath: string) {
  return `${newDirectoryPath}${path.slice(oldDirectoryPath.length)}`;
}

/** @param root 工作区根路径。@param path 文件绝对路径。@param fallbackName 非工作区路径时的显示名。@returns 统一 `/` 分隔的相对路径或回退名称。 */
function workspaceRelativePath(root: string, path: string, fallbackName: string) {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = path.replace(/\\/g, "/");
  const prefix = `${normalizedRoot}/`;
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : fallbackName;
}

/** @param content Markdown 文本。@returns 行数、词数与 Unicode 字符数统计对象。 */
function getDocumentStatistics(content: string) {
  return {
    lineCount: content === "" ? 1 : content.split(/\r\n|\r|\n/).length,
    wordCount: Array.from(content.matchAll(/[\p{Script=Han}]|[\p{L}\p{N}_]+/gu)).length,
    characterCount: Array.from(content).length,
  };
}

export default App;
