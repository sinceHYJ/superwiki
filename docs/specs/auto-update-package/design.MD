# 自动更新与 GitHub Actions 打包发布技术方案

> 设计基线：当前工作树 `0.8.3`。本文区分“已在代码中实现”“已配置但尚未端到端验收”和“未实现”，不将未经实际 GitHub Actions 验收的流程描述为已发布能力。

## 1. 方案概览

桌面端采用 Tauri v2 官方 Updater，而不是自建更新服务。客户端从 GitHub Releases 的静态 `latest.json` 读取稳定版本信息，使用内置公钥验证更新包签名；下载完成后，先把所有未保存的 Markdown 文档串行落盘，再调用 Updater 安装并重启。

打包流程以 Git 标签为入口：Windows 与 macOS 在 GitHub Actions 矩阵中分别构建、签名并上传临时工件，随后由 `scripts/update-release.mjs` 汇总为草稿 Release，再由手动工作流公开发布。该脚本已按删除前受审版本恢复，且本地更新测试已通过；恢复后尚未执行真实 GitHub Actions，因此 CI/CD 仍待端到端验收。

### 架构图（Mermaid）

```mermaid
flowchart LR
  subgraph Desktop[SuperWiki 桌面客户端]
    START[应用启动]
    UI["AppUpdater.tsx<br/>标题栏按钮与更新弹窗"]
    CTRL["updateController.ts<br/>更新状态机"]
    CHECK["check()<br/>15 秒超时"]
    STABLE{是否为稳定版<br/>且有新版本？}
    LATEST["latest<br/>显示已是最新版本"]
    REJECT["拒绝预发布版本<br/>展示可重试错误"]
    AVAILABLE["available<br/>保存版本与更新日志"]
    DOT["标题栏更新按钮<br/>展示红点"]
    DIALOG["打开更新弹窗<br/>支持手动再次检查"]
    DOWNLOAD["用户点击下载<br/>downloading"]
    PROGRESS["展示下载字节数<br/>总大小与百分比"]
    READY["ready<br/>下载完成，等待安装"]
    INSTALL["用户点击保存并安装重启"]
    SAVE["updateSave.ts<br/>保存队列与安装前快照"]
    APP["App.tsx<br/>编辑器同步与 Tauri invoke"]
    TUP["Tauri Updater<br/>检查、下载、验签、安装"]
    PROC["Tauri Process<br/>relaunch"]
  end

  GH["GitHub Releases<br/>latest.json / 安装包 / .sig"]
  FS[用户本地 Markdown 文件]

  START --> UI
  UI -->|桌面运行时启动检查| CTRL
  UI --> DIALOG
  DIALOG -->|手动检查| CTRL
  CTRL --> CHECK
  CHECK --> TUP
  TUP -->|请求 latest.json| GH
  GH -->|Update 或 null| TUP
  TUP --> STABLE
  STABLE -->|无更新| LATEST
  STABLE -->|预发布版本| REJECT
  STABLE -->|有稳定新版本| AVAILABLE
  AVAILABLE --> DOT
  DOT -->|用户点击更新按钮| DIALOG
  DIALOG -->|available 时点击下载| DOWNLOAD
  DOWNLOAD --> TUP
  TUP -->|下载、验签、Progress| GH
  TUP --> PROGRESS
  PROGRESS --> READY
  READY --> INSTALL
  INSTALL --> APP
  APP -->|同步当前编辑器内容| SAVE
  SAVE -->|串行保存全部草稿| FS
  SAVE -->|全部保存成功| TUP
  TUP -->|安装完成| PROC
  PROC -->|重启应用| START

  subgraph CI[GitHub Actions]
    TAG[vX.Y.Z 标签] --> BUILD["Build update draft<br/>Windows + macOS"]
    BUILD --> ART[Actions Artifacts]
    ART --> DRAFT[草稿 Release 汇总]
    DRAFT --> PUBLISH["Publish update<br/>手动发布"]
  end
  PUBLISH --> GH

  subgraph Legend[颜色图例]
    LEGEND_CODE[项目代码逻辑]
    LEGEND_MIDDLEWARE[Tauri 中间件]
    LEGEND_EXTERNAL[外部服务 / 平台]
  end

  classDef code fill:#DBEAFE,stroke:#2563EB,color:#1E3A8A,stroke-width:2px
  classDef middleware fill:#FEF3C7,stroke:#D97706,color:#78350F,stroke-width:2px
  classDef external fill:#DCFCE7,stroke:#16A34A,color:#14532D,stroke-width:2px
  class START,UI,CTRL,CHECK,STABLE,LATEST,REJECT,AVAILABLE,DOT,DIALOG,DOWNLOAD,PROGRESS,READY,INSTALL,SAVE,APP code
  class TUP,PROC middleware
  class GH,FS,TAG,BUILD,ART,DRAFT,PUBLISH external
  class LEGEND_CODE code
  class LEGEND_MIDDLEWARE middleware
  class LEGEND_EXTERNAL external
```

