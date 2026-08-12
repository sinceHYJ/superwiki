export type VideoProvider = "youtube" | "vimeo" | "bilibili";

export type VideoDescriptor = {
  provider: VideoProvider;
  videoId: string;
  originalUrl: string;
  embedUrl: string;
};

const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID_PATTERN = /^\d+$/;
const BILIBILI_ID_PATTERN = /^BV[A-Za-z0-9]{10}$/i;

function normalizedHost(url: URL) {
  return url.hostname.toLowerCase().replace(/^www\./, "");
}

function youtubeVideoId(url: URL) {
  const host = normalizedHost(url);
  if (host === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] ?? "";
  if (host !== "youtube.com" && host !== "m.youtube.com" && host !== "youtube-nocookie.com") return "";
  if (url.pathname === "/watch") return url.searchParams.get("v") ?? "";

  const [kind, id] = url.pathname.split("/").filter(Boolean);
  return ["embed", "shorts", "live"].includes(kind ?? "") ? id ?? "" : "";
}

function vimeoVideoId(url: URL) {
  const host = normalizedHost(url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (host === "player.vimeo.com" && parts[0] === "video") return parts[1] ?? "";
  if (host === "vimeo.com") return parts[0] ?? "";
  return "";
}

function bilibiliVideoId(url: URL) {
  const host = normalizedHost(url);
  if (host !== "bilibili.com" && host !== "m.bilibili.com") return "";
  const parts = url.pathname.split("/").filter(Boolean);
  return parts[0] === "video" ? parts[1] ?? "" : "";
}

export function videoProviderName(provider: VideoProvider) {
  if (provider === "youtube") return "YouTube";
  if (provider === "vimeo") return "Vimeo";
  return "Bilibili";
}

export function parseVideoUrl(source: string): VideoDescriptor | null {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const youtubeId = youtubeVideoId(url);
  if (YOUTUBE_ID_PATTERN.test(youtubeId)) {
    return {
      provider: "youtube",
      videoId: youtubeId,
      originalUrl: url.href,
      embedUrl: `https://www.youtube.com/embed/${youtubeId}?autoplay=1`,
    };
  }

  const vimeoId = vimeoVideoId(url);
  if (VIMEO_ID_PATTERN.test(vimeoId)) {
    return {
      provider: "vimeo",
      videoId: vimeoId,
      originalUrl: url.href,
      embedUrl: `https://player.vimeo.com/video/${vimeoId}?autoplay=1`,
    };
  }

  const bilibiliId = bilibiliVideoId(url);
  if (BILIBILI_ID_PATTERN.test(bilibiliId)) {
    return {
      provider: "bilibili",
      videoId: bilibiliId,
      originalUrl: url.href,
      embedUrl: `https://player.bilibili.com/player.html?bvid=${bilibiliId}&autoplay=1`,
    };
  }

  return null;
}
