# SQLite 设置迁移验收报告

日期：2026-09-19，macOS Apple Silicon。分支：`codex/move-settings-sqlite`；受测提交：`cdbe702`；应用版本：0.8.3。

**结论：不通过。23 个可修改配置项的常规界面写入均已在真实 SQLite 中核对，但发现 3 项高优先级可靠性缺陷，以及 3 项校验/反馈/检查问题。**

本次仅增加测试入口、回归测试和报告，没有修改业务实现。不能将“写入成功”理解为所有重启、异常恢复和关闭流程均正确。

## 1. 测试方法与现场

| 项目 | 实际执行情况 |
| --- | --- |
| 依据 | 本目录 `spec.MD`、`design.MD`，并对照当前代码 |
| 桌面版本 | 本分支 `npm run tauri dev` 编译的 debug 二进制；为原生自动化访问创建临时 `.app` 外壳，WebView 为 `localhost:1420/`，不是已安装旧版本 |
| 数据库 | `~/Library/Application Support/com.superwiki.app/settings.sqlite3`；测试前不存在，首次启动由当前代码建立 |
| 工作区 A | iCloud 云盘“个人知识库”；只编辑新增的 `SQLITE-QA-20260919.md` |
| 工作区 B | `/tmp/superwiki-sqlite-test-20260919/workspace-b`；同名文档、21 篇 recent 测试文档及重命名测试均在此执行 |
| 修改方式 | 正常用例通过真实界面点击、录入、保存；独立 SQLite 只读连接检查六张表；正常退出并重新启动核对恢复 |
| 故障注入 | 另开 SQLite 连接持有 `BEGIN EXCLUSIVE`，触发 5 秒等待超时；不破坏库文件。快捷键缺陷后用先前测试快照恢复 |
| OSS | 仅虚拟 AccessKey，Endpoint 为 `https://127.0.0.1:8` / `:9`；启用测试在空工作区执行，不上传个人知识库 |
| 数据证据 | `test-evidence.jsonl`，35 份带时间及步骤名的真实数据库快照；Secret 仅保留长度与 SHA-256 |
| 依赖 | `rusqlite 0.40.2`、`libsqlite3-sys 0.38.2`、Tauri Rust 2.11.5、JS API 2.11.1；bundled 头文件标记 SQLite 3.53.2（不是通过应用连接执行 `sqlite_version()` 得到） |

原生自动化中少数点击只改变焦点，已重试并以实际选中项和数据库结果为准。一次目录选择误开 iCloud 根目录，形成工作区 ID 2；未编辑其中内容，此临时记录随测试库一起移出应用目录。A 的 ID 为 3，B 的 ID 为 1。

## 2. 设置页逐项结果

### 2.1 基础、外观与应用标记

| 配置 | 界面操作 | SQLite 结果 | 重启/行为核对 |
| --- | --- | --- | --- |
| 打开的 Tab 数量 | 8 → 3；尝试 0 | `open_tab_limit=3`，0 未写入 | 重启仍为 3；连续打开测试文档时最多保留 3 个 Tab |
| 自动保存 | 开 → 关 → 开；故障恢复后再关 | `auto_save` 正确为 0/1 | 关闭时草稿不落盘，⌘S 后正文落盘并写 recent；开启后正文与 recent 自动保存；重启保持值 |
| 主题色 | 依次选择 mint、coral、lavender、yellow、sky | 每次 `theme_color` 与界面相符 | yellow 重启仍为 yellow，未被历史迁移逻辑覆盖 |
| 内容宽度 | default → full → default | `content_width` 正确更新 | full 重启后仍选中；切回 default 也核对落盘 |
| 主题历史标记（无编辑入口） | 首次初始化、后续修改及重启 | `theme_color_redesign_v1=1` | 全程保持 1，不覆盖用户选色 |
| 关于（非用户配置） | 打开关于页 | 无配置写入要求 | 显示 SuperWiki v0.8.3 |