## 2. 依赖与开源组件

下表的“声明版本”来自依赖清单；“锁定版本”来自当前 `node_modules` 或 `Cargo.lock`。`^` 表示允许同一主版本内升级，因此实际构建应以锁文件为准。

| 组件 | 声明版本 | 当前锁定版本 | 引入位置 | 作用 |
| --- | --- | --- | --- | --- |
| `@tauri-apps/plugin-updater` | `^2.11.0` | `2.11.0` | `src/AppUpdater.tsx` | 调用 `check`，并在 `Update` 对象上执行下载与安装；签名校验由官方 Updater 完成。 |
| `tauri-plugin-updater` | `"2"` | `2.11.0` | `src-tauri/Cargo.toml`、`src-tauri/src/lib.rs` | Rust 端注册 Updater 插件，为前端 Updater API 提供原生实现。 |
| `@tauri-apps/plugin-process` | `^2.3.1` | `2.3.1` | `src/AppUpdater.tsx` | 安装成功后调用 `relaunch()` 重启应用。 |
| `tauri-plugin-process` | `"2"` | `2.3.1` | `src-tauri/Cargo.toml`、`src-tauri/src/lib.rs` | Rust 端启用进程重启能力。 |
| `@tauri-apps/plugin-opener` | `^2.5.5` | `2.5.5` | `src/AppUpdater.tsx` | 在系统默认浏览器打开 Release 页或更新日志链接。 |
| `tauri-plugin-opener` | `"2.5.4"` | `2.5.4` | `src-tauri/Cargo.toml`、`src-tauri/src/lib.rs` | Rust 端注册外链打开能力。前后端插件小版本不一致，但分别由各自语言生态锁定。 |
| `@tauri-apps/api` | `^2` | `2.11.1` | `src/AppUpdater.tsx`、`src/App.tsx` | 判断是否为桌面运行时、监听窗口关闭、调用 Tauri 命令。 |
| `react-markdown` | `^10.1.0` | `10.1.0` | `src/AppUpdater.tsx` | 渲染 `latest.json.notes` 中的 Markdown 更新日志。 |
| `remark-gfm` | `^4.0.1` | `4.0.1` | `src/AppUpdater.tsx` | 为更新日志提供 GFM 表格、任务列表等语法支持。 |
| `lucide-react` | `^1.28.0` | `1.28.0` | `src/AppUpdater.tsx` | 提供下载和关闭图标，不参与更新协议。 |
| `tauri-apps/tauri-action@v0` | 工作流固定为 `v0` 标签 | 未锁定到 commit SHA | `.github/workflows/build-update.yml` | 在 Windows/macOS Runner 中执行 Tauri 构建与更新产物生成。 |
| `actions/checkout@v4`、`actions/setup-node@v4`、`actions/upload-artifact@v4`、`actions/download-artifact@v4` | 工作流固定为各自主版本标签 | 未锁定到 commit SHA | 两个工作流 | 检出代码、配置 Node、跨 Job 传递构建工件。 |
| `dtolnay/rust-toolchain@stable` | `stable` 标签 | 未锁定到 commit SHA | `build-update.yml` | 安装稳定版 Rust 工具链。 |

## 3. 配置、配置项与数据存储

### 3.1 数据库和持久化状态

本功能**没有数据库、数据库表、迁移文件或更新专用的 `localStorage` 配置项**。更新状态（阶段、已下载字节、错误文本、当前 `Update` 句柄）仅保存在 `updateController.ts` 的模块内存中；应用退出后下载进度和状态都会丢失。文档保存仍复用既有 Tauri 命令 `save_workspace_file`，直接写入用户选择的本地 Markdown 文件。

### 3.2 应用依赖与版本配置

