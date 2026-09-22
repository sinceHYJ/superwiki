//! Tauri 本地文件服务与命令注册：负责工作区文件访问及设置模块的 IPC 转发。
//! 所有路径读写必须经过本文件的边界校验；设置数据由 `settings` 模块持久化到 SQLite。

use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
};
#[cfg(target_os = "windows")]
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

/// SQLite 设置服务；仅通过下方异步命令暴露给前端。
mod settings;

/// 工作区树中的文件或目录节点，序列化为前端使用的 camelCase 字段。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileTreeNode {
    /// 节点展示名称。
    name: String,
    /// 节点规范化后的绝对路径。
    path: String,
    /// 是否为目录；目录节点才拥有 `children`。
    is_dir: bool,
    /// 是否为可编辑的 Markdown 文件。
    is_markdown: bool,
    /// 是否为只读预览的图片文件。
    is_image: bool,
    /// 是否为 Office 预览文件。
    is_office: bool,
    /// 已排序的直接子节点；普通文件为空数组。
    children: Vec<FileTreeNode>,
}

/// 用户打开的工作区及其顶层目录树。
#[derive(Serialize)]
pub(crate) struct WorkspaceTree {
    /// 工作区根目录规范化后的绝对路径。
    root: String,
    /// 工作区根目录展示名称。
    name: String,
    /// 根目录直接子节点，目录优先且按名称排序。
    children: Vec<FileTreeNode>,
}

/// 上传资源的元数据，描述目标工作区、关联 Markdown 文档和原始文件名。
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetUploadMetadata {
    /// 工作区根目录绝对路径。
    root: String,
    /// 上传资源关联的 Markdown 文档绝对路径。
    document_path: String,
    /// 客户端原始文件名，保存前会净化。
    file_name: String,
}

/// 写入 SQLite 前已规范化的 OSS 非敏感配置。
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OssSyncConfig {
    /// OSS 区域标识。
    region: String,
    /// HTTP(S) Endpoint。
    endpoint: String,
    /// 目标 Bucket。
    bucket: String,
    /// Bucket 对象前缀；空字符串表示根目录。
    prefix: String,
    /// AccessKey ID，密钥不在此结构中保存。
    access_key_id: String,
    #[serde(default)]
    /// 是否启用自动同步；缺失旧字段默认关闭。
    enabled: bool,
}

/// 打开工作区命令一次返回的数据库记录、目录树和文档偏好。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenWorkspaceResult {
    /// 用于后续偏好操作的持久化工作区记录。
    workspace: settings::WorkspaceRecord,
    /// 当前文件系统扫描得到的工作区目录树。
    tree: WorkspaceTree,
    /// 收藏和最近编辑文档快照。
    preferences: settings::WorkspacePreferences,
}

/// Bilibili 视频信息 API 的最小响应字段。
#[derive(Deserialize)]
struct BilibiliViewResponse {
    /// API 业务状态码，零表示成功。
    code: i32,
    /// 成功时的视频元数据；失败时可能缺失。
    data: Option<BilibiliVideoData>,
}

/// Bilibili 视频元数据中本应用需要的封面字段。
#[derive(Deserialize)]
struct BilibiliVideoData {
    /// 封面 URL；API 未提供时为 `None`。
    pic: Option<String>,
}

#[tauri::command]
/// 下载并返回 Bilibili 视频封面二进制。
/// 参数：`bvid` 必须是 12 字符、以 `BV` 开头的字母数字编号。返回：图片 IPC 响应。错误/副作用：编号、远端 API 或下载失败时返回错误；会发起网络请求。
async fn fetch_bilibili_thumbnail(bvid: String) -> Result<tauri::ipc::Response, String> {
    if !bvid.starts_with("BV")
        || bvid.len() != 12
        || !bvid
            .chars()
            .skip(2)
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err("Bilibili 视频编号无效".into());
    }

    let client = reqwest::Client::builder()
        .user_agent("SuperWiki/0.5.0")
        .build()
        .map_err(|error| format!("无法创建网络客户端：{error}"))?;
    let metadata_url = format!("https://api.bilibili.com/x/web-interface/view?bvid={bvid}");
    let metadata = client
        .get(metadata_url)
        .header(reqwest::header::REFERER, "https://www.bilibili.com/")
        .send()
        .await
        .map_err(|error| format!("无法请求 Bilibili 视频信息：{error}"))?
        .error_for_status()
        .map_err(|error| format!("Bilibili 视频信息请求失败：{error}"))?
        .json::<BilibiliViewResponse>()
        .await
        .map_err(|error| format!("无法解析 Bilibili 视频信息：{error}"))?;

    if metadata.code != 0 {
        return Err(format!("Bilibili 返回错误码：{}", metadata.code));
    }
    let source = metadata
        .data
        .and_then(|data| data.pic)
        .ok_or_else(|| "Bilibili 未返回视频封面".to_string())?
        .replace("http://", "https://");

    let image = client
        .get(source)
        .header(reqwest::header::REFERER, "https://www.bilibili.com/")
        .send()
        .await
        .map_err(|error| format!("无法下载 Bilibili 视频封面：{error}"))?
        .error_for_status()
        .map_err(|error| format!("Bilibili 视频封面下载失败：{error}"))?
        .bytes()
        .await
        .map_err(|error| format!("无法读取 Bilibili 视频封面：{error}"))?;

    Ok(tauri::ipc::Response::new(image.to_vec()))
}

/// 判断路径是否具有允许编辑的 Markdown 扩展名。
/// 参数：`path` 为任意文件路径。返回：`.md`/`.markdown`（忽略大小写）时为 `true`。
fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
        })
}

/// 判断路径是否为支持只读预览的图片。
/// 参数：`path` 为任意文件路径。返回：支持的图片扩展名时为 `true`。
fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico"
            )
        })
}

/// 判断路径是否具有可读取 HTML 资源的扩展名。
/// 参数：`path` 为任意文件路径。返回：`.html`/`.htm`（忽略大小写）时为 `true`。
fn is_html(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm")
        })
}

/// 判断路径是否为支持预览的 Office 文件。
/// 参数：`path` 为任意文件路径。返回：DOCX、XLSX 或 PPTX 时为 `true`。
fn is_office(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "docx" | "xlsx" | "pptx"
            )
        })
}