证据步骤：`initial`、`basic-tab3-auto-off`、`appearance-*`、`auto-save-on`、`personal-auto-save-preview`。

### 2.2 十二个快捷键

下列每项均在设置页真实录入；SQLite `shortcut_overrides` 的 action/chord 一一核对。正常自定义组合重启恢复成功。

| 名称 | action_id | 实际写入 chord | 结果 |
| --- | --- | --- | --- |
| 加粗 | bold | `Mod+Alt+Shift+KeyB` | 通过 |
| 斜体 | italic | `Mod+Alt+Shift+KeyI` | 通过 |
| 行内代码 | inlineCode | `Mod+Alt+Shift+KeyE` | 通过 |
| 代码块 | codeBlock | `Mod+Alt+Shift+KeyC` | 通过 |
| 插入链接 | link | `Mod+Alt+Shift+KeyK` | 通过 |
| 插入图片 | image | `Mod+Alt+Shift+KeyM` | 通过 |
| 保存当前文档 | save | `Mod+Alt+Shift+KeyS` | 通过 |
| 收藏/取消收藏 | favorite | `Mod+Alt+Shift+KeyD` | 通过 |
| 左侧栏 | toggleSidebar | `Mod+Alt+Shift+KeyL` | 通过 |
| 右侧目录 | toggleOutline | `Mod+Alt+Shift+KeyO` | 通过 |
| 编辑/预览切换 | toggleView | `Mod+Alt+Shift+KeyV` | 通过 |
| 只读全屏 | toggleFullscreen | `Mod+Alt+Shift+KeyF` | 通过 |

点击“恢复默认”后覆盖表为 0 行，重启恢复默认绑定。录入复制保留键、已有斜体组合键均提示冲突，数据库保持不变。

**例外：合法互换默认组合键后不能重启，见 F1；非法 chord 未被读取校验拒绝，见 F5。** 本组主要验收持久化；未逐一验证全部编辑器命令的格式转换行为。

证据步骤：`shortcuts-editor-six`、`shortcuts-all-twelve`、`shortcuts-conflict-unchanged`、`shortcuts-reset-default`、`shortcut-swapped-ui-save`。

### 2.3 OSS 七个字段

| 配置 | 实际操作 | SQLite/界面结果 |
| --- | --- | --- |
| 启用状态 | 0 → 1 → 正常重启 → 0 | enabled 正确；重启勾选；空目录提示同步 0 个文件 |
| 区域 | oss-cn-hangzhou → oss-cn-shanghai | region 正确，重启恢复 |
| Endpoint | https://127.0.0.1:9 → 127.0.0.1:8 | 保存为 https://127.0.0.1:8，协议规范化及恢复正确 |
| Bucket | superwiki-sqlite-qa → superwiki-sqlite-qa-two | bucket 正确，重启恢复 |
| 远端目录 | /sqlite-qa/ → qa-second | 规范化为 sqlite-qa，再更新为 qa-second；`../bad` 被拒绝且原记录不变 |
| AccessKey ID | 第一组虚拟 ID → 第二组虚拟 ID | access_key_id 正确，重启恢复 |
| AccessKey Secret | 首次不填、首次填写、留空、替换 | 首次不填失败且表无记录；填写后长度/hash 匹配；留空修改其他字段保留旧 hash；替换后 hash 正确改变 |

首次虚拟 Secret：长度 33，SHA-256 `a5c5f8c8cd36020fdc0c4e824e733ff8e52094a7baa248316f76ef5db4e204f7`；替换后长度 22，SHA-256 `d5283873b17be369d172274993c52b3237fe39ff4c77d809b1102efb220bd9e6`。两者均与预期测试输入独立计算结果相同。

界面说明明确写“本地 SQLite 配置数据库”，重启显示“已保存；留空则不修改”，不回显 Secret。未用真实 OSS 凭据，因此**真实测试连接、实际上传成功不列为通过**。已静态确认 OSS 客户端经专用命令读取 SQLite 凭据。