| 文件 | 字段 / 配置项 | 当前值 | 说明 |
| --- | --- | --- | --- |
| `package.json` | `version` | `0.8.3` | 前端应用版本；发布标签和其他版本文件必须一致。 |
| `package.json` | `scripts.test:updates` | `node --test tests/updates.test.mjs` | 更新控制器、保存队列及发布清单校验的 Node 测试入口；恢复脚本后当前 8 项测试均通过。 |
| `package.json` | `dependencies.@tauri-apps/plugin-updater` | `^2.11.0` | 前端 Updater SDK。 |
| `package.json` | `dependencies.@tauri-apps/plugin-process` | `^2.3.1` | 前端重启 SDK。 |
| `package.json` | `dependencies.@tauri-apps/plugin-opener` | `^2.5.5` | 前端外链打开 SDK。 |
| `package.json` | `dependencies.react-markdown` / `remark-gfm` | `^10.1.0` / `^4.0.1` | 更新日志渲染。 |
| `src-tauri/Cargo.toml` | `[package].version` | `0.8.3` | Rust 应用版本。 |
| `src-tauri/Cargo.toml` | `tauri-plugin-updater` | `"2"` | Rust Updater 插件。 |
| `src-tauri/Cargo.toml` | `tauri-plugin-process` | `"2"` | Rust 进程重启插件。 |
| `src-tauri/Cargo.toml` | `tauri-plugin-opener` | `"2.5.4"` | Rust 外链打开插件。 |
| `src-tauri/Cargo.lock` | `tauri-plugin-updater` / `tauri-plugin-process` / `tauri-plugin-opener` | `2.11.0` / `2.3.1` / `2.5.4` | 当前可复现的 Rust 解析版本。 |
| `.agents/skills/superwiki-release/scripts/sync-version.mjs` | `--check` | 无入参以外配置 | 读取 `package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`Cargo.toml`、`Cargo.lock`，验证均为同一 SemVer。环境变量 `SUPERWIKI_ROOT` 未设置时，以脚本相对路径推导仓库根目录。 |

### 3.3 Tauri 更新器与能力配置

| 文件 | 字段路径 | 当前值 | 说明 |
| --- | --- | --- | --- |
| `src-tauri/tauri.conf.json` | `productName` | `SuperWiki` | 打包产品名。 |
| `src-tauri/tauri.conf.json` | `version` | `0.8.3` | 与前端、Rust 包版本保持一致。 |
| `src-tauri/tauri.conf.json` | `identifier` | `com.superwiki.app` | 桌面应用标识。 |
| `src-tauri/tauri.conf.json` | `bundle.active` | `true` | 启用 Tauri bundle 输出。 |
| `src-tauri/tauri.conf.json` | `bundle.targets` | `all` | 默认可构建所有支持的 bundle；工作流以 `--bundles` 覆盖为指定格式。 |
| `src-tauri/tauri.conf.json` | `plugins.updater.endpoints` | `["https://github.com/sinceHYJ/superwiki/releases/latest/download/latest.json"]` | 更新元数据唯一来源；生产模式应使用 HTTPS。 |
| `src-tauri/tauri.conf.json` | `plugins.updater.windows.installMode` | `passive` | Windows 安装器采用被动安装 UI 模式。 |
| `src-tauri/tauri.conf.json` | `plugins.updater.pubkey` | `dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDMxNjlCMzA1M0IwRTQzMUYKUldRZlF3NDdCYk5wTVdpSCtKZk85T2dVYlRPbVV0cldscHdDR3NMVTJ1eEdUUlAvVWczZTQwcE8K` | Tauri updater 公钥，属于可公开分发的信任锚；配套私钥不得写入仓库。 |
| `src-tauri/tauri.release.conf.json` | `bundle.createUpdaterArtifacts` | `true` | 发布构建额外生成 Updater 所需的归档和签名工件。 |
| `src-tauri/src/lib.rs` | 插件注册 | `tauri_plugin_updater::Builder::new().build()` | 在 Tauri Builder 链中启用 Updater；同时初始化 opener 与 process 插件。 |
| `src-tauri/capabilities/default.json` | `identifier` / `windows` | `default` / `["main"]` | 更新能力只授予主窗口。 |
| `src-tauri/capabilities/default.json` | `permissions`：更新 | `updater:allow-check`、`updater:allow-download`、`updater:allow-install` | 分别允许检查、下载、安装。 |
| `src-tauri/capabilities/default.json` | `permissions`：重启 | `process:allow-restart` | 允许安装后调用 `relaunch()`。 |
| `src-tauri/capabilities/default.json` | `permissions`：外链 | `opener:allow-open-url`，白名单为 `https://*`、`http://*` | 仅允许 HTTP/HTTPS 更新日志链接与 Release 页；不允许任意 URI scheme。 |