/// 递归扫描目录并生成按目录优先、名称排序的文件树。
/// 参数：`path` 必须为可读取目录。返回：其直接节点及递归子节点。错误/副作用：读取失败时返回错误。
fn scan_directory(path: &Path) -> Result<Vec<FileTreeNode>, String> {
    let mut nodes = Vec::new();
    let entries = fs::read_dir(path).map_err(|error| error.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        let entry_path = entry.path();
        let is_dir = file_type.is_dir();
        let children = if is_dir {
            scan_directory(&entry_path)?
        } else {
            Vec::new()
        };

        nodes.push(FileTreeNode {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry_path.to_string_lossy().into_owned(),
            is_dir,
            is_markdown: !is_dir && is_markdown(&entry_path),
            is_image: !is_dir && is_image(&entry_path),
            is_office: !is_dir && is_office(&entry_path),
            children,
        });
    }

    nodes.sort_by(|left, right| {
        right
            .is_dir
            .cmp(&left.is_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(nodes)
}

/// 规范化并验证工作区内的文件或目录路径。
/// 参数：`root` 为工作区根目录，`path` 为目标路径。返回：规范化目标路径。错误：越界、根无效或目标非条目时返回错误。
fn workspace_entry_path(root: &str, path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    let path = fs::canonicalize(path).map_err(|error| error.to_string())?;

    if !root.is_dir() || !path.starts_with(&root) || (!path.is_file() && !path.is_dir()) {
        return Err("文件或文件夹不在已打开的目录中".into());
    }
    Ok(path)
}

/// 验证工作区内的普通文件路径。
/// 参数：`root` 为工作区根目录，`path` 为目标路径。返回：规范化普通文件路径。错误：目录或越界条目被拒绝。
fn workspace_file_path(root: &str, path: &str) -> Result<PathBuf, String> {
    let path = workspace_entry_path(root, path)?;
    if !path.is_file() {
        return Err("文件不在已打开的目录中".into());
    }
    Ok(path)
}

/// 规范化 OSS 对象前缀并禁止向上目录组件。
/// 参数：`prefix` 为用户输入前缀。返回：去首尾斜杠并统一为 `/` 的前缀。错误：包含 `..` 时返回错误。
fn normalize_oss_prefix(prefix: &str) -> Result<String, String> {
    let prefix = prefix.trim().trim_matches('/').replace('\\', "/");
    if prefix.split('/').any(|part| part == "..") {
        return Err("OSS 远端目录不能包含 ..".into());
    }
    Ok(prefix)
}

/// 规范化 OSS Endpoint 为 HTTP(S) URL。
/// 参数：`endpoint` 为用户输入。返回：无协议时自动添加 `https://` 的 URL。错误：为空或协议非 HTTP(S) 时返回错误。
fn normalize_oss_endpoint(endpoint: &str) -> Result<String, String> {
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

/// 校验 OSS 同步所需的必填配置。
/// 参数：`config` 为已规范化 OSS 配置。返回：字段齐全时为 `()`。错误：区域、Endpoint、Bucket 或 AccessKey ID 为空时返回错误。
fn validate_oss_sync_config(config: &OssSyncConfig) -> Result<(), String> {
    if config.region.trim().is_empty()
        || config.endpoint.trim().is_empty()
        || config.bucket.trim().is_empty()
        || config.access_key_id.trim().is_empty()
    {
        return Err("请完整填写区域、Endpoint、Bucket 和 AccessKey ID".into());
    }
    Ok(())
}

/// 验证工作区内非根目录的目录路径。
/// 参数：`root` 为工作区根目录，`path` 为目标路径。返回：规范化目录路径。错误：根目录、文件或越界路径被拒绝。
fn workspace_directory_path(root: &str, path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    let path = fs::canonicalize(path).map_err(|error| error.to_string())?;

    if !root.is_dir() || path == root || !path.starts_with(&root) || !path.is_dir() {
        return Err("文件夹不在已打开的目录中".into());
    }
    Ok(path)
}

/// 验证可作为新建条目父级的工作区目录路径。
/// 参数：`root` 为工作区根目录，`path` 为父目录。返回：规范化目录路径。错误：越界或非目录时返回错误。
fn workspace_parent_directory_path(root: &str, path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    let path = fs::canonicalize(path).map_err(|error| error.to_string())?;

    if !root.is_dir() || !path.starts_with(&root) || !path.is_dir() {
        return Err("目标文件夹不在已打开的目录中".into());
    }
    Ok(path)
}

/// 校验新建或重命名的单个文件名。
/// 参数：`name` 为用户输入名称。返回：合法时为 `()`。错误：空、`.`、`..` 或包含路径分隔符时返回错误。
fn validate_entry_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        return Err("名称无效".into());
    }
    Ok(())
}

#[tauri::command]
/// 列出工作区目录树。
/// 参数：`root` 为工作区目录。返回：规范化根及递归文件树。错误：根无效或扫描失败时返回错误。
fn list_workspace(root: String) -> Result<WorkspaceTree, String> {
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    build_workspace_tree(&root)
}

/// 基于已规范化的目录根构建工作区树。
///
/// 参数：`root` 必须是已规范化目录。返回：其 `WorkspaceTree`。错误：扫描失败或不是目录时返回错误。
fn build_workspace_tree(root: &Path) -> Result<WorkspaceTree, String> {
    if !root.is_dir() {
        return Err("选择的路径不是文件夹".into());
    }

    Ok(WorkspaceTree {
        name: root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.to_string_lossy().into_owned()),
        children: scan_directory(root)?,
        root: root.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
/// 重命名工作区中的非根目录。
/// 参数：`root` 为工作区根，`path` 为原目录，`new_name` 为不含分隔符的新名称。返回：新绝对路径。错误/副作用：校验或重命名失败时返回错误；成功时修改文件系统。
fn rename_workspace_directory(
    root: String,
    path: String,
    new_name: String,
) -> Result<String, String> {
    validate_entry_name(&new_name)?;
    let path = workspace_directory_path(&root, &path)?;
    if path
        .file_name()
        .is_some_and(|name| name == new_name.as_str())
    {
        return Ok(path.to_string_lossy().into_owned());
    }

    let destination = path
        .parent()
        .ok_or_else(|| "无法确定文件夹的上级目录".to_string())?
        .join(new_name);
    if destination.exists() {
        return Err("同名文件或文件夹已存在".into());
    }

    fs::rename(&path, &destination).map_err(|error| format!("无法重命名文件夹：{error}"))?;
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
/// 重命名工作区中的文件，并保留其受支持的扩展名类别。
/// 参数：`root` 为工作区根，`path` 为原文件，`new_name` 为新名称。返回：新绝对路径。错误/副作用：无效类型、冲突或重命名失败时返回错误；成功时修改文件系统。
fn rename_workspace_file(root: String, path: String, new_name: String) -> Result<String, String> {
    validate_entry_name(&new_name)?;
    let path = workspace_file_path(&root, &path)?;
    if path
        .file_name()
        .is_some_and(|name| name == new_name.as_str())
    {
        return Ok(path.to_string_lossy().into_owned());
    }

    let destination = path
        .parent()
        .ok_or_else(|| "无法确定文件的上级目录".to_string())?
        .join(new_name);
    if is_markdown(&path) && !is_markdown(&destination) {
        return Err("Markdown 文件重命名后必须保留 .md 或 .markdown 扩展名".into());
    }
    if is_image(&path) && !is_image(&destination) {
        return Err("图片重命名后必须保留支持的图片扩展名".into());
    }
    if is_office(&path) && !is_office(&destination) {
        return Err("Office 文件重命名后必须保留 .docx、.xlsx 或 .pptx 扩展名".into());
    }
    if destination.exists() {
        return Err("同名文件或文件夹已存在".into());
    }

    fs::rename(&path, &destination).map_err(|error| format!("无法重命名文件：{error}"))?;
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
/// 永久删除工作区内非根目录及其后代。
/// 参数：`root` 为工作区根，`path` 为目录。返回：成功时为 `()`。错误/副作用：校验或删除失败时返回错误；成功时递归删除文件系统内容。
fn delete_workspace_directory(root: String, path: String) -> Result<(), String> {
    let path = workspace_directory_path(&root, &path)?;
    fs::remove_dir_all(path).map_err(|error| format!("无法删除文件夹：{error}"))
}

#[tauri::command]
/// 永久删除工作区内文件。
/// 参数：`root` 为工作区根，`path` 为文件。返回：成功时为 `()`。错误/副作用：校验或删除失败时返回错误；成功时删除文件。
fn delete_workspace_file(root: String, path: String) -> Result<(), String> {
    let path = workspace_file_path(&root, &path)?;
    fs::remove_file(path).map_err(|error| format!("无法删除文件：{error}"))
}

#[tauri::command]
/// 在工作区目录中新建子目录。
/// 参数：`root` 为工作区根，`parent_path` 为父目录，`name` 为合法单段名称。返回：新目录绝对路径。错误/副作用：冲突或创建失败时返回错误；成功时创建目录。
fn create_workspace_directory(
    root: String,
    parent_path: String,
    name: String,
) -> Result<String, String> {
    validate_entry_name(&name)?;
    let parent = workspace_parent_directory_path(&root, &parent_path)?;
    let destination = parent.join(name);
    fs::create_dir(&destination).map_err(|error| {
        if error.kind() == ErrorKind::AlreadyExists {
            "同名文件或文件夹已存在".to_string()
        } else {
            format!("无法创建文件夹：{error}")
        }
    })?;
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
/// 在工作区目录中新建空 Markdown 文件。
/// 参数：`root` 为工作区根，`parent_path` 为父目录，`name` 为名称或 Markdown 文件名。返回：新文件绝对路径。错误/副作用：冲突、扩展名无效或创建失败时返回错误；成功时创建文件。
fn create_workspace_markdown_file(
    root: String,
    parent_path: String,
    name: String,
) -> Result<String, String> {
    validate_entry_name(&name)?;
    let file_name = if Path::new(&name).extension().is_none() {
        format!("{name}.md")
    } else if is_markdown(Path::new(&name)) {
        name
    } else {
        return Err("只能新建 Markdown 文件".into());
    };

    let parent = workspace_parent_directory_path(&root, &parent_path)?;
    let destination = parent.join(file_name);
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination)
        .map_err(|error| {
            if error.kind() == ErrorKind::AlreadyExists {
                "同名文件或文件夹已存在".to_string()
            } else {
                format!("无法创建 Markdown 文件：{error}")
            }
        })?;
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
/// 读取工作区内 Markdown 文本。
/// 参数：`root` 为工作区根，`path` 为 Markdown 文件。返回：UTF-8 文件内容。错误：越界、非 Markdown 或读取失败时返回错误。
fn read_workspace_file(root: String, path: String) -> Result<String, String> {
    let path = workspace_file_path(&root, &path)?;
    if !is_markdown(&path) {
        return Err("只能读取 Markdown 文件".into());
    }
    fs::read_to_string(path).map_err(|error| format!("无法读取文件：{error}"))
}

#[tauri::command]
/// 读取工作区文件的原始二进制内容以供同步。
/// 参数：`root` 为工作区根，`path` 为文件。返回：IPC 二进制响应。错误：越界或读取失败时返回错误。
fn read_workspace_sync_file(root: String, path: String) -> Result<tauri::ipc::Response, String> {
    let path = workspace_file_path(&root, &path)?;
    fs::read(path)
        .map(tauri::ipc::Response::new)
        .map_err(|error| format!("无法读取同步文件：{error}"))
}

/// 初始化 SQLite 设置数据库并返回应用启动快照。
///
/// 参数：`app` 为 Tauri 应用句柄。返回：`BootstrapSettings` 启动快照。错误/副作用：初始化失败时返回错误；同步数据库工作移至阻塞线程。
#[tauri::command]
async fn initialize_settings(app: tauri::AppHandle) -> Result<settings::BootstrapSettings, String> {
    tauri::async_runtime::spawn_blocking(move || settings::initialize(&app))
        .await
        .map_err(|error| format!("配置初始化任务失败：{error}"))?
}

/// 校验并保存单项应用偏好。
///
/// 参数：`app` 为应用句柄，`change` 为键值更新。返回：成功时为 `()`。错误/副作用：白名单或写入失败时返回错误；数据库写入在阻塞线程执行。
#[tauri::command]
async fn update_app_preference(
    app: tauri::AppHandle,
    change: settings::PreferenceChange,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || settings::update_preference(&app, change))
        .await
        .map_err(|error| format!("配置保存任务失败：{error}"))?
}

/// 原子保存所有非默认快捷键覆盖。
///
/// 参数：`app` 为应用句柄，`overrides` 为动作 ID 到组合键映射。返回：成功时为 `()`。错误/副作用：无效数据或写入失败时返回错误；在阻塞线程替换快照。
#[tauri::command]
async fn save_shortcut_overrides(
    app: tauri::AppHandle,
    overrides: HashMap<String, String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || settings::save_shortcuts(&app, overrides))
        .await
        .map_err(|error| format!("快捷键保存任务失败：{error}"))?
}

/// 打开工作区、登记其持久化记录并读取关联偏好。
///
/// 参数：`app` 为应用句柄，`root` 为用户选择目录。返回：目录树、工作区 ID 与偏好。错误/副作用：路径或数据库失败时返回错误；在阻塞线程规范化并登记工作区。
#[tauri::command]
async fn open_workspace(
    app: tauri::AppHandle,
    root: String,
) -> Result<OpenWorkspaceResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 使用规范化路径作为数据库唯一键，避免同一目录因符号链接或相对路径重复登记。
        let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
        let tree = build_workspace_tree(&root)?;
        let (workspace, preferences) = settings::open_workspace(&app, &root)?;
        Ok(OpenWorkspaceResult {
            workspace,
            tree,
            preferences,
        })
    })
    .await
    .map_err(|error| format!("工作区打开任务失败：{error}"))?
}

/// 清除最近打开工作区标记，不删除历史工作区与其文档偏好。
/// 参数：`app` 为应用句柄。返回：成功时为 `()`。错误/副作用：写入失败时返回错误；在阻塞线程更新数据库。
#[tauri::command]
async fn close_workspace(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || settings::close_workspace(&app))
        .await
        .map_err(|error| format!("工作区配置保存任务失败：{error}"))?
}

/// 设置 Markdown 文档的收藏状态并返回更新后的工作区偏好。
///
/// 参数：`app` 为应用句柄，`workspace_id` 标识工作区，`path` 为文档，`favorite` 决定添加或移除。返回：更新后的偏好。错误/副作用：路径或写入失败时返回错误；在阻塞线程更新收藏。
#[tauri::command]
async fn set_document_favorite(
    app: tauri::AppHandle,
    workspace_id: i64,
    path: String,
    favorite: bool,
) -> Result<settings::WorkspacePreferences, String> {
    tauri::async_runtime::spawn_blocking(move || {
        settings::set_favorite(&app, workspace_id, &path, favorite)
    })
    .await
    .map_err(|error| format!("收藏保存任务失败：{error}"))?
}

/// 写入一条最近编辑记录并返回按上限裁剪后的工作区偏好。
/// 参数：`app` 为应用句柄，`workspace_id` 标识工作区，`path` 为文档。返回：更新后的偏好。错误/副作用：路径或写入失败时返回错误；在阻塞线程写入记录。
#[tauri::command]
async fn record_recent_edit(
    app: tauri::AppHandle,
    workspace_id: i64,
    path: String,
) -> Result<settings::WorkspacePreferences, String> {
    tauri::async_runtime::spawn_blocking(move || settings::record_recent(&app, workspace_id, &path))
        .await
        .map_err(|error| format!("最近编辑保存任务失败：{error}"))?
}

/// 在文件或目录重命名后迁移其收藏和最近编辑路径。
///
/// 参数：`app` 为应用句柄，`workspace_id` 标识工作区，`old_path`/`new_path` 为迁移路径。返回：更新后的偏好。错误/副作用：路径或写入失败时返回错误；冲突保留较新时间戳。
#[tauri::command]
async fn remap_workspace_documents(
    app: tauri::AppHandle,
    workspace_id: i64,
    old_path: String,
    new_path: String,
) -> Result<settings::WorkspacePreferences, String> {
    tauri::async_runtime::spawn_blocking(move || {
        settings::remap_documents(&app, workspace_id, &old_path, &new_path)
    })
    .await
    .map_err(|error| format!("文档配置更新任务失败：{error}"))?
}

/// 在文件或目录删除后清理其本身及后代的文档偏好记录。
/// 参数：`app` 为应用句柄，`workspace_id` 标识工作区，`path` 为删除路径。返回：更新后的偏好。错误/副作用：路径或写入失败时返回错误；在阻塞线程清理后代记录。
#[tauri::command]
async fn remove_workspace_documents(
    app: tauri::AppHandle,
    workspace_id: i64,
    path: String,
) -> Result<settings::WorkspacePreferences, String> {
    tauri::async_runtime::spawn_blocking(move || {
        settings::remove_documents(&app, workspace_id, &path)
    })
    .await
    .map_err(|error| format!("文档配置清理任务失败：{error}"))?
}

/// 读取可回显到前端的脱敏 OSS 配置。
/// 参数：`app` 为应用句柄。返回：不含密钥的配置或 `None`。错误：读取失败时返回错误。
#[tauri::command]
async fn load_oss_sync_settings(
    app: tauri::AppHandle,
) -> Result<Option<settings::OssSyncSettings>, String> {
    tauri::async_runtime::spawn_blocking(move || settings::load_oss_settings(&app))
        .await
        .map_err(|error| format!("OSS 配置读取任务失败：{error}"))?
}

/// 规范化并校验前端 OSS 输入后保存到 SQLite。
///
/// 参数：`app` 为应用句柄，`settings` 为前端 OSS 输入。返回：成功时为 `()`。错误/副作用：规范化或写入失败时返回错误；空密钥保留已有密钥并在阻塞线程写入。
#[tauri::command]
async fn save_oss_sync_settings(
    app: tauri::AppHandle,
    settings: settings::OssSyncSettingsInput,
) -> Result<(), String> {
    let config = OssSyncConfig {
        region: settings.region.trim().to_string(),
        endpoint: normalize_oss_endpoint(&settings.endpoint)?,
        bucket: settings.bucket.trim().to_string(),
        prefix: normalize_oss_prefix(&settings.prefix)?,
        access_key_id: settings.access_key_id.trim().to_string(),
        enabled: settings.enabled,
    };
    validate_oss_sync_config(&config)?;
    // 仅将经过 endpoint、prefix 与必填字段校验的值交给持久化模块。
    let normalized = settings::OssSyncSettingsInput {
        region: config.region,
        endpoint: config.endpoint,
        bucket: config.bucket,
        prefix: config.prefix,
        access_key_id: config.access_key_id,
        access_key_secret: settings.access_key_secret,
        enabled: config.enabled,
    };
    tauri::async_runtime::spawn_blocking(move || {
        crate::settings::save_oss_settings(&app, normalized)
    })
    .await
    .map_err(|error| format!("OSS 配置保存任务失败：{error}"))?
}

/// 读取同步任务使用的完整 OSS 凭据；调用方不得向前端回传 AccessKey Secret。
/// 参数：`app` 为应用句柄。返回：仅 Rust 内部使用的完整凭据。错误：读取失败时返回错误。
#[tauri::command]
async fn load_oss_sync_credentials(
    app: tauri::AppHandle,
) -> Result<settings::OssSyncCredentials, String> {
    tauri::async_runtime::spawn_blocking(move || settings::load_oss_credentials(&app))
        .await
        .map_err(|error| format!("OSS 密钥读取任务失败：{error}"))?
}

#[tauri::command]
/// 保存工作区内 Markdown 文件。
/// 参数：`root` 为工作区根，`path` 为 Markdown 文件，`content` 为完整 Markdown 文本。返回：成功时为 `()`。错误/副作用：越界、类型或写入失败时返回错误；成功时覆盖文件内容。
fn save_workspace_file(root: String, path: String, content: String) -> Result<(), String> {
    let path = workspace_file_path(&root, &path)?;
    if !is_markdown(&path) {
        return Err("只能保存 Markdown 文件".into());
    }
    fs::write(path, content).map_err(|error| format!("无法保存文件：{error}"))
}

/// 将上传图片名收敛为安全的单段文件名。
/// 参数：`file_name` 为客户端原始文件名。返回：保留支持扩展名、仅含安全字符的文件名。错误：无名称或不支持图片类型时返回错误。
fn sanitize_image_name(file_name: &str) -> Result<String, String> {
    let base_name = file_name
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "图片文件名无效".to_string())?;
    let path = Path::new(base_name);
    if !is_image(path) {
        return Err("不支持该图片格式".into());
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "图片扩展名无效".to_string())?
        .to_ascii_lowercase();
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let sanitized_stem: String = stem
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect();
    let sanitized_stem = sanitized_stem.trim_matches('-');
    Ok(format!(
        "{}.{}",
        if sanitized_stem.is_empty() {
            "image"
        } else {
            sanitized_stem
        },
        extension
    ))
}

