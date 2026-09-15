use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufReader, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::UNIX_EPOCH,
};
use tauri::{Emitter, Manager};
use uuid::Uuid;

const CONFIG_VERSION: u8 = 1;
const PROVIDER_OSS: &str = "oss";
const SYNC_METADATA_DIRECTORY: &str = ".superwiki-sync";

#[derive(Default)]
pub struct WorkspaceWatcher(Mutex<Option<RecommendedWatcher>>);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncAccount {
    id: String,
    provider: String,
    region: String,
    endpoint: String,
    bucket: String,
    access_key_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncBinding {
    id: String,
    local_root: String,
    account_id: String,
    remote_root: String,
    enabled: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncConfigStore {
    version: u8,
    device_id: String,
    accounts: Vec<SyncAccount>,
    bindings: Vec<SyncBinding>,
}

impl Default for SyncConfigStore {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            device_id: Uuid::new_v4().to_string(),
            accounts: Vec::new(),
            bindings: Vec::new(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyOssConfig {
    region: String,
    endpoint: String,
    bucket: String,
    prefix: String,
    access_key_id: String,
    #[serde(default)]
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSettingsInput {
    region: String,
    endpoint: String,
    bucket: String,
    prefix: String,
    access_key_id: String,
    access_key_secret: Option<String>,
    enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSyncSettings {
    binding_id: String,
    binding_root: String,
    opened_root: String,
    relative_scope: String,
    effective_remote_path: String,
    inherited: bool,
    provider: String,
    region: String,
    endpoint: String,
    bucket: String,
    prefix: String,
    access_key_id: String,
    has_access_key_secret: bool,
    enabled: bool,
    device_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSyncCredentials {
    binding_id: String,
    workspace_id: String,
    binding_root: String,
    opened_root: String,
    relative_scope: String,
    effective_remote_path: String,
    provider: String,
    region: String,
    endpoint: String,
    bucket: String,
    prefix: String,
    access_key_id: String,
    access_key_secret: String,
    device_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSyncEntry {
    path: String,
    kind: String,
    hash: Option<String>,
    size: Option<u64>,
    modified_at: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSyncSnapshot {
    entries: Vec<LocalSyncEntry>,
    skipped: Vec<String>,
}

fn app_config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_config_dir(app)?.join("sync-config-v1.json"))
}

fn legacy_config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_config_dir(app)?.join("oss-sync.json"))
}

fn secret_entry(account_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.superwiki.app.sync", account_id)
        .map_err(|error| format!("无法访问系统凭据库：{error}"))
}

fn legacy_secret_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.superwiki.app", "oss-access-key-secret")
        .map_err(|error| format!("无法访问旧版系统凭据：{error}"))
}

fn normalize_endpoint(endpoint: &str) -> Result<String, String> {
    let endpoint = endpoint.trim().trim_end_matches('/');
    if endpoint.is_empty() {
        return Err("请填写 OSS Endpoint".into());
    }
    if endpoint.starts_with("https://") || endpoint.starts_with("http://") {
        return Ok(endpoint.to_string());
    }
    if endpoint.contains("://") {
        return Err("OSS Endpoint 必须使用 http 或 https 协议".into());
    }
    Ok(format!("https://{endpoint}"))
}

fn normalize_remote_root(prefix: &str) -> Result<String, String> {
    let prefix = prefix.trim().trim_matches('/').replace('\\', "/");
    if prefix.split('/').any(|part| part == "..") {
        return Err("远端目录不能包含 ..".into());
    }
    Ok(prefix)
}

fn load_store(app: &tauri::AppHandle) -> Result<SyncConfigStore, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(SyncConfigStore::default());
    }
    serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
        .map_err(|error| format!("同步配置无效：{error}"))
}

fn save_store(app: &tauri::AppHandle, store: &SyncConfigStore) -> Result<(), String> {
    let content = serde_json::to_vec_pretty(store).map_err(|error| error.to_string())?;
    fs::write(config_path(app)?, content).map_err(|error| format!("无法保存同步配置：{error}"))
}

fn canonical_directory(root: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("工作区不是文件夹".into());
    }
    Ok(root)
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn relative_text(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .map_err(|_| "路径不在同步工作区内".to_string())
}

fn migrate_legacy(
    app: &tauri::AppHandle,
    root: &Path,
    store: &mut SyncConfigStore,
) -> Result<(), String> {
    if !store.bindings.is_empty() {
        return Ok(());
    }
    let legacy_path = legacy_config_path(app)?;
    if !legacy_path.exists() {
        return Ok(());
    }
    let legacy: LegacyOssConfig = serde_json::from_slice(
        &fs::read(&legacy_path).map_err(|error| format!("无法读取旧版 OSS 配置：{error}"))?,
    )
    .map_err(|error| format!("旧版 OSS 配置无效：{error}"))?;
    let account_id = Uuid::new_v4().to_string();
    if let Ok(secret) = legacy_secret_entry()?.get_password() {
        secret_entry(&account_id)?
            .set_password(&secret)
            .map_err(|error| format!("无法迁移 OSS 密钥：{error}"))?;
    }
    store.accounts.push(SyncAccount {
        id: account_id.clone(),
        provider: PROVIDER_OSS.into(),
        region: legacy.region,
        endpoint: normalize_endpoint(&legacy.endpoint)?,
        bucket: legacy.bucket,
        access_key_id: legacy.access_key_id,
    });
    store.bindings.push(SyncBinding {
        id: Uuid::new_v4().to_string(),
        local_root: path_text(root),
        account_id,
        remote_root: normalize_remote_root(&legacy.prefix)?,
        enabled: legacy.enabled,
    });
    save_store(app, store)?;
    fs::remove_file(legacy_path).map_err(|error| format!("无法清理旧版 OSS 配置：{error}"))?;
    let _ = legacy_secret_entry()?.delete_credential();
    Ok(())
}

fn resolve_binding<'a>(
    store: &'a SyncConfigStore,
    opened_root: &Path,
) -> Option<(&'a SyncBinding, &'a SyncAccount, PathBuf)> {
    store
        .bindings
        .iter()
        .filter_map(|binding| {
            let binding_root = fs::canonicalize(&binding.local_root).ok()?;
            opened_root.strip_prefix(&binding_root).ok()?;
            let account = store
                .accounts
                .iter()
                .find(|account| account.id == binding.account_id)?;
            Some((binding, account, binding_root))
        })
        .max_by_key(|(_, _, root)| root.components().count())
}

fn join_remote(root: &str, scope: &str) -> String {
    [root.trim_matches('/'), scope.trim_matches('/')]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

#[tauri::command]
pub fn load_workspace_sync_settings(
    app: tauri::AppHandle,
    root: String,
) -> Result<Option<WorkspaceSyncSettings>, String> {
    let opened_root = canonical_directory(&root)?;
    let mut store = load_store(&app)?;
    migrate_legacy(&app, &opened_root, &mut store)?;
    let Some((binding, account, binding_root)) = resolve_binding(&store, &opened_root) else {
        return Ok(None);
    };
    let relative_scope = relative_text(&binding_root, &opened_root)?;
    Ok(Some(WorkspaceSyncSettings {
        binding_id: binding.id.clone(),
        binding_root: path_text(&binding_root),
        opened_root: path_text(&opened_root),
        effective_remote_path: join_remote(&binding.remote_root, &relative_scope),
        inherited: binding_root != opened_root,
        relative_scope,
        provider: account.provider.clone(),
        region: account.region.clone(),
        endpoint: account.endpoint.clone(),
        bucket: account.bucket.clone(),
        prefix: binding.remote_root.clone(),
        access_key_id: account.access_key_id.clone(),
        has_access_key_secret: secret_entry(&account.id)?.get_password().is_ok(),
        enabled: binding.enabled,
        device_id: store.device_id,
    }))
}

#[tauri::command]
pub fn save_workspace_sync_settings(
    app: tauri::AppHandle,
    root: String,
    settings: SyncSettingsInput,
) -> Result<(), String> {
    let root = canonical_directory(&root)?;
    if settings.region.trim().is_empty()
        || settings.bucket.trim().is_empty()
        || settings.access_key_id.trim().is_empty()
    {
        return Err("请完整填写区域、Bucket 和 AccessKey ID".into());
    }
    let mut store = load_store(&app)?;
    let exact = store
        .bindings
        .iter()
        .position(|binding| fs::canonicalize(&binding.local_root).is_ok_and(|path| path == root));
    let normalized_endpoint = normalize_endpoint(&settings.endpoint)?;
    let existing_account = store.accounts.iter().find(|account| {
        account.provider == PROVIDER_OSS
            && account.region == settings.region.trim()
            && account.endpoint == normalized_endpoint
            && account.bucket == settings.bucket.trim()
            && account.access_key_id == settings.access_key_id.trim()
    });
    let binding_id = exact
        .map(|index| store.bindings[index].id.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let account_id = exact
        .map(|index| store.bindings[index].account_id.clone())
        .or_else(|| existing_account.map(|account| account.id.clone()))
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let account = SyncAccount {
        id: account_id.clone(),
        provider: PROVIDER_OSS.into(),
        region: settings.region.trim().to_string(),
        endpoint: normalized_endpoint,
        bucket: settings.bucket.trim().to_string(),
        access_key_id: settings.access_key_id.trim().to_string(),
    };
    if let Some(index) = store.accounts.iter().position(|item| item.id == account_id) {
        store.accounts[index] = account;
    } else {
        store.accounts.push(account);
    }
    if let Some(secret) = settings
        .access_key_secret
        .filter(|value| !value.trim().is_empty())
    {
        secret_entry(&account_id)?
            .set_password(&secret)
            .map_err(|error| format!("无法保存 OSS 密钥：{error}"))?;
    } else if secret_entry(&account_id)?.get_password().is_err() {
        return Err("请填写 AccessKey Secret".into());
    }
    let binding = SyncBinding {
        id: binding_id,
        local_root: path_text(&root),
        account_id,
        remote_root: normalize_remote_root(&settings.prefix)?,
        enabled: settings.enabled,
    };
    if let Some(index) = exact {
        store.bindings[index] = binding;
    } else {
        store.bindings.push(binding);
    }
    save_store(&app, &store)
}

#[tauri::command]
pub fn load_workspace_sync_credentials(
    app: tauri::AppHandle,
    root: String,
) -> Result<WorkspaceSyncCredentials, String> {
    let opened_root = canonical_directory(&root)?;
    let store = load_store(&app)?;
    let (binding, account, binding_root) = resolve_binding(&store, &opened_root)
        .ok_or_else(|| "当前工作区没有同步绑定".to_string())?;
    let relative_scope = relative_text(&binding_root, &opened_root)?;
    Ok(WorkspaceSyncCredentials {
        binding_id: binding.id.clone(),
        workspace_id: binding.id.clone(),
        binding_root: path_text(&binding_root),
        opened_root: path_text(&opened_root),
        effective_remote_path: join_remote(&binding.remote_root, &relative_scope),
        relative_scope,
        provider: account.provider.clone(),
        region: account.region.clone(),
        endpoint: account.endpoint.clone(),
        bucket: account.bucket.clone(),
        prefix: binding.remote_root.clone(),
        access_key_id: account.access_key_id.clone(),
        access_key_secret: secret_entry(&account.id)?
            .get_password()
            .map_err(|error| format!("无法读取 OSS 密钥：{error}"))?,
        device_id: store.device_id,
    })
}

#[tauri::command]
pub fn remove_workspace_sync_binding(app: tauri::AppHandle, root: String) -> Result<(), String> {
    let root = canonical_directory(&root)?;
    let mut store = load_store(&app)?;
    let removed_accounts: Vec<String> = store
        .bindings
        .iter()
        .filter(|binding| fs::canonicalize(&binding.local_root).is_ok_and(|path| path == root))
        .map(|binding| binding.account_id.clone())
        .collect();
    store
        .bindings
        .retain(|binding| !fs::canonicalize(&binding.local_root).is_ok_and(|path| path == root));
    for account_id in removed_accounts {
        if !store
            .bindings
            .iter()
            .any(|binding| binding.account_id == account_id)
        {
            store.accounts.retain(|account| account.id != account_id);
            let _ = secret_entry(&account_id)?.delete_credential();
        }
    }
    save_store(&app, &store)
}

fn hash_file(path: &Path) -> Result<(String, u64), String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let size = file.metadata().map_err(|error| error.to_string())?.len();
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok((format!("{:x}", hasher.finalize()), size))
}

fn scan(
    root: &Path,
    path: &Path,
    entries: &mut Vec<LocalSyncEntry>,
    skipped: &mut Vec<String>,
) -> Result<(), String> {
    for item in fs::read_dir(path).map_err(|error| error.to_string())? {
        let item = item.map_err(|error| error.to_string())?;
        let item_path = item.path();
        let metadata = fs::symlink_metadata(&item_path).map_err(|error| error.to_string())?;
        let relative = relative_text(root, &item_path)?;
        if path == root && item.file_name() == SYNC_METADATA_DIRECTORY {
            skipped.push(relative);
            continue;
        }
        if metadata.file_type().is_symlink() {
            skipped.push(relative);
            continue;
        }
        if metadata.is_dir() {
            entries.push(LocalSyncEntry {
                path: relative,
                kind: "directory".into(),
                hash: None,
                size: None,
                modified_at: None,
            });
            scan(root, &item_path, entries, skipped)?;
        } else if metadata.is_file() {
            let (hash, size) = hash_file(&item_path)?;
            let modified_at = metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                .map(|value| value.as_millis() as u64);
            entries.push(LocalSyncEntry {
                path: relative,
                kind: "file".into(),
                hash: Some(hash),
                size: Some(size),
                modified_at,
            });
        } else {
            skipped.push(relative);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn scan_workspace_sync(root: String) -> Result<LocalSyncSnapshot, String> {
    let root = canonical_directory(&root)?;
    let mut entries = Vec::new();
    let mut skipped = Vec::new();
    scan(&root, &root, &mut entries, &mut skipped)?;
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(LocalSyncSnapshot { entries, skipped })
}

fn checked_relative(relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if relative.is_empty()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("同步路径无效".into());
    }
    Ok(path.to_path_buf())
}

fn safe_target(root: &Path, relative: &str, create_parents: bool) -> Result<PathBuf, String> {
    let relative = checked_relative(relative)?;
    let mut current = root.to_path_buf();
    let components: Vec<_> = relative.components().collect();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            return Err("同步路径无效".into());
        };
        current.push(name);
        if current.exists() {
            if fs::symlink_metadata(&current)
                .map_err(|error| error.to_string())?
                .file_type()
                .is_symlink()
            {
                return Err("同步路径不能经过符号链接".into());
            }
        } else if create_parents && index + 1 < components.len() {
            fs::create_dir(&current).map_err(|error| error.to_string())?;
        }
    }
    Ok(current)
}

#[tauri::command]
pub fn read_workspace_sync_chunk(
    root: String,
    path: String,
    offset: u64,
    length: usize,
) -> Result<tauri::ipc::Response, String> {
    let root = canonical_directory(&root)?;
    let target = safe_target(&root, &path, false)?;
    if !target.is_file() {
        return Err("同步文件不存在".into());
    }
    let mut file = File::open(target).map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    let mut content = vec![0; length];
    let read = file.read(&mut content).map_err(|error| error.to_string())?;
    content.truncate(read);
    Ok(tauri::ipc::Response::new(content))
}

fn temp_path(app: &tauri::AppHandle, token: &str) -> Result<PathBuf, String> {
    Uuid::parse_str(token).map_err(|_| "同步临时文件标识无效".to_string())?;
    let directory = app_config_dir(app)?.join("sync-temp");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join(token))
}

#[tauri::command]
pub fn begin_workspace_sync_write(app: tauri::AppHandle) -> Result<String, String> {
    let token = Uuid::new_v4().to_string();
    File::create(temp_path(&app, &token)?).map_err(|error| error.to_string())?;
    Ok(token)
}

#[tauri::command]
pub fn write_workspace_sync_chunk(
    app: tauri::AppHandle,
    token: String,
    offset: u64,
    content: Vec<u8>,
) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .open(temp_path(&app, &token)?)
        .map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    file.write_all(&content).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn commit_workspace_sync_write(
    app: tauri::AppHandle,
    root: String,
    path: String,
    token: String,
) -> Result<(), String> {
    let root = canonical_directory(&root)?;
    let target = safe_target(&root, &path, true)?;
    let source = temp_path(&app, &token)?;
    let staging = target.with_file_name(format!(".superwiki-sync-{}.tmp", Uuid::new_v4()));
    fs::copy(&source, &staging).map_err(|error| error.to_string())?;
    if target.is_dir() {
        fs::remove_dir_all(&target).map_err(|error| error.to_string())?;
    } else if target.exists() {
        fs::remove_file(&target).map_err(|error| error.to_string())?;
    }
    fs::rename(staging, target).map_err(|error| error.to_string())?;
    fs::remove_file(source).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn cancel_workspace_sync_write(app: tauri::AppHandle, token: String) -> Result<(), String> {
    let path = temp_path(&app, &token)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn hash_workspace_sync_temp(app: tauri::AppHandle, token: String) -> Result<String, String> {
    hash_file(&temp_path(&app, &token)?).map(|(hash, _)| hash)
}

#[tauri::command]
pub fn create_workspace_sync_directory(root: String, path: String) -> Result<(), String> {
    let root = canonical_directory(&root)?;
    let target = safe_target(&root, &path, true)?;
    if target.exists() && !target.is_dir() {
        fs::remove_file(&target).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(target).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_workspace_sync_entry(root: String, path: String) -> Result<(), String> {
    let root = canonical_directory(&root)?;
    let target = safe_target(&root, &path, false)?;
    if !target.exists() {
        return Ok(());
    }
    if target.is_dir() {
        fs::remove_dir_all(target).map_err(|error| error.to_string())
    } else {
        fs::remove_file(target).map_err(|error| error.to_string())
    }
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| error.to_string())?;
    for item in fs::read_dir(source).map_err(|error| error.to_string())? {
        let item = item.map_err(|error| error.to_string())?;
        let source_path = item.path();
        let metadata = fs::symlink_metadata(&source_path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        let destination_path = destination.join(item.file_name());
        if metadata.is_dir() {
            copy_directory(&source_path, &destination_path)?;
        } else if metadata.is_file() {
            fs::copy(source_path, destination_path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn copy_workspace_sync_entry(
    root: String,
    source: String,
    destination: String,
) -> Result<(), String> {
    let root = canonical_directory(&root)?;
    let source = safe_target(&root, &source, false)?;
    let destination = safe_target(&root, &destination, true)?;
    if destination.exists() {
        return Err("同步冲突副本已存在".into());
    }
    if source.is_dir() {
        copy_directory(&source, &destination)
    } else if source.is_file() {
        fs::copy(source, destination)
            .map(|_| ())
            .map_err(|error| error.to_string())
    } else {
        Err("同步源文件不存在".into())
    }
}

fn baseline_path(app: &tauri::AppHandle, binding_id: &str) -> Result<PathBuf, String> {
    Uuid::parse_str(binding_id).map_err(|_| "同步绑定标识无效".to_string())?;
    let directory = app_config_dir(app)?.join("sync-state");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join(format!("{binding_id}.json")))
}

#[tauri::command]
pub fn load_sync_baseline(
    app: tauri::AppHandle,
    binding_id: String,
) -> Result<Option<serde_json::Value>, String> {
    let path = baseline_path(&app, &binding_id)?;
    if !path.exists() {
        return Ok(None);
    }
    serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_sync_baseline(
    app: tauri::AppHandle,
    binding_id: String,
    baseline: serde_json::Value,
) -> Result<(), String> {
    let content = serde_json::to_vec_pretty(&baseline).map_err(|error| error.to_string())?;
    fs::write(baseline_path(&app, &binding_id)?, content).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn start_workspace_watcher(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceWatcher>,
    root: String,
) -> Result<(), String> {
    let root = canonical_directory(&root)?;
    let emitter = app.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        if let Ok(event) = result {
            let paths: Vec<String> = event
                .paths
                .into_iter()
                .map(|path| path_text(&path))
                .collect();
            let _ = emitter.emit("workspace-sync-changed", paths);
        }
    })
    .map_err(|error| error.to_string())?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|error| error.to_string())?;
    *state
        .0
        .lock()
        .map_err(|_| "无法锁定目录监听器".to_string())? = Some(watcher);
    Ok(())
}

#[tauri::command]
pub fn stop_workspace_watcher(state: tauri::State<'_, WorkspaceWatcher>) -> Result<(), String> {
    *state
        .0
        .lock()
        .map_err(|_| "无法锁定目录监听器".to_string())? = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_directory(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("superwiki-sync-{name}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn rejects_unsafe_relative_paths() {
        assert!(checked_relative("../secret").is_err());
        assert!(checked_relative("C:\\secret").is_err());
        assert!(checked_relative("docs/guide.md").is_ok());
    }

    #[test]
    fn joins_remote_paths() {
        assert_eq!(join_remote("notes/", "/project/docs"), "notes/project/docs");
        assert_eq!(join_remote("", "project"), "project");
    }

    #[test]
    fn resolves_the_nearest_workspace_binding() {
        let root = temporary_directory("binding");
        let nested = root.join("notes").join("private");
        fs::create_dir_all(&nested).unwrap();
        let parent_account = SyncAccount {
            id: "parent-account".into(),
            provider: PROVIDER_OSS.into(),
            region: "r".into(),
            endpoint: "https://example.com".into(),
            bucket: "b".into(),
            access_key_id: "k".into(),
        };
        let child_account = SyncAccount {
            id: "child-account".into(),
            ..parent_account.clone()
        };
        let store = SyncConfigStore {
            accounts: vec![parent_account, child_account],
            bindings: vec![
                SyncBinding {
                    id: "parent".into(),
                    local_root: path_text(&root),
                    account_id: "parent-account".into(),
                    remote_root: "root".into(),
                    enabled: true,
                },
                SyncBinding {
                    id: "child".into(),
                    local_root: path_text(&root.join("notes")),
                    account_id: "child-account".into(),
                    remote_root: "notes".into(),
                    enabled: true,
                },
            ],
            ..SyncConfigStore::default()
        };
        let (binding, _, _) = resolve_binding(&store, &fs::canonicalize(&nested).unwrap()).unwrap();
        assert_eq!(binding.id, "child");
        fs::remove_dir_all(root).unwrap();
    }
}
