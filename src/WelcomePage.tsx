/**
 * 独立欢迎页：展示已登记的本地工作区及打开文件夹入口。
 * 本组件只负责展示和回调，不扫描文件系统或写入持久化配置。
 */
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import type { WorkspaceRecord } from "./settingsStore";

/** 欢迎页的数据与操作入口，由 App 维护打开状态及请求互斥。 */
type WelcomePageProps = {
  /** 按最近成功打开时间倒序排列的历史工作区。 */
  workspaces: WorkspaceRecord[];
  /** 用户选择已登记工作区时触发，参数为绝对路径。 */
  onOpenWorkspace: (root: string) => void;
  /** 请求显示系统文件夹选择器。 */
  onSelectFolder: () => void;
};

/**
 * 渲染可键盘访问的工作区列表和首次使用引导。
 * @param props 历史工作区及用户操作回调。
 * @returns 欢迎页元素；点击按钮时调用对应回调，打开失败由 App 展示错误。
 */
export default function WelcomePage({ workspaces, onOpenWorkspace, onSelectFolder }: WelcomePageProps) {
  return (
    <section className="welcome-page" aria-labelledby="welcome-title">
      <header className="welcome-header">
        <img className="welcome-brand" src="/superwiki-logo.png" alt="" />
        <h1 id="welcome-title">欢迎使用 SuperWiki</h1>
        <p>打开本地文件夹，继续记录与思考。</p>
        <div className="welcome-actions">
          <button type="button" className="welcome-open" onClick={onSelectFolder}>
            <FolderOpen size={17} />打开文件夹
          </button>
        </div>
      </header>
      <section className="welcome-workspaces" aria-labelledby="welcome-workspaces-title">
        <h2 id="welcome-workspaces-title">已有工作区</h2>
        {workspaces.length === 0 ? (
          <p className="welcome-empty">暂无工作区，打开一个文件夹开始使用</p>
        ) : (
          <ul className="welcome-workspace-list">
            {workspaces.map(({ id, path }) => (
              <li key={id}>
                <button type="button" className="welcome-workspace" title={path} onClick={() => onOpenWorkspace(path)}>
                  <Folder size={22} aria-hidden="true" />
                  <span className="welcome-workspace-text">
                    <strong>{path.split(/[\\/]/).filter(Boolean).pop() || path}</strong>
                    <small>{path}</small>
                  </span>
                  <ChevronRight size={17} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
