---
name: superwiki-release
description: 发布和打包 SuperWiki 桌面客户端。用于用户要求打包客户端、发布新版本、升级版本号、比较上个版本后的 Git 提交、生成发布说明，或执行“版本提交后再构建 DMG”的完整发布流程。仅适用于 SuperWiki 仓库。
---

# SuperWiki 客户端发布

按固定顺序完成：检查仓库 → 对比版本差异 → 确认新版本 → 同步版本号 → 验证并提交 → 打包 → 创建版本标签。

## 约束

- 仅在仓库根目录包含 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 和 `build.sh` 时执行。
- 不自动提交发布前已经存在的未提交改动。若 `git status --short` 非空，列出文件并暂停，让用户先提交或暂存；禁止自行 `git add -A`、`git stash`、丢弃或混入这些改动。
- 不执行 `git push`，除非用户明确要求。
- 不修改业务代码，不顺带重构打包脚本。
- 新版本必须符合 SemVer，例如 `0.2.0`、`1.0.0-beta.1`。
- 四处版本必须一致：`package.json`、`package-lock.json` 根包、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`；同时更新 `src-tauri/Cargo.lock` 中 `superwiki` 包版本。
- 只有打包成功后才创建本地版本标签；打包失败时保留版本提交以便排查，但不创建标签、不回滚、不声称发布成功。

## 工作流

### 1. 进入并检查仓库

执行：

```bash
git rev-parse --show-toplevel
git status --short --branch
node .agents/skills/superwiki-release/scripts/sync-version.mjs --check
```

必须从 `git rev-parse` 返回的仓库根目录继续。若工作区不干净或版本不一致，停止并明确说明原因和处理办法。

### 2. 确定上一个版本基准

优先选择当前 `HEAD` 可达的最新 SemVer 标签：

```bash
git tag --merged HEAD --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-version:refname
git tag --merged HEAD --list '[0-9]*.[0-9]*.[0-9]*' --sort=-version:refname
```

取第一个与 SemVer 格式完整匹配的标签。不要把非版本标签当作发布基准。

如果没有版本标签，视为首次规范发布，使用最早一次修改版本文件的提交作为基准：

```bash
git log --reverse --format='%H' -- package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml | head -1
```

若仍找不到基准，停止并说明仓库历史不足，不能可靠比较。

### 3. 汇总距离上个版本的变更

针对 `<base>..HEAD` 执行：

```bash
git log --no-merges --date=short --pretty=format:'%h%x09%ad%x09%s' <base>..HEAD
git diff --stat <base>..HEAD
git diff --name-status <base>..HEAD
```

向用户展示：

- 基准版本标签或基准提交；
- 当前版本；
- 提交数量和提交列表；
- 主要修改文件；
- 按 `feat`、`fix`、`perf`、`refactor`、`docs/test/chore/build/ci` 分类的简短发布摘要。

若范围内没有提交，不升级版本、不提交、不打包。

### 4. 推荐并确认新版本

用户已提供明确版本号时，验证它大于当前版本后使用。否则根据提交推荐：

- 存在 `BREAKING CHANGE` 或提交类型带 `!`：推荐 major；
- 否则存在 `feat`：推荐 minor；
- 其他有效变更：推荐 patch。

必须先展示推荐值及依据，再让用户确认具体版本；不要静默决定版本。用户明确说“按推荐版本继续”或在同一请求中指定版本时，无需重复确认。

### 5. 同步版本号并验证

执行：

```bash
node .agents/skills/superwiki-release/scripts/sync-version.mjs <new-version>
node .agents/skills/superwiki-release/scripts/sync-version.mjs --check
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

任一验证失败都停止，不提交、不打包。报告失败命令、直接错误和建议修复方法；保留版本文件修改供用户检查。

### 6. 仅提交版本文件

先确认差异只包含预期版本文件：

```bash
git diff -- package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git status --short
```

只暂存以下文件：

```bash
git add package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: 发布 v<new-version>"
```

提交后记录提交哈希。若出现其他文件改动，停止并说明，不扩大暂存范围。

### 7. 打包客户端

使用项目现有交互式脚本，不复制其构建逻辑：

```bash
./build.sh
```

- 版本输入直接接受默认值，默认值应等于刚提交的新版本。
- 架构默认选择 Universal；用户明确指定 Apple Silicon 或 Intel 时按用户选择。
- 签名默认选择正常构建；仅当用户明确要求本地测试或跳过签名时选择 `--no-sign` 对应选项。
- 通过 PTY 运行并按提示输入，不改写 `build.sh`。
- 完成后确认输出的 `.dmg` 文件真实存在，并报告绝对路径、文件大小和 SHA-256：

```bash
ls -lh <dmg-path>
shasum -a 256 <dmg-path>
```

### 8. 打包成功后创建本地标签

确认标签尚不存在后创建 annotated tag：

```bash
git rev-parse -q --verify "refs/tags/v<new-version>"
git tag -a "v<new-version>" -m "SuperWiki v<new-version>"
```

若标签已存在，停止并报告冲突，不覆盖标签。除非用户明确要求，否则不要 push commit 或 tag。

## 最终输出

必须明确给出：

1. 上一个版本基准和本次提交范围；
2. 主要变更摘要；
3. 旧版本 → 新版本；
4. 版本提交哈希；
5. 本地标签；
6. DMG 绝对路径、大小和 SHA-256；
7. 验证命令结果；
8. 是否需要用户继续执行 `git push` 和 `git push origin v<new-version>`。

如果中途失败，结论必须写明失败阶段、根因、当前仓库状态和恢复/重试步骤。
