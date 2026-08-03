import { lazy, memo, Suspense, useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  BookOpen,
  ChevronRight,
  Columns2,
  File,
  FileCode2,
  Folder,
  Image as ImageIcon,
  FolderOpen,
  PanelLeftClose,
  Pencil,
  RefreshCw,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { imageMimeType, proxyWorkspaceImage } from "./workspaceImages";
import "./App.css";

type FileTreeNode = {
  name: string;
  path: string;
  isDir: boolean;
  isMarkdown: boolean;
  isImage: boolean;
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
  kind: "markdown" | "image";
};

type ViewMode = "editor" | "split" | "preview";
type SaveState = "saved" | "saving" | "error";

type DirectoryContextMenu = {
  node: FileTreeNode;
  x: number;
  y: number;
};

const WORKSPACE_STORAGE_KEY = "superwiki.workspaceRoot";
const WysiwygEditor = lazy(() => import("./WysiwygEditor"));

function App() {
  const [workspace, setWorkspace] = useState<WorkspaceTree | null>(null);
  const [activeFile, setActiveFile] = useState<ActiveFile | null>(null);
  const [content, setContent] = useState("");
  const [editorVersion, setEditorVersion] = useState(0);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("split");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [directoryContextMenu, setDirectoryContextMenu] = useState<DirectoryContextMenu | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [error, setError] = useState("");
  const loadedContent = useRef("");
  const activeFileRef = useRef<ActiveFile | null>(null);
  const contentRef = useRef("");
  const imageUrlRef = useRef<string | null>(null);
  const editorMarkdownRef = useRef<(() => string) | null>(null);
  const saveTimerRef = useRef<number | null>(null);

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
        loadedContent.current = "";
        contentRef.current = "";
        setContent("");
      } else {
        const fileContent = await invoke<string>("read_workspace_file", {
          root: file.root,
          path: file.path,
        });
        replaceImageUrl(null);
        loadedContent.current = fileContent;
        contentRef.current = fileContent;
        setContent(fileContent);
        setEditorVersion((version) => version + 1);
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
      loadedContent.current = "";
      contentRef.current = "";
      setActiveFile(null);
      setContent("");
      replaceImageUrl(null);
      await loadWorkspace(selected);
    } catch (reason) {
      setError(String(reason));
    }
  };

  useEffect(() => () => {
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
  }, []);

  useEffect(() => {
    if (!directoryContextMenu) return;

    const closeMenu = () => setDirectoryContextMenu(null);
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
      loadedContent.current = "";
      contentRef.current = "";
      setActiveFile(null);
      setContent("");
      replaceImageUrl(null);
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

  const handleImageUploaded = useCallback(() => {
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
      kind: file.isImage ? "image" : "markdown",
    });
  }, [openFile, workspace]);

  const openDirectoryContextMenu = useCallback((event: React.MouseEvent, node: FileTreeNode) => {
    event.preventDefault();
    event.stopPropagation();
    setDirectoryContextMenu({
      node,
      x: Math.min(event.clientX, window.innerWidth - 150),
      y: Math.min(event.clientY, window.innerHeight - 44),
    });
  }, []);

  const renameDirectory = useCallback(async (node: FileTreeNode, inputName: string) => {
    if (!workspace) return false;
    const newName = inputName.trim();
    if (!newName) {
      setError("文件夹名称不能为空");
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
      const renamedPath = await invoke<string>("rename_workspace_directory", {
        root: workspace.root,
        path: node.path,
        newName,
      });

      const currentFile = activeFileRef.current;
      if (currentFile && isPathInsideDirectory(currentFile.path, node.path)) {
        const updatedFile = {
          ...currentFile,
          path: replaceDirectoryPath(currentFile.path, node.path, renamedPath),
        };
        activeFileRef.current = updatedFile;
        setActiveFile(updatedFile);
      }

      const tree = await invoke<WorkspaceTree>("list_workspace", { root: workspace.root });
      setWorkspace(tree);
      setRenamingPath(null);
      return true;
    } catch (reason) {
      setError(`无法重命名文件夹：${String(reason)}`);
      return false;
    }
  }, [flushPendingSave, workspace]);

  const previewContent = useDeferredValue(content);

  const changeViewMode = (mode: ViewMode) => {
    if (mode === "preview") syncEditorContent();
    setViewMode(mode);
  };

  const activeRelativePath = activeFile
    ? workspaceRelativePath(activeFile.root, activeFile.path, activeFile.name)
    : null;

  return (
    <main className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><BookOpen size={18} /></span>
          <span>SuperWiki</span>
        </div>

        <button className="open-folder primary" onClick={() => void selectWorkspace()}>
          <FolderOpen size={17} /> 打开文件夹
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
              <div className="workspace-root"><FolderOpen size={15} /><strong>{workspace.name}</strong></div>
              {workspace.children.map((node) => (
                <MemoizedTreeNode
                  key={node.path}
                  node={node}
                  depth={0}
                  activePath={activeFile?.path ?? null}
                  renamingPath={renamingPath}
                  onOpen={openTreeFile}
                  onContextMenu={openDirectoryContextMenu}
                  onRename={renameDirectory}
                  onCancelRename={() => setRenamingPath(null)}
                />
              ))}
              {workspace.children.length === 0 && <div className="empty-directory">文件夹为空</div>}
            </div>
          )}
        </div>

        {directoryContextMenu && (
          <div
            className="directory-context-menu"
            style={{ left: directoryContextMenu.x, top: directoryContextMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              onClick={() => {
                setRenamingPath(directoryContextMenu.node.path);
                setDirectoryContextMenu(null);
              }}
            >
              <Pencil size={13} />重命名
            </button>
          </div>
        )}

        <div className="sidebar-footer">Markdown · 图片预览</div>
      </aside>

      <section className="workspace">
        <header className="toolbar">
          <div className="document-title">
            <button className="icon-button sidebar-toggle" onClick={() => setSidebarOpen((value) => !value)} title="切换目录">
              <PanelLeftClose size={18} />
            </button>
            <div className="document-heading">
              <h1>{activeFile?.name ?? workspace?.name ?? "SuperWiki"}</h1>
              {activeFile && activeRelativePath && (
                <div className="document-meta">
                  <span className="document-path" title={activeRelativePath}>{activeRelativePath}</span>
                  <span className="meta-separator">·</span>
                  {activeFile.kind === "markdown" && <span className={`save-state ${saveState}`}>{saveLabel(saveState)}</span>}
                  {activeFile.kind === "image" && <span className="readonly-state">图片预览 · 只读</span>}
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
            </div>
          )}
        </header>

        {error && <div className="error-banner">{error}</div>}

        {!workspace && !workspaceLoading && (
          <EmptyState
            icon={<FolderOpen size={32} />}
            title="打开一个文件夹开始使用"
            description="选择包含 Markdown 或图片文件的本地文件夹，目录会显示在左侧。"
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
            description="从左侧目录中选择 Markdown 文件进行编辑，或选择图片进行只读预览。"
          />
        )}

        {activeFile?.kind === "markdown" && (
          <div className={`editor-layout mode-${viewMode}`}>
            {viewMode !== "preview" && (
              <section className="editor-pane" aria-label="Markdown 所见即所得编辑器">
                <div className="pane-label">所见即所得</div>
                <Suspense fallback={<div className="editor-loading">正在加载所见即所得编辑器…</div>}>
                  <WysiwygEditor
                    key={`${activeFile.path}:${editorVersion}`}
                    documentId={`${activeFile.path}:${editorVersion}`}
                    workspaceRoot={activeFile.root}
                    documentPath={activeFile.path}
                    initialValue={content}
                    onChange={handleEditorChange}
                    onReady={handleEditorReady}
                    onImageUploaded={handleImageUploaded}
                  />
                </Suspense>
              </section>
            )}

            {viewMode !== "editor" && (
              <section className="preview-pane" aria-label="Markdown 预览">
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
          </div>
        )}

        {activeFile?.kind === "image" && imageUrl && (
          <section className="image-preview" aria-label="图片预览">
            <div className="image-preview-canvas">
              <img src={imageUrl} alt={activeFile.name} />
            </div>
          </section>
        )}
      </section>
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
  onOpen: (node: FileTreeNode) => void;
  onContextMenu: (event: React.MouseEvent, node: FileTreeNode) => void;
  onRename: (node: FileTreeNode, name: string) => Promise<boolean>;
  onCancelRename: () => void;
};

function TreeNode({
  node,
  depth,
  activePath,
  renamingPath,
  onOpen,
  onContextMenu,
  onRename,
  onCancelRename,
}: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [renameValue, setRenameValue] = useState(node.name);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const cancelledRenameRef = useRef(false);
  const renaming = renamingPath === node.path;
  const style = { paddingLeft: 10 + depth * 15 };

  useEffect(() => {
    if (!renaming) return;
    cancelledRenameRef.current = false;
    setRenameValue(node.name);
    requestAnimationFrame(() => renameInputRef.current?.select());
  }, [node.name, renaming]);

  if (node.isDir) {
    return (
      <details className="tree-directory" onToggle={(event) => setExpanded(event.currentTarget.open)}>
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
          {renaming ? (
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
          ) : <span>{node.name}</span>}
        </summary>
        {expanded && node.children.map((child) => (
          <MemoizedTreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            activePath={activePath}
            renamingPath={renamingPath}
            onOpen={onOpen}
            onContextMenu={onContextMenu}
            onRename={onRename}
            onCancelRename={onCancelRename}
          />
        ))}
      </details>
    );
  }

  return (
    <button
      role="treeitem"
      className={`tree-row file ${activePath === node.path ? "active" : ""} ${node.isMarkdown || node.isImage ? "" : "unsupported"}`}
      style={style}
      disabled={!node.isMarkdown && !node.isImage}
      title={node.isMarkdown || node.isImage ? node.path : "当前仅支持 Markdown 编辑和图片预览"}
      onClick={() => onOpen(node)}
    >
      <span className="tree-spacer" />
      {node.isMarkdown ? <FileCode2 size={14} /> : node.isImage ? <ImageIcon size={14} /> : <File size={14} />}
      <span>{node.name}</span>
    </button>
  );
}

const MemoizedTreeNode = memo(TreeNode);

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