### 3.4 前端运行时常量和状态

| 文件 | 名称 | 当前值 / 取值 | 说明 |
| --- | --- | --- | --- |
| `src/AppUpdater.tsx` | `releasePage` | `https://github.com/sinceHYJ/superwiki/releases` | “打开发布页”按钮基址；有目标版本时跳转到对应标签页。 |
| `src/AppUpdater.tsx` | `check({ timeout })` | `timeout: 15000`（毫秒） | 单次检查超时 15 秒。 |
| `src/updateController.ts` | `UpdateState.phase` | `idle`、`checking`、`latest`、`available`、`downloading`、`ready`、`installing` | 更新状态机全部阶段。初始状态为 `idle`，`downloaded: 0`，`error: ""`。 |
| `src/updateController.ts` | 预发布过滤 | `version.split("+")[0].includes("-")` | 带 prerelease 标识的版本被关闭并报错；构建元数据 `+...` 不参与判断。 |
| `src/App.tsx` | 自动保存等待 | `1000`（毫秒） | 普通自动保存的防抖时间；安装前会取消计时器并立即收集最新编辑器内容。 |

### 3.5 GitHub Actions 与机密配置

| 文件 | 字段路径 | 当前值 | 说明 |
| --- | --- | --- | --- |
| `.github/workflows/build-update.yml` | `name` | `Build update draft` | 标签构建工作流显示名称。 |
| `.github/workflows/build-update.yml` | `on.push.tags` | `["v*.*.*"]` | 推送匹配模式的标签时触发；模式本身不保证标签是稳定 SemVer，后续脚本本应校验。 |
| `.github/workflows/build-update.yml` | 顶层 `permissions.contents` | `read` | 构建 Job 只读仓库内容；`draft` Job 覆盖为 `write`。 |
| `.github/workflows/build-update.yml` | `concurrency.group` / `cancel-in-progress` | `update-${{ github.ref_name }}` / `false` | 同一标签的工作流避免并发写同一 Release，并让已开始的执行不被取消。 |
| `.github/workflows/build-update.yml` | `jobs.build.strategy.fail-fast` | `false` | 一个矩阵失败时另一平台仍继续，便于收集诊断结果。 |
| `.github/workflows/build-update.yml` | Windows 矩阵 | `windows-latest`、`x86_64-pc-windows-msvc`、`nsis,msi` | 生成 Windows x64 的 NSIS 和 MSI。 |
| `.github/workflows/build-update.yml` | macOS 矩阵 | `macos-latest`、`universal-apple-darwin`、`app,dmg` | 生成 Universal macOS App/DMG，并额外安装 `aarch64-apple-darwin` 与 `x86_64-apple-darwin` 目标。 |
| `.github/workflows/build-update.yml` | Node / Rust Action | `actions/setup-node@v4` + `node-version: '24'`；`dtolnay/rust-toolchain@stable` | CI 构建环境。 |
| `.github/workflows/build-update.yml` | 构建前命令 | `npm ci`；`node .agents/skills/superwiki-release/scripts/sync-version.mjs --check`；`node scripts/update-release.mjs check-tag`；`npm run test:updates` | 安装依赖、校验版本、校验标签、运行测试。第三项引用不存在的文件，导致后续命令不会执行。 |
| `.github/workflows/build-update.yml` | `tauri-action` | `tauri-apps/tauri-action@v0` | 仅构建，不创建或上传 Release。使用浮动标签而非 commit SHA。 |
| `.github/workflows/build-update.yml` | `tauri-action.with.includeUpdaterJson` | `false` | 禁用 Action 自动生成/上传 `latest.json`，设计上交给汇总脚本统一生成。 |
| `.github/workflows/build-update.yml` | `tauri-action.with.args` | `--target ${{ matrix.target }} --bundles ${{ matrix.bundles }} --config src-tauri/tauri.release.conf.json` | 按矩阵构建，并叠加生成更新工件的配置。 |
| `.github/workflows/build-update.yml` | `NODE_OPTIONS` | `--max-old-space-size=4096` | Node 堆上限 4 GiB。 |
| `.github/workflows/build-update.yml` | `TAURI_SIGNING_PRIVATE_KEY` | `${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}` | 必填机密；工作树与日志均不能读取其真实值，必须与 `pubkey` 匹配。 |
| `.github/workflows/build-update.yml` | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | `${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}` | 可选机密；若私钥加密则必须设置。当前是否在 GitHub 仓库设置无法由本地代码验证。 |
| `.github/workflows/build-update.yml` | Apple 相关变量 | `APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`、`APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID` 全部为注释行 | 未注入 Runner，因此未启用 macOS 代码签名/公证。 |
| `.github/workflows/build-update.yml` | 上传工件 | 名称 `update-${{ matrix.os }}`；路径为 `**/*.exe`、`**/*.msi`、`**/*.dmg`、`**/*.app.tar.gz`、`**/*.sig`；`if-no-files-found: error` | 将两个构建 Job 的产物交给草稿 Job；缺任一匹配文件即失败。 |
| `.github/workflows/build-update.yml` | `jobs.draft` | `needs: build`、`ubuntu-latest`、`contents: write` | 仅在两个构建都成功后下载 `update-*` 工件，并调用已恢复脚本的 `draft` 子命令。 |
| `.github/workflows/build-update.yml` | `jobs.draft.env.GH_TOKEN` | `${{ github.token }}` | GitHub 自动提供的临时 Token，用于创建草稿 Release；实际值不应记录或输出。 |
| `.github/workflows/publish-update.yml` | `name` / `on` | `Publish update` / `workflow_dispatch` | 仅可从 Actions UI 或 API 手动触发。 |
| `.github/workflows/publish-update.yml` | `inputs.tag` | 必填 `string`；说明示例 `v0.8.0` | 操作者指定已填写更新日志的草稿标签。 |
| `.github/workflows/publish-update.yml` | `permissions.contents` | `write` | 允许修改 Release。 |
| `.github/workflows/publish-update.yml` | `concurrency.group` / `cancel-in-progress` | `update-${{ inputs.tag }}` / `false` | 与同标签构建互斥。 |
| `.github/workflows/publish-update.yml` | 发布命令及环境 | `node scripts/update-release.mjs publish`；`GH_TOKEN=${{ github.token }}`；`UPDATE_TAG=${{ inputs.tag }}` | 使用已恢复脚本校验并公开草稿；尚待在 GitHub Actions 实际执行验证。 |

