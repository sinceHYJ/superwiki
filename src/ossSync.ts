import OSS from "ali-oss";
import { invoke } from "@tauri-apps/api/core";

export type OssSyncSettings = {
  region: string;
  endpoint: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  hasAccessKeySecret: boolean;
  enabled: boolean;
};

type OssSyncCredentials = Omit<OssSyncSettings, "hasAccessKeySecret"> & {
  accessKeySecret: string;
};

type WorkspaceFile = {
  path: string;
  isDir: boolean;
  children: WorkspaceFile[];
};

export async function loadOssSyncSettings() {
  return invoke<OssSyncSettings | null>("load_oss_sync_settings");
}

export async function saveOssSyncSettings(settings: Omit<OssSyncSettings, "hasAccessKeySecret"> & {
  accessKeySecret?: string;
}) {
  await invoke("save_oss_sync_settings", { settings });
}

function createClient(credentials: OssSyncCredentials) {
  return new OSS({
    region: credentials.region,
    endpoint: credentials.endpoint,
    bucket: credentials.bucket,
    accessKeyId: credentials.accessKeyId,
    accessKeySecret: credentials.accessKeySecret,
    authorizationV4: true,
    secure: true,
  });
}

function remoteObjectKey(prefix: string, root: string, path: string) {
  const relativePath = path.slice(root.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
  return [prefix.replace(/^\/+|\/+$/g, ""), relativePath].filter(Boolean).join("/");
}

function collectFiles(nodes: WorkspaceFile[]) {
  const files: string[] = [];
  const visit = (entries: WorkspaceFile[]) => {
    for (const entry of entries) {
      if (entry.isDir) visit(entry.children);
      else files.push(entry.path);
    }
  };
  visit(nodes);
  return files;
}

async function getClient() {
  const credentials = await invoke<OssSyncCredentials>("load_oss_sync_credentials");
  return { client: createClient(credentials), credentials };
}

export async function testOssSyncConnection() {
  const { client, credentials } = await getClient();
  const objectName = [
    credentials.prefix.replace(/^\/+|\/+$/g, ""),
    `.superwiki-connection-test-${crypto.randomUUID()}`,
  ].filter(Boolean).join("/");
  await client.put(objectName, new Blob(["SuperWiki OSS connection test"]));
  await client.delete(objectName);
}

export async function syncWorkspace(root: string, nodes: WorkspaceFile[]) {
  const { client, credentials } = await getClient();
  const files = collectFiles(nodes);
  await Promise.all(files.map(async (path) => {
    const bytes = await invoke<ArrayBuffer>("read_workspace_sync_file", { root, path });
    await client.put(remoteObjectKey(credentials.prefix, root, path), new Blob([bytes]));
  }));
  return files.length;
}

export async function syncWorkspaceFile(root: string, path: string) {
  const { client, credentials } = await getClient();
  const bytes = await invoke<ArrayBuffer>("read_workspace_sync_file", { root, path });
  await client.put(remoteObjectKey(credentials.prefix, root, path), new Blob([bytes]));
}