证据步骤：`oss-missing-secret-rejected`、`oss-initial-save`、`oss-all-fields-secret-retained`、`oss-endpoint-secret-replaced`、`oss-enabled`、`oss-disabled-invalid-prefix-rejected`。

## 3. 需求验收场景

| 场景 | 结果 | 证据/说明 |
| --- | --- | --- |
| 首次无库初始化 | 通过 | 默认 8/自动保存开/sky/default，五个列表或配置表为空，版本 1 |
| 多工作区保存及重启 | 通过 | 所有工作区行保持；last_workspace_id 单独更新 |
| 新路径分配独立 ID | 通过 | B=1、A=3；路径唯一 |
| 重开同路径复用 ID | 通过 | A/B 多次打开及重启后未重复生成 |
| 关闭工作区不删记录 | 通过 | last ID=NULL，workspaces/favorite/recent 保留 |
| 关闭后重启不恢复目录 | 通过 | 重启为未选择文件夹 |
| 已记录目录无法访问 | 通过 | 临时移走 B 后重启提示文件不存在；列表、last ID、recent 不被删除 |
| A/B 同名收藏、recent 隔离 | 通过 | 两个 workspace_id 各有独立同名记录；B 取消收藏不影响 A |
| A 关闭、切换、重启后恢复 | 通过 | A 的收藏及 recent 均恢复 |
| 仅浏览不产生 recent | 通过 | A 收藏但未保存时 recent 为空；手动保存后出现 |
| 每工作区 recent 最多 20 条 | 通过 | B 连续保存 21 篇，保留 02–21；A 仍保留一条 |
| 文件重命名更新关联 | 正常通过，异常失败 | 正常时两表同步新路径并保留时间；锁失败时见 F3 |
| 已成功配置正常退出后恢复 | 正常通过，特例失败 | 基础/外观/全部常规快捷键/OSS 恢复；互换快捷键见 F1 |
| 保存期间禁用重复提交 | 已测基础项通过 | 锁定期间数字输入及自动保存开关禁用；未穷举每个控件同事件周期重入 |
| 保存失败提示、重试 | 部分通过 | 有明确 database is locked，旧 DB 值保留，无自动补交；草稿与错误清理见 F4 |
| 保存期间阻止系统关闭 | 失败 | 锁定提交后立即 ⌘W 仍退出，见 F2 |
| 启动读取失败阻断 | 通过 | 加载期没有主界面，超时只有错误和重试，无默认值绕过 |
| 重试仍失败 | 通过 | 保持阻断，数据库数据未变 |
| 解锁后重试成功 | 通过 | 恢复工作区及已保存设置 |
| 已有旧 JSON 不导入、不改写 | 通过 | 新库 OSS 初始为空；两个旧 JSON 测试前后 SHA-1 校验一致 |
| 不访问旧 localStorage/keyring | 静态检查通过 | 业务源文件未发现旧读写入口；未单独植入 localStorage/keychain 哨兵或追踪系统调用 |
| Markdown/图片不迁入库 | 通过 | 六表只存配置/文档相对路径；正文保存在文件，图片只读预览 |

UI 回归已覆盖：无工作区引导、目录展开/收起时子节点出现/消失、所见即所得标题/粗体/列表、编辑→预览即时内容同步、图片只读、Tab 数量限制。大目录输入性能、全部语法高亮、长文档滚动、跨平台路径专项与安装更新中的并发关闭未在本轮完整执行，不能算作通过。当前界面只有编辑/预览切换，未把旧指南提及的“三种模式”当作已经完成的测试。

## 4. 缺陷及修复建议

### F1 — P1：合法快捷键互换导致整个应用无法启动

复现：默认配置下依次将加粗改为 `⌘⌥B`、斜体改为 `⌘B`、加粗改为 `⌘I`。每次界面接受并保存，最终数据库只有 `bold=Mod+KeyI`、`italic=Mod+KeyB`，二者并不重复。正常退出重启后出现“快捷键‘加粗’配置无效：与‘斜体’冲突”，重试仍失败，无法进入设置修复。