`latest.json` 由 `scripts/update-release.mjs:draft` 生成：初始字段为 `version`、占位 `notes` 和 `platforms`；`platforms` 固定包含 `windows-x86_64`、`darwin-x86_64`、`darwin-aarch64`，每项包含 GitHub Release 下载 `url` 与对应 `.sig` 文件内容的 `signature`。`publish` 会校验资产和签名一致，再将草稿正文写入 `notes`、写入 ISO 8601 格式的 `pub_date`，随后覆盖上传 manifest 并公开 Release。真实 Release 资产尚未生成，故不能在本文提供具体 URL、签名或时间戳。

## 4. 流程、算法与模块调用

### 4.1 改动模块及职责

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| 更新 UI | `src/AppUpdater.tsx`、`src/AppUpdater.css` | 标题栏入口、弹窗、版本与更新日志展示、进度、错误、下载/安装按钮。 |
| 更新状态机 | `src/updateController.ts` | 去重检查、稳定版过滤、下载进度累加、安装状态控制与错误回退。 |
| 安装前保存 | `src/updateSave.ts` | 收集草稿，并用 Promise 队列保证旧写入先完成。 |
| 应用集成 | `src/App.tsx` | 连接编辑器即时同步、Tauri `save_workspace_file`、文档切换拦截和 UI 组件。 |
| 原生能力 | `src-tauri/src/lib.rs`、`src-tauri/capabilities/default.json` | 注册 Updater/Process/Opener 插件并限制前端权限。 |
| 发布构建 | `.github/workflows/build-update.yml`、`.github/workflows/publish-update.yml`、`src-tauri/tauri.release.conf.json` | 双平台构建、签名工件、草稿汇总与手动发布的工作流定义。 |
| 测试 | `tests/updates.test.mjs` | 覆盖状态机、保存序列和原本应由发布脚本导出的校验函数。 |

### 4.2 关键函数和伪代码

本次没有新增函数。下表列出当前实现中与自动更新直接相关的方法；参数类型为源码中的真实类型或等价描述。

