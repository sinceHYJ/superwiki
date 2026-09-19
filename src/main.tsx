/** 应用前端入口：挂载 React 根节点，并先通过 SettingsGate 初始化 SQLite 配置。 */
import React from "react";
import ReactDOM from "react-dom/client";
import SettingsGate from "./SettingsGate";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SettingsGate />
  </React.StrictMode>,
);
