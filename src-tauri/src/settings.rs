//! 应用设置 SQLite 存储：初始化数据库，并提供工作区、收藏、最近编辑、快捷键和 OSS 配置的读写。
//! 本模块只能通过 Rust 侧 Tauri 命令调用；前端不得直接访问数据库。

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

/// 当前 SQLite 架构版本；启动时可从版本 1、2 升级，其他未知版本拒绝读写。
const SCHEMA_VERSION: i64 = 3;
/// 每个工作区保留的最近编辑 Markdown 文档上限。
const MAX_RECENT_DOCUMENTS: i64 = 20;
/// 可持久化覆盖的快捷键动作标识；不在此列表中的键会被拒绝。
const SHORTCUT_IDS: &[&str] = &[
    "bold",
    "italic",
    "inlineCode",
    "codeBlock",
    "link",
    "image",
    "save",
    "favorite",
    "toggleSidebar",
    "toggleOutline",
    "toggleView",
    "toggleFullscreen",
];

/// 应用级偏好设置，序列化后供前端恢复界面状态。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppPreferences {
    /// 可同时打开的页签数量上限，必须为正整数。
    open_tab_limit: i64,
    /// 是否在下次启动时自动打开上次工作区；默认开启。
    auto_open_last_workspace: bool,
    /// 是否启用编辑器自动保存。
    auto_save: bool,
    /// 当前主题色标识。
    theme_color: String,
    /// 内容区宽度模式，如 `default` 或 `full`。
    content_width: String,
    /// 是否启用新版主题色设计。
    theme_color_redesign_v1: bool,
    /// 最近打开工作区的数据库 ID；`None` 表示无工作区。
    last_workspace_id: Option<i64>,
}

/// 工作区在数据库中的稳定标识及其规范化根目录。
#[derive(Serialize)]
pub(crate) struct WorkspaceRecord {
    /// 数据库主键，用于关联工作区偏好。
    pub(crate) id: i64,
    /// 工作区规范化后的绝对路径。
    pub(crate) path: String,
}

/// 收藏或最近编辑记录转换为前端模型前的内部文档表示。
struct StoredDocument {
    /// 所属工作区根目录。
    root: String,
    /// 文档绝对路径。
    path: String,
    /// 用于界面展示的文件名。
    name: String,
    /// 相对于工作区根目录、以 `/` 分隔的路径。
    relative_path: String,
    /// 收藏或编辑发生的 Unix 毫秒时间戳。
    timestamp: i64,
}

/// 前端展示的收藏 Markdown 文档。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FavoriteDocument {
    /// 所属工作区根目录。
    root: String,
    /// 文档绝对路径。
    path: String,
    /// 展示文件名。
    name: String,
    /// 工作区内相对路径。
    relative_path: String,
    /// 收藏时间的 Unix 毫秒时间戳。
    favorited_at: i64,
}

/// 前端展示的最近编辑 Markdown 文档。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecentDocument {
    /// 所属工作区根目录。
    root: String,
    /// 文档绝对路径。
    path: String,
    /// 展示文件名。
    name: String,
    /// 工作区内相对路径。
    relative_path: String,
    /// 最近编辑时间的 Unix 毫秒时间戳。
    edited_at: i64,
}

/// 单个工作区的收藏与最近编辑偏好。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspacePreferences {
    /// 工作区数据库主键。
    pub(crate) workspace_id: i64,
    /// 工作区规范化后的绝对路径。
    pub(crate) root: String,
    /// 按收藏时间倒序排列的现存 Markdown 文档。
    pub(crate) favorites: Vec<FavoriteDocument>,
    /// 按编辑时间倒序排列的现存 Markdown 文档。
    pub(crate) recent: Vec<RecentDocument>,
}

/// 不包含明文密钥的 OSS 配置，用于安全地回显到前端。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OssSyncSettings {
    /// OSS 区域标识。
    pub(crate) region: String,
    /// 规范化后的 OSS Endpoint。
    pub(crate) endpoint: String,
    /// OSS Bucket 名称。
    pub(crate) bucket: String,
    /// Bucket 内的可选对象前缀。
    pub(crate) prefix: String,
    /// 用于鉴权的 AccessKey ID。
    pub(crate) access_key_id: String,
    /// 数据库中是否已有非空 AccessKey Secret；绝不回传密钥本身。
    pub(crate) has_access_key_secret: bool,
    /// 是否启用 OSS 同步。
    pub(crate) enabled: bool,
}

/// 执行 OSS 同步时使用的完整凭据，仅在 Rust 进程内传递。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OssSyncCredentials {
    /// OSS 区域标识。
    pub(crate) region: String,
    /// 规范化后的 OSS Endpoint。
    pub(crate) endpoint: String,
    /// OSS Bucket 名称。
    pub(crate) bucket: String,
    /// Bucket 内的可选对象前缀。
    pub(crate) prefix: String,
    /// 用于鉴权的 AccessKey ID。
    pub(crate) access_key_id: String,
    /// 用于鉴权的明文 AccessKey Secret，不得记录或回显到前端。
    pub(crate) access_key_secret: String,
}

/// 前端提交的 OSS 配置；密钥为空时保留数据库中的已有密钥。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OssSyncSettingsInput {
    /// OSS 区域标识。
    pub(crate) region: String,
    /// 用户输入的 OSS Endpoint。
    pub(crate) endpoint: String,
    /// OSS Bucket 名称。
    pub(crate) bucket: String,
    /// Bucket 内的可选对象前缀。
    pub(crate) prefix: String,
    /// 用于鉴权的 AccessKey ID。
    pub(crate) access_key_id: String,
    /// 可选的新 AccessKey Secret；`None` 或空白值表示保留旧值。
    pub(crate) access_key_secret: Option<String>,
    /// 是否启用 OSS 同步。
    pub(crate) enabled: bool,
}

/// 前端请求更新单个应用偏好时传入的键和值。
#[derive(Deserialize)]
pub(crate) struct PreferenceChange {
    /// 前端 camelCase 偏好键，仅允许白名单中的值。
    key: String,
    /// 与 `key` 对应的 JSON 值，在写入前会进行类型和枚举校验。
    value: Value,
}

/// 应用启动时一次性返回的全部设置快照。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BootstrapSettings {
    /// 应用级界面偏好。
    preferences: AppPreferences,
    /// 快捷键动作 ID 到组合键字符串的覆盖映射；缺少键代表使用默认值。
    shortcut_overrides: HashMap<String, String>,
    /// 已保存的 OSS 配置；未配置时为 `None`。
    oss_sync: Option<OssSyncSettings>,
    /// 历史打开过的工作区。
    workspaces: Vec<WorkspaceRecord>,
}

