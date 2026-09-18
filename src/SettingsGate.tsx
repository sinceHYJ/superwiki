import { useEffect, useState } from "react";
import App from "./App";
import { initializeSettings, type BootstrapSettings } from "./settingsStore";
import "./App.css";

type GateState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; settings: BootstrapSettings };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export default function SettingsGate() {
  const [state, setState] = useState<GateState>({ status: "loading" });

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
