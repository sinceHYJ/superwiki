import OSS from "ali-oss";
import type { WorkspaceSyncCredentials } from "../config";
import type { ChunkReader, ChunkWriter, RemoteEntry, RemoteRevision, SyncLease, SyncManifest, SyncProvider } from "../types";

const INTERNAL_DIRECTORY = ".superwiki-sync";
const CHUNK_SIZE = 8 * 1024 * 1024;
const LEASE_DURATION = 2 * 60 * 1000;

function joinPath(...parts: string[]) {
  return parts.map((part) => part.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
}

function bytes(content: unknown) {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (typeof content === "string") return new TextEncoder().encode(content);
  return new Uint8Array(content as ArrayLike<number>);
}

export class OssSyncProvider implements SyncProvider {
  private readonly client: OSS;
  private readonly root: string;

  constructor(credentials: WorkspaceSyncCredentials) {
    this.root = credentials.prefix.replace(/^\/+|\/+$/g, "");
    this.client = new OSS({
      region: credentials.region,
      endpoint: credentials.endpoint,
      bucket: credentials.bucket,
      accessKeyId: credentials.accessKeyId,
      accessKeySecret: credentials.accessKeySecret,
      authorizationV4: true,
      secure: true,
    });
  }

  private object(path: string) {
    return joinPath(this.root, path);
  }

  private internal(name: string) {
    return this.object(`${INTERNAL_DIRECTORY}/${name}`);
  }

  async testConnection() {
    const name = this.internal(`connection-${crypto.randomUUID()}`);
    await this.client.put(name, new Blob(["SuperWiki sync test"]));
    await this.client.delete(name);
  }

  async list(scope: string) {
    const prefix = this.object(scope);
    const queryPrefix = prefix ? `${prefix.replace(/\/$/, "")}/` : this.root ? `${this.root}/` : "";
    const entries: RemoteEntry[] = [];
    let marker: string | undefined;
    do {
      const result = await this.client.list({ prefix: queryPrefix, marker, "max-keys": 1000 }, {});
      for (const object of result.objects ?? []) {
        const relative = this.root ? object.name.slice(this.root.length).replace(/^\//, "") : object.name;
        if (!relative || relative.startsWith(`${INTERNAL_DIRECTORY}/`)) continue;
        const directory = relative.endsWith("/");
        entries.push({
          path: directory ? relative.slice(0, -1) : relative,
          kind: directory ? "directory" : "file",
          size: directory ? undefined : object.size,
          modifiedAt: Date.parse(object.lastModified),
          revision: object.etag,
          hash: `remote:${object.etag}`,
        });
      }
      marker = result.isTruncated ? result.nextMarker : undefined;
    } while (marker);
    return entries;
  }

  async download(path: string, target: ChunkWriter, signal: AbortSignal, onProgress?: (completed: number, total: number) => void) {
    const name = this.object(path);
    const head = await this.client.head(name);
    const headers = head.res.headers as Record<string, string | number | undefined>;
    const total = Number(headers["content-length"] ?? head.res.size ?? 0);
    let offset = 0;
    try {
      while (offset < total) {
        if (signal.aborted) throw new DOMException("同步已取消", "AbortError");
        const end = Math.min(total - 1, offset + CHUNK_SIZE - 1);
        const result = await this.client.get(name, undefined, { headers: { Range: `bytes=${offset}-${end}` } });
        const content = bytes(result.content);
        await target.write(offset, content);
        offset += content.byteLength;
        onProgress?.(offset, total);
      }
      await target.commit();
    } catch (error) {
      await target.cancel();
      throw error;
    }
  }

  async upload(path: string, source: ChunkReader, signal: AbortSignal, onProgress?: (completed: number, total: number) => void): Promise<RemoteRevision> {
    const name = this.object(path);
    if (source.size === 0) {
      const result = await this.client.put(name, new Blob([]));
      await this.client.delete(`${name}/`).catch(() => undefined);
      return { value: (result.res.headers as Record<string, string | undefined>).etag };
    }
    const partSize = Math.max(CHUNK_SIZE, Math.ceil(source.size / 10_000));
    const upload = await this.client.initMultipartUpload(name);
    const parts: Array<{ number: number; etag: string }> = [];
    let offset = 0;
    const cancelUpload = () => this.client.cancel({ name, uploadId: upload.uploadId });
    signal.addEventListener("abort", cancelUpload, { once: true });
    try {
      while (offset < source.size) {
        if (signal.aborted) throw new DOMException("同步已取消", "AbortError");
        const content = await source.read(offset, Math.min(partSize, source.size - offset));
        const number = parts.length + 1;
        const result = await this.client.uploadPart(name, upload.uploadId, number, new Blob([content]), 0, content.byteLength - 1);
        parts.push({ number, etag: result.etag });
        offset += content.byteLength;
        onProgress?.(offset, source.size);
      }
      const result = await this.client.completeMultipartUpload(name, upload.uploadId, parts);
      await this.client.delete(`${name}/`).catch(() => undefined);
      return { value: (result.res.headers as Record<string, string | undefined>).etag };
    } catch (error) {
      await this.client.abortMultipartUpload(name, upload.uploadId).catch(() => undefined);
      throw error;
    } finally {
      signal.removeEventListener("abort", cancelUpload);
    }
  }

  async createDirectory(path: string) {
    const name = this.object(path).replace(/\/$/, "");
    await this.client.delete(name).catch(() => undefined);
    await this.client.put(`${name}/`, new Blob([]));
  }

  async remove(path: string, expectedRevision?: string) {
    const name = this.object(path);
    if (expectedRevision) {
      const result = await this.client.head(name);
      const current = (result.res.headers as Record<string, string | undefined>).etag;
      if (current && current !== expectedRevision) throw new Error(`远端文件已变化：${path}`);
    }
    await this.client.delete(name);
    await this.client.delete(`${name.replace(/\/$/, "")}/`).catch(() => undefined);
  }

  async acquireLease(workspaceId: string) {
    const lease: SyncLease = { id: `${workspaceId}:${crypto.randomUUID()}`, expiresAt: Date.now() + LEASE_DURATION };
    const name = this.internal("lease.json");
    try {
      await this.client.put(name, new Blob([JSON.stringify(lease)]), { headers: { "x-oss-forbid-overwrite": "true" } } as never);
      return lease;
    } catch {
      const current = await this.readLease();
      if (current && current.expiresAt > Date.now()) throw new Error("另一个设备正在同步，请稍后重试");
      await this.client.delete(name).catch(() => undefined);
      await this.client.put(name, new Blob([JSON.stringify(lease)]), { headers: { "x-oss-forbid-overwrite": "true" } } as never);
      return lease;
    }
  }

  async renewLease(lease: SyncLease) {
    await this.assertLease(lease);
    const renewed = { ...lease, expiresAt: Date.now() + LEASE_DURATION };
    await this.client.put(this.internal("lease.json"), new Blob([JSON.stringify(renewed)]));
    return renewed;
  }

  async releaseLease(lease: SyncLease) {
    if ((await this.readLease())?.id === lease.id) await this.client.delete(this.internal("lease.json"));
  }

  private async readLease(): Promise<SyncLease | null> {
    try {
      const result = await this.client.get(this.internal("lease.json"));
      return JSON.parse(new TextDecoder().decode(bytes(result.content))) as SyncLease;
    } catch {
      return null;
    }
  }

  private async assertLease(lease: SyncLease) {
    const current = await this.readLease();
    if (!current || current.id !== lease.id || current.expiresAt <= Date.now()) throw new Error("同步租约已失效");
  }

  async loadManifest() {
    try {
      const result = await this.client.get(this.internal("manifest-v1.json"));
      return JSON.parse(new TextDecoder().decode(bytes(result.content))) as SyncManifest;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "NoSuchKey" || code === "NoSuchKeyError") return null;
      throw error;
    }
  }

  async saveManifest(manifest: SyncManifest, lease: SyncLease) {
    await this.assertLease(lease);
    await this.client.put(this.internal("manifest-v1.json"), new Blob([JSON.stringify(manifest, null, 2)]));
  }
}