/// 在资源目录中创建不冲突文件并写入字节。
/// 参数：`assets_dir` 为已验证目录，`file_name` 为安全名称，`bytes` 为文件内容。返回：新文件路径。错误/副作用：创建或写入失败时返回错误；成功时写入文件。
fn unique_asset_path(assets_dir: &Path, file_name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("png");

    for index in 0.. {
        let candidate_name = if index == 0 {
            file_name.to_string()
        } else {
            format!("{stem}-{index}.{extension}")
        };
        let candidate = assets_dir.join(candidate_name);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut file) => {
                if let Err(error) = file.write_all(bytes) {
                    let _ = fs::remove_file(&candidate);
                    return Err(format!("无法保存图片：{error}"));
                }
                return Ok(candidate);
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("无法保存图片：{error}")),
        }
    }
    unreachable!()
}

/// 保存 Markdown 同级 `assets/` 中的上传图片。
/// 参数：`metadata` 描述工作区、文档和原文件名，`bytes` 为非空图片数据。返回：插入 Markdown 的相对资源路径。错误/副作用：路径/类型/写入失败时返回错误；成功时创建资源文件。
fn save_uploaded_image(metadata: AssetUploadMetadata, bytes: &[u8]) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("图片内容为空".into());
    }
    let root = fs::canonicalize(&metadata.root).map_err(|error| error.to_string())?;
    let document_path = workspace_file_path(&metadata.root, &metadata.document_path)?;
    if !is_markdown(&document_path) {
        return Err("图片只能上传到 Markdown 文档".into());
    }

    let document_dir = document_path
        .parent()
        .ok_or_else(|| "无法确定文档目录".to_string())?;
    let assets_dir = document_dir.join("assets");
    fs::create_dir_all(&assets_dir).map_err(|error| format!("无法创建 assets 目录：{error}"))?;
    let assets_dir =
        fs::canonicalize(&assets_dir).map_err(|error| format!("无法访问 assets 目录：{error}"))?;
    if !assets_dir.starts_with(&root) || !assets_dir.is_dir() {
        return Err("图片目录不在已打开的目录中".into());
    }

    let file_name = sanitize_image_name(&metadata.file_name)?;
    let destination = unique_asset_path(&assets_dir, &file_name, bytes)?;
    let saved_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "图片文件名无效".to_string())?;
    Ok(format!("assets/{saved_name}"))
}

