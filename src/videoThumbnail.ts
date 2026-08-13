import { invoke } from "@tauri-apps/api/core";
import type { VideoDescriptor } from "./videoUrl";

const YOUTUBE_THUMBNAIL_STEPS = ["maxresdefault", "sddefault", "hqdefault", "mqdefault", "default"] as const;

export function youtubeThumbnailUrls(videoId: string) {
  return YOUTUBE_THUMBNAIL_STEPS.map(
    (quality) => `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/${quality}.jpg`,
  );
}

async function bilibiliThumbnailUrl(videoId: string) {
  const imageData = await invoke<ArrayBuffer>("fetch_bilibili_thumbnail", { bvid: videoId });
  const bytes = new Uint8Array(imageData);
  if (bytes.length === 0) throw new Error("Bilibili 封面响应为空");
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return `data:image/jpeg;base64,${btoa(binary)}`;
}

export function releaseVideoThumbnailUrls(_urls: string[]) {}

export async function resolveVideoThumbnailUrls(video: VideoDescriptor) {
  if (video.provider === "youtube") return youtubeThumbnailUrls(video.videoId);
  if (video.provider === "bilibili") return [await bilibiliThumbnailUrl(video.videoId)];
  return [];
}
