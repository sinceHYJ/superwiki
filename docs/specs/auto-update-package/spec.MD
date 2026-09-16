# 自动更新与 GitHub Actions 发布规格

> 本文仅记录当前工作树中能由代码、配置或工作流直接验证的功能；不将规划、注释或已有说明文档当作已可用能力。核对基线：`0.8.3`。

## 范围与状态

| 范围 | 当前状态 | 事实依据 |
| --- | --- | --- |
| 桌面端自动更新交互 | 已实现 | `src/AppUpdater.tsx`、`src/updateController.ts`、`src/updateSave.ts` |
| Tauri 更新器、更新源与签名公钥 | 已配置 | `src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`src-tauri/capabilities/default.json` |
| GitHub Actions 构建、草稿与手动发布流程定义 | 已配置 | `.github/workflows/build-update.yml`、`.github/workflows/publish-update.yml` |
| GitHub Actions 实际打包、创建草稿及公开发布 | 脚本已恢复，待端到端验收 | `scripts/update-release.mjs`、两个工作流和更新测试 |

## 自动更新：已实现功能点

1. 桌面客户端使用 Tauri Updater；更新源固定为 GitHub Releases 的 `latest/download/latest.json`，并在客户端配置中内置更新签名公钥。
2. Rust 端已注册 Updater 插件，并授予检查、下载和安装更新的 capability。Windows 安装模式为 `passive`。
3. 应用启动时只自动检查一次更新；更新按钮支持用户手动再次检查。检查请求超时为 15 秒。
4. 仅接受稳定版本；更新源若返回带预发布标识的版本，客户端会拒绝该更新并显示可重试错误。
5. 发现新版本时，标题栏更新按钮显示红点和目标版本；弹窗同时展示当前版本、目标版本和更新日志。
6. 更新日志以 Markdown 渲染，不渲染 HTML；日志中的 HTTP/HTTPS 链接通过系统默认浏览器打开，打开失败会提示错误。
7. 用户可显式下载更新，界面展示已下载字节数、总大小（若服务端提供）和百分比。关闭更新弹窗后下载继续在当前进程内进行；退出应用后不保留下载进度。
8. 下载完成前不能安装；下载、检查和安装中的重复操作会被忽略。下载或签名校验失败后会回到“可下载”状态，用户可重试。
9. 用户点击“保存并安装重启”后，应用会先同步当前编辑器的最新输入，再保存所有已打开 Markdown 的未保存草稿；任一保存失败时不安装、不重启，并保留重试入口。
10. 更新前保存与普通自动保存使用串行队列，先等待在途保存完成，避免旧保存覆盖安装前快照。安装期间阻止关闭窗口和切换文档。
11. 浏览器预览环境不支持更新检查、下载或安装；旧版 `v0.7.1` 未包含更新器，不能通过自动更新直接升级。

## GitHub Actions：已配置功能点

1. `Build update draft` 在推送匹配 `v*.*.*` 的标签时触发；同一标签使用并发组串行执行，且不取消已开始的任务。
2. 工作流包含 Windows 和 macOS 两个构建矩阵：
   - Windows：`x86_64-pc-windows-msvc`，目标包为 NSIS 和 MSI。
   - macOS：`universal-apple-darwin`，目标包为 App 和 DMG，并安装 Intel 与 Apple Silicon 交叉编译目标。
3. 两个构建任务均配置 Node.js 24、稳定版 Rust、`npm ci`、版本一致性检查和更新相关测试；构建时向 `tauri-action` 注入 `TAURI_SIGNING_PRIVATE_KEY` 及可选的私钥密码。
4. 发布构建叠加 `src-tauri/tauri.release.conf.json`，启用 `createUpdaterArtifacts`。工作流预期收集 Windows 安装包、macOS DMG、macOS 更新归档及其 `.sig` 签名文件。
5. 构建任务明确关闭 `tauri-action` 自动创建 Release，设计为在两端构建成功后下载工件，再由后续草稿步骤统一处理。
6. `Publish update` 是手动触发工作流，要求输入标签，并与同标签构建共用并发组；其配置目标是将已审核草稿公开。

## 当前限制与未完成项

1. `scripts/update-release.mjs` 已从删除前受审版本恢复，提供标签校验、草稿 Release 创建、`latest.json` 生成与校验、公开发布功能；`npm run test:updates` 已通过 8 项测试。
2. GitHub Actions 尚未在恢复后的工作树运行，因此 Windows/macOS 双平台构建、草稿资产、签名、`latest.json` 上传和公开发布仍待端到端验收。
3. GitHub Actions 中 Apple 代码签名与公证的环境变量被注释，macOS 的 Apple 签名、公证及 Gatekeeper 验证尚未配置。
4. 更新签名只能证明更新包由持有配套私钥的一方生成；它不替代 macOS 代码签名或公证。
