import { lazy, memo, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ChevronRight,
  Columns2,
  Copy,
  File,
  FileCode2,
  Folder,
  Image as ImageIcon,
  FolderOpen,
  PanelLeftClose,
  PanelRightClose,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import MermaidDiagram from "./MermaidDiagram";
import { isMermaidLanguage } from "./mermaidRenderer";
import PlantUmlDiagram from "./PlantUmlDiagram";
import { isPlantUmlLanguage } from "./plantumlRenderer";
import { imageMimeType, proxyWorkspaceImage } from "./workspaceImages";
import "./App.css";

type FileTreeNode = {
  name: string;
  path: string;
  isDir: boolean;
  isMarkdown: boolean;
  isImage: boolean;
  isOffice: boolean;
  children: FileTreeNode[];
};

type WorkspaceTree = {
  root: string;
  name: string;
  children: FileTreeNode[];
};

type ActiveFile = {
  root: string;
  path: string;
  name: string;
  kind: "markdown" | "image" | "office";
};

type ViewMode = "editor" | "split" | "preview";
type SaveState = "saved" | "saving" | "error";
type ThemeColor = "yellow" | "sky" | "mint" | "coral" | "lavender";

type DocumentHeading = {
  level: number;
  text: string;
};

type DirectoryContextMenu = {
  node: FileTreeNode;
  isWorkspaceRoot: boolean;
  x: number;
  y: number;
};

type CreateEntryKind = "file" | "directory";

type CreateEntryMenu = {
  parentPath: string;
  x: number;
  y: number;
};

type CreatingEntry = {
  parentPath: string;
  kind: CreateEntryKind;
};

const WORKSPACE_STORAGE_KEY = "superwiki.workspaceRoot";
const THEME_COLOR_STORAGE_KEY = "superwiki.themeColor";
const THEME_COLOR_REDESIGN_MIGRATION_KEY = "superwiki.themeColorRedesignV1";
const THEME_COLORS: { id: ThemeColor; name: string; color: string }[] = [
  { id: "yellow", name: "明亮黄", color: "#d9ed72" },
  { id: "sky", name: "天蓝色", color: "oklch(0.6331 0.0643 238.60)" },
  { id: "mint", name: "薄荷绿", color: "#86efac" },
  { id: "coral", name: "珊瑚粉", color: "#fda4af" },
  { id: "lavender", name: "薰衣草紫", color: "#c4b5fd" },
];

function isThemeColor(value: string | null): value is ThemeColor {
  return THEME_COLORS.some((theme) => theme.id === value);
}
const DEFAULT_SIDEBAR_WIDTH = 286;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 480;
const MIN_WORKSPACE_WIDTH = 360;
const OPEN_IN_FILE_MANAGER_LABEL = /Macintosh|Mac OS X/i.test(navigator.userAgent)
  ? "在 Finder 中打开"
  : "在文件管理器打开";
const WysiwygEditor = lazy(() => import("./WysiwygEditor"));
const OfficePreview = lazy(() => import("./OfficePreview"));

function App() {
  const [workspace, setWorkspace] = useState<WorkspaceTree | null>(null);
  const [activeFile, setActiveFile] = useState<ActiveFile | null>(null);
  const [content, setContent] = useState("");
  const [editorVersion, setEditorVersion] = useState(0);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [officeData, setOfficeData] = useState<ArrayBuffer | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("editor");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [themeColor, setThemeColor] = useState<ThemeColor>(() => {
    const storedTheme = localStorage.getItem(THEME_COLOR_STORAGE_KEY);
    const redesignMigrated = localStorage.getItem(THEME_COLOR_REDESIGN_MIGRATION_KEY) === "1";

    if (!redesignMigrated) {
      localStorage.setItem(THEME_COLOR_REDESIGN_MIGRATION_KEY, "1");
      if (!storedTheme || storedTheme === "yellow") {
        localStorage.setItem(THEME_COLOR_STORAGE_KEY, "sky");
        return "sky";
      }
    }

    return isThemeColor(storedTheme) ? storedTheme : "sky";
  });
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [directoryContextMenu, setDirectoryContextMenu] = useState<DirectoryContextMenu | null>(null);
  const [createEntryMenu, setCreateEntryMenu] = useState<CreateEntryMenu | null>(null);
  const [creatingEntry, setCreatingEntry] = useState<CreatingEntry | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [error, setError] = useState("");
  const loadedContent = useRef("");
  const activeFileRef = useRef<ActiveFile | null>(null);
  const contentRef = useRef("");
  const imageUrlRef = useRef<string | null>(null);
  const editorMarkdownRef = useRef<(() => string) | null>(null);
  const editorPaneRef = useRef<HTMLElement>(null);
  const previewPaneRef = useRef<HTMLElement>(null);
  const saveTimerRef = useRef<number | null>(null);
  const sidebarResizingRef = useRef(false);

  const replaceImageUrl = useCallback((url: string | null) => {
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    imageUrlRef.current = url;
    setImageUrl(url);
  }, []);

  const syncEditorContent = useCallback(() => {
    const latestMarkdown = editorMarkdownRef.current?.();
    if (latestMarkdown === undefined) return contentRef.current;

    contentRef.current = latestMarkdown;
    setContent(latestMarkdown);
    return latestMarkdown;
  }, []);

  const flushPendingSave = useCallback(async () => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    const file = activeFileRef.current;
    if (!file || file.kind !== "markdown") return;

    const latestContent = syncEditorContent();
    if (latestContent === loadedContent.current) return;

    await invoke("save_workspace_file", {
      root: file.root,
      path: file.path,
      content: latestContent,
    });
    loadedContent.current = latestContent;
  }, [syncEditorContent]);

  const openFile = useCallback(async (file: ActiveFile) => {
    try {
      setError("");
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
        loadedContent.current = fileContent;
        contentRef.current = fileContent;
        setContent(fileContent);
        setEditorVersion((version) => version + 1);
        setViewMode("editor");
        setSaveState("saved");
      }

      activeFileRef.current = file;
      setActiveFile(file);
    } catch (reason) {
      setError(String(reason));
    }
  }, [flushPendingSave, replaceImageUrl]);

  const loadWorkspace = useCallback(async (root: string, remember = true) => {
    setWorkspaceLoading(true);
    try {
      setError("");
      const tree = await invoke<WorkspaceTree>("list_workspace", { root });
      setWorkspace(tree);
      if (remember) localStorage.setItem(WORKSPACE_STORAGE_KEY, tree.root);
    } catch (reason) {
      setWorkspace(null);
      localStorage.removeItem(WORKSPACE_STORAGE_KEY);
      setError(`无法打开文件夹：${String(reason)}`);
    } finally {
      setWorkspaceLoading(false);
    }
  }, []);

  const selectWorkspace = async () => {
    const selected = await open({ directory: true, multiple: false, title: "打开笔记文件夹" });
    if (!selected) return;

    try {
      await flushPendingSave();
      activeFileRef.current = null;
      setDirectoryContextMenu(null);
      setCreateEntryMenu(null);
      setCreatingEntry(null);
      setRenamingPath(null);
      loadedContent.current = "";
      contentRef.current = "";
      setActiveFile(null);
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

  useEffect(() => {
    if (!directoryContextMenu && !createEntryMenu) return;

    const closeMenus = () => {
      setDirectoryContextMenu(null);
      setCreateEntryMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenus();
    };
    window.addEventListener("click", closeMenus);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", closeMenus);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [createEntryMenu, directoryContextMenu]);

  useEffect(() => {
    if (!settingsOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [settingsOpen]);

  useEffect(() => {
    const storedRoot = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (storedRoot) void loadWorkspace(storedRoot, false);
  }, [loadWorkspace]);

  useEffect(() => {
    if (!activeFile || activeFile.kind !== "markdown" || content === loadedContent.current) return;

    setSaveState("saving");
    saveTimerRef.current = window.setTimeout(async () => {
      try {
        await invoke("save_workspace_file", {
          root: activeFile.root,
          path: activeFile.path,
          content,
        });
        loadedContent.current = content;
        saveTimerRef.current = null;
        setSaveState("saved");
      } catch (reason) {
        saveTimerRef.current = null;
        setSaveState("error");
        setError(String(reason));
      }
    }, 500);

    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    };
  }, [activeFile, content]);

  const closeWorkspace = async () => {
    try {
      await flushPendingSave();
      activeFileRef.current = null;
      setDirectoryContextMenu(null);
      setCreateEntryMenu(null);
      setCreatingEntry(null);
      setRenamingPath(null);
      loadedContent.current = "";
      contentRef.current = "";
      setActiveFile(null);
      setContent("");
      replaceImageUrl(null);
      setOfficeData(null);
      setWorkspace(null);
      setError("");
      localStorage.removeItem(WORKSPACE_STORAGE_KEY);
    } catch (reason) {
      setError(String(reason));
    }
  };

  const handleEditorChange = useCallback((value: string) => {
    contentRef.current = value;
    setContent(value);
  }, []);

  const handleEditorReady = useCallback((getMarkdown: (() => string) | null) => {
    editorMarkdownRef.current = getMarkdown;
  }, []);

  const handleAssetUploaded = useCallback(() => {
    const root = activeFileRef.current?.root;
    if (!root) return;

    void invoke<WorkspaceTree>("list_workspace", { root })
      .then(setWorkspace)
      .catch((reason) => setError(`无法刷新目录：${String(reason)}`));
  }, []);

  const openTreeFile = useCallback((file: FileTreeNode) => {
    if (!workspace) return;
    void openFile({
      root: workspace.root,
      path: file.path,
      name: file.name,
      kind: file.isImage ? "image" : file.isOffice ? "office" : "markdown",
    });
  }, [openFile, workspace]);

  const openDirectoryContextMenu = useCallback((
    event: React.MouseEvent,
    node: FileTreeNode,
    isWorkspaceRoot = false,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setCreateEntryMenu(null);
    setCreatingEntry(null);
    setDirectoryContextMenu({
      node,
      isWorkspaceRoot,
      x: Math.min(event.clientX, window.innerWidth - 170),
      y: Math.min(event.clientY, window.innerHeight - (isWorkspaceRoot ? 70 : 130)),
    });
  }, []);

  const copyAbsolutePath = useCallback(async (node: FileTreeNode) => {
    setDirectoryContextMenu(null);
    try {
      setError("");
      await writeText(node.path);
    } catch (reason) {
      setError(`无法复制绝对路径：${String(reason)}`);
    }
  }, []);

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

  const openCreateEntryMenu = useCallback((event: React.MouseEvent, parentPath: string) => {
    event.preventDefault();
    event.stopPropagation();
    setDirectoryContextMenu(null);
    setRenamingPath(null);
    setCreateEntryMenu({
      parentPath,
      x: Math.min(event.clientX, window.innerWidth - 160),
      y: Math.min(event.clientY, window.innerHeight - 76),
    });
  }, []);

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

      const tree = await invoke<WorkspaceTree>("list_workspace", { root: workspace.root });
      setWorkspace(tree);
      setRenamingPath(null);
      return true;
    } catch (reason) {
      setError(`无法重命名${entryLabel}：${String(reason)}`);
      return false;
    }
  }, [flushPendingSave, workspace]);

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
      if (deletesCurrentFile) await flushPendingSave();

      await invoke(node.isDir ? "delete_workspace_directory" : "delete_workspace_file", {
        root: workspace.root,
        path: node.path,
      });

      if (deletesCurrentFile) {
        activeFileRef.current = null;
        editorMarkdownRef.current = null;
        loadedContent.current = "";
        contentRef.current = "";
        setActiveFile(null);
        setContent("");
        replaceImageUrl(null);
        setOfficeData(null);
        setSaveState("saved");
      }

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
  }, [flushPendingSave, replaceImageUrl, workspace]);

  const previewContent = useDeferredValue(content);
  const documentHeadings = useMemo(() => extractDocumentHeadings(previewContent), [previewContent]);

  const scrollToHeading = useCallback((index: number) => {
    const selector = "h1, h2, h3, h4, h5, h6";
    const scrollInPane = (pane: HTMLElement | null) => {
      pane?.querySelectorAll<HTMLElement>(selector)[index]?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    };

    if (viewMode !== "preview") scrollInPane(editorPaneRef.current);
    if (viewMode !== "editor") scrollInPane(previewPaneRef.current);
  }, [viewMode]);

  const changeViewMode = (mode: ViewMode) => {
    if (mode === "preview") syncEditorContent();
    setViewMode(mode);
  };

  const clampSidebarWidth = useCallback((width: number) => {
    const availableWidth = Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - MIN_WORKSPACE_WIDTH);
    return Math.min(Math.max(width, MIN_SIDEBAR_WIDTH), Math.max(MIN_SIDEBAR_WIDTH, availableWidth));
  }, []);

  const stopSidebarResize = useCallback(() => {
    sidebarResizingRef.current = false;
    setSidebarResizing(false);
  }, []);

  const handleSidebarResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    sidebarResizingRef.current = true;
    setSidebarResizing(true);
  };

  const handleSidebarResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!sidebarResizingRef.current) return;
    setSidebarWidth(clampSidebarWidth(event.clientX));
  };

  const handleSidebarResizeEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    stopSidebarResize();
  };

  const handleSidebarResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -10 : 10;
    setSidebarWidth((width) => clampSidebarWidth(width + direction));
  };

  const activeRelativePath = activeFile
    ? workspaceRelativePath(activeFile.root, activeFile.path, activeFile.name)
    : null;

  return (
    <main
      className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"} ${sidebarResizing ? "sidebar-resizing" : ""}`}
      data-theme={themeColor}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="library-identity">
            <span className="brand-mark"><img src="/superwiki-logo.png" alt="" /></span>
            <span className="library-name">
              {workspace?.name ?? "个人知识库"}
              <small>{workspace ? "本地工作区" : "尚未选择文件夹"}</small>
            </span>
          </div>
          <button className="icon-button sidebar-head-toggle" onClick={() => setSidebarOpen(false)} title="收起目录" aria-label="收起目录">
            <PanelLeftClose size={17} />
          </button>
        </div>

        <button className="open-folder primary" onClick={() => void selectWorkspace()}>
          <FolderOpen size={16} /> {workspace ? "更换文件夹" : "打开文件夹"}
        </button>

        <div className="sidebar-content folder-only">
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
          {!workspaceLoading && workspace && (
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
                <button
                  className="tree-add-button"
                  title="在根目录中新建"
                  onClick={(event) => openCreateEntryMenu(event, workspace.root)}
                >
                  <Plus size={14} />
                </button>
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
                  activePath={activeFile?.path ?? null}
                  renamingPath={renamingPath}
                  creatingEntry={creatingEntry}
                  onOpen={openTreeFile}
                  onContextMenu={openDirectoryContextMenu}
                  onAdd={openCreateEntryMenu}
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

        {createEntryMenu && (
          <div
            className="directory-context-menu create-entry-menu"
            style={{ left: createEntryMenu.x, top: createEntryMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              onClick={() => {
                setCreatingEntry({ parentPath: createEntryMenu.parentPath, kind: "file" });
                setCreateEntryMenu(null);
              }}
            >
              <FileCode2 size={14} />文件
            </button>
            <button
              onClick={() => {
                setCreatingEntry({ parentPath: createEntryMenu.parentPath, kind: "directory" });
                setCreateEntryMenu(null);
              }}
            >
              <Folder size={14} />文件夹
            </button>
          </div>
        )}

        {directoryContextMenu && (
          <div
            className="directory-context-menu"
            style={{ left: directoryContextMenu.x, top: directoryContextMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
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

        <div className="sidebar-footer">
          <button
            className="settings-button"
            onClick={() => setSettingsOpen(true)}
            title="设置"
            aria-label="打开设置"
          >
            <Settings size={15} />
            <span>偏好设置</span>
            <small>本地</small>
          </button>
          <div className="local-storage-note">Markdown · 图片与 Office 预览</div>
        </div>
      </aside>

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
        <header className="toolbar">
          <div className="document-title">
            <button className="icon-button sidebar-toggle" onClick={() => setSidebarOpen((value) => !value)} title="切换目录">
              <PanelLeftClose size={18} />
            </button>
            <img className="toolbar-logo" src="/superwiki-logo.png" alt="" />
            <div className="document-heading">
              <h1>{activeFile?.name ?? workspace?.name ?? "SuperWiki"}</h1>
              {activeFile && activeRelativePath && (
                <div className="document-meta">
                  <span className="document-path" title={activeRelativePath}>{activeRelativePath}</span>
                  <span className="meta-separator">·</span>
                  {activeFile.kind === "markdown" && <span className={`save-state ${saveState}`}>{saveLabel(saveState)}</span>}
                  {activeFile.kind === "image" && <span className="readonly-state">图片预览 · 只读</span>}
                  {activeFile.kind === "office" && <span className="readonly-state">Office 预览 · 只读</span>}
                </div>
              )}
            </div>
          </div>

          {activeFile?.kind === "markdown" && (
            <div className="toolbar-actions">
              <div className="view-switcher" aria-label="视图模式">
                <button className={viewMode === "editor" ? "active" : ""} onClick={() => changeViewMode("editor")}>编辑</button>
                <button className={viewMode === "split" ? "active" : ""} onClick={() => changeViewMode("split")} title="分栏"><Columns2 size={15} /></button>
                <button className={viewMode === "preview" ? "active" : ""} onClick={() => changeViewMode("preview")}>预览</button>
              </div>
              <button
                className={`icon-button outline-toggle ${outlineOpen ? "" : "collapsed"}`}
                onClick={() => setOutlineOpen((value) => !value)}
                title={outlineOpen ? "隐藏右侧目录" : "显示右侧目录"}
                aria-label={outlineOpen ? "隐藏右侧目录" : "显示右侧目录"}
                aria-pressed={!outlineOpen}
              >
                <PanelRightClose size={18} />
              </button>
            </div>
          )}
        </header>

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

        {workspace && !activeFile && !workspaceLoading && (
          <EmptyState
            icon={<FileCode2 size={32} />}
            title="选择一个 Markdown 或图片文件"
            description="从左侧目录中选择 Markdown 文件进行编辑，或选择图片、DOCX、XLSX、PPTX 进行只读预览。"
          />
        )}

        {activeFile?.kind === "markdown" && (
          <div className={`editor-layout mode-${viewMode} ${outlineOpen ? "" : "outline-hidden"}`}>
            {viewMode !== "preview" && (
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
                    onAssetUploaded={handleAssetUploaded}
                  />
                </Suspense>
              </section>
            )}

            {viewMode !== "editor" && (
              <section ref={previewPaneRef} className="preview-pane" aria-label="Markdown 预览">
                <div className="pane-label">预览</div>
                <article className="markdown-body">
                  <MarkdownPreview
                    content={previewContent}
                    workspaceRoot={activeFile.root}
                    documentPath={activeFile.path}
                  />
                </article>
              </section>
            )}

            {outlineOpen && <DocumentOutline headings={documentHeadings} onSelect={scrollToHeading} />}
          </div>
        )}

        {activeFile?.kind === "image" && imageUrl && (
          <section className="image-preview" aria-label="图片预览">
            <div className="image-preview-canvas">
              <img src={imageUrl} alt={activeFile.name} />
            </div>
          </section>
        )}

        {activeFile?.kind === "office" && officeData && (
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
                <button className="active" aria-current="page">
                  <Settings size={16} />外观
                </button>
              </nav>
              <div className="settings-content">
                <div className="settings-section-heading">
                  <h3>外观</h3>
                  <p>选择应用的主色调，修改后会立即生效。</p>
                </div>
                <div className="theme-color-grid" role="group" aria-label="主色调">
                  {THEME_COLORS.map((theme) => (
                    <button
                      key={theme.id}
                      className={`theme-color-option ${themeColor === theme.id ? "active" : ""}`}
                      aria-pressed={themeColor === theme.id}
                      onClick={() => {
                        setThemeColor(theme.id);
                        localStorage.setItem(THEME_COLOR_STORAGE_KEY, theme.id);
                      }}
                    >
                      <span className="theme-color-swatch" style={{ backgroundColor: theme.color }} />
                      <span>{theme.name}</span>
                      {themeColor === theme.id && <span className="theme-selected-mark">✓</span>}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

type EmptyStateProps = {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: string;
  onAction?: () => void;
};

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

type TreeNodeProps = {
  node: FileTreeNode;
  depth: number;
  activePath: string | null;
  renamingPath: string | null;
  creatingEntry: CreatingEntry | null;
  onOpen: (node: FileTreeNode) => void;
  onContextMenu: (event: React.MouseEvent, node: FileTreeNode) => void;
  onAdd: (event: React.MouseEvent, parentPath: string) => void;
  onRename: (node: FileTreeNode, name: string) => Promise<boolean>;
  onCreateEntry: (parentPath: string, kind: CreateEntryKind, name: string) => Promise<boolean>;
  onCancelRename: () => void;
  onCancelCreate: () => void;
};

function TreeNode({
  node,
  depth,
  activePath,
  renamingPath,
  creatingEntry,
  onOpen,
  onContextMenu,
  onAdd,
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
          {!renaming && (
            <button
              className="tree-add-button"
              title={`在 ${node.name} 中新建`}
              onClick={(event) => onAdd(event, node.path)}
            >
              <Plus size={14} />
            </button>
          )}
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
            onAdd={onAdd}
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

type CreateEntryInputProps = {
  depth: number;
  kind: CreateEntryKind;
  onCreate: (name: string) => Promise<boolean>;
  onCancel: () => void;
};

function CreateEntryInput({ depth, kind, onCreate, onCancel }: CreateEntryInputProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const cancelledRef = useRef(false);
  const style = { paddingLeft: 10 + depth * 15 };

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

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

const MemoizedTreeNode = memo(TreeNode);

type DocumentOutlineProps = {
  headings: DocumentHeading[];
  onSelect: (index: number) => void;
};

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

type MarkdownPreviewProps = {
  content: string;
  workspaceRoot: string;
  documentPath: string;
};

const MarkdownPreview = memo(function MarkdownPreview({ content, workspaceRoot, documentPath }: MarkdownPreviewProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
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
      }}
    >
      {content}
    </ReactMarkdown>
  );
});

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

function pathFileName(path: string) {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

function isPathInsideDirectory(path: string, directoryPath: string) {
  return path === directoryPath
    || path.startsWith(`${directoryPath}/`)
    || path.startsWith(`${directoryPath}\\`);
}

function replaceDirectoryPath(path: string, oldDirectoryPath: string, newDirectoryPath: string) {
  return `${newDirectoryPath}${path.slice(oldDirectoryPath.length)}`;
}

function workspaceRelativePath(root: string, path: string, fallbackName: string) {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = path.replace(/\\/g, "/");
  const prefix = `${normalizedRoot}/`;
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : fallbackName;
}

function saveLabel(state: SaveState) {
  if (state === "saving") return "正在保存…";
  if (state === "error") return "保存失败";
  return "已保存";
}

export default App;
