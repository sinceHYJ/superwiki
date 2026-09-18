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

const SCHEMA_VERSION: i64 = 1;
const MAX_RECENT_DOCUMENTS: i64 = 20;
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppPreferences {
    open_tab_limit: i64,
    auto_save: bool,
    theme_color: String,
    content_width: String,
    theme_color_redesign_v1: bool,
    last_workspace_id: Option<i64>,
}

#[derive(Serialize)]
pub(crate) struct WorkspaceRecord {
    pub(crate) id: i64,
    pub(crate) path: String,
}

struct StoredDocument {
    root: String,
    path: String,
    name: String,
    relative_path: String,
    timestamp: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FavoriteDocument {
    root: String,
    path: String,
    name: String,
    relative_path: String,
    favorited_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecentDocument {
    root: String,
    path: String,
    name: String,
    relative_path: String,
    edited_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspacePreferences {
    pub(crate) workspace_id: i64,
    pub(crate) root: String,
    pub(crate) favorites: Vec<FavoriteDocument>,
    pub(crate) recent: Vec<RecentDocument>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OssSyncSettings {
    pub(crate) region: String,
    pub(crate) endpoint: String,
    pub(crate) bucket: String,
    pub(crate) prefix: String,
    pub(crate) access_key_id: String,
    pub(crate) has_access_key_secret: bool,
    pub(crate) enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OssSyncCredentials {
    pub(crate) region: String,
    pub(crate) endpoint: String,
    pub(crate) bucket: String,
    pub(crate) prefix: String,
    pub(crate) access_key_id: String,
    pub(crate) access_key_secret: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OssSyncSettingsInput {
    pub(crate) region: String,
    pub(crate) endpoint: String,
    pub(crate) bucket: String,
    pub(crate) prefix: String,
    pub(crate) access_key_id: String,
    pub(crate) access_key_secret: Option<String>,
    pub(crate) enabled: bool,
}

#[derive(Deserialize)]
pub(crate) struct PreferenceChange {
    key: String,
    value: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BootstrapSettings {
    preferences: AppPreferences,
    shortcut_overrides: HashMap<String, String>,
    oss_sync: Option<OssSyncSettings>,
    workspaces: Vec<WorkspaceRecord>,
}

pub(crate) fn database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法确定应用配置目录：{error}"))?;
    fs::create_dir_all(&config_dir).map_err(|error| format!("无法创建应用配置目录：{error}"))?;
    Ok(config_dir.join("settings.sqlite3"))
}

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

fn open_existing(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(database_error)?;
    configure_connection(&connection)?;
    validate_schema(&connection)?;
    Ok(connection)
}

fn validate_schema(connection: &Connection) -> Result<(), String> {
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(database_error)?;
    if version != SCHEMA_VERSION {
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

pub(crate) fn initialize(app: &tauri::AppHandle) -> Result<BootstrapSettings, String> {
    let path = database_path(app)?;
    let mut connection = Connection::open(&path).map_err(database_error)?;
    configure_connection(&connection)?;
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(database_error)?;
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
    }
    validate_schema(&connection)?;
    read_bootstrap(&connection)
}

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
        .prepare("SELECT id, path FROM workspaces ORDER BY id")
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

fn read_preferences(connection: &Connection) -> Result<AppPreferences, String> {
    connection
        .query_row(
            "SELECT open_tab_limit, auto_save, theme_color, content_width, theme_color_redesign_v1, last_workspace_id FROM app_settings WHERE id = 1",
            [],
            |row| {
                Ok(AppPreferences {
                    open_tab_limit: row.get(0)?,
                    auto_save: row.get::<_, i64>(1)? != 0,
                    theme_color: row.get(2)?,
                    content_width: row.get(3)?,
                    theme_color_redesign_v1: row.get::<_, i64>(4)? != 0,
                    last_workspace_id: row.get(5)?,
                })
            },
        )
        .map_err(database_error)
}

pub(crate) fn update_preference(
    app: &tauri::AppHandle,
    change: PreferenceChange,
) -> Result<(), String> {
    let connection = open_existing(&database_path(app)?)?;
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

pub(crate) fn close_workspace(app: &tauri::AppHandle) -> Result<(), String> {
    open_existing(&database_path(app)?)?
        .execute(
            "UPDATE app_settings SET last_workspace_id = NULL WHERE id = 1",
            [],
        )
        .map(|_| ())
        .map_err(database_error)
}

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

pub(crate) fn record_recent(
    app: &tauri::AppHandle,
    workspace_id: i64,
    path: &str,
) -> Result<WorkspacePreferences, String> {
    let mut connection = open_existing(&database_path(app)?)?;
    let root = workspace_root(&connection, workspace_id)?;
    let relative = relative_document_path(&root, path, true)?;
    let transaction = connection.transaction().map_err(database_error)?;
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

pub(crate) fn remove_documents(
    app: &tauri::AppHandle,
    workspace_id: i64,
    path: &str,
) -> Result<WorkspacePreferences, String> {
    let mut connection = open_existing(&database_path(app)?)?;
    let root = workspace_root(&connection, workspace_id)?;
    let relative = relative_document_path(&root, path, false)?;
    let transaction = connection.transaction().map_err(database_error)?;
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

fn workspace_root(connection: &Connection, workspace_id: i64) -> Result<String, String> {
    connection
        .query_row(
            "SELECT path FROM workspaces WHERE id = ?1",
            [workspace_id],
            |row| row.get(0),
        )
        .map_err(database_error)
}

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

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn now_millis() -> Result<i64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    i64::try_from(millis).map_err(|_| "当前时间超出支持范围".to_string())
}

pub(crate) fn load_oss_settings(app: &tauri::AppHandle) -> Result<Option<OssSyncSettings>, String> {
    read_oss_settings(&open_existing(&database_path(app)?)?)
}

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

pub(crate) fn load_oss_credentials(app: &tauri::AppHandle) -> Result<OssSyncCredentials, String> {
    open_existing(&database_path(app)?)?.query_row(
        "SELECT region, endpoint, bucket, prefix, access_key_id, access_key_secret FROM oss_sync WHERE id = 1",
        [],
        |row| Ok(OssSyncCredentials { region: row.get(0)?, endpoint: row.get(1)?, bucket: row.get(2)?, prefix: row.get(3)?, access_key_id: row.get(4)?, access_key_secret: row.get(5)? }),
    ).map_err(|error| format!("请先保存 OSS 配置：{error}"))
}

fn database_error(error: rusqlite::Error) -> String {
    format!("配置数据库操作失败：{error}")
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn app_settings_start_with_current_defaults() {
        let connection = test_database();
        let values: (i64, i64, String, String, i64, Option<i64>) = connection
            .query_row(
                "SELECT open_tab_limit, auto_save, theme_color, content_width, theme_color_redesign_v1, last_workspace_id FROM app_settings WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            )
            .unwrap();
        assert_eq!(values, (8, 1, "sky".into(), "default".into(), 1, None));
    }
}
