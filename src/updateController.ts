import type { DownloadEvent } from "@tauri-apps/plugin-updater";

export interface PendingUpdate {
  version: string;
  body?: string;
  download: (onEvent: (event: DownloadEvent) => void) => Promise<void>;
  install: () => Promise<void>;
  close: () => Promise<void>;
}

export type UpdateState = {
  phase: "idle" | "checking" | "latest" | "available" | "downloading" | "ready" | "installing";
  version?: string;
  notes?: string;
  downloaded: number;
  total?: number;
  error: string;
};

export function createUpdateController(check: () => Promise<PendingUpdate | null>) {
  let state: UpdateState = { phase: "idle", downloaded: 0, error: "" };
  let update: PendingUpdate | null = null;
  let started = false;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<UpdateState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const controller = {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start() {
      if (started) return;
      started = true;
      void controller.check();
    },
    async check() {
      if (["checking", "downloading", "ready", "installing"].includes(state.phase)) return;
      set({ phase: "checking", error: "" });
      try {
        const next = await check();
        // The stable feed should never offer prereleases, even if mispublished.
        if (next && next.version.split("+")[0].includes("-")) {
          await next.close();
          throw new Error("更新源包含非稳定版本，请稍后重试。");
        }
        if (update) await update.close();
        update = next;
        set({ phase: next ? "available" : "latest", version: next?.version, notes: next?.body });
      } catch (error) {
        set({ phase: update ? "available" : "idle", error: `检查更新失败：${String(error)}` });
      }
    },
    async download() {
      if (!update || state.phase !== "available") return;
      set({ phase: "downloading", error: "", downloaded: 0, total: undefined });
      try {
        await update.download((event) => {
          if (event.event === "Started") set({ total: event.data.contentLength });
          if (event.event === "Progress") set({ downloaded: state.downloaded + event.data.chunkLength });
        });
        set({ phase: "ready" });
      } catch (error) {
        set({ phase: "available", error: `下载更新失败：${String(error)}` });
      }
    },
    async install(prepare: () => Promise<void>, restart: () => Promise<void>) {
      if (!update || state.phase !== "ready") return;
      set({ phase: "installing", error: "" });
      try {
        await prepare();
        await update.install();
        await restart();
      } catch (error) {
        set({ phase: "ready", error: `更新未完成：${String(error)}` });
      }
    },
  };
  return controller;
}
