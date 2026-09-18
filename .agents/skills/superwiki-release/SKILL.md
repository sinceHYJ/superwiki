---
name: superwiki-release
description: 通过 GitHub Actions 发布 SuperWiki 桌面客户端。用于用户要求对比上个版本后的 Git 提交、升级版本号、提交版本改动、创建并推送发布标签。推送 vX.Y.Z 标签后由 GitHub Actions 构建并创建草稿发布。仅适用于 SuperWiki 仓库。
---

# SuperWiki 客户端发布

按固定顺序完成：检查仓库 → 对比版本差异 → 确认新版本 → 同步版本号 → 验证 → 使用 `git-commit` 提交 → 创建标签 → 推送分支和标签。

## 发布模型

- 本地不打包，不运行 `build.sh`。项目根目录也不再要求存在 `build.sh`。
- 推送稳定标签 `vX.Y.Z` 会触发 `.github/workflows/build-update.yml`：GitHub Actions 在 Windows 和 macOS 上构建产物，并创建 GitHub 草稿发布。
- 草稿发布创建后，用户需要在 GitHub 填写更新日志，再手动运行 `Publish update` 工作流完成正式发布。
- GitHub Actions 当前仅支持稳定版标签 `vX.Y.Z`。不要使用预发布版或带构建元数据的 SemVer 标签；`scripts/update-release.mjs check-tag` 会拒绝它们。

## 约束

- 仅在仓库根目录包含 `package.json`、`src-tauri/tauri.conf.json` 和 `src-tauri/Cargo.toml` 时执行。
- 不自动提交发布前已经存在的未提交改动。若 `git status --short` 非空，列出文件并暂停，让用户先提交或暂存；禁止自行 `git add -A`、`git stash`、丢弃或混入这些改动。
- 不修改业务代码，不顺带重构构建或发布脚本。
- 新版本必须是递增的稳定版 `X.Y.Z`，例如 `0.2.0` 或 `1.0.0`。
- 五处版本必须一致：`package.json`、`package-lock.json` 根包、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 中的 `superwiki` 包。
- 提交必须使用 `git-commit` 技能，并且只能包含本次会话修改的版本文件。
- 标签和分支推送是本技能发布流程的一部分；仅推送当前分支和指定标签，禁止 force push。

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

优先选择当前 `HEAD` 可达的最新稳定标签：

```bash
git tag --merged HEAD --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-version:refname
```

取第一个完整匹配 `vX.Y.Z` 的标签。不要把非版本标签或预发布标签当作发布基准。

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

若范围内没有提交，不升级版本、不提交、不创建或推送标签。

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

任一验证失败都停止，不提交、不创建或推送标签。报告失败命令、直接错误和建议修复方法；保留版本文件修改供用户检查。

### 6. 使用 `git-commit` 提交版本文件

先确认差异只包含预期版本文件：

```bash
git diff -- package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git status --short
```

调用 `git-commit` 技能，按其会话范围和暂存检查规则，仅提交以下版本文件：

```text
package.json
package-lock.json
src-tauri/tauri.conf.json
src-tauri/Cargo.toml
src-tauri/Cargo.lock
```

提交信息使用：

```text
chore: 发布 v<new-version>
```

提交后记录提交哈希。若出现其他文件改动，停止并说明，不扩大暂存范围。

### 7. 创建并推送发布标签

提交完成后，先确认本地和远程标签均不存在：

```bash
git rev-parse -q --verify "refs/tags/v<new-version>"
git ls-remote --exit-code --tags origin "refs/tags/v<new-version>"
```

仅当两个检查都确认标签不存在时，创建 annotated tag：

```bash
git tag -a "v<new-version>" -m "SuperWiki v<new-version>"
```

推送版本提交所在分支，再推送指定标签：

```bash
git push origin <current-branch>
git push origin "v<new-version>"
```

标签推送成功即表示 GitHub Actions 构建已被触发。不要以本地构建结果冒充已完成的云端构建；检查 Actions 运行状态并报告链接或状态。

若推送失败，保留本地提交和标签，报告失败命令、远程错误和重试步骤。禁止 force push 或覆盖已有远程标签。

## 最终输出

必须明确给出：

1. 上一个版本基准和本次提交范围；
2. 主要变更摘要；
3. 旧版本 → 新版本；
4. 版本提交哈希；
5. 已推送的标签；
6. GitHub Actions 构建状态或链接；
7. 验证命令结果；
8. 下一步：构建完成后在 GitHub 草稿发布中填写更新日志，并运行 `Publish update` 工作流。

如果中途失败，结论必须写明失败阶段、根因、当前仓库状态和恢复/重试步骤。
