import { useEffect, useMemo, useState } from "react";
import { parseVideoUrl } from "./videoUrl";

type VideoEmbedPreviewProps = {
  url: string;
  label?: string;
};

export default function VideoEmbedPreview({ url, label }: VideoEmbedPreviewProps) {
  const descriptor = useMemo(() => parseVideoUrl(url), [url]);
  const [activated, setActivated] = useState(false);

  useEffect(() => setActivated(false), [url]);

  if (!descriptor) return <a href={url}>{label || url}</a>;

  const displayLabel = label && label !== url ? label : "视频播放器";

  return (
    <div className="video-embed-card" data-provider={descriptor.provider}>
      <div className="video-embed-stage">
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
          <button className="video-embed-play" type="button" onClick={() => setActivated(true)}>
            <span className="video-embed-play-icon" aria-hidden="true">▶</span>
            <span>点击加载并播放外部视频</span>
          </button>
        )}
      </div>
    </div>
  );
}
