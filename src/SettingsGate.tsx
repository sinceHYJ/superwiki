/**
 * 设置启动门：在 SQLite 设置成功初始化前阻止主界面渲染，并为失败提供可重试界面。
 * 该组件避免应用在配置未知或损坏时继续运行。
 */
import { useEffect, useState } from "react";
import App from "./App";
import { initializeSettings, type BootstrapSettings } from "./settingsStore";
import "./App.css";

/** 设置启动门的加载、失败和可渲染状态。 */
type GateState =
  /** 初始化尚未完成，此时不得渲染主应用。 */
  | { status: "loading" }
  /** 初始化失败；`message` 是向用户展示的错误原因。 */
  | { status: "error"; message: string }
  /** 初始化成功；`settings` 是传给主应用的完整启动快照。 */
  | { status: "ready"; settings: BootstrapSettings };

/**
 * 将任意 Promise 拒绝原因转换为可显示的错误文本。
 *
 * @param error 异步初始化捕获的任意拒绝值。
 * @returns `Error.message` 或通过 `String` 转换后的文本，始终可渲染。
 */
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 初始化设置后渲染主应用；初始化失败时保留重试入口。
 *
 * @returns 设置加载中的提示、失败重试界面，或接收启动快照的 `App` 元素。
 */
export default function SettingsGate() {
  const [state, setState] = useState<GateState>({ status: "loading" });

  /**
   * 触发或重试设置初始化，并将结果写回门控状态。
   *
   * @returns 无返回值；异步调用成功后置为 `ready`，失败后置为 `error`。
   * @sideEffect 更新 React 状态并发起 Tauri SQLite 初始化 IPC。
   */
  const load = () => {
    setState({ status: "loading" });
    void initializeSettings()
      .then((settings) => setState({ status: "ready", settings }))
      .catch((error) => setState({ status: "error", message: errorMessage(error) }));
  };

  useEffect(load, []);

  if (state.status === "ready") return <App initialSettings={state.settings} />;

  return (
    <main className="settings-gate">
      <section className="settings-gate-card" role={state.status === "error" ? "alert" : "status"}>
        <h1>{state.status === "error" ? "无法读取应用配置" : "正在读取应用配置"}</h1>
        {state.status === "error" ? (
          <>
            <p>SQLite 配置数据库读取失败。修复存储问题后重试，应用不会在配置未知时继续启动。</p>
            <pre>{state.message}</pre>
            <button type="button" onClick={load}>重试</button>
          </>
        ) : <p>请稍候…</p>}
      </section>
    </main>
  );
}
