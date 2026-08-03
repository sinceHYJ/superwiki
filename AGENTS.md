# SuperWiki Agent 指南

## 1. 项目定位

SuperWiki 是一个纯本地桌面 Markdown 文件夹编辑器，采用：

- **桌面容器与本地能力**：Tauri 2
- **本地文件服务层**：Rust
- **界面层**：React 19 + TypeScript + Vite
- **Markdown 编辑器**：CodeMirror 6
- **Markdown 渲染**：react-markdown + remark-gfm

项目没有独立 HTTP 服务、数据库、账号系统或云端同步。所有文件读取和写入均发生在用户主动选择的本地文件夹内。

## 2. 总体架构

```text
用户
  │
  ├─ 选择本地文件夹
  │    └─ @tauri-apps/plugin-dialog
  │
  ▼
React / TypeScript 前端（src/）
  ├─ 文件夹树展示
  ├─ 当前文件和视图状态
  ├─ CodeMirror Markdown 编辑
  ├─ react-markdown 实时预览
  └─ 500ms 防抖自动保存
          │
          │ Tauri invoke
          ▼
Rust 本地文件服务（src-tauri/src/lib.rs）
  ├─ list_workspace
  ├─ read_workspace_file
  ├─ save_workspace_file
  ├─ 路径规范化与根目录边界检查
  └─ std::fs 本地文件读写
          │
          ▼
用户选择的本地文件夹
```

## 3. 目录结构

```text
superwiki/
├── src/
│   ├── App.tsx             # 主界面、目录树、编辑器、预览和自动保存
│   ├── App.css             # 应用布局、目录树和 Markdown 样式
│   ├── main.tsx            # React 入口
│   └── vite-env.d.ts
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs          # Rust 文件服务和 Tauri 命令注册
│   │   └── main.rs         # 桌面程序入口
│   ├── capabilities/
│   │   └── default.json    # Tauri 权限声明
│   ├── Cargo.toml
│   └── tauri.conf.json
├── public/                 # 前端静态资源
├── package.json
└── vite.config.ts
```

## 4. 前端职责

主要文件：`src/App.tsx`

### 4.1 工作区状态

- `workspace`：当前打开文件夹的完整树结构。
- `activeFile`：当前正在编辑的 Markdown 文件。
- `content`：编辑器当前内容。
- `viewMode`：`editor`、`split` 或 `preview`。
- `saveState`：`saved`、`saving` 或 `error`。
- `superwiki.workspaceRoot`：保存在 `localStorage` 中的上次打开目录。

### 4.2 文件夹选择

前端通过 `@tauri-apps/plugin-dialog` 打开系统目录选择器：

```ts
open({ directory: true, multiple: false })
```

选择完成后调用 Rust 的 `list_workspace`，前端不能自行读取本地文件系统。

### 4.3 目录树

- 文件夹使用原生 `<details>/<summary>` 展开和收起。
- 连续点击中 `event.detail > 1` 时阻止第二次默认切换，避免双击后立即恢复原状态。
- 所有文件均可显示，但只有 `.md` 和 `.markdown` 文件可以点击编辑。
- 不要重新改成通过普通按钮反转 React 布尔状态的实现。

### 4.4 文件保存

- 内容修改后 500ms 自动保存。
- 切换文件、切换文件夹或关闭工作区前必须调用 `flushPendingSave`。
- `loadedContent` 表示最近一次成功读取或保存的内容，用于避免无变化写入。
- 保存失败时必须保留当前编辑内容并显示错误，不能静默丢弃。

### 4.5 编辑与预览布局

右侧工作区的滚动边界依赖以下约束：

```css
.workspace {
  min-height: 0;
  overflow: hidden;
}

.editor-layout {
  min-height: 0;
  overflow: hidden;
}

.preview-pane {
  overflow: auto;
}
```

不要移除 `.workspace` 或 `.editor-layout` 的 `min-height: 0`，否则长 Markdown 预览会被内容撑高并失去内部滚动能力。

## 5. Rust 文件服务职责

主要文件：`src-tauri/src/lib.rs`

### 5.1 数据结构

Rust 返回的数据使用 Serde 序列化：

- `WorkspaceTree`：根目录路径、目录名称和子节点。
- `FileTreeNode`：名称、绝对路径、节点类型、是否为 Markdown、子节点。
- `FileTreeNode` 使用 `#[serde(rename_all = "camelCase")]` 与 TypeScript 字段对齐。

### 5.2 Tauri 命令

#### `list_workspace`

```text
输入：root: String
输出：WorkspaceTree
```

职责：

- 规范化根目录路径。
- 验证路径是文件夹。
- 递归读取目录。
- 文件夹排在文件之前，同类节点按名称排序。

#### `read_workspace_file`

```text
输入：root: String, path: String
输出：String
```

职责：验证路径安全后，以 UTF-8 文本读取 Markdown 文件。

#### `save_workspace_file`

```text
输入：root: String, path: String, content: String
输出：()
```

职责：验证路径安全后，将内容写回现有 Markdown 文件。

### 5.3 路径安全约束

所有文件读取和写入必须经过 `workspace_file_path`：

1. 对根目录和目标文件执行 `fs::canonicalize`。
2. 根路径必须是目录。
3. 文件路径必须以规范化后的根路径开头。
4. 目标必须是现有普通文件。
5. 扩展名必须是 `.md` 或 `.markdown`，且不区分大小写。

禁止：

- 直接信任前端传入的文件路径。
- 绕过 `workspace_file_path` 读写文件。
- 允许 `../`、符号链接或其他方式访问根目录之外的文件。
- 将任意非 Markdown 文件作为 UTF-8 文本覆盖。

## 6. 当前功能边界

当前支持：

- 打开和记住一个本地文件夹。
- 树形展示目录。
- 读取、编辑和保存已有 Markdown 文件。
- 编辑、分栏和预览模式。
- GFM 表格、任务列表、删除线等 Markdown 扩展。

当前不支持，除非用户明确要求，不要自行增加：

- 新建、删除、重命名或移动文件。
- 多工作区或多标签页。
- 全文搜索。
- 图片资源管理。
- Git 集成或云同步。
- 非 Markdown 文件编辑。
- HTTP API、数据库或后台常驻服务。

## 7. 修改原则

- 所有回答使用中文。
- 优先做最小、可验证的修改。
- 不重构与当前需求无关的代码。
- 前端类型字段必须与 Rust Serde 输出保持一致。
- 新增 Tauri 命令时，同时完成：
  1. Rust 命令实现。
  2. `generate_handler!` 注册。
  3. 必要的 capability 权限。
  4. TypeScript 调用和类型定义。
  5. Rust 测试或前端构建验证。
- 不要通过前端 Node API、浏览器 File System API 或未授权插件绕过 Rust 文件服务层。

## 8. 开发与验证命令

安装依赖：

```bash
npm install
```

启动桌面应用：

```bash
npm run tauri dev
```

前端类型检查与生产构建：

```bash
npm run build
```

Rust 格式检查：

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

Rust 测试：

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Rust 静态检查：

```bash
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

涉及界面修改时，至少验证：

1. 未打开文件夹时的引导页。
2. 目录展开和收起。
3. Markdown 文件切换前保存。
4. 编辑、分栏、预览三种模式。
5. 长文档预览可以独立滚动。

## 9. Git 约定

- 默认分支：`main`。
- Commit Message 格式：`<type>: <description>`。
- 常用类型：`feat`、`fix`、`refactor`、`test`、`docs`、`chore`。
- `node_modules/`、`dist/` 和 `src-tauri/target/` 不得提交。
