# Architecture Overview

> 本文是 SuperWiki 的架构速览，按实际代码维护。它参考了 [ARCHITECTURE.md 模板](https://architecture.md/)，用于帮助贡献者快速定位代码、理解数据流和识别安全边界。
>
> 最后更新：2026-09-16

## 1. Project Structure

SuperWiki 是一个本地优先的桌面 Markdown 知识库。项目采用 Tauri 2 作为桌面容器，React 负责界面和交互，Rust 负责本地文件系统及需要原生能力的命令。没有独立的 HTTP 后端、应用数据库、账号系统或必需的云端服务。

```text
superwiki/
├── src/                              # React + TypeScript 界面和客户端能力
│   ├── main.tsx                      # React 入口
│   ├── App.tsx                       # 主界面、工作区状态、文件生命周期和设置
│   ├── WelcomePage.tsx               # 无工作区时的独立欢迎页和历史工作区入口
│   ├── App.css                       # 应用布局、目录树和 Markdown 样式
│   ├── WysiwygEditor.tsx             # Milkdown Crepe 所见即所得编辑器
│   ├── OfficePreview.tsx              # DOCX/XLSX/PPTX 只读预览
│   ├── AppUpdater.tsx                 # 更新检查、下载和安装界面
│   ├── updateController.ts            # 更新状态机
│   ├── updateSave.ts                  # 更新前保存文档的队列
│   ├── workspaceImages.ts             # 工作区图片读取、路径解析和上传
│   ├── workspaceHtml.ts               # HTML 资源读取、路径解析和上传
│   ├── ossSync.ts                     # 可选的 Alibaba OSS 单向同步
│   ├── editorLanguages.ts             # CodeMirror 语言列表和按需加载
│   ├── mermaidRenderer.ts             # Mermaid 本地渲染
│   ├── plantumlRenderer.ts            # PlantUML 本地渲染
│   ├── video*.ts(x)                   # 视频链接解析、缩略图和嵌入预览
│   ├── remark*.ts                     # Markdown 扩展处理器
│   ├── shortcuts.ts                   # 快捷键定义和本地配置
│   └── contentWidth.ts                # 内容宽度配置
├── src-tauri/
│   ├── src/main.rs                    # Tauri 二进制入口
│   ├── src/lib.rs                     # Tauri 命令、本地文件服务和安全校验
│   ├── capabilities/default.json     # 主窗口权限声明
│   ├── tauri.conf.json                # 开发、打包和更新源配置
│   ├── tauri.release.conf.json        # 发布构建附加配置
│   └── Cargo.toml                     # Rust 依赖和 crate 配置
├── tests/                             # Node.js 内置测试
├── docs/                              # 项目文档
├── public/                            # 前端静态资源
├── .github/workflows/                 # 发布构建和更新发布流程
├── package.json                       # 前端依赖和脚本
└── vite.config.ts                     # Vite/Tauri 开发构建配置
```

## 2. High-Level System Diagram

```text
┌──────────────┐
│     用户      │
└──────┬───────┘
       │ 选择文件夹、编辑和预览
       ▼
┌──────────────────────────────────────────────┐
│ Tauri WebView                                 │
│ React App                                      │
│ ┌──────────────┐  ┌────────────────────────┐ │
│ │ 工作区/标签页 │  │ Milkdown / Markdown    │ │
│ │ 设置/自动保存 │  │ 预览/资源嵌入          │ │
│ └──────┬───────┘  └──────────┬─────────────┘ │
└────────┼─────────────────────┼───────────────┘
         │ @tauri-apps/api invoke
         ▼
┌──────────────────────────────────────────────┐
│ Rust 本地能力层：src-tauri/src/lib.rs        │
│ 路径校验、目录扫描、文件读写、资源上传、     │
│ 凭据库访问、Bilibili 封面请求、文件管理器调用 │
└────────┬─────────────────────┬────────────────┘
         │                     │
         ▼                     ▼
┌─────────────────┐   ┌────────────────────────┐
│ 用户选择的本地   │   │ 可选外部服务/平台       │
│ 工作区文件夹     │   │ OSS、Bilibili、视频平台、│
│ Markdown/附件    │   │ GitHub 更新源          │
└─────────────────┘   └────────────────────────┘
```

核心边界是：前端可以管理界面状态和调用 Tauri 命令，但不能绕过 Rust 直接读取或写入用户工作区。Markdown 文件始终以 Markdown 文本落盘，编辑器内部状态不会成为持久化格式。

## 3. Core Components

### 3.1. Desktop Shell and Frontend

**名称**：Tauri 桌面应用与 React 前端

**职责**：创建桌面窗口，加载 Vite 构建产物，提供工作区目录树、文档标签页、编辑/预览、设置、快捷键、最近编辑和收藏等交互。

**技术**：Tauri 2、React 19、TypeScript、Vite 7、Lucide React。

**入口**：`src-tauri/src/main.rs` → `src-tauri/src/lib.rs::run()` → `src/main.tsx` → `src/App.tsx`。

`App.tsx` 是当前前端的编排层，集中管理工作区、打开的文档、草稿、保存队列、视图模式、同步状态和设置。它通过 `React.lazy` 延迟加载所见即所得编辑器和 Office 预览器，避免在仅浏览目录或图片时提前加载重型依赖。

### 3.2. Document Editing and Markdown Rendering

**名称**：Markdown 编辑和预览子系统

**职责**：

- Milkdown Crepe 提供所见即所得编辑，支持 CommonMark、列表、表格、链接、图片、代码块和顶部工具栏。
- CodeMirror 仅按当前代码块语言按需加载解析器，支持 JavaScript、TypeScript、JSX、TSX、Rust、Python、Java、Go、HTML、CSS、JSON、YAML、TOML、Markdown、SQL 和 Shell。
- `react-markdown` + `remark-gfm` 提供独立预览，预览内容使用 `useDeferredValue` 降低长文档输入时的同步计算压力。
- Mermaid 和 PlantUML 在客户端按需加载并渲染为 SVG；Mermaid 使用严格安全级别。
- 普通 Markdown 图片、特殊 HTML 内嵌链接和 YouTube/Vimeo/Bilibili 视频链接由独立扩展处理。

**关键文件**：`src/WysiwygEditor.tsx`、`src/App.tsx`、`src/htmlEmbed.ts`、`src/videoEmbed.ts`、`src/mermaidRenderer.ts`、`src/plantumlRenderer.ts`。

编辑器的 `onReady` 暴露 `getMarkdown()`，文件切换、关闭工作区、切换纯预览和更新安装前会主动同步编辑器内容，避免最后一次输入尚未触发更新事件时丢失。

### 3.3. Rust Local File Service

**名称**：Tauri Rust 命令层

**职责**：扫描和刷新工作区树，读取/保存 Markdown，读取图片、HTML 和 Office 文件，创建/删除/重命名文件和文件夹，上传资源，打开系统文件管理器，并访问应用配置目录和系统凭据库。

**技术**：Rust 2021、Tauri 2、Serde、`std::fs`、`reqwest`、`keyring`。

**关键文件**：`src-tauri/src/lib.rs`、`src-tauri/capabilities/default.json`。

主要命令分组如下：

| 分组 | Tauri 命令 |
| --- | --- |
| 工作区 | `list_workspace`、`create_workspace_directory`、`create_workspace_markdown_file`、`rename_workspace_directory`、`rename_workspace_file`、`delete_workspace_directory`、`delete_workspace_file` |
| 文档与附件读取 | `read_workspace_file`、`read_workspace_image`、`read_workspace_html`、`read_workspace_office`、`read_workspace_sync_file` |
| 文档与资源写入 | `save_workspace_file`、`upload_workspace_image`、`upload_workspace_html` |
| 系统和同步 | `open_workspace_entry_in_file_manager`、`load_oss_sync_settings`、`save_oss_sync_settings`、`load_oss_sync_credentials` |
| 视频和更新相关网络能力 | `fetch_bilibili_thumbnail` |

### 3.4. File Type Previewers and Resource Embeds

图片支持 PNG、JPEG、GIF、WebP、SVG、BMP 和 ICO；Office 支持 DOCX、XLSX 和 PPTX。Office 文件由 `@silurus/ooxml` 在前端按需读取并只读渲染，不会写回 Office 文件。

图片和 HTML 上传会把文件保存到当前 Markdown 文档同级的 `assets/` 目录，生成不冲突的安全文件名，并在 Markdown 中插入相对路径或带标记的链接。资源读取仍由 Rust 校验路径后返回，前端再生成 Blob URL；切换文件或销毁组件时释放 Blob URL。

视频预览默认先显示缩略图，用户点击后才加载外部 iframe。当前识别 YouTube、Vimeo 和 Bilibili 的链接。

### 3.5. Autosave, Preferences, and Updates

编辑器内容进入 React 状态后，默认经过 1000ms 防抖自动保存；`createSaveQueue` 保证写入串行，避免旧的自动保存覆盖较新的内容。切换文档、关闭标签页、切换工作区、删除当前文件或安装更新前会刷新待保存内容。关闭自动保存时，当前文档草稿只保留在内存中，用户应在离开前手动保存。

用户偏好和索引通过 `settingsStore.ts` 调用 Rust，保存在应用私有目录的 SQLite 中，包括上次工作区、工作区列表、最近编辑、收藏、主题色、自动保存、启动恢复选项、打开标签页上限、快捷键和内容宽度。应用版本更新由 `AppUpdater.tsx` 和 `updateController.ts` 管理，安装前使用 `updateSave.ts` 保存打开的文档。

### 3.6. Startup and Welcome Page

`SettingsGate` 初始化 SQLite 后才挂载主界面；数据库读取或迁移失败时阻断启动并允许重试。架构版本 2 新增 `auto_open_last_workspace`，版本 3 新增工作区最近打开时间，二者均通过事务从旧版升级；迁移保留已有数据，失败回滚，未知版本继续拒绝读取。旧版应用无法读取升级后的配置库。

启动时仅依据初始快照中的 `autoOpenLastWorkspace` 和 `lastWorkspaceId` 决定是否恢复工作区。恢复期间显示加载状态，失败返回欢迎页并保留错误和历史记录。运行中修改开关只影响下次启动，不清除上次工作区标记。

`WelcomePage` 在未打开工作区时隐藏目录和编辑工具，展示历史工作区名称、完整路径及打开文件夹、设置入口。历史按最近成功打开时间倒序展示，不扫描磁盘；点击后通过现有 `open_workspace` 命令扫描、登记并更新时间，成功结果立即置顶。目录请求互斥，关闭工作区后回到欢迎页并沿用清除上次工作区标记的行为。

## 4. Data Stores

### 4.1. User Workspace

**名称**：用户主动选择的本地文件夹

**类型**：操作系统文件系统中的 Markdown、图片、HTML、Office 及其他附件

**用途**：系统的主要事实来源。目录树由 Rust 递归扫描生成；Markdown 文档以 UTF-8 文本读取和保存，其他支持的文件主要用于只读预览。

**关键约定**：应用不会自动建立数据库或隐藏副本。删除文件夹和文件是永久操作，Markdown 中删除图片引用也不会自动删除 `assets/` 中的实际图片文件。

### 4.2. Local Application State

**名称**：浏览器存储、内存状态、应用配置和系统凭据库

**类型**：`localStorage`、React 内存状态、应用配置目录中的 `oss-sync.json`、操作系统 Keyring

**用途**：

- `localStorage` 保存工作区路径、最近编辑、收藏和界面偏好，不保存文档正文。
- `documentDrafts`、打开标签页和当前编辑器内容在进程内存中维护。
- `oss-sync.json` 保存 OSS 区域、Endpoint、Bucket、前缀和 AccessKey ID 等非密钥配置。
- OSS AccessKey Secret 通过 `keyring` 以 `com.superwiki.app` 服务项保存，不写入配置 JSON。

### 4.3. Optional Alibaba OSS

**名称**：OSS 远端对象存储

**类型**：Alibaba OSS 兼容对象存储，通过 `ali-oss` SDK 访问

**用途**：可选的工作区单向上传同步。全量同步会递归上传工作区中的文件；文档保存或资源上传后，在同步启用且凭据可用时会排队上传对应文件。当前代码没有远端下载、冲突解决、版本合并或双向同步流程，因此 OSS 不是本地文件的替代数据源。

## 5. External Integrations / APIs

| 服务或平台 | 用途 | 集成方式 | 触发条件 |
| --- | --- | --- | --- |
| Tauri Dialog | 选择本地工作区文件夹 | `@tauri-apps/plugin-dialog` | 用户点击打开文件夹 |
| Tauri Clipboard | 复制绝对路径 | `@tauri-apps/plugin-clipboard-manager` | 用户执行复制路径 |
| Tauri Opener | 打开 URL、在文件管理器中定位文件 | `@tauri-apps/plugin-opener` + Rust 命令 | 用户主动操作 |
| Alibaba OSS | 可选工作区同步 | 前端 `ali-oss` SDK，凭据由 Rust 从 Keyring 提供 | 用户配置并启用同步 |
| Bilibili API | 获取 Bilibili 视频封面 | Rust `reqwest` 请求 `api.bilibili.com` | 解析 Bilibili 视频预览时 |
| YouTube / Vimeo / Bilibili | 播放外部视频 | 预览组件加载外部 iframe | 用户点击播放 |
| GitHub Releases | 应用更新检查和安装包下载 | Tauri updater，地址配置在 `src-tauri/tauri.conf.json` | 应用启动或用户检查更新 |

Mermaid、PlantUML 和 Office 预览是本地依赖，不是远程 API。它们通过动态导入加载到 WebView 中。

## 6. Deployment & Infrastructure

**运行时**：桌面端本地运行。Tauri 将 Vite 前端产物嵌入应用包，应用不依赖常驻本地服务器；开发模式使用 Vite `http://localhost:1420`。

**构建命令**：

```bash
npm run tauri dev       # 启动桌面开发环境
npm run build           # TypeScript 类型检查和 Vite 生产构建
npm run tauri build    # 构建 Tauri 安装包
```

**发布平台**：GitHub Actions 在推送 `v*.*.*` 标签后构建 Windows NSIS/MSI 和 macOS App/DMG。`build-update.yml` 生成构建产物和更新工件，`publish-update.yml` 负责手动发布已经填写更新日志的草稿版本。

**更新源**：`src-tauri/tauri.conf.json` 指向 GitHub Releases 的 `latest.json`，并配置 Tauri updater 公钥。当前 Apple 签名/公证在 CI 配置中尚未启用。

**日志和监控**：项目没有服务端监控、集中式日志或后台任务系统。错误主要在前端状态和 Rust 命令返回的 `Result<_, String>` 中展示。

## 7. Security Considerations

### 7.1. Workspace Boundary

所有工作区文件访问都应经过 `workspace_entry_path` 或其派生函数。Rust 会对根目录和目标路径执行 `fs::canonicalize`，确认根路径是目录、目标存在且位于根目录内；文件命令还会确认目标是普通文件并按扩展名限制 Markdown、图片、HTML 或 Office 类型。创建和重命名名称会拒绝空名称、`.`、`..` 以及路径分隔符。

资源上传后还会对 `assets/` 目录重新规范化，并再次确认它位于工作区根目录内。前端的相对路径解析只用于定位，不能替代 Rust 的边界校验。

### 7.2. Credentials and External Content

- OSS AccessKey Secret 不写入 JSON，而是使用系统 Keyring；但同步时凭据会进入前端 OSS 客户端的运行时内存。
- 外部视频使用 iframe，加载会将用户连接到第三方平台；应用不承诺这些平台的隐私或内容安全。
- 本地 HTML 内嵌预览使用 `sandbox="allow-scripts"`，并设置 `no-referrer`；HTML 是用户工作区内容，仍应视为可执行的主动内容。
- Mermaid 使用 `securityLevel: "strict"`，避免把图表内容当作不受限 HTML 执行。
- `tauri.conf.json` 当前将 CSP 设为 `null`。如果未来扩大 HTML、外链或脚本能力，应优先收紧 CSP，并重新审查外部 iframe、资源和更新源的允许列表。

### 7.3. Trust Model and Data Loss

应用假设用户选择的工作区和其中内容是用户信任的本地数据。没有账号鉴权或多用户权限模型。文件删除不可恢复，自动保存直接覆盖原文件，也没有内置历史版本或备份；重要资料应由用户自行备份。

## 8. Development & Testing Environment

**本地要求**：Node.js、Rust 和当前平台所需的 Tauri 依赖。安装依赖使用 `npm ci`，然后运行 `npm run tauri dev`。

**验证命令**：

```bash
npm run build
npm run test:updates
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

**测试范围**：

- `tests/contentWidth.test.mjs`：内容宽度配置行为。
- `tests/updates.test.mjs`：更新控制器和更新前保存队列。
- `src-tauri/src/lib.rs` 内的 Rust 测试：扩展名识别、路径边界、创建/删除/重命名、资源上传和 OSS 配置等。
- 前端没有独立的浏览器端到端测试框架，涉及 UI 的改动需要在 Tauri 桌面开发环境手动验证。

**代码质量工具**：TypeScript 编译器、Vite 构建、Rustfmt 和 Clippy。当前 `package.json` 没有单独的 ESLint 脚本。

## 9. Future Considerations / Roadmap

以下是当前架构的明确边界或后续评估项，不代表已经承诺实现：

- `App.tsx` 和 `src-tauri/src/lib.rs` 集中了较多编排逻辑；随着功能增加，可按领域拆分，但拆分不应破坏 Tauri 命令与前端类型的对应关系。
- OSS 当前是单向上传，没有下载、冲突检测和历史版本；若增加双向同步，需要先定义冲突模型、删除语义和凭据/隐私策略。
- 当前没有全文搜索、Git 集成、云端协作、多工作区或 Markdown 历史版本；这些能力会改变状态模型和存储边界，不能直接叠加到现有自动保存流程上。
- 本地 HTML 拖放在 Tauri 桌面环境仍有已记录问题，见 [`KNOWN_ISSUES.md`](../KNOWN_ISSUES.md)。
- 若继续增加外部内容能力，应收紧当前 `CSP: null` 配置，并明确每种外部来源的权限、隐私和失败处理。

## 10. Project Identification

**项目名称**：SuperWiki

**项目定位**：免费、本地优先的个人 Markdown 知识库桌面应用。

**仓库地址**：[github.com/sinceHYJ/superwiki](https://github.com/sinceHYJ/superwiki)

**当前版本**：`0.8.3`（`package.json`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json` 保持一致）

**主要技术栈**：Tauri 2、Rust、React 19、TypeScript、Vite 7、Milkdown Crepe 7、react-markdown、remark-gfm。

**维护者/团队**：仓库当前未声明独立团队或主要联系人。

**文档最后更新**：2026-09-16

## 11. Glossary / Acronyms

| 术语 | 说明 |
| --- | --- |
| 工作区（Workspace） | 用户在应用中主动选择的本地文件夹及其递归内容。 |
| Tauri 命令 | 由 Rust 暴露、前端通过 `invoke` 调用的本地能力函数。 |
| WebView | Tauri 窗口中承载 React 前端的系统 Web 内容渲染环境。 |
| WYSIWYG | What You See Is What You Get，即所见即所得编辑模式。 |
| Markdown | 文档在磁盘上的主要持久化格式，扩展名为 `.md` 或 `.markdown`。 |
| GFM | GitHub Flavored Markdown，项目通过 `remark-gfm` 支持表格、任务列表和删除线等扩展。 |
| OSS | Alibaba Object Storage Service，对应项目中的可选远端同步目标。 |
| Blob URL | 前端由二进制数据创建的临时 URL，用于在 WebView 中预览本地图片或 HTML。 |
| Keyring | 操作系统提供的凭据安全存储，用于保存 OSS AccessKey Secret。 |
| `loadedContent` | 前端记录的最近一次成功读取或保存的文档内容，用于跳过无变化写入。 |
