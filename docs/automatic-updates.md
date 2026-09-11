# 自动更新与发布

客户端每次启动检查一次稳定版，不轮询。顶部更新按钮可手动检查；发现版本只显示红点。用户下载后，点击“保存并安装重启”才会安装。关闭弹窗不会中断下载；退出应用后不保留下载进度。

## 首次配置

1. 更新签名公钥保存在 `src-tauri/tauri.conf.json`。配套私钥生成在维护者电脑的 `~/.tauri/superwiki-updater.key`，不进入仓库。请备份此文件；已安装的客户端只信任对应公钥，不能直接替换成另一把密钥。
2. 仓库 Secret `TAURI_SIGNING_PRIVATE_KEY` 保存私钥内容。当前首次配置已完成；生成的私钥没有密码，`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 可不设置。如以后使用加密密钥，应同时配置密码 Secret。
3. macOS 正式分发建议配置 `APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`，以及公证所需的 `APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`。更新签名不等同于 Apple 代码签名或公证；未配置时必须在真实 macOS 机器上确认安装与 Gatekeeper 行为后再发布。
4. 当前更新源为公开仓库 `sinceHYJ/superwiki`。客户端不含 GitHub Token，需要能访问 GitHub Releases。旧 v0.7.1 不含更新器，需先手动安装一次含更新器的新版本。

## 发布步骤

1. 按现有版本流程同步版本文件并完成验证，提交后推送稳定版标签 `vX.Y.Z`。`Build update draft` 会校验标签与版本文件，构建 Windows x64 的 NSIS/MSI 和 macOS Universal 的 app/DMG；签名更新产物单独生成。
2. 两个平台均成功后，汇总产物并创建草稿 Release。Windows 更新使用 NSIS，macOS Intel/Apple Silicon 使用同一个 Universal `.app.tar.gz`。草稿包含安装包、`.sig` 和 `latest.json`。构建不自动公开版本。
3. 在 GitHub 草稿 Release 中填写更新日志并保存草稿。**不要直接点击 Publish release**；运行 Actions → `Publish update`，输入对应标签。该流程把正文写入 `latest.json.notes`，校验版本、平台、附件及签名内容一致后公开 Release，并设为 Latest。
4. 发布后，用含更新器的较低版本在 Windows 和 macOS 分别验收：启动红点、日志、后台下载、全部文档保存、安装重启与新版版本号。首次正式启用之前必须完成这两端验收。

若草稿上传中途失败，先检查该草稿附件。构建流程为防止覆盖已审阅内容，不会覆盖同名 Release；删除失败的草稿后重新运行构建。不要覆盖已公开版本的更新包。发布工作流失败时保留草稿，可修复后重试。

## 本地构建

现有 `build.sh`、`build-windows.ps1` 仍可正常构建普通安装包，无需更新私钥。签名更新产物仅通过叠加 `src-tauri/tauri.release.conf.json` 启用，例如：

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Join-Path $env:USERPROFILE '.tauri/superwiki-updater.key'
npm run tauri build -- --config src-tauri/tauri.release.conf.json
```

macOS 在对应机器上使用相同配置，Universal 构建参数为 `--target universal-apple-darwin --bundles app,dmg`。不应把 DMG 本身作为 updater 的安装产物。

## 验证命令

```text
npm run test:updates
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

新增测试覆盖启动去重、手动检查、预发布过滤、下载失败、进度、安装保存门禁、在途保存顺序、草稿快照及发布清单校验。模拟签名错误测试只能证明客户端阻止继续安装；真实签名校验由官方 updater 执行，需要使用真实更新包补充验收。

参考：[Tauri Updater](https://v2.tauri.app/plugin/updater/)、[JavaScript API](https://v2.tauri.app/reference/javascript/updater/)、[tauri-action](https://github.com/tauri-apps/tauri-action)。