根因：`src/shortcuts.ts:129` 从默认集合开始，逐项覆盖时立即检查冲突；处理 bold 时 italic 仍是旧默认 `Mod+KeyI`。`src/settingsStore.ts:85` 将该错误传播给启动门控。

方案：先合并完整覆盖集合，再对最终集合统一检查 action、chord 格式、保留键和重复键，不能在合并中间状态判断冲突。新增回归测试已失败复现，不应删除或跳过测试掩盖问题。

### F2 — P1：配置保存期间系统关闭保护被另一监听器绕过

复现：数据库持有排他锁，在基础设置点击自动保存开关，立即 `⌘W`。控件已进入保存禁用状态，应用仍退出；数据库仍是旧值。已再次执行“点击后立即 ⌘W”的组合操作确认。

根因：`src/App.tsx:578` 和 `src/AppUpdater.tsx:36` 各注册一个 `onCloseRequested`。前者在配置保存期间 preventDefault，后者在非安装状态不阻止。锁定的 JS API 2.11.1 中，每个监听回调独立创建 `CloseRequestedEvent`，任一回调未阻止便调用 `destroy()`；一个监听器的阻止不影响另一个。

方案：复用官方 API，由唯一关闭监听器统一判断“配置保存中或更新安装中”；自绘关闭也遵循同一判断，避免使用独立 `destroy()` 绕过安装保护。

版本核对：官方发布索引列出的稳定版本为 Tauri 2.11.5 / JS API 2.11.1，项目已对齐；未发现“升级即可修复项目两个独立监听器”的发布说明或完全对应社区补丁。这里应修正项目接入，不能据相关 macOS issue 推断框架升级会自动解决。