/// 将上传 HTML 名收敛为安全的单段文件名。
/// 参数：`file_name` 为客户端原始文件名。返回：保留 `.html`/`.htm`、仅含安全字符的文件名。错误：无名称或扩展名不支持时返回错误。
fn sanitize_html_name(file_name: &str) -> Result<String, String> {
    let base_name = file_name
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "HTML 文件名无效".to_string())?;
    let path = Path::new(base_name);
    if !is_html(path) {
        return Err("仅支持 .html 或 .htm 文件".into());
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "HTML 扩展名无效".to_string())?
        .to_ascii_lowercase();
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("page");
    let sanitized_stem: String = stem
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect();
    let sanitized_stem = sanitized_stem.trim_matches('-');
    Ok(format!(
        "{}.{}",
        if sanitized_stem.is_empty() {
            "page"
        } else {
            sanitized_stem
        },
        extension
    ))
}

/// 保存 Markdown 同级 `assets/` 中的上传 HTML 资源。
/// 参数：`metadata` 描述目标文档，`bytes` 为非空 UTF-8 HTML 数据。返回：插入 Markdown 的相对资源路径。错误/副作用：UTF-8、路径、类型或写入失败时返回错误；成功时创建资源文件。
fn save_uploaded_html(metadata: AssetUploadMetadata, bytes: &[u8]) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("HTML 文件内容为空".into());
    }
    std::str::from_utf8(bytes)
        .map_err(|error| format!("HTML 文件不是有效的 UTF-8 文本：{error}"))?;

    let root = fs::canonicalize(&metadata.root).map_err(|error| error.to_string())?;
    let document_path = workspace_file_path(&metadata.root, &metadata.document_path)?;
    if !is_markdown(&document_path) {
        return Err("HTML 文件只能上传到 Markdown 文档".into());
    }

    let document_dir = document_path
        .parent()
        .ok_or_else(|| "无法确定文档目录".to_string())?;
    let assets_dir = document_dir.join("assets");
    fs::create_dir_all(&assets_dir).map_err(|error| format!("无法创建 assets 目录：{error}"))?;
    let assets_dir =
        fs::canonicalize(&assets_dir).map_err(|error| format!("无法访问 assets 目录：{error}"))?;
    if !assets_dir.starts_with(&root) || !assets_dir.is_dir() {
        return Err("HTML 资源目录不在已打开的目录中".into());
    }

    let file_name = sanitize_html_name(&metadata.file_name)?;
    let destination = unique_asset_path(&assets_dir, &file_name, bytes)?;
    let saved_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "HTML 文件名无效".to_string())?;
    Ok(format!("assets/{saved_name}"))
}