| 文件:方法 | 参数 | 逻辑 |
| --- | --- | --- |
| [src/AppUpdater.tsx:AppUpdater](/Users/administrator/cp/project/superwiki/src/AppUpdater.tsx:17) | `{ currentVersion: string; prepareInstall: () => Promise<void>; finishInstall: () => void; onOpenChange: (open: boolean) => void }` | 在桌面运行时启动一次检查；渲染红点和弹窗；将下载、安装操作委托给状态机。 |
| [src/AppUpdater.tsx:openDialog](/Users/administrator/cp/project/superwiki/src/AppUpdater.tsx:42) | 无 | 打开原生 `<dialog>`，清空外链错误，并触发一次手动检查。 |
| [src/AppUpdater.tsx:openLink](/Users/administrator/cp/project/superwiki/src/AppUpdater.tsx:49) | `url: string` | 仅接受 `http:` / `https:` URL；通过 Opener 打开，失败则写入 `linkError`。 |
| [src/updateController.ts:createUpdateController](/Users/administrator/cp/project/superwiki/src/updateController.ts:20) | `check: () => Promise<PendingUpdate \| null>` | 创建模块级状态、订阅集合和单个 `Update` 句柄，返回更新操作接口。 |
| [src/updateController.ts:start](/Users/administrator/cp/project/superwiki/src/updateController.ts:35) | 无 | 用 `started` 布尔值保证一次应用生命周期内只发起一次启动检查。 |
| [src/updateController.ts:check](/Users/administrator/cp/project/superwiki/src/updateController.ts:40) | 无 | 忽略检查/下载/准备安装/安装中的重复调用；请求更新，拒绝预发布，替换旧句柄，更新为 `latest` 或 `available`。 |
| [src/updateController.ts:download](/Users/administrator/cp/project/superwiki/src/updateController.ts:57) | 无 | 仅在 `available` 状态下载；接收 `Started` 与 `Progress` 事件，累计字节数；成功转 `ready`，失败回退 `available`。 |
| [src/updateController.ts:install](/Users/administrator/cp/project/superwiki/src/updateController.ts:70) | `prepare: () => Promise<void>`，`restart: () => Promise<void>` | 仅在 `ready` 状态执行：先保存，再 `update.install()`，最后重启；任一步失败转回 `ready` 以支持重试。 |
| [src/updateSave.ts:collectUpdateDocuments](/Users/administrator/cp/project/superwiki/src/updateSave.ts:4) | `tabs: DocumentFile[]`，`drafts: Record<string, string>`，`active: DocumentFile \| null`，`latest: string` | 将非活动页草稿与当前页即时编辑器内容转换为待写入文档；遇到无法定位的草稿直接失败，避免静默丢失。 |
| [src/updateSave.ts:createSaveQueue](/Users/administrator/cp/project/superwiki/src/updateSave.ts:18) | `write: (document: UpdateDocument) => Promise<void>` | 返回串行写队列：普通写入挂到 `pending` 后；安装前写入先等待已在途任务，再逐项写入。 |
| [src/updateSave.ts:saveBeforeUpdate](/Users/administrator/cp/project/superwiki/src/updateSave.ts:26) | `documents: UpdateDocument[]` | 伪代码：`await pending; for (document of documents) await write(document)`；任何一项失败立即中断，不进入安装。 |
| [src/App.tsx:prepareUpdateInstall](/Users/administrator/cp/project/superwiki/src/App.tsx:374) | 无 | 禁止正在切换文件时安装；取消自动保存定时器；同步编辑器；收集草稿并调用 `saveBeforeUpdate`；失败时恢复草稿和错误状态。 |
| [scripts/update-release.mjs:check-tag](/Users/administrator/cp/project/superwiki/scripts/update-release.mjs:95) | 工作流命令行子命令；`GITHUB_REF_NAME` 或 `UPDATE_TAG` | 仅接受稳定版 `vX.Y.Z`，并校验去除 `v` 后的标签版本与 `package.json.version` 一致。 |
| [scripts/update-release.mjs:draft](/Users/administrator/cp/project/superwiki/scripts/update-release.mjs:40) | 工作流命令行子命令；`GITHUB_REF_NAME` 或 `UPDATE_TAG` | 收集 `update-artifacts`，要求唯一的 NSIS、Universal macOS 归档、DMG、MSI 及签名；生成并校验 `latest.json`，再创建草稿 Release 和上传资产。 |
| [scripts/update-release.mjs:publish](/Users/administrator/cp/project/superwiki/scripts/update-release.mjs:68) | 工作流命令行子命令；环境变量 `UPDATE_TAG` | 读取草稿及资产，拒绝预发布或占位更新日志，下载 manifest 与签名并校验，写入正式更新日志和 `pub_date` 后公开 Release。 |
| [scripts/update-release.mjs:stableVersion](/Users/administrator/cp/project/superwiki/scripts/update-release.mjs:10)、[scripts/update-release.mjs:validateManifest](/Users/administrator/cp/project/superwiki/scripts/update-release.mjs:15) | `(tag: string)`；`(manifest, tag, assetNames)` | `stableVersion` 仅接受稳定版标签；`validateManifest` 校验版本、三平台条目、GitHub 下载 URL、资产存在性和签名。两者由更新测试覆盖。 |

