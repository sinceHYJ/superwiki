/**
 * OSS 同步客户端：通过 Rust 读取配置和文件，再将工作区文件单向上传到阿里云 OSS。
 * 密钥仅从 Rust 命令获取；保存设置时必须通过设置写入门面维护未完成写入状态。
 */
import OSS from "ali-oss";
import { invoke } from "@tauri-apps/api/core";
import { invokeSettingsWrite } from "./settingsStore";

/** 可安全展示在设置界面的 OSS 配置，不含明文 AccessKey Secret。 */
export type OssSyncSettings = {
  /** OSS 地域标识，例如 `oss-cn-hangzhou`。 */
  region: string;
  /** 规范化后的 HTTP(S) OSS Endpoint。 */
  endpoint: string;
  /** 目标 OSS Bucket 名称。 */
  bucket: string;
  /** Bucket 内对象前缀；空字符串表示 Bucket 根目录。 */
  prefix: string;
  /** 用于 OSS 鉴权的 AccessKey ID。 */
  accessKeyId: string;
  /** 本地 SQLite 是否保存了非空密钥；绝不携带密钥明文。 */
  hasAccessKeySecret: boolean;
  /** 是否启用自动同步。 */
  enabled: boolean;
};

/** 实际发起 OSS 请求所需的完整凭据，仅在此模块内短暂使用。 */
type OssSyncCredentials = Omit<OssSyncSettings, "hasAccessKeySecret"> & {
  /** 用于 OSS 鉴权的明文 AccessKey Secret；不得写日志或回显到 UI。 */
  accessKeySecret: string;
};

/** 用于递归收集可同步文件的工作区树节点。 */
type WorkspaceFile = {
  /** 节点绝对路径；文件节点会被上传。 */
  path: string;
  /** 是否为目录；为真时仅递归处理 `children`。 */
  isDir: boolean;
  /** 直接子节点；文件节点为空数组。 */
  children: WorkspaceFile[];
};

/**
 * 读取脱敏 OSS 配置，供设置界面回显。
 *
 * @returns 已保存但不含密钥明文的 `OssSyncSettings`；未配置时为 `null`。
 * @throws Tauri IPC 或 SQLite 读取失败时抛出错误。
 */
export async function loadOssSyncSettings() {
  return invoke<OssSyncSettings | null>("load_oss_sync_settings");
}

/**
 * 保存 OSS 配置，并在未提供新密钥时保留 SQLite 中已有密钥。
 *
 * @param settings 待保存的配置；`accessKeySecret` 可选，空值表示不修改旧密钥。
 * @returns 配置写入完成后解析为 `void`。
 * @throws 配置格式无效、Tauri IPC 或 SQLite 写入失败时抛出错误。
 */
export async function saveOssSyncSettings(settings: Omit<OssSyncSettings, "hasAccessKeySecret"> & {
  accessKeySecret?: string;
}) {
  await invokeSettingsWrite("save_oss_sync_settings", { settings });
}

/**
 * 根据完整凭据创建强制 HTTPS 与 V4 鉴权的 OSS 客户端。
 *
 * @param credentials 包含 Endpoint、Bucket 和明文密钥的临时凭据，仅在同步期间使用。
 * @returns 已配置 `ali-oss` 客户端实例。
 */
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

/**
 * 将工作区绝对文件路径转换为以 `/` 分隔的 OSS 对象键。
 *
 * @param prefix Bucket 内的对象前缀；首尾 `/` 会被移除，空字符串表示根目录。
 * @param root 工作区根目录绝对路径，用于截取文件相对路径。
 * @param path 工作区内文件的绝对路径，必须以 `root` 开头。
 * @returns 由非空前缀和相对路径组成的 OSS 对象键。
 */
function remoteObjectKey(prefix: string, root: string, path: string) {
  const relativePath = path.slice(root.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
  return [prefix.replace(/^\/+|\/+$/g, ""), relativePath].filter(Boolean).join("/");
}

/**
 * 深度优先收集目录树中的所有文件绝对路径，不包含目录节点。
 *
 * @param nodes 工作区树的起始节点列表；目录节点会递归读取 `children`。
 * @returns 所有叶子文件的绝对路径数组，保持树的遍历顺序。
 */
function collectFiles(nodes: WorkspaceFile[]) {
  const files: string[] = [];
  /**
   * 递归遍历当前层级并将叶子节点加入结果。
   *
   * @param entries 当前层级的文件或目录节点。
   * @returns 无返回值；通过闭包修改外层 `files`。
   */
  const visit = (entries: WorkspaceFile[]) => {
    for (const entry of entries) {
      if (entry.isDir) visit(entry.children);
      else files.push(entry.path);
    }
  };
  visit(nodes);
  return files;
}

/**
 * 从 Rust 获取完整凭据并创建本次同步使用的 OSS 客户端。
 *
 * @returns 包含 OSS 客户端和临时完整凭据的对象，供同一次同步生成对象键。
 * @throws 未配置 OSS 凭据、Tauri IPC 或客户端初始化失败时抛出错误。
 */
async function getClient() {
  const credentials = await invoke<OssSyncCredentials>("load_oss_sync_credentials");
  return { client: createClient(credentials), credentials };
}

/**
 * 上传后立即删除随机测试对象，以验证当前配置具有写入与删除权限。
 *
 * @returns 测试对象成功删除后解析为 `void`。
 * @throws 读取凭据、上传或删除测试对象失败时抛出错误；可能短暂产生测试对象。
 */
export async function testOssSyncConnection() {
  const { client, credentials } = await getClient();
  const objectName = [
    credentials.prefix.replace(/^\/+|\/+$/g, ""),
    `.superwiki-connection-test-${crypto.randomUUID()}`,
  ].filter(Boolean).join("/");
  await client.put(objectName, new Blob(["SuperWiki OSS connection test"]));
  await client.delete(objectName);
}

/**
 * 同步工作区树中所有文件，并返回成功提交的文件数量。
 *
 * @param root 工作区根目录绝对路径，用于 Rust 文件读取和生成对象相对路径。
 * @param nodes 待同步的工作区树节点；仅叶子文件会被上传。
 * @returns 全部上传成功后的文件数量；空树返回 `0`。
 * @throws 读取凭据、读取本地文件或任一 OSS 上传失败时抛出错误。
 */
export async function syncWorkspace(root: string, nodes: WorkspaceFile[]) {
  const { client, credentials } = await getClient();
  const files = collectFiles(nodes);
  await Promise.all(files.map(async (path) => {
    const bytes = await invoke<ArrayBuffer>("read_workspace_sync_file", { root, path });
    await client.put(remoteObjectKey(credentials.prefix, root, path), new Blob([bytes]));
  }));
  return files.length;
}

/**
 * 同步一个工作区文件；路径安全校验和二进制读取由 Rust 文件服务负责。
 *
 * @param root 工作区根目录绝对路径。
 * @param path 待上传文件绝对路径，必须位于 `root` 内。
 * @returns 文件上传成功后解析为 `void`。
 * @throws 读取凭据、Rust 路径校验、文件读取或 OSS 上传失败时抛出错误。
 */
export async function syncWorkspaceFile(root: string, path: string) {
  const { client, credentials } = await getClient();
  const bytes = await invoke<ArrayBuffer>("read_workspace_sync_file", { root, path });
  await client.put(remoteObjectKey(credentials.prefix, root, path), new Blob([bytes]));
}
