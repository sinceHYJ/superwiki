import { useEffect, useMemo, useState } from "react";
import { releaseVideoThumbnailUrls, resolveVideoThumbnailUrls } from "./videoThumbnail";
import { parseVideoUrl } from "./videoUrl";

type VideoEmbedPreviewProps = {
  url: string;
  label?: string;
};

export default function VideoEmbedPreview({ url, label }: VideoEmbedPreviewProps) {
  const descriptor = useMemo(() => parseVideoUrl(url), [url]);
  const [activated, setActivated] = useState(false);
  const [thumbnailUrls, setThumbnailUrls] = useState<string[]>([]);
  const [thumbnailIndex, setThumbnailIndex] = useState(0);

  useEffect(() => {
    setActivated(false);
    setThumbnailUrls([]);
    setThumbnailIndex(0);
    if (!descriptor || (descriptor.provider !== "youtube" && descriptor.provider !== "bilibili")) return;

    let cancelled = false;
    let resolvedUrls: string[] = [];
    void resolveVideoThumbnailUrls(descriptor).then((urls) => {
      resolvedUrls = urls;
      if (!cancelled) setThumbnailUrls(urls);
      else releaseVideoThumbnailUrls(urls);
    });
    return () => {
      cancelled = true;
      releaseVideoThumbnailUrls(resolvedUrls);
    };
  }, [descriptor]);

  if (!descriptor) return <a href={url}>{label || url}</a>;

  const displayLabel = label && label !== url ? label : "视频播放器";
  const thumbnailUrl = thumbnailUrls[thumbnailIndex];

  return (
    <div className="video-embed-card" data-provider={descriptor.provider}>
      <div className={`video-embed-stage${thumbnailUrl ? " has-thumbnail" : ""}`}>
        {activated ? (
          <iframe
            className="video-embed-frame"
            src={descriptor.embedUrl}
            title={displayLabel}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <>
            {thumbnailUrl && (
              <img
                className="video-embed-thumbnail"
                src={thumbnailUrl}
                alt=""
                onError={() => {
                  setThumbnailIndex((index) => index + 1 < thumbnailUrls.length ? index + 1 : thumbnailUrls.length);
                }}
              />
            )}
            <button className="video-embed-play" type="button" onClick={() => setActivated(true)}>
              <span className="video-embed-play-icon" aria-hidden="true">▶</span>
              <span>点击加载并播放外部视频</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
