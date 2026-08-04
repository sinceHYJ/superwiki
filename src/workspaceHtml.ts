import { invoke } from "@tauri-apps/api/core";
import { resolveWorkspacePath } from "./workspaceImages";

export async function uploadWorkspaceHtml(root: string, documentPath: string, file: File) {
  const metadata = new TextEncoder().encode(JSON.stringify({
    root,
    documentPath,
    fileName: file.name,
  }));
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const payload = new Uint8Array(4 + metadata.length + fileBytes.length);
  new DataView(payload.buffer).setUint32(0, metadata.length);
  payload.set(metadata, 4);
  payload.set(fileBytes, 4 + metadata.length);
  return invoke<string>("upload_workspace_html", payload);
}

export async function proxyWorkspaceHtml(
  root: string,
  documentPath: string,
  source: string,
  cache: Map<string, string>,
) {
  const cached = cache.get(source);
  if (cached) return cached;

  const path = resolveWorkspacePath(root, documentPath, source);
  const html = await invoke<string>("read_workspace_html", { root, path });
  const blobUrl = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  cache.set(source, blobUrl);
  return blobUrl;
}