参考：[官方 API](https://tauri.app/reference/javascript/api/namespacewindow/#oncloserequested)、[官方源码](https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/packages/api/src/window.ts)、[Rust 2.11.5 发布说明](https://tauri.app/release/tauri/v2.11.5/)、[JS API 2.11.1 发布说明](https://tauri.app/release/@tauri-apps/api/v2.11.1/)。本地实际依据为 `node_modules/@tauri-apps/api/window.js:1632`。

### F3 — P1：重命名后 SQLite 失败，缺少元数据恢复入口

复现：对已收藏并有 recent 的 `QA-renamed.md` 加数据库排他锁，界面重命名为 `QA-remap-failed.md`。文件实际改名成功，但界面报“无法重命名文件：…database is locked”；数据库两表仍为旧路径。解除锁后没有“只重试记录更新”入口。重开 B 后，收藏由 1 变 0，recent 由 20 变 19。

根因：`src/App.tsx:1023` 将文件系统成功和元数据写入放在同一 try/catch，错误统一表述为重命名失败；没有保留路径参数及独立重试入口。之后 `read_workspace_preferences` 的失效裁剪删除旧路径记录。

方案：明确区分“文件已改名”与“记录更新失败”，保留本次旧/新路径，提供仅重试 `remap_workspace_documents` 的入口；待处理时避免裁剪该关联。符合设计 7.4，无需重复执行文件改名或引入后台重试框架。

### F4 — P2：即时设置失败没有保留草稿，重试成功后残留旧错误

复现：锁定数据库，关闭自动保存，等待超时。报错但开关回到开启，没有设计要求的未保存选择与重新提交入口。解锁后再次点击保存成功，DB 为 0，旧“自动保存配置失败”提示仍在。

根因：`src/App.tsx:778` 等事件只维护已提交值；catch 设全局 error，成功路径没有清除此项旧错误，也没有独立表单草稿。

方案：按设计 7.3 保留本项草稿及错误状态，重试成功后清除对应错误；不得显示旧错误误导用户。现有数据库未被错误覆盖，这是通过的部分。

### F5 — P2：非法快捷键字符串通过读取校验

自动化复现：`readShortcutBindings({ bold: "invalid-chord" })` 成功返回，未抛错。该值永远不会由正常键盘组合生成，但可能来自损坏或手动修改的配置库。

根因：`src/shortcuts.ts:129` 仅检查冲突，没有检查 chord 语法；Rust 保存侧也只检查非空。设计 4.2 要求无效 chord 导致配置读取失败。

方案：使用与键盘录入一致的 chord 有效值规则验证完整读取结果，遇到非法字符串显式报错。此项为生产解析器单测复现，未将非法字符串注入实际桌面测试库。

### F6 — P2：Rust 严格静态检查失败

`cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` 返回 101：`src-tauri/src/lib.rs:8` 的 `use tauri::Manager;` 未使用。

方案：移除该无用导入后重新执行检查。本次是测试任务，没有顺手修改业务文件。设计 11.4 的旧“clippy 已通过”记录不能代替当前分支结果。

## 5. 自动化检查

| 命令 | 结果 |
| --- | --- |
| `npm run build` | 通过；有既有的 PlantUML url 模块外部化、chunk 大小警告 |
| `npm run test:updates` | 8/8 通过 |
| `node --test tests/contentWidth.test.mjs` | 2/2 通过 |
| `npm run test:settings`（本次新增） | 4/6 通过，F1/F5 两项失败 |
| 三份 Node 测试合并运行 | 共 16 项，14 通过、2 失败，退出码 1 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 19/19 通过，其中 settings 模块只有 3 项，并非设计列出的完整 Rust 场景 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` | 失败，见 F6 |
| SQLite 完整性 | 所有 35 个快照及最终库 `integrity_check=ok`，user_version=1 |

设计文档原先提到的 `index.html`、`scripts/update-release.mjs` 缺失，本分支测试时已经不存在该阻塞；构建和更新测试确实执行成功。

## 6. 未覆盖范围与后续验收

| 范围 | 状态及原因 |
| --- | --- |
| 真实 OSS 连接和上传成功 | 未执行；没有使用或申请真实凭据，未向远端发送个人知识库 |
| Windows/Linux 系统关闭、路径大小写及盘符 | 本轮仅 macOS，需对应平台执行 |
| 损坏文件、缺表、非法版本、不可写目录等启动组合 | 本轮用真实数据库锁覆盖读取失败/重试主流程，未穷举其他故障类型 |
| 更新安装中退出、全部配置乱序回包、快速 A/B 竞态 | 未完成完整动态压力测试；代码仍缺少部分设计中的 workspaceId 回包保护，需专门测试，不能宣称已复现串数据 |
| 文件永久删除、全部目录重映射及特殊路径组合 | 未执行不可恢复删除；正常文件重命名与失败路径已覆盖，目录 `%/_`、符号链接边界等仍需专项 |

建议先修复 F1–F3，再运行新增回归测试并重做相应桌面用例；同时解决 F4–F6 后再判定是否满足发布验收。`test:settings` 当前有意保留失败断言，作为缺陷的可执行证据，不是已通过的测试套件。

## 7. 现场恢复及文件改动

应用测试进程和本次启动的 Vite/开发进程已停止；测试库移到 `/tmp/superwiki-sqlite-test-20260919/final-tested.sqlite3`，应用目录恢复为测试前无 `settings.sqlite3` 的状态。下一次运行本分支将重新初始化默认配置。旧 JSON 校验未变化；未触碰系统凭据库。

个人知识库新增测试文档已移出到 `/tmp/superwiki-sqlite-test-20260919/personal-test-document.md`。测试前 1128 个文件逐一复核：**1127 个原文件内容相同、无文件缺失、无新增文件残留**；仅 Finder 元数据 `.DS_Store` 因系统目录选择器访问发生变化。原有笔记与资源均未修改。

仓库改动仅为：

- `package.json`：增加 `test:settings` 命令。
- `tests/settings.test.mjs`：6 个生产快捷键解析器回归测试。
- 本报告及 `test-evidence.jsonl`：验收结果与脱敏数据库快照。

用户原有未跟踪目录 `docs/specs/sync/` 保持不动。未创建提交、未升级依赖、未修改业务实现。