/// 解析 IPC 二进制上传负载的长度前缀元数据和正文。
/// 参数：`body` 为四字节大端 JSON 长度前缀加原始文件字节。返回：元数据及正文切片。错误：长度或 JSON 无效时返回错误。
fn parse_upload_payload(body: &[u8]) -> Result<(AssetUploadMetadata, &[u8]), String> {
    if body.len() < 4 {
        return Err("图片上传请求无效".into());
    }
    let metadata_length = u32::from_be_bytes(body[0..4].try_into().unwrap()) as usize;
    let metadata_end = 4usize
        .checked_add(metadata_length)
        .filter(|end| *end <= body.len())
        .ok_or_else(|| "图片上传元数据无效".to_string())?;
    let metadata = serde_json::from_slice(&body[4..metadata_end])
        .map_err(|error| format!("无法解析图片上传元数据：{error}"))?;
    Ok((metadata, &body[metadata_end..]))
}

#[tauri::command]
/// 接收二进制 IPC 图片上传并保存到当前 Markdown 的资源目录。
/// 参数：`request` 必须含 Raw 二进制负载。返回：相对资源路径。错误/副作用：负载或保存失败时返回错误；成功时创建图片文件。
fn upload_workspace_image(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("图片上传请求必须使用二进制数据".into());
    };
    let (metadata, image_bytes) = parse_upload_payload(body)?;
    save_uploaded_image(metadata, image_bytes)
}