### 4.3 客户端调用图（PlantUML）

```plantuml
@startuml
actor 用户
participant "AppUpdater.tsx" as UI
participant "updateController.ts" as C
participant "Tauri Updater" as U
participant "GitHub Releases\nlatest.json / 工件" as GH
participant "App.tsx" as APP
participant "updateSave.ts" as S
participant "save_workspace_file" as FS
participant "Tauri Process" as P

用户 -> UI: 启动应用 / 点击检查更新
UI -> C: start() / check()
C -> U: check({ timeout: 15000 })
U -> GH: HTTPS 请求 latest.json
GH --> U: Update 或 null
U --> C: 版本、notes、下载句柄
C --> UI: latest / available / 错误

用户 -> UI: 下载更新
UI -> C: download()
C -> U: update.download(onEvent)
U -> GH: 下载并校验更新工件
U --> C: Started / Progress / 完成
C --> UI: downloading -> ready

用户 -> UI: 保存并安装重启
UI -> C: install(prepareInstall, relaunch)
C -> APP: prepareUpdateInstall()
APP -> S: collectUpdateDocuments(...)
APP -> S: saveBeforeUpdate(documents)
S -> FS: 依次写入每份 Markdown
FS --> S: 全部成功
S --> APP: 保存完成
APP --> C: prepare 成功
C -> U: update.install()
U --> C: 安装完成
C -> P: relaunch()
@enduml
```

### 4.4 发布调用图（PlantUML）

```plantuml
@startuml
actor 维护者
participant "Git 标签" as TAG
participant "Build update draft" as BUILD
participant "sync-version.mjs" as SYNC
participant "update-release.mjs" as SCRIPT
participant "tauri-action" as TAURI
participant "Actions Artifacts" as ART
participant "draft Job" as DRAFT
participant "Publish update" as PUB
database "GitHub Release" as REL

维护者 -> TAG: push vX.Y.Z
TAG -> BUILD: 触发 Windows/macOS 矩阵
BUILD -> SYNC: --check
SYNC --> BUILD: 版本一致
BUILD -> SCRIPT: check-tag
SCRIPT --> BUILD: 标签与 package.json 版本一致
BUILD -> TAURI: 构建、生成更新工件、签名
TAURI -> ART: upload update-windows / update-macos
ART -> DRAFT: download update-*
DRAFT -> SCRIPT: draft
SCRIPT -> REL: 创建草稿与 latest.json
维护者 -> PUB: 手动输入 tag
PUB -> SCRIPT: publish
SCRIPT -> REL: 公开草稿并设为 Latest
@enduml
```

## 5. 技术决策与 Trade-off

| 决策 | 选择原因 | 优势 | 代价 / 风险 |
| --- | --- | --- | --- |
| 使用 Tauri 官方 Updater + GitHub Releases | 项目是本地桌面应用，无独立更新服务和数据库；Tauri 已提供签名校验和平台安装机制。 | 无需维护服务器；更新包可验签；前后端 API 与 Tauri v2 一致。 | 依赖 GitHub 可访问性；没有私有更新渠道、灰度或镜像回退。 |
| 将下载与安装拆为两步 | 必须在安装前先保存所有编辑器草稿。 | 下载过程可在弹窗关闭后继续；可显示进度；避免安装覆盖未保存内容。 | 状态机更多，退出后不能断点续传。 |
| 安装前使用串行保存队列 | 自动保存可能已经在运行，直接并发写会使旧内容覆盖最后快照。 | 保证旧写入完成后再写入安装快照，任何失败均阻止安装。 | 文档多或磁盘慢时安装等待变长；任一文件失败会阻断全部更新。 |
| 启动只检查一次，支持手动检查 | 避免重复请求和组件重新挂载导致的重复弹窗。 | 行为可预测、网络消耗低。 | 不轮询；用户需手动检查才能在运行期间发现随后发布的版本。 |
| 只允许稳定版 | 正式用户不应被错误发布的 beta/rc 更新。 | 降低误升级风险。 | 无法通过当前渠道测试预发布版本或实现测试频道。 |
| Windows 使用 `passive` 安装模式 | 在默认安装器体验与较少交互之间折中。 | 安装步骤相对简洁。 | 仍可能显示安装器 UI；需要在真实 Windows 机器验收。 |
| macOS 使用 Universal 构建 | 一个更新归档覆盖 Intel 和 Apple Silicon。 | Release 资产更少，客户端平台匹配更简单。 | macOS 构建耗时与 Runner 成本更高；未完成 Apple 签名/公证。 |
| 构建和发布拆分 | 先让维护者审阅草稿与更新日志，再公开。 | 降低错误标签或不完整资产直接发布的概率；避免矩阵并行写同一 Release。 | 操作多一步；依赖汇总脚本正确存在。 |
| 禁用 `tauri-action` 自动 `latest.json` | 设计上由单一汇总阶段生成 manifest，避免矩阵并行写同一 `latest.json` 的竞态。 | 将 Release 资产和 manifest 校验集中；恢复后的脚本会校验三平台、URL、资产和签名。 | 自定义汇总脚本是关键依赖；虽已恢复，仍需要真实 GitHub Actions 验证。 |

