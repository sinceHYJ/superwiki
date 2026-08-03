use serde::Serialize;
use std::{fs, path::Path};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileTreeNode {
    name: String,
    path: String,
    is_dir: bool,
    is_markdown: bool,
    children: Vec<FileTreeNode>,
}

#[derive(Serialize)]
struct WorkspaceTree {
    root: String,
    name: String,
    children: Vec<FileTreeNode>,
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
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

fn workspace_file_path(root: &str, path: &str) -> Result<std::path::PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    let path = fs::canonicalize(path).map_err(|error| error.to_string())?;

    if !root.is_dir() || !path.starts_with(&root) || !path.is_file() || !is_markdown(&path) {
        return Err("文件不在已打开的目录中，或不是 Markdown 文件".into());
    }
    Ok(path)
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
fn read_workspace_file(root: String, path: String) -> Result<String, String> {
    fs::read_to_string(workspace_file_path(&root, &path)?)
        .map_err(|error| format!("无法读取文件：{error}"))
}

#[tauri::command]
fn save_workspace_file(root: String, path: String, content: String) -> Result<(), String> {
    fs::write(workspace_file_path(&root, &path)?, content)
        .map_err(|error| format!("无法保存文件：{error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_workspace,
            read_workspace_file,
            save_workspace_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn recognizes_markdown_extensions() {
        assert!(is_markdown(Path::new("README.md")));
        assert!(is_markdown(Path::new("NOTE.MARKDOWN")));
        assert!(!is_markdown(Path::new("image.png")));
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
