import { invoke } from "@tauri-apps/api/core";

export function imageMimeType(name: string) {
  const extension = name.split(/[?#]/, 1)[0].split(".").pop()?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "svg") return "image/svg+xml";
  if (extension === "ico") return "image/x-icon";
  return `image/${extension ?? "png"}`;
}

export async function uploadWorkspaceImage(root: string, documentPath: string, file: File) {
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
  return invoke<string>("upload_workspace_image", payload);
}

export async function proxyWorkspaceImage(
  root: string,
  documentPath: string,
  source: string,
  cache: Map<string, string>,
) {
  if (/^(?:https?:|data:|blob:)/i.test(source)) return source;
  const cached = cache.get(source);
  if (cached) return cached;

  const path = resolveWorkspacePath(root, documentPath, source);
  const imageData = await invoke<ArrayBuffer>("read_workspace_image", { root, path });
  const blobUrl = URL.createObjectURL(new Blob([imageData], { type: imageMimeType(source) }));
  cache.set(source, blobUrl);
  return blobUrl;
}

function resolveWorkspacePath(root: string, documentPath: string, source: string) {
  const normalize = (value: string) => value.replace(/\\/g, "/");
  const normalizedRoot = normalize(root).replace(/\/+$/, "");
  const normalizedDocument = normalize(documentPath);
  const cleanSource = decodeURIComponent(source.split(/[?#]/, 1)[0]);
  const base = cleanSource.startsWith("/")
    ? normalizedRoot.split("/")
    : normalizedDocument.split("/").slice(0, -1);

  for (const segment of cleanSource.replace(/^\/+/, "").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") base.pop();
    else base.push(segment);
  }
  return base.join("/");
}