## 6. 当前 Debug、缺陷与限制

### 已修复的阻断缺陷

`scripts/update-release.mjs` 曾在提交 `66393a2` 被删除，但工作流与测试仍引用它，导致 `npm run test:updates` 报 `ERR_MODULE_NOT_FOUND`，并会使标签工作流停在 `check-tag`。该脚本现已按删除前受审版本恢复，包含 `check-tag`、`draft`、`publish`、`stableVersion`、`validateManifest`；`npm run test:updates` 已通过 8/8。

### 其他限制与风险

| 项目 | 现状与影响 | 建议 |
| --- | --- | --- |
| macOS 代码签名与公证 | Apple 相关 Secrets 在工作流中被注释，Gatekeeper 行为未纳入 CI。更新包签名不等于 Apple 代码签名/公证。 | 配置证书、签名身份和公证凭据后，在 Intel 与 Apple Silicon 真实设备验收。 |
| 端到端验签 | 单元测试只能模拟下载/签名失败分支；当前没有已验证的真实 Release 更新测试。 | 脚本恢复后用较低正式版本分别在 Windows/macOS 验证下载、验签、安装与重启。 |
| Action 供应链可复现性 | 所有 Actions 使用主版本/`stable` 浮动标签，而不是 commit SHA。 | 发布链路稳定后，将第三方 Action 固定到受信任 commit SHA，并设定更新策略。 |
| GitHub 网络依赖 | 更新源和下载资产均指向公开 GitHub；断网、限流、区域网络问题会导致检查或下载失败。 | 保留当前错误与重试入口；如需企业级可用性，再评估镜像/自建更新源。 |
| 无下载续传 | 更新进度仅存在进程内存，退出后从头开始下载。 | 若安装包较大，再评估官方 API 支持范围或引入受控缓存；当前未实现。 |
| 无 beta/灰度渠道 | 客户端拒绝带 `-` 的版本，并只读取 Latest Release。 | 若需内测，增加独立 endpoint/渠道配置，不应放宽稳定版过滤后直接面向正式用户。 |
| 发布链路未端到端验证 | 本地测试已覆盖 manifest 校验，但尚未使用真实 GitHub Actions 生成并公开包含 `latest.json` 的 Release。 | 使用非生产标签验证标签校验、双平台资产、草稿、签名、manifest 与手动公开发布。 |

## 7. 参考

- [Tauri v2 Updater：配置、签名、`createUpdaterArtifacts` 与 GitHub 静态更新源](https://v2.tauri.app/plugin/updater/)
- [Tauri Updater JavaScript API：`check`、`download`、`install` 与进度事件](https://v2.tauri.app/reference/javascript/updater/)
- [Tauri 官方 GitHub Action：构建、更新资产和 Release 参数](https://github.com/tauri-apps/tauri-action)
- [Tauri Action 变更记录：`includeUpdaterJson` 更名与 Universal macOS 行为](https://github.com/tauri-apps/tauri-action/blob/dev/CHANGELOG.md)
- [GitHub Actions 工作流语法与权限、机密引用](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [GitHub Actions Artifacts：跨 Job 上传和下载构建资产](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts)
- [GitHub Actions 并发控制](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency)
- [GitHub Actions Secrets 安全参考](https://docs.github.com/en/actions/reference/security/secrets)
