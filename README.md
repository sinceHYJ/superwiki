# SuperWiki

一个基于 Tauri 2（Rust）与 React + TypeScript 的本地 Markdown 文件夹编辑器。

## 功能

- 打开任意本地文件夹并按可折叠树形结构展示
- 未打开文件夹时显示明确的打开目录引导
- 点击本地 `.md` / `.markdown` 文件直接编辑并保存
- CodeMirror Markdown 编辑
- 编辑、分栏、预览三种视图
- 500ms 防抖自动保存，切换文件前立即保存
- 自动恢复上次打开的文件夹

## 开发

```bash
npm install
npm run tauri dev
```

## 检查

```bash
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```
