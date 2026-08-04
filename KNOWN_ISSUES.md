# 已知问题

## BUG-001：桌面环境拖入 HTML 文件没有反应

- **记录日期**：2026-08-04
- **状态**：待修复
- **影响范围**：Tauri 桌面应用中的 Milkdown 所见即所得编辑器
- **相关功能**：将本地 `.html` / `.htm` 文件拖入编辑器并内嵌预览

### 问题现象

在浏览器环境中派发 HTML5 `drop` 事件时，HTML 上传和内嵌预览可以正常工作；但运行 `npm run tauri dev` 后，从 Finder 或文件资源管理器把 HTML 文件拖入编辑器没有反应。

### 根本原因

Tauri 窗口默认启用了原生文件拖放处理器（`dragDropEnabled: true`）。操作系统文件拖入 WebView 时，事件先被 Tauri 原生拖放层接管，Milkdown 的上传插件无法收到前端 HTML5 `DragEvent`，因此不会执行 HTML 上传逻辑。

当前项目没有使用 Tauri 的 `onDragDropEvent`，HTML 上传实现依赖 Milkdown 的 HTML5 `drop` 事件，两套事件机制未对齐。

### 建议修复方案

在 `src-tauri/tauri.conf.json` 的主窗口配置中增加：

```json
{
  "dragDropEnabled": false
}
```

关闭 Tauri 原生文件拖放处理器，让操作系统拖入事件进入 WebView，并由 Milkdown 的现有上传插件统一处理图片和 HTML 文件。

### 修复验证项

1. 在 macOS Finder 中拖入 `.html` 和 `.htm` 文件，可以生成 HTML 内嵌预览。
2. 原有 PNG、JPEG、GIF、WebP、SVG 等图片拖入上传不受影响。
3. HTML 文件复制到当前 Markdown 同级的 `assets/` 目录。
4. Markdown 自动保存特殊链接，重新打开文档后可以恢复内嵌预览。
5. 拖入不支持的文件不会破坏编辑器内容。
6. Windows 环境下验证 HTML5 文件拖放正常。

### 版本与参考

Tauri 相关依赖已经是检查时的最新稳定版，因此该问题不能通过升级 Tauri 解决：

- `@tauri-apps/api`: `2.11.1`（最新稳定版 `2.11.1`）
- `@tauri-apps/cli`: `2.11.4`（最新稳定版 `2.11.4`）
- Rust `tauri`: `2.11.5`（最新稳定版 `2.11.5`）

Milkdown 当前使用 `@milkdown/crepe@7.21.3`，检查时最新稳定版为 `7.22.0`。本问题发生在 Milkdown 收到拖放事件之前，升级 Milkdown 不能修复 Tauri 原生拖放拦截，因此本次不建议为该 Bug 升级 Milkdown。

参考资料：

- Tauri 2 配置参考：https://v2.tauri.app/reference/config/
- Tauri `dragDropEnabled` 配置定义：https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-utils/src/config.rs
- Tauri HTML5 文件拖放讨论：https://github.com/tauri-apps/tauri/issues/2964