/// 返回应用私有目录中的设置数据库路径，并在不存在时创建父目录。
///
/// 参数：`app` 用于解析平台相关配置目录。
/// 返回：设置数据库 `PathBuf`。
/// 错误/副作用：创建配置目录失败时返回错误；可能创建目录。
pub(crate) fn database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法确定应用配置目录：{error}"))?;
    fs::create_dir_all(&config_dir).map_err(|error| format!("无法创建应用配置目录：{error}"))?;
    Ok(config_dir.join("settings.sqlite3"))
}

/// 为连接配置数据库完整性与并发策略。
///
/// 参数：`connection` 为待配置的已打开 SQLite 连接。
/// 返回：成功时为 `()`。
/// 错误/副作用：设置锁等待、日志模式、外键和同步级别；失败时不应继续使用该连接。
fn configure_connection(connection: &Connection) -> Result<(), String> {
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(database_error)?;
    connection
        .pragma_update(None, "journal_mode", "DELETE")
        .map_err(database_error)?;
    connection
        .execute_batch("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;")
        .map_err(database_error)
}

/// 以读写方式打开已初始化的数据库并验证其架构。
///
/// 参数：`path` 必须指向现有设置库。
/// 返回：已配置并已验证架构的 `Connection`。
/// 错误：文件无法打开、连接配置失败、版本或表缺失时返回错误，避免对未知数据库写入。
fn open_existing(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(database_error)?;
    configure_connection(&connection)?;
    validate_schema(&connection, SCHEMA_VERSION)?;
    Ok(connection)
}

/// 验证数据库版本和必需表均与当前程序兼容。
///
/// 参数：`connection` 为待检查的数据库连接，`expected_version` 为当前步骤要求的架构版本。
/// 返回：兼容时为 `()`。
/// 错误：版本或必需表不匹配时返回错误；该检查刻意不执行自动迁移。
fn validate_schema(connection: &Connection, expected_version: i64) -> Result<(), String> {
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(database_error)?;
    if version != expected_version {
        return Err(format!("不支持的配置数据库版本：{version}"));
    }
    for table in [
        "workspaces",
        "app_settings",
        "shortcut_overrides",
        "oss_sync",
        "favorite_documents",
        "recent_documents",
    ] {
        let exists: i64 = connection
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get(0),
            )
            .map_err(database_error)?;
        if exists != 1 {
            return Err(format!("配置数据库缺少数据表：{table}"));
        }
    }
    Ok(())
}

/// 初始化或升级设置数据库，并读取启动快照。
///
/// 参数：`app` 用于定位应用私有数据库目录。
/// 返回：包含应用、工作区和 OSS 设置的 `BootstrapSettings`。
/// 错误/副作用：空库初始化、版本 1 事务升级；未知版本或损坏数据库返回错误。
pub(crate) fn initialize(app: &tauri::AppHandle) -> Result<BootstrapSettings, String> {
    let path = database_path(app)?;
    let mut connection = Connection::open(&path).map_err(database_error)?;
    configure_connection(&connection)?;
    initialize_database(&mut connection)?;
    read_bootstrap(&connection)
}

/// 初始化空库或将版本 1、2 升级为版本 3，保留工作区及全部已有配置。
///
/// 参数：`connection` 为已配置连接；返回：初始化完成时为 `()`。
/// 错误/副作用：未知版本、损坏架构或事务失败时返回错误；迁移失败自动回滚。
fn initialize_database(connection: &mut Connection) -> Result<(), String> {
    let mut version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(database_error)?;
    // 只有空库可以初始化，避免把半成品或旧架构误判为首次运行。
    if version == 0 {
        let user_objects: i64 = connection
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
                [],
                |row| row.get(0),
            )
            .map_err(database_error)?;
        if user_objects != 0 {
            return Err("配置数据库结构不完整，无法自动初始化".into());
        }
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(database_error)?;
        transaction
            .execute_batch(include_str!("settings_schema.sql"))
            .map_err(database_error)?;
        transaction
            .execute("INSERT INTO app_settings(id) VALUES (1)", [])
            .map_err(database_error)?;
        transaction
            .pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)?;
        version = SCHEMA_VERSION;
    }
    // 只升级明确支持的旧版本；事务失败时连同新增列和版本号一起回滚。
    if version == 1 {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(database_error)?;
        validate_schema(&transaction, 1)?;
        transaction.execute_batch(
            "ALTER TABLE app_settings ADD COLUMN auto_open_last_workspace INTEGER NOT NULL DEFAULT 1 CHECK(auto_open_last_workspace IN (0, 1));",
        ).map_err(database_error)?;
        transaction
            .pragma_update(None, "user_version", 2)
            .map_err(database_error)?;
        validate_schema(&transaction, 2)?;
        // 下一步会新增排序字段；此处只验证唯一设置行，避免提前读取不存在的列。
        let settings_count: i64 = transaction
            .query_row(
                "SELECT count(*) FROM app_settings WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .map_err(database_error)?;
        if settings_count != 1 {
            return Err("配置数据库缺少应用设置".into());
        }
        transaction.commit().map_err(database_error)?;
        version = 2;
    }
    // 版本 2 尚未记录重新打开工作区的时间；旧 ID 的递减顺序是可恢复的最接近历史顺序。
    if version == 2 {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(database_error)?;
        validate_schema(&transaction, 2)?;
        transaction.execute_batch(
            "ALTER TABLE workspaces ADD COLUMN last_opened_at INTEGER NOT NULL DEFAULT 0 CHECK(last_opened_at BETWEEN 0 AND 9007199254740991);\
             UPDATE workspaces SET last_opened_at = id;\
             CREATE INDEX workspaces_recent_open_order ON workspaces(last_opened_at DESC, id DESC);",
        ).map_err(database_error)?;
        transaction
            .pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(database_error)?;
        validate_schema(&transaction, SCHEMA_VERSION)?;
        read_bootstrap(&transaction)?;
        transaction.commit().map_err(database_error)?;
    }
    validate_schema(connection, SCHEMA_VERSION)
}

