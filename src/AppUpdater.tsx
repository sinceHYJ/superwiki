import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Download, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createUpdateController } from "./updateController";
import "./AppUpdater.css";

// Module lifetime, rather than dialog/component lifetime, defines a single launch.
const updater = createUpdateController(() => check({ timeout: 15000 }));
const releasePage = "https://github.com/sinceHYJ/superwiki/releases";

export default function AppUpdater({ currentVersion, prepareInstall, finishInstall, onOpenChange }: {
  currentVersion: string;
  prepareInstall: () => Promise<void>;
  finishInstall: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const state = useSyncExternalStore(updater.subscribe, updater.getSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [linkError, setLinkError] = useState("");
  const native = isTauri();
  const installing = state.phase === "installing";
  const downloading = state.phase === "downloading";
  const installingRef = useRef(installing);
  installingRef.current = installing;

  useEffect(() => { if (native) updater.start(); }, [native]);
  useEffect(() => {
    if (!native) return;
    const listener = getCurrentWindow().onCloseRequested((event) => {
      if (installingRef.current) event.preventDefault();
    });
    return () => { void listener.then((unlisten) => unlisten()); };
  }, [native]);

  const openDialog = () => {
    onOpenChange(true);
    setLinkError("");
    dialog.current?.showModal();
    if (native) void updater.check();
  };
  const closeDialog = () => { if (!installing) dialog.current?.close(); };
  const openLink = async (url: string) => {
    if (!/^https?:\/\//i.test(url)) return;
    try { await openUrl(url); }
    catch (error) { setLinkError(`无法打开链接：${String(error)}`); }
  };

  return <>
    <button ref={trigger} className="app-update-button" onClick={openDialog}
      title={state.version ? `发现新版本 v${state.version}` : "检查更新"}
      aria-label={state.version ? `发现新版本 v${state.version}，查看更新` : "检查更新"}>
      <Download size={16} />
      {state.version && <span className="app-update-dot" />}
    </button>
    <dialog ref={dialog} className="app-update-dialog" aria-labelledby="app-update-title"
      onCancel={(event) => { if (installing) event.preventDefault(); }}
      onClose={() => { onOpenChange(false); trigger.current?.focus(); }}>
      <header>
        <h2 id="app-update-title">{state.version ? "发现新版本" : "检查更新"}</h2>
        <button autoFocus onClick={closeDialog} disabled={installing} aria-label="关闭更新窗口"><X size={18} /></button>
      </header>
      <p>当前版本：{currentVersion ? `v${currentVersion}` : "读取中…"}
        {state.version && <>　最新版本：v{state.version}</>}</p>
      {state.version && <div className="app-update-notes" tabIndex={0}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
          a: ({ href, children }) => <a href={href} onClick={(event) => {
            event.preventDefault();
            if (href) void openLink(href);
          }}>{children}</a>,
          img: ({ alt }) => <span>{alt}</span>,
        }}>{state.notes?.trim() || "此版本暂无更新日志。"}</ReactMarkdown>
      </div>}
      <div aria-live="polite" className="app-update-status">
        {!native && <p>浏览器预览不支持更新，请在桌面应用中检查。</p>}
        {state.phase === "checking" && <p>正在检查更新…</p>}
        {state.phase === "latest" && <p>已是最新版本。</p>}
        {downloading && <>
          <progress max={state.total || undefined} value={state.total ? Math.min(state.downloaded, state.total) : undefined} />
          <p>正在下载：{(state.downloaded / 1024 / 1024).toFixed(1)} MB
            {state.total ? ` / ${(state.total / 1024 / 1024).toFixed(1)} MB（${Math.min(100, Math.round(state.downloaded / state.total * 100))}%）` : ""}</p>
        </>}
        {state.phase === "ready" && <p>下载完成。安装前将保存全部未保存文档，应用随后重启。</p>}
        {installing && <p>正在保存文档并安装更新，请勿关闭应用…</p>}
        {(state.error || linkError) && <p role="alert" className="app-update-error">{state.error || linkError}</p>}
      </div>
      <footer>
        <button onClick={closeDialog} disabled={installing}>{downloading ? "后台下载" : "稍后"}</button>
        <button onClick={() => void openLink(state.version ? `${releasePage}/tag/v${state.version.replace(/^v/, "")}` : releasePage)} disabled={!native || installing}>打开发布页</button>
        {state.phase === "available" ? <button className="app-update-primary" onClick={() => void updater.download()}>下载更新</button>
          : state.phase === "ready" ? <button className="app-update-primary" onClick={() => {
            if (updater.getSnapshot().phase !== "ready") return;
            void updater.install(prepareInstall, relaunch).finally(finishInstall);
          }}>保存并安装重启</button>
          : <button className="app-update-primary" disabled={!native || downloading || installing || state.phase === "checking"}
            onClick={() => void updater.check()}>检查更新</button>}
      </footer>
    </dialog>
  </>;
}
