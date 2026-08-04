use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileTreeNode {
    name: String,
    path: String,
    is_dir: bool,
    is_markdown: bool,
    is_image: bool,
    is_office: bool,
    children: Vec<FileTreeNode>,
}

#[derive(Serialize)]
struct WorkspaceTree {
    root: String,
    name: String,
    children: Vec<FileTreeNode>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetUploadMetadata {
    root: String,
    document_path: String,
    file_name: String,
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
        })
}

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

fn is_html(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm")
        })
}

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

fn workspace_file_path(root: &str, path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    let path = fs::canonicalize(path).map_err(|error| error.to_string())?;

    if !root.is_dir() || !path.starts_with(&root) || !path.is_file() {
        return Err("文件不在已打开的目录中".into());
    }
    Ok(path)
}

fn workspace_directory_path(root: &str, path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    let path = fs::canonicalize(path).map_err(|error| error.to_string())?;

    if !root.is_dir() || path == root || !path.starts_with(&root) || !path.is_dir() {
        return Err("文件夹不在已打开的目录中".into());
    }
    Ok(path)
}

fn workspace_parent_directory_path(root: &str, path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    let path = fs::canonicalize(path).map_err(|error| error.to_string())?;

    if !root.is_dir() || !path.starts_with(&root) || !path.is_dir() {
        return Err("目标文件夹不在已打开的目录中".into());
    }
    Ok(path)
}

fn validate_entry_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        return Err("名称无效".into());
    }
    Ok(())
}

#[tauri::command]
fn list_workspace(root: String) -> Result<WorkspaceTree, String> {
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("选择的路径不是文件夹".into());
    }

    Ok(WorkspaceTree {
        name: root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.to_string_lossy().into_owned()),
        children: scan_directory(&root)?,
        root: root.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
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
fn read_workspace_file(root: String, path: String) -> Result<String, String> {
    let path = workspace_file_path(&root, &path)?;
    if !is_markdown(&path) {
        return Err("只能读取 Markdown 文件".into());
    }
    fs::read_to_string(path).map_err(|error| format!("无法读取文件：{error}"))
}

#[tauri::command]
fn save_workspace_file(root: String, path: String, content: String) -> Result<(), String> {
    let path = workspace_file_path(&root, &path)?;
    if !is_markdown(&path) {
        return Err("只能保存 Markdown 文件".into());
    }
    fs::write(path, content).map_err(|error| format!("无法保存文件：{error}"))
}

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
fn upload_workspace_image(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("图片上传请求必须使用二进制数据".into());
    };
    let (metadata, image_bytes) = parse_upload_payload(body)?;
    save_uploaded_image(metadata, image_bytes)
}

#[tauri::command]
fn upload_workspace_html(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("HTML 上传请求必须使用二进制数据".into());
    };
    let (metadata, html_bytes) = parse_upload_payload(body)?;
    save_uploaded_html(metadata, html_bytes)
}

#[tauri::command]
fn read_workspace_html(root: String, path: String) -> Result<String, String> {
    let path = workspace_file_path(&root, &path)?;
    if !is_html(&path) {
        return Err("只能读取 HTML 文件".into());
    }
    fs::read_to_string(path).map_err(|error| format!("无法读取 HTML 文件：{error}"))
}

#[tauri::command]
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
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_workspace,
            rename_workspace_directory,
            rename_workspace_file,
            create_workspace_directory,
            create_workspace_markdown_file,
            read_workspace_file,
            save_workspace_file,
            read_workspace_image,
            read_workspace_html,
            read_workspace_office,
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

    #[test]
    fn workspace_files_must_stay_inside_root() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("superwiki-test-{unique}"));
        let root = base.join("root");
        let inside = root.join("note.md");
        let outside = base.join("outside.md");
        fs::create_dir_all(&root).unwrap();
        fs::write(&inside, "# inside").unwrap();
        fs::write(&outside, "# outside").unwrap();

        assert!(workspace_file_path(root.to_str().unwrap(), inside.to_str().unwrap()).is_ok());
        assert!(workspace_file_path(root.to_str().unwrap(), outside.to_str().unwrap()).is_err());

        fs::remove_dir_all(base).unwrap();
    }
}