/// 汇总启动主界面所需的全部设置。
///
/// 参数：`connection` 为已验证的数据库连接。
/// 返回：应用偏好、快捷键覆盖、脱敏 OSS 配置与工作区列表。
/// 错误：任一数据库查询失败时返回错误。
fn read_bootstrap(connection: &Connection) -> Result<BootstrapSettings, String> {
    let preferences = read_preferences(connection)?;
    let shortcut_overrides = connection
        .prepare("SELECT action_id, chord FROM shortcut_overrides ORDER BY action_id")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<HashMap<_, _>>>()
        })
        .map_err(database_error)?;
    let workspaces = connection
        .prepare("SELECT id, path FROM workspaces ORDER BY last_opened_at DESC, id DESC")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| {
                    Ok(WorkspaceRecord {
                        id: row.get(0)?,
                        path: row.get(1)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(database_error)?;
    Ok(BootstrapSettings {
        preferences,
        shortcut_overrides,
        oss_sync: read_oss_settings(connection)?,
        workspaces,
    })
}

/// 从唯一的应用设置行读取界面偏好。
///
/// 参数：`connection` 为已验证的数据库连接。
/// 返回：布尔字段从 SQLite 整数转换后的 `AppPreferences`。
/// 错误：设置行缺失或字段类型不正确时返回错误。
fn read_preferences(connection: &Connection) -> Result<AppPreferences, String> {
    connection
        .query_row(
            "SELECT open_tab_limit, auto_save, theme_color, content_width, theme_color_redesign_v1, last_workspace_id, auto_open_last_workspace FROM app_settings WHERE id = 1",
            [],
            |row| {
                Ok(AppPreferences {
                    open_tab_limit: row.get(0)?,
                    auto_save: row.get::<_, i64>(1)? != 0,
                    theme_color: row.get(2)?,
                    content_width: row.get(3)?,
                    theme_color_redesign_v1: row.get::<_, i64>(4)? != 0,
                    last_workspace_id: row.get(5)?,
                    auto_open_last_workspace: row.get::<_, i64>(6)? != 0,
                })
            },
        )
        .map_err(database_error)
}

/// 校验并持久化一个应用级偏好。
///
/// 参数：`app` 用于定位数据库；`change.key` 仅支持预定义键，`change.value` 必须匹配类型和范围。
/// 返回：成功时为 `()`。
/// 错误/副作用：校验失败或写入失败时返回错误；成功时更新应用设置行。
pub(crate) fn update_preference(
    app: &tauri::AppHandle,
    change: PreferenceChange,
) -> Result<(), String> {
    let connection = open_existing(&database_path(app)?)?;
    write_preference(&connection, change)
}

/// 在给定连接上校验并更新单项配置，供 IPC 和数据库测试复用。
///
/// 参数：`connection` 为已验证的设置库；`change` 为待写入的键和值。
/// 返回：成功时为 `()`；错误/副作用：非法值被拒绝，成功时仅更新指定列。
fn write_preference(connection: &Connection, change: PreferenceChange) -> Result<(), String> {
    match change.key.as_str() {
        "openTabLimit" => {
            let value = change
                .value
                .as_i64()
                .filter(|value| *value >= 1)
                .ok_or("打开页签数量必须是正整数")?;
            connection
                .execute(
                    "UPDATE app_settings SET open_tab_limit = ?1 WHERE id = 1",
                    [value],
                )
                .map_err(database_error)?;
        }
        "autoOpenLastWorkspace" => {
            let value = change.value.as_bool().ok_or("自动打开上次工作区配置无效")?;
            connection
                .execute(
                    "UPDATE app_settings SET auto_open_last_workspace = ?1 WHERE id = 1",
                    [i64::from(value)],
                )
                .map_err(database_error)?;
        }
        "autoSave" => {
            let value = change.value.as_bool().ok_or("自动保存配置无效")?;
            connection
                .execute(
                    "UPDATE app_settings SET auto_save = ?1 WHERE id = 1",
                    [i64::from(value)],
                )
                .map_err(database_error)?;
        }
        "themeColor" => {
            let value = change
                .value
                .as_str()
                .filter(|value| matches!(*value, "yellow" | "sky" | "mint" | "coral" | "lavender"))
                .ok_or("主题色配置无效")?;
            connection
                .execute(
                    "UPDATE app_settings SET theme_color = ?1 WHERE id = 1",
                    [value],
                )
                .map_err(database_error)?;
        }
        "contentWidth" => {
            let value = change
                .value
                .as_str()
                .filter(|value| matches!(*value, "default" | "full"))
                .ok_or("内容宽度配置无效")?;
            connection
                .execute(
                    "UPDATE app_settings SET content_width = ?1 WHERE id = 1",
                    [value],
                )
                .map_err(database_error)?;
        }
        _ => return Err("未知配置项".into()),
    }
    Ok(())
}

/// 原子替换全部快捷键覆盖记录。
///
/// 参数：`app` 用于定位数据库；`overrides` 的 key 必须是已注册动作且 chord 非空。
/// 返回：成功时为 `()`。
/// 错误/副作用：校验或事务失败时返回错误；成功时旧记录被新快照取代。
pub(crate) fn save_shortcuts(
    app: &tauri::AppHandle,
    overrides: HashMap<String, String>,
) -> Result<(), String> {
    if overrides
        .iter()
        .any(|(id, chord)| !SHORTCUT_IDS.contains(&id.as_str()) || chord.trim().is_empty())
    {
        return Err("快捷键配置无效".into());
    }
    let mut connection = open_existing(&database_path(app)?)?;
    // 整体替换必须在同一事务内完成，避免崩溃后留下空的快捷键表。
    let transaction = connection.transaction().map_err(database_error)?;
    transaction
        .execute("DELETE FROM shortcut_overrides", [])
        .map_err(database_error)?;
    for (id, chord) in overrides {
        transaction
            .execute(
                "INSERT INTO shortcut_overrides(action_id, chord) VALUES (?1, ?2)",
                params![id, chord],
            )
            .map_err(database_error)?;
    }
    transaction.commit().map_err(database_error)
}

/// 登记或重新打开工作区，并返回其 ID 与仍然有效的文档偏好。
///
/// 参数：`app` 用于定位数据库；`root` 必须是上层已规范化的工作区路径。
/// 返回：持久化 `WorkspaceRecord` 与清理失效项后的 `WorkspacePreferences`。
/// 错误/副作用：数据库读写失败时返回错误；成功时更新时间并把该工作区置于欢迎页列表最前。
pub(crate) fn open_workspace(
    app: &tauri::AppHandle,
    root: &Path,
) -> Result<(WorkspaceRecord, WorkspacePreferences), String> {
    let root_text = root.to_string_lossy().into_owned();
    let mut connection = open_existing(&database_path(app)?)?;
    let transaction = connection.transaction().map_err(database_error)?;
    transaction
        .execute(
            "INSERT INTO workspaces(path) VALUES (?1) ON CONFLICT(path) DO NOTHING",
            [&root_text],
        )
        .map_err(database_error)?;
    let id: i64 = transaction
        .query_row(
            "SELECT id FROM workspaces WHERE path = ?1",
            [&root_text],
            |row| row.get(0),
        )
        .map_err(database_error)?;
    let opened_at = next_workspace_opened_at(&transaction)?;
    transaction
        .execute(
            "UPDATE workspaces SET last_opened_at = ?1 WHERE id = ?2",
            params![opened_at, id],
        )
        .map_err(database_error)?;
    transaction
        .execute(
            "UPDATE app_settings SET last_workspace_id = ?1 WHERE id = 1",
            [id],
        )
        .map_err(database_error)?;
    transaction.commit().map_err(database_error)?;
    let preferences = read_workspace_preferences(&mut connection, id, &root_text)?;
    Ok((
        WorkspaceRecord {
            id,
            path: root_text,
        },
        preferences,
    ))
}

/// 生成严格递增的工作区打开时间，避免同一毫秒内连续打开导致列表顺序不稳定。
///
/// 参数：`transaction` 为登记工作区的独占事务。
/// 返回：Unix 毫秒或比已有最大值大一的时间戳。
/// 错误：系统时间无效、数据库读取失败或时间戳超过允许范围时返回错误。
fn next_workspace_opened_at(transaction: &rusqlite::Transaction<'_>) -> Result<i64, String> {
    let now = now_millis()?;
    let previous: Option<i64> = transaction
        .query_row("SELECT max(last_opened_at) FROM workspaces", [], |row| {
            row.get(0)
        })
        .map_err(database_error)?;
    let next = previous
        .map(|value| value.checked_add(1).ok_or("工作区最近打开时间超出范围"))
        .transpose()?
        .map_or(now, |value| value.max(now));
    if next > 9_007_199_254_740_991 {
        return Err("工作区最近打开时间超出范围".into());
    }
    Ok(next)
}

/// 清除最近打开工作区标记，但保留工作区及其偏好记录供后续恢复。
///
/// 参数：`app` 用于定位数据库。
/// 返回：成功时为 `()`。
/// 错误/副作用：更新失败时返回错误；成功时将 `last_workspace_id` 置空。
pub(crate) fn close_workspace(app: &tauri::AppHandle) -> Result<(), String> {
    open_existing(&database_path(app)?)?
        .execute(
            "UPDATE app_settings SET last_workspace_id = NULL WHERE id = 1",
            [],
        )
        .map(|_| ())
        .map_err(database_error)
}

/// 添加或移除工作区内 Markdown 文档的收藏，并返回更新后的偏好。
///
/// 参数：`app` 用于定位数据库；`workspace_id` 标识工作区；`path` 位于其根目录；`favorite` 决定添加或移除。
/// 返回：清理失效项后的 `WorkspacePreferences`。
/// 错误/副作用：路径、工作区或数据库操作无效时返回错误；成功时更新收藏表。
pub(crate) fn set_favorite(
    app: &tauri::AppHandle,
    workspace_id: i64,
    path: &str,
    favorite: bool,
) -> Result<WorkspacePreferences, String> {
    let mut connection = open_existing(&database_path(app)?)?;
    let root = workspace_root(&connection, workspace_id)?;
    let relative = relative_document_path(&root, path, favorite)?;
    if favorite {
        connection.execute(
            "INSERT INTO favorite_documents(workspace_id, document_path, favorited_at) VALUES (?1, ?2, ?3) ON CONFLICT(workspace_id, document_path) DO UPDATE SET favorited_at = excluded.favorited_at",
            params![workspace_id, relative, now_millis()?],
        ).map_err(database_error)?;
    } else {
        connection
            .execute(
                "DELETE FROM favorite_documents WHERE workspace_id = ?1 AND document_path = ?2",
                params![workspace_id, relative],
            )
            .map_err(database_error)?;
    }
    read_workspace_preferences(&mut connection, workspace_id, &root)
}

/// 记录一次 Markdown 文档编辑，并裁剪超出数量上限的历史记录。
///
/// 参数：`app` 用于定位数据库；`workspace_id` 标识工作区；`path` 必须是存在的 Markdown 文件。
/// 返回：按 `MAX_RECENT_DOCUMENTS` 裁剪后的 `WorkspacePreferences`。
/// 错误/副作用：路径、时钟或数据库操作失败时返回错误；成功时写入当前毫秒时间戳。
pub(crate) fn record_recent(
    app: &tauri::AppHandle,
    workspace_id: i64,
    path: &str,
) -> Result<WorkspacePreferences, String> {
    let mut connection = open_existing(&database_path(app)?)?;
    let root = workspace_root(&connection, workspace_id)?;
    let relative = relative_document_path(&root, path, true)?;
    let transaction = connection.transaction().map_err(database_error)?;
    // 用数据库排序裁剪，保证同一时间戳时仍能得到确定的保留结果。
    transaction.execute(
        "INSERT INTO recent_documents(workspace_id, document_path, edited_at) VALUES (?1, ?2, ?3) ON CONFLICT(workspace_id, document_path) DO UPDATE SET edited_at = excluded.edited_at",
        params![workspace_id, relative, now_millis()?],
    ).map_err(database_error)?;
    transaction.execute(
        "DELETE FROM recent_documents WHERE workspace_id = ?1 AND document_path NOT IN (SELECT document_path FROM recent_documents WHERE workspace_id = ?1 ORDER BY edited_at DESC, document_path ASC LIMIT ?2)",
        params![workspace_id, MAX_RECENT_DOCUMENTS],
    ).map_err(database_error)?;
    transaction.commit().map_err(database_error)?;
    read_workspace_preferences(&mut connection, workspace_id, &root)
}

/// 将收藏和最近编辑记录从旧路径批量迁移到新路径。
///
/// 参数：`app` 用于定位数据库；`workspace_id` 标识工作区；`old_path` 与 `new_path` 均为工作区内路径。
/// 返回：迁移后的 `WorkspacePreferences`。
/// 错误/副作用：路径或数据库操作无效时返回错误；冲突时合并记录并保留较新时间戳。
pub(crate) fn remap_documents(
    app: &tauri::AppHandle,
    workspace_id: i64,
    old_path: &str,
    new_path: &str,
) -> Result<WorkspacePreferences, String> {
    let mut connection = open_existing(&database_path(app)?)?;
    let root = workspace_root(&connection, workspace_id)?;
    let old_relative = relative_document_path(&root, old_path, false)?;
    let new_relative = relative_document_path(&root, new_path, false)?;
    let transaction = connection.transaction().map_err(database_error)?;
    remap_table(
        &transaction,
        "favorite_documents",
        "favorited_at",
        workspace_id,
        &old_relative,
        &new_relative,
    )?;
    remap_table(
        &transaction,
        "recent_documents",
        "edited_at",
        workspace_id,
        &old_relative,
        &new_relative,
    )?;
    transaction.commit().map_err(database_error)?;
    read_workspace_preferences(&mut connection, workspace_id, &root)
}

/// 删除指定文档或目录及其全部后代的偏好记录。
///
/// 参数：`app` 用于定位数据库；`workspace_id` 标识工作区；`path` 可指向已不存在的工作区内条目。
/// 返回：清理后的 `WorkspacePreferences`。
/// 错误/副作用：路径或数据库操作无效时返回错误；成功时删除匹配条目及其后代。
pub(crate) fn remove_documents(
    app: &tauri::AppHandle,
    workspace_id: i64,
    path: &str,
) -> Result<WorkspacePreferences, String> {
    let mut connection = open_existing(&database_path(app)?)?;
    let root = workspace_root(&connection, workspace_id)?;
    let relative = relative_document_path(&root, path, false)?;
    let transaction = connection.transaction().map_err(database_error)?;
    // 目录删除要匹配其后代，且 LIKE 元字符必须转义，避免误删名称含 `%` 或 `_` 的记录。
    for table in ["favorite_documents", "recent_documents"] {
        let sql = format!("DELETE FROM {table} WHERE workspace_id = ?1 AND (document_path = ?2 OR document_path LIKE ?3 ESCAPE '\\')");
        transaction
            .execute(
                &sql,
                params![
                    workspace_id,
                    relative,
                    format!("{}%", escape_like(&(relative.clone() + "/")))
                ],
            )
            .map_err(database_error)?;
    }
    transaction.commit().map_err(database_error)?;
    read_workspace_preferences(&mut connection, workspace_id, &root)
}

/// 在单个偏好表中迁移某个路径及其后代。
///
/// 参数：`connection` 为当前事务连接；`table`/`timestamp_column` 只能由固定调用点传入；其余参数描述工作区和路径替换。
/// 返回：成功时为 `()`。
/// 错误/副作用：查询或写入失败时返回错误；冲突时保留较新时间戳并删除旧路径记录。
fn remap_table(
    connection: &Connection,
    table: &str,
    timestamp_column: &str,
    workspace_id: i64,
    old_path: &str,
    new_path: &str,
) -> Result<(), String> {
    let query =
        format!("SELECT document_path, {timestamp_column} FROM {table} WHERE workspace_id = ?1");
    let rows = connection
        .prepare(&query)
        .and_then(|mut statement| {
            statement
                .query_map([workspace_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(database_error)?;
    for (path, timestamp) in rows {
        let suffix = if path == old_path {
            Some("")
        } else {
            path.strip_prefix(&(old_path.to_string() + "/"))
        };
        let Some(suffix) = suffix else { continue };
        let replacement = if suffix.is_empty() {
            new_path.to_string()
        } else {
            format!("{new_path}/{suffix}")
        };
        let sql = format!("INSERT INTO {table}(workspace_id, document_path, {timestamp_column}) VALUES (?1, ?2, ?3) ON CONFLICT(workspace_id, document_path) DO UPDATE SET {timestamp_column} = max({timestamp_column}, excluded.{timestamp_column})");
        connection
            .execute(&sql, params![workspace_id, replacement, timestamp])
            .map_err(database_error)?;
        let delete = format!("DELETE FROM {table} WHERE workspace_id = ?1 AND document_path = ?2");
        connection
            .execute(&delete, params![workspace_id, path])
            .map_err(database_error)?;
    }
    Ok(())
}

/// 清理失效条目后，读取工作区的收藏和最近编辑列表。
///
/// 参数：`connection` 为可写连接；`workspace_id` 标识工作区；`root` 为工作区绝对根路径。
/// 返回：包含收藏和最近编辑条目的 `WorkspacePreferences`。
/// 错误/副作用：查询或清理失败时返回错误；会删除已不存在 Markdown 文件记录。
fn read_workspace_preferences(
    connection: &mut Connection,
    workspace_id: i64,
    root: &str,
) -> Result<WorkspacePreferences, String> {
    prune_missing_documents(connection, workspace_id, root)?;
    Ok(WorkspacePreferences {
        workspace_id,
        root: root.to_string(),
        favorites: read_documents(
            connection,
            "favorite_documents",
            "favorited_at",
            workspace_id,
            root,
        )?
        .into_iter()
        .map(|document| FavoriteDocument {
            root: document.root,
            path: document.path,
            name: document.name,
            relative_path: document.relative_path,
            favorited_at: document.timestamp,
        })
        .collect(),
        recent: read_documents(
            connection,
            "recent_documents",
            "edited_at",
            workspace_id,
            root,
        )?
        .into_iter()
        .map(|document| RecentDocument {
            root: document.root,
            path: document.path,
            name: document.name,
            relative_path: document.relative_path,
            edited_at: document.timestamp,
        })
        .collect(),
    })
}

/// 从指定偏好表读取文档，并将数据库相对路径还原为绝对路径。
///
/// 参数：`connection` 为只读查询连接；`table`/`timestamp_column` 仅限固定表字段；`workspace_id` 和 `root` 限定读取范围。
/// 返回：转换为绝对路径后的内部文档记录列表。
/// 错误：动态 SQL 查询或字段转换失败时返回错误。
fn read_documents(
    connection: &Connection,
    table: &str,
    timestamp_column: &str,
    workspace_id: i64,
    root: &str,
) -> Result<Vec<StoredDocument>, String> {
    let sql = format!("SELECT document_path, {timestamp_column} FROM {table} WHERE workspace_id = ?1 ORDER BY {timestamp_column} DESC, document_path ASC");
    connection
        .prepare(&sql)
        .and_then(|mut statement| {
            statement
                .query_map([workspace_id], |row| {
                    let relative_path: String = row.get(0)?;
                    let path = Path::new(root)
                        .join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
                    Ok(StoredDocument {
                        root: root.to_string(),
                        name: path
                            .file_name()
                            .map(|name| name.to_string_lossy().into_owned())
                            .unwrap_or_else(|| relative_path.clone()),
                        path: path.to_string_lossy().into_owned(),
                        relative_path,
                        timestamp: row.get(1)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(database_error)
}

/// 删除数据库中已不存在或不再是 Markdown 文件的偏好记录。
///
/// 参数：`connection` 为可写连接；`workspace_id` 标识工作区；`root` 为工作区绝对根路径。
/// 返回：成功时为 `()`。
/// 错误/副作用：查询或删除失败时返回错误；每次读取偏好前清理失效条目。
fn prune_missing_documents(
    connection: &mut Connection,
    workspace_id: i64,
    root: &str,
) -> Result<(), String> {
    for table in ["favorite_documents", "recent_documents"] {
        let sql = format!("SELECT document_path FROM {table} WHERE workspace_id = ?1");
        let paths = connection
            .prepare(&sql)
            .and_then(|mut statement| {
                statement
                    .query_map([workspace_id], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .map_err(database_error)?;
        for relative in paths {
            let path = Path::new(root).join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
            if !path.is_file() || !super::is_markdown(&path) {
                let delete =
                    format!("DELETE FROM {table} WHERE workspace_id = ?1 AND document_path = ?2");
                connection
                    .execute(&delete, params![workspace_id, relative])
                    .map_err(database_error)?;
            }
        }
    }
    Ok(())
}

/// 查询工作区 ID 对应的根目录。
///
/// 参数：`connection` 为已验证连接；`workspace_id` 为工作区数据库主键。
/// 返回：工作区规范化绝对路径。
/// 错误：ID 不存在或查询失败时返回可展示错误。
fn workspace_root(connection: &Connection, workspace_id: i64) -> Result<String, String> {
    connection
        .query_row(
            "SELECT path FROM workspaces WHERE id = ?1",
            [workspace_id],
            |row| row.get(0),
        )
        .map_err(database_error)
}

/// 将文档路径验证并转换成可跨平台存储的工作区相对路径。
///
/// 参数：`root` 为工作区绝对根路径；`path` 为待转换路径；`must_exist` 为真时要求现存 Markdown 文件。
/// 返回：以 `/` 分隔、无 `.`/`..` 组件的工作区相对路径。
/// 错误：越界、根目录、非法组件或不满足存在条件时返回错误。
fn relative_document_path(root: &str, path: &str, must_exist: bool) -> Result<String, String> {
    let root_path = Path::new(root);
    let target = if must_exist {
        fs::canonicalize(path).map_err(|error| error.to_string())?
    } else {
        PathBuf::from(path)
    };
    let relative = target
        .strip_prefix(root_path)
        .map_err(|_| "文档不在工作区中".to_string())?;
    // 禁止根目录、`..` 和其他非普通组件，避免偏好记录越过工作区边界。
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err("文档路径无效".into());
    }
    if must_exist && (!target.is_file() || !super::is_markdown(&target)) {
        return Err("只能记录工作区中的 Markdown 文档".into());
    }
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

/// 转义 SQLite `LIKE ... ESCAPE '\\'` 使用的反斜杠、百分号和下划线。
///
/// 参数：`value` 为待作为 LIKE 字面量匹配的路径片段。
/// 返回：可安全拼入指定 LIKE 表达式的转义字符串。
fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// 返回当前 Unix 毫秒时间戳；系统时间早于 epoch 或超出 `i64` 时返回错误。
///
/// 返回：可存入 SQLite `INTEGER` 的 Unix 毫秒 `i64`。
/// 错误：系统时间或数值转换失败时返回错误。
fn now_millis() -> Result<i64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    i64::try_from(millis).map_err(|_| "当前时间超出支持范围".to_string())
}

/// 读取可安全回显的 OSS 配置；未配置时返回 `None`。
///
/// 参数：`app` 用于定位设置数据库。
/// 返回：不含明文密钥的配置，或未配置时的 `None`。
/// 错误：数据库打开或查询失败时返回错误。
pub(crate) fn load_oss_settings(app: &tauri::AppHandle) -> Result<Option<OssSyncSettings>, String> {
    read_oss_settings(&open_existing(&database_path(app)?)?)
}

/// 从 OSS 表读取脱敏配置，不返回 AccessKey Secret 明文。
///
/// 参数：`connection` 为已验证数据库连接。
/// 返回：不含密钥的配置，或表中无配置时的 `None`。
/// 错误：字段读取失败时返回错误。
fn read_oss_settings(connection: &Connection) -> Result<Option<OssSyncSettings>, String> {
    connection.query_row(
        "SELECT enabled, region, endpoint, bucket, prefix, access_key_id, length(access_key_secret) > 0 FROM oss_sync WHERE id = 1",
        [],
        |row| Ok(OssSyncSettings {
            enabled: row.get::<_, i64>(0)? != 0,
            region: row.get(1)?, endpoint: row.get(2)?, bucket: row.get(3)?, prefix: row.get(4)?, access_key_id: row.get(5)?, has_access_key_secret: row.get::<_, i64>(6)? != 0,
        }),
    ).optional().map_err(database_error)
}

/// 保存 OSS 配置，并在请求未提供新密钥时保留已有密钥。
///
/// 参数：`app` 用于定位数据库；`settings` 为已由调用方规范化的 OSS 输入。
/// 返回：成功时为 `()`。
/// 错误/副作用：首次保存无密钥或数据库写入失败时返回错误；成功时覆盖唯一配置行。
pub(crate) fn save_oss_settings(
    app: &tauri::AppHandle,
    settings: OssSyncSettingsInput,
) -> Result<(), String> {
    let connection = open_existing(&database_path(app)?)?;
    let existing_secret: Option<String> = connection
        .query_row(
            "SELECT access_key_secret FROM oss_sync WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(database_error)?;
    let secret = settings
        .access_key_secret
        .filter(|value| !value.trim().is_empty())
        .or(existing_secret)
        .ok_or("请填写 AccessKey Secret")?;
    connection.execute(
        "INSERT INTO oss_sync(id, enabled, region, endpoint, bucket, prefix, access_key_id, access_key_secret) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, region=excluded.region, endpoint=excluded.endpoint, bucket=excluded.bucket, prefix=excluded.prefix, access_key_id=excluded.access_key_id, access_key_secret=excluded.access_key_secret",
        params![i64::from(settings.enabled), settings.region, settings.endpoint, settings.bucket, settings.prefix, settings.access_key_id, secret],
    ).map(|_| ()).map_err(database_error)
}

/// 读取执行同步所需的完整 OSS 凭据。
///
/// 参数：`app` 用于定位设置数据库。
/// 返回：包含明文密钥的 `OssSyncCredentials`，仅允许 Rust 同步逻辑使用。
/// 错误：未保存配置或查询失败时返回错误；调用方不得记录或向前端回传密钥。
pub(crate) fn load_oss_credentials(app: &tauri::AppHandle) -> Result<OssSyncCredentials, String> {
    open_existing(&database_path(app)?)?.query_row(
        "SELECT region, endpoint, bucket, prefix, access_key_id, access_key_secret FROM oss_sync WHERE id = 1",
        [],
        |row| Ok(OssSyncCredentials { region: row.get(0)?, endpoint: row.get(1)?, bucket: row.get(2)?, prefix: row.get(3)?, access_key_id: row.get(4)?, access_key_secret: row.get(5)? }),
    ).map_err(|error| format!("请先保存 OSS 配置：{error}"))
}

/// 将 `rusqlite` 错误统一转换为应用可展示的中文错误。
///
/// 参数：`error` 为底层数据库错误。
/// 返回：带统一前缀的中文错误字符串。
fn database_error(error: rusqlite::Error) -> String {
    format!("配置数据库操作失败：{error}")
}

/// 数据库架构与外键约束的单元测试。
#[cfg(test)]
mod tests {
    use super::*;

    /// 创建已执行架构脚本并插入默认设置行的内存数据库。
    ///
    /// 返回：可供测试写入的内存 `Connection`。
    fn test_database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        configure_connection(&connection).unwrap();
        connection
            .execute_batch(include_str!("settings_schema.sql"))
            .unwrap();
        connection
            .execute("INSERT INTO app_settings(id) VALUES (1)", [])
            .unwrap();
        connection
    }

    #[test]
    /// 验证工作区路径去重、ID 稳定以及触发器禁止删除工作区。
    ///
    /// 副作用：仅写入测试内存数据库。
    fn schema_generates_stable_workspace_ids_and_prevents_deletion() {
        let connection = test_database();
        connection
            .execute("INSERT INTO workspaces(path) VALUES ('C:/notes')", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO workspaces(path) VALUES ('C:/notes') ON CONFLICT(path) DO NOTHING",
                [],
            )
            .unwrap();
        let (count, id): (i64, i64) = connection
            .query_row("SELECT count(*), min(id) FROM workspaces", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!((count, id), (1, 1));
        assert!(connection
            .execute("DELETE FROM workspaces WHERE id = 1", [])
            .is_err());
    }

    #[test]
    /// 验证不同工作区可拥有同名文档，且外键拒绝未知工作区引用。
    ///
    /// 副作用：仅写入测试内存数据库。
    fn document_records_are_isolated_by_workspace_foreign_key() {
        let connection = test_database();
        connection
            .execute("INSERT INTO workspaces(path) VALUES ('C:/one')", [])
            .unwrap();
        connection
            .execute("INSERT INTO workspaces(path) VALUES ('C:/two')", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO favorite_documents(workspace_id, document_path, favorited_at) VALUES (1, 'note.md', 1), (2, 'note.md', 2)",
                [],
            )
            .unwrap();
        let count: i64 = connection
            .query_row("SELECT count(*) FROM favorite_documents", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 2);
        assert!(connection
            .execute(
                "INSERT INTO recent_documents(workspace_id, document_path, edited_at) VALUES (99, 'missing.md', 1)",
                [],
            )
            .is_err());
    }

    #[test]
    /// 验证新建数据库写入的应用设置默认值与当前产品默认值一致。
    ///
    /// 副作用：仅读取测试内存数据库。
    fn app_settings_start_with_current_defaults() {
        let connection = test_database();
        let values: (i64, i64, i64, String, String, i64, Option<i64>) = connection
            .query_row(
                "SELECT open_tab_limit, auto_open_last_workspace, auto_save, theme_color, content_width, theme_color_redesign_v1, last_workspace_id FROM app_settings WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
            )
            .unwrap();
        assert_eq!(values, (8, 1, 1, "sky".into(), "default".into(), 1, None));
    }

    /// 使用冻结的版本 1 架构创建旧库，避免迁移测试随新架构一起变化。
    /// 返回：含默认设置的内存连接；副作用：仅写入测试数据库。
    fn legacy_database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        configure_connection(&connection).unwrap();
        connection
            .execute_batch(include_str!("../test-fixtures/settings-v1.sql"))
            .unwrap();
        connection
            .execute_batch("INSERT INTO app_settings(id) VALUES (1); PRAGMA user_version = 1;")
            .unwrap();
        connection
    }

    /// 使用版本 1 架构构造当前发布版本的版本 2 数据库。
    /// 返回：含版本 2 启动设置的内存连接；副作用：仅修改测试数据库。
    fn version_two_database() -> Connection {
        let connection = legacy_database();
        connection
            .execute_batch(
                "ALTER TABLE app_settings ADD COLUMN auto_open_last_workspace INTEGER NOT NULL DEFAULT 1 CHECK(auto_open_last_workspace IN (0, 1));\
                 PRAGMA user_version = 2;",
            )
            .unwrap();
        connection
    }

    #[test]
    /// 验证首次启动默认开启自动恢复，且写入后重新初始化仍保留布尔值。
    /// 副作用：仅初始化和修改测试内存数据库。
    fn startup_preference_defaults_and_round_trips() {
        let mut connection = Connection::open_in_memory().unwrap();
        configure_connection(&connection).unwrap();
        initialize_database(&mut connection).unwrap();
        assert!(
            read_preferences(&connection)
                .unwrap()
                .auto_open_last_workspace
        );
        for enabled in [false, true] {
            write_preference(
                &connection,
                PreferenceChange {
                    key: "autoOpenLastWorkspace".into(),
                    value: serde_json::json!(enabled),
                },
            )
            .unwrap();
            initialize_database(&mut connection).unwrap();
            let snapshot = serde_json::to_value(read_bootstrap(&connection).unwrap()).unwrap();
            assert_eq!(snapshot["preferences"]["autoOpenLastWorkspace"], enabled);
        }
        for invalid in [
            serde_json::json!(1),
            serde_json::json!("false"),
            serde_json::Value::Null,
        ] {
            assert!(write_preference(
                &connection,
                PreferenceChange {
                    key: "autoOpenLastWorkspace".into(),
                    value: invalid,
                }
            )
            .is_err());
        }
        assert!(
            read_preferences(&connection)
                .unwrap()
                .auto_open_last_workspace
        );
        assert!(connection
            .execute("UPDATE app_settings SET auto_open_last_workspace = 2", [])
            .is_err());
    }

    #[test]
    /// 验证升级保留所有旧表数据，默认开启且重复初始化不会重置用户选择。
    /// 副作用：仅迁移测试内存数据库，OSS 字段使用虚构测试值。
    fn migration_preserves_existing_data_and_runs_once() {
        let mut connection = legacy_database();
        connection.execute_batch("
            INSERT INTO workspaces(id, path) VALUES (1, '/one/notes'), (2, '/two/notes');
            UPDATE app_settings SET open_tab_limit = 12, auto_save = 0, theme_color = 'mint', content_width = 'full', theme_color_redesign_v1 = 0, last_workspace_id = 2;
            INSERT INTO favorite_documents VALUES (1, 'note.md', 123);
            INSERT INTO recent_documents VALUES (2, 'note.md', 456);
            INSERT INTO shortcut_overrides VALUES ('bold', 'Mod+Alt+KeyB');
            INSERT INTO oss_sync VALUES (1, 0, 'test-region', 'test-endpoint', 'test-bucket', 'test-prefix', 'test-id', 'test-secret');
        ").unwrap();
        initialize_database(&mut connection).unwrap();
        validate_schema(&connection, 3).unwrap();
        let snapshot = read_bootstrap(&connection).unwrap();
        assert!(snapshot.preferences.auto_open_last_workspace);
        assert_eq!(snapshot.preferences.last_workspace_id, Some(2));
        assert_eq!(snapshot.preferences.open_tab_limit, 12);
        assert!(!snapshot.preferences.auto_save);
        assert_eq!(snapshot.preferences.theme_color, "mint");
        assert_eq!(snapshot.preferences.content_width, "full");
        assert!(!snapshot.preferences.theme_color_redesign_v1);
        assert_eq!(
            snapshot
                .workspaces
                .iter()
                .map(|item| (item.id, item.path.as_str()))
                .collect::<Vec<_>>(),
            vec![(2, "/two/notes"), (1, "/one/notes")]
        );
        assert_eq!(snapshot.shortcut_overrides["bold"], "Mod+Alt+KeyB");
        let favorite: (i64, String, i64) = connection
            .query_row("SELECT * FROM favorite_documents", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
        assert_eq!(favorite, (1, "note.md".into(), 123));
        let recent: (i64, String, i64) = connection
            .query_row("SELECT * FROM recent_documents", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
        assert_eq!(recent, (2, "note.md".into(), 456));
        let secret: String = connection
            .query_row("SELECT access_key_secret FROM oss_sync", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(secret, "test-secret");
        let oss = serde_json::to_value(snapshot.oss_sync).unwrap();
        assert_eq!(oss["bucket"], "test-bucket");
        write_preference(
            &connection,
            PreferenceChange {
                key: "autoOpenLastWorkspace".into(),
                value: serde_json::json!(false),
            },
        )
        .unwrap();
        initialize_database(&mut connection).unwrap();
        assert!(
            !read_preferences(&connection)
                .unwrap()
                .auto_open_last_workspace
        );
        assert_eq!(
            read_preferences(&connection).unwrap().last_workspace_id,
            Some(2)
        );
    }

    #[test]
    /// 验证版本 2 升级会回填历史顺序，并在重新打开时把该工作区置顶。
    /// 副作用：仅迁移和更新测试内存数据库。
    fn migration_from_version_two_orders_workspaces_by_recent_open() {
        let mut connection = version_two_database();
        connection
            .execute_batch(
                "INSERT INTO workspaces(id, path) VALUES (1, '/one/notes'), (2, '/two/notes');\
                 UPDATE app_settings SET last_workspace_id = 2;",
            )
            .unwrap();
        initialize_database(&mut connection).unwrap();
        validate_schema(&connection, 3).unwrap();
        let migrated = read_bootstrap(&connection).unwrap();
        assert_eq!(
            migrated
                .workspaces
                .iter()
                .map(|workspace| workspace.id)
                .collect::<Vec<_>>(),
            vec![2, 1]
        );

        let transaction = connection.transaction().unwrap();
        let opened_at = next_workspace_opened_at(&transaction).unwrap();
        transaction
            .execute(
                "UPDATE workspaces SET last_opened_at = ?1 WHERE id = 1",
                params![opened_at],
            )
            .unwrap();
        transaction.commit().unwrap();
        let reopened = read_bootstrap(&connection).unwrap();
        assert_eq!(
            reopened
                .workspaces
                .iter()
                .map(|workspace| workspace.id)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
    }

    #[test]
    /// 验证新增列后的读取失败会同时回滚列和版本号，修复旧数据后可重试。
    /// 副作用：仅在测试库中删除并恢复默认行。
    fn failed_migration_rolls_back_schema_and_version() {
        let mut connection = legacy_database();
        connection.execute("DELETE FROM app_settings", []).unwrap();
        assert!(initialize_database(&mut connection).is_err());
        validate_schema(&connection, 1).unwrap();
        let new_columns: i64 = connection.query_row("SELECT count(*) FROM pragma_table_info('app_settings') WHERE name = 'auto_open_last_workspace'", [], |row| row.get(0)).unwrap();
        assert_eq!(new_columns, 0);
        connection
            .execute("INSERT INTO app_settings(id) VALUES (1)", [])
            .unwrap();
        initialize_database(&mut connection).unwrap();
        assert!(
            read_preferences(&connection)
                .unwrap()
                .auto_open_last_workspace
        );
    }

    #[test]
    /// 验证未知版本与非空零版本库继续被拒绝，不被误判为首次安装。
    /// 副作用：仅修改测试内存数据库的版本号。
    fn initialization_rejects_unknown_or_incomplete_databases() {
        let mut connection = legacy_database();
        for version in [0, 99] {
            connection
                .pragma_update(None, "user_version", version)
                .unwrap();
            assert!(initialize_database(&mut connection).is_err());
            let actual: i64 = connection
                .pragma_query_value(None, "user_version", |row| row.get(0))
                .unwrap();
            assert_eq!(actual, version);
        }
    }
}