#[tauri::command]
/// 接收二进制 IPC HTML 上传并保存到当前 Markdown 的资源目录。
/// 参数：`request` 必须含 Raw 二进制负载。返回：相对资源路径。错误/副作用：负载或保存失败时返回错误；成功时创建 HTML 文件。
fn upload_workspace_html(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("HTML 上传请求必须使用二进制数据".into());
    };
    let (metadata, html_bytes) = parse_upload_payload(body)?;
    save_uploaded_html(metadata, html_bytes)
}

#[tauri::command]
/// 读取工作区内 HTML 文本。
/// 参数：`root` 为工作区根，`path` 为 HTML 文件。返回：UTF-8 HTML 文本。错误：越界、非 HTML 或读取失败时返回错误。
fn read_workspace_html(root: String, path: String) -> Result<String, String> {
    let path = workspace_file_path(&root, &path)?;
    if !is_html(&path) {
        return Err("只能读取 HTML 文件".into());
    }
    fs::read_to_string(path).map_err(|error| format!("无法读取 HTML 文件：{error}"))
}

#[tauri::command]
/// 读取工作区内支持图片的原始字节。
/// 参数：`root` 为工作区根，`path` 为图片文件。返回：IPC 二进制响应。错误：越界、类型或读取失败时返回错误。
fn read_workspace_image(root: String, path: String) -> Result<tauri::ipc::Response, String> {
    let path = workspace_file_path(&root, &path)?;
    if !is_image(&path) {
        return Err("只能预览支持的图片文件".into());
    }
    fs::read(path)
        .map(tauri::ipc::Response::new)
        .map_err(|error| format!("无法读取图片：{error}"))
}

#[tauri::command]
/// 在系统文件管理器中打开目录或定位文件。
/// 参数：`app` 为应用句柄，`root` 为工作区根，`path` 为工作区内条目。返回：成功时为 `()`。错误/副作用：路径或系统打开失败时返回错误；会唤起外部文件管理器。
fn open_workspace_entry_in_file_manager(
    app: tauri::AppHandle,
    root: String,
    path: String,
) -> Result<(), String> {
    let path = workspace_entry_path(&root, &path)?;
    if path.is_dir() {
        app.opener()
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(|error| format!("无法打开文件夹：{error}"))
    } else {
        app.opener()
            .reveal_item_in_dir(path)
            .map_err(|error| format!("无法打开文件所在目录：{error}"))
    }
}

#[tauri::command]
/// 读取工作区内支持的 Office 文件原始字节。
/// 参数：`root` 为工作区根，`path` 为 Office 文件。返回：IPC 二进制响应。错误：越界、类型或读取失败时返回错误。
fn read_workspace_office(root: String, path: String) -> Result<tauri::ipc::Response, String> {
    let path = workspace_file_path(&root, &path)?;
    if !is_office(&path) {
        return Err("只能预览 DOCX、XLSX 或 PPTX 文件".into());
    }
    fs::read(path)
        .map(tauri::ipc::Response::new)
        .map_err(|error| format!("无法读取 Office 文件：{error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// 构建 Tauri 应用、注册本地命令并运行桌面事件循环。
/// 返回：正常退出时为 `()`。副作用：创建桌面窗口、注册 IPC 命令并启动应用生命周期。
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(not(target_os = "windows"))]
            let _ = app;
            #[cfg(target_os = "windows")]
            app.get_webview_window("main")
                .expect("main window not found")
                .set_decorations(false)?;
            Ok(())
        })
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            initialize_settings,
            update_app_preference,
            save_shortcut_overrides,
            open_workspace,
            close_workspace,
            set_document_favorite,
            record_recent_edit,
            remap_workspace_documents,
            remove_workspace_documents,
            list_workspace,
            rename_workspace_directory,
            rename_workspace_file,
            delete_workspace_directory,
            delete_workspace_file,
            create_workspace_directory,
            create_workspace_markdown_file,
            read_workspace_file,
            read_workspace_sync_file,
            save_workspace_file,
            load_oss_sync_settings,
            save_oss_sync_settings,
            load_oss_sync_credentials,
            open_workspace_entry_in_file_manager,
            read_workspace_image,
            read_workspace_html,
            read_workspace_office,
            fetch_bilibili_thumbnail,
            upload_workspace_image,
            upload_workspace_html
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// 验证受支持 Markdown、图片、HTML 与 Office 扩展名识别。
    #[test]
    fn recognizes_supported_file_extensions() {
        assert!(is_markdown(Path::new("README.md")));
        assert!(is_markdown(Path::new("NOTE.MARKDOWN")));
        assert!(!is_markdown(Path::new("image.png")));
        assert!(is_image(Path::new("image.png")));
        assert!(is_image(Path::new("photo.JPEG")));
        assert!(is_image(Path::new("icon.svg")));
        assert!(!is_image(Path::new("video.mp4")));
        assert!(is_html(Path::new("page.html")));
        assert!(is_html(Path::new("page.HTM")));
        assert!(!is_html(Path::new("page.xhtml")));
        assert!(is_office(Path::new("document.docx")));
        assert!(is_office(Path::new("workbook.XLSX")));
        assert!(is_office(Path::new("slides.pptx")));
        assert!(!is_office(Path::new("legacy.doc")));
        assert!(!is_office(Path::new("document.pdf")));
    }

    /// 验证 Endpoint 自动补 HTTPS、去尾斜杠并拒绝非 HTTP(S) 协议。
    #[test]
    fn normalizes_oss_endpoints() {
        assert_eq!(
            normalize_oss_endpoint("oss-cn-beijing.aliyuncs.com/").unwrap(),
            "https://oss-cn-beijing.aliyuncs.com"
        );
        assert_eq!(
            normalize_oss_endpoint("http://localhost:9000/").unwrap(),
            "http://localhost:9000"
        );
        assert!(normalize_oss_endpoint("ftp://example.com").is_err());
    }

    /// 验证旧 OSS 配置缺失 enabled 字段时默认关闭同步。
    #[test]
    fn defaults_oss_sync_to_disabled_for_existing_configs() {
        let config: OssSyncConfig = serde_json::from_str(
            r#"{"region":"oss-cn-beijing","endpoint":"oss-cn-beijing.aliyuncs.com","bucket":"superwiki","prefix":"superwiki","accessKeyId":"test"}"#,
        )
        .unwrap();
        assert!(!config.enabled);
    }

    /// 验证 Office 读取仅接受支持的扩展名。
    #[test]
    fn reads_only_supported_office_files() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("superwiki-office-{unique}"));
        fs::create_dir_all(&root).unwrap();
        let office = root.join("document.docx");
        let unsupported = root.join("document.doc");
        fs::write(&office, b"office-bytes").unwrap();
        fs::write(&unsupported, b"legacy-office-bytes").unwrap();

        let root_string = root.to_string_lossy().into_owned();
        assert!(
            read_workspace_office(root_string.clone(), office.to_string_lossy().into_owned(),)
                .is_ok()
        );
        assert!(
            read_workspace_office(root_string, unsupported.to_string_lossy().into_owned(),)
                .is_err()
        );

        fs::remove_dir_all(root).unwrap();
    }

    /// 验证二进制上传负载可还原 JSON 元数据与资源字节。
    #[test]
    fn parses_binary_image_upload_payload() {
        let metadata = AssetUploadMetadata {
            root: "/notes".into(),
            document_path: "/notes/doc.md".into(),
            file_name: "image.png".into(),
        };
        let metadata_bytes = serde_json::to_vec(&metadata).unwrap();
        let mut payload = Vec::new();
        payload.extend_from_slice(&(metadata_bytes.len() as u32).to_be_bytes());
        payload.extend_from_slice(&metadata_bytes);
        payload.extend_from_slice(b"image-bytes");

        let (parsed, bytes) = parse_upload_payload(&payload).unwrap();
        assert_eq!(parsed.root, "/notes");
        assert_eq!(parsed.document_path, "/notes/doc.md");
        assert_eq!(parsed.file_name, "image.png");
        assert_eq!(bytes, b"image-bytes");
    }

    /// 验证 HTML 资源命名、保存、读取与扩展名限制。
    #[test]
    fn uploads_and_reads_html_assets() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("superwiki-html-upload-{unique}"));
        let docs = root.join("docs");
        fs::create_dir_all(&docs).unwrap();
        let document = docs.join("note.md");
        fs::write(&document, "# note").unwrap();

        let metadata = || AssetUploadMetadata {
            root: root.to_string_lossy().into_owned(),
            document_path: document.to_string_lossy().into_owned(),
            file_name: "交互 demo.HTML".into(),
        };
        let relative_path =
            save_uploaded_html(metadata(), b"<!doctype html><h1>demo</h1>").unwrap();
        assert_eq!(relative_path, "assets/交互-demo.html");
        assert_eq!(
            read_workspace_html(
                root.to_string_lossy().into_owned(),
                docs.join(&relative_path).to_string_lossy().into_owned(),
            )
            .unwrap(),
            "<!doctype html><h1>demo</h1>"
        );
        assert!(save_uploaded_html(metadata(), b"second").is_ok());
        assert!(save_uploaded_html(
            AssetUploadMetadata {
                root: root.to_string_lossy().into_owned(),
                document_path: document.to_string_lossy().into_owned(),
                file_name: "invalid.txt".into(),
            },
            b"invalid",
        )
        .is_err());

        fs::remove_dir_all(root).unwrap();
    }

    /// 验证同名图片上传生成确定的递增相对资源路径。
    #[test]
    fn creates_unique_relative_image_paths() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("superwiki-upload-{unique}"));
        let docs = root.join("docs");
        fs::create_dir_all(&docs).unwrap();
        let document = docs.join("note.md");
        fs::write(&document, "# note").unwrap();

        let metadata = || AssetUploadMetadata {
            root: root.to_string_lossy().into_owned(),
            document_path: document.to_string_lossy().into_owned(),
            file_name: "示例 image.png".into(),
        };
        assert_eq!(
            save_uploaded_image(metadata(), b"first").unwrap(),
            "assets/示例-image.png"
        );
        assert_eq!(
            save_uploaded_image(metadata(), b"second").unwrap(),
            "assets/示例-image-1.png"
        );
        assert_eq!(
            fs::read(docs.join("assets/示例-image.png")).unwrap(),
            b"first"
        );
        assert_eq!(
            fs::read(docs.join("assets/示例-image-1.png")).unwrap(),
            b"second"
        );

        fs::remove_dir_all(root).unwrap();
    }

    /// 验证可在工作区创建目录和自动补 `.md` 的 Markdown 文件。
    #[test]
    fn creates_workspace_markdown_files_and_directories() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("superwiki-create-{unique}"));
        fs::create_dir_all(&root).unwrap();

        let directory = create_workspace_directory(
            root.to_string_lossy().into_owned(),
            root.to_string_lossy().into_owned(),
            "notes".into(),
        )
        .unwrap();
        let file = create_workspace_markdown_file(
            root.to_string_lossy().into_owned(),
            directory.clone(),
            "first-note".into(),
        )
        .unwrap();

        assert!(PathBuf::from(directory).is_dir());
        assert_eq!(PathBuf::from(&file).file_name().unwrap(), "first-note.md");
        assert_eq!(fs::read_to_string(file).unwrap(), "");
        fs::remove_dir_all(root).unwrap();
    }

    /// 验证新建条目拒绝越界名称、错误扩展名与重复路径。
    #[test]
    fn refuses_invalid_workspace_entries() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("superwiki-create-errors-{unique}"));
        let outside = std::env::temp_dir().join(format!("superwiki-create-outside-{unique}"));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(root.join("existing.md"), "existing").unwrap();

        let root_string = root.to_string_lossy().into_owned();
        assert!(create_workspace_directory(
            root_string.clone(),
            root_string.clone(),
            "../outside".into(),
        )
        .is_err());
        assert!(create_workspace_markdown_file(
            root_string.clone(),
            root_string.clone(),
            "note.txt".into(),
        )
        .is_err());
        assert!(create_workspace_markdown_file(
            root_string.clone(),
            root_string.clone(),
            "existing.md".into(),
        )
        .is_err());
        assert!(create_workspace_directory(
            root_string,
            outside.to_string_lossy().into_owned(),
            "invalid".into(),
        )
        .is_err());

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    /// 验证删除命令移除工作区内文件和目录。
    #[test]
    fn deletes_workspace_files_and_directories() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("superwiki-delete-{unique}"));
        let directory = root.join("notes");
        let nested_file = directory.join("nested.md");
        let file = root.join("note.txt");
        fs::create_dir_all(&directory).unwrap();
        fs::write(&nested_file, "nested").unwrap();
        fs::write(&file, "note").unwrap();

        let root_string = root.to_string_lossy().into_owned();
        delete_workspace_file(root_string.clone(), file.to_string_lossy().into_owned()).unwrap();
        delete_workspace_directory(root_string, directory.to_string_lossy().into_owned()).unwrap();

        assert!(!file.exists());
        assert!(!directory.exists());
        fs::remove_dir_all(root).unwrap();
    }

    /// 验证删除命令拒绝工作区根目录和根外条目。
    #[test]
    fn refuses_to_delete_workspace_root_or_outside_entries() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("superwiki-delete-root-{unique}"));
        let outside = std::env::temp_dir().join(format!("superwiki-delete-outside-{unique}"));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let outside_file = outside.join("outside.md");
        fs::write(&outside_file, "outside").unwrap();

        let root_string = root.to_string_lossy().into_owned();
        assert!(delete_workspace_directory(root_string.clone(), root_string.clone()).is_err());
        assert!(delete_workspace_directory(
            root_string.clone(),
            outside.to_string_lossy().into_owned(),
        )
        .is_err());
        assert!(
            delete_workspace_file(root_string, outside_file.to_string_lossy().into_owned(),)
                .is_err()
        );
        assert!(root.is_dir());
        assert!(outside.is_dir());
        assert!(outside_file.is_file());

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    /// 验证文件重命名保留内容并返回新路径。
    #[test]
    fn renames_workspace_files() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("superwiki-file-rename-{unique}"));
        fs::create_dir_all(&root).unwrap();
        let markdown = root.join("old.md");
        fs::write(&markdown, "# note").unwrap();

        let renamed = rename_workspace_file(
            root.to_string_lossy().into_owned(),
            markdown.to_string_lossy().into_owned(),
            "new.md".into(),
        )
        .unwrap();

        assert_eq!(PathBuf::from(&renamed).file_name().unwrap(), "new.md");
        assert_eq!(fs::read_to_string(renamed).unwrap(), "# note");
        assert!(!markdown.exists());
        fs::remove_dir_all(root).unwrap();
    }

    /// 验证文件重命名拒绝越界、类型不匹配与同名冲突。
    #[test]
    fn refuses_invalid_file_renames() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("superwiki-file-rename-errors-{unique}"));
        fs::create_dir_all(&root).unwrap();
        let markdown = root.join("note.md");
        fs::write(&markdown, "# note").unwrap();
        fs::write(root.join("existing.md"), "existing").unwrap();

        let rename = |name: &str| {
            rename_workspace_file(
                root.to_string_lossy().into_owned(),
                markdown.to_string_lossy().into_owned(),
                name.into(),
            )
        };
        assert!(rename("../outside.md").is_err());
        assert!(rename("note.txt").is_err());
        assert!(rename("existing.md").is_err());
        assert!(markdown.is_file());

        fs::remove_dir_all(root).unwrap();
    }

    /// 验证目录重命名保留子文件并返回规范化新路径。
    #[test]
    fn renames_workspace_directory() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("superwiki-rename-{unique}"));
        let source = root.join("old-name");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("note.md"), "# note").unwrap();

        let renamed = rename_workspace_directory(
            root.to_string_lossy().into_owned(),
            source.to_string_lossy().into_owned(),
            "new-name".into(),
        )
        .unwrap();

        assert_eq!(
            PathBuf::from(renamed),
            fs::canonicalize(&root).unwrap().join("new-name")
        );
        assert!(root.join("new-name/note.md").is_file());
        assert!(!source.exists());
        fs::remove_dir_all(root).unwrap();
    }

    /// 验证目录重命名拒绝空名称、越界、根目录与同名冲突。
    #[test]
    fn refuses_invalid_or_conflicting_directory_renames() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("superwiki-rename-errors-{unique}"));
        let source = root.join("source");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir(root.join("existing")).unwrap();

        let rename = |path: &Path, name: &str| {
            rename_workspace_directory(
                root.to_string_lossy().into_owned(),
                path.to_string_lossy().into_owned(),
                name.into(),
            )
        };
        assert!(rename(&source, "").is_err());
        assert!(rename(&source, "   ").is_err());
        assert!(rename(&source, "../outside").is_err());
        assert!(rename(&source, "existing").is_err());
        assert!(rename(&root, "renamed-root").is_err());
        assert!(source.is_dir());

        fs::remove_dir_all(root).unwrap();
    }

    /// 验证通用工作区路径校验允许根内条目并拒绝根外条目。
    #[test]
    fn workspace_entries_must_stay_inside_root() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("superwiki-test-{unique}"));
        let root = base.join("root");
        let directory = root.join("notes");
        let inside = root.join("note.txt");
        let outside = base.join("outside.txt");
        fs::create_dir_all(&directory).unwrap();
        fs::write(&inside, "inside").unwrap();
        fs::write(&outside, "outside").unwrap();

        assert!(workspace_entry_path(root.to_str().unwrap(), root.to_str().unwrap()).is_ok());
        assert!(workspace_entry_path(root.to_str().unwrap(), directory.to_str().unwrap()).is_ok());
        assert!(workspace_entry_path(root.to_str().unwrap(), inside.to_str().unwrap()).is_ok());
        assert!(workspace_entry_path(root.to_str().unwrap(), outside.to_str().unwrap()).is_err());
        assert!(workspace_file_path(root.to_str().unwrap(), directory.to_str().unwrap()).is_err());

        fs::remove_dir_all(base).unwrap();
    }
}
