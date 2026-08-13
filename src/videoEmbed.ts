import type { Editor } from "@milkdown/kit/core";
import type { Node as MarkdownNode } from "@milkdown/kit/transformer";
import { Plugin } from "@milkdown/kit/prose/state";
import { $nodeSchema, $prose, $remark, $view } from "@milkdown/kit/utils";
import { releaseVideoThumbnailUrls, resolveVideoThumbnailUrls } from "./videoThumbnail";
import { parseVideoUrl } from "./videoUrl";

const VIDEO_EMBED_NODE = "video-embed";

type MarkdownParent = MarkdownNode & { children?: MarkdownNode[] };
type MarkdownLink = MarkdownNode & {
  children?: Array<MarkdownNode & { value?: string }>;
  title?: string | null;
  url?: string;
};

function markdownText(node: MarkdownNode & { children?: MarkdownNode[]; value?: string }): string {
  if (typeof node.value === "string") return node.value;
  return node.children?.map(markdownText).join("") ?? "";
}

function linkText(link: MarkdownLink) {
  return markdownText(link) || link.url || "视频";
}

function transformVideoLinks(tree: MarkdownParent) {
  for (let index = 0; index < (tree.children?.length ?? 0); index += 1) {
    const child = tree.children?.[index] as MarkdownParent | undefined;
    if (child?.type !== "paragraph" || child.children?.length !== 1) continue;

    const link = child.children[0] as MarkdownLink;
    if (link.type !== "link" || !link.url) continue;
    const video = parseVideoUrl(link.url);
    if (!video) continue;

    tree.children![index] = {
      type: VIDEO_EMBED_NODE,
      provider: video.provider,
      videoId: video.videoId,
      url: link.url,
      label: linkText(link),
      title: link.title ?? null,
    } as MarkdownNode;
  }
}

const remarkVideoEmbed = $remark(
  "remark-superwiki-video-embed",
  () => () => (tree: MarkdownNode) => transformVideoLinks(tree as MarkdownParent),
);

const videoEmbedSchema = $nodeSchema(VIDEO_EMBED_NODE, () => ({
  atom: true,
  draggable: true,
  group: "block",
  isolating: true,
  marks: "",
  selectable: true,
  attrs: {
    provider: { default: "youtube", validate: "string" },
    videoId: { default: "", validate: "string" },
    url: { default: "", validate: "string" },
    label: { default: "视频", validate: "string" },
    title: { default: null, validate: "string|null" },
  },
  parseDOM: [{
    tag: `div[data-type="${VIDEO_EMBED_NODE}"]`,
    getAttrs: (dom) => ({
      provider: dom.dataset.provider ?? "youtube",
      videoId: dom.dataset.videoId ?? "",
      url: dom.dataset.url ?? "",
      label: dom.dataset.label ?? "视频",
      title: dom.dataset.title || null,
    }),
  }],
  toDOM: (node) => ["div", {
    "data-type": VIDEO_EMBED_NODE,
    "data-provider": node.attrs.provider,
    "data-video-id": node.attrs.videoId,
    "data-url": node.attrs.url,
    "data-label": node.attrs.label,
    "data-title": node.attrs.title ?? "",
  }],
  parseMarkdown: {
    match: (node) => node.type === VIDEO_EMBED_NODE,
    runner: (state, node, type) => {
      state.addNode(type, {
        provider: node.provider as string,
        videoId: node.videoId as string,
        url: node.url as string,
        label: node.label as string,
        title: (node.title as string | null) ?? null,
      });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === VIDEO_EMBED_NODE,
    runner: (state, node) => {
      state.openNode("paragraph");
      if (node.attrs.label === node.attrs.url && !node.attrs.title) {
        state.addNode("text", undefined, node.attrs.url);
      } else {
        state.addNode("link", [{ type: "text", value: node.attrs.label }], undefined, {
          title: node.attrs.title,
          url: node.attrs.url,
        });
      }
      state.closeNode();
    },
  },
}));

const videoPastePlugin = $prose((ctx) => new Plugin({
  props: {
    handlePaste: (view, event) => {
      const text = event.clipboardData?.getData("text/plain").trim();
      if (!text || /\s/.test(text)) return false;
      const video = parseVideoUrl(text);
      if (!video) return false;

      const { $from } = view.state.selection;
      if ($from.depth !== 1 || $from.parent.type.name !== "paragraph" || $from.parent.textContent.trim()) {
        return false;
      }

      const nodeType = videoEmbedSchema.type(ctx);
      const node = nodeType.create({
        provider: video.provider,
        videoId: video.videoId,
        url: text,
        label: text,
        title: null,
      });
      const depth = $from.depth;
      view.dispatch(
        view.state.tr
          .replaceWith($from.before(depth), $from.after(depth), node)
          .scrollIntoView(),
      );
      return true;
    },
  },
}));

const videoEmbedView = $view(videoEmbedSchema.node, () => (node) => {
  const dom = document.createElement("div");
  const stage = document.createElement("div");
  let currentUrl = "";
  let thumbnailUrls: string[] = [];

  dom.className = "video-embed-card";
  dom.dataset.type = VIDEO_EMBED_NODE;
  dom.contentEditable = "false";
  stage.className = "video-embed-stage";
  dom.append(stage);

  const render = (url: string, label: string) => {
    currentUrl = url;
    const video = parseVideoUrl(url);
    if (!video) return;

    const displayLabel = label && label !== url ? label : "视频播放器";
    dom.dataset.provider = video.provider;
    dom.dataset.videoId = video.videoId;
    dom.dataset.url = url;
    dom.dataset.label = label;
    releaseVideoThumbnailUrls(thumbnailUrls);
    thumbnailUrls = [];
    stage.replaceChildren();

    const thumbnail = document.createElement("img");
    const play = document.createElement("button");
    const icon = document.createElement("span");
    const text = document.createElement("span");
    thumbnail.className = "video-embed-thumbnail";
    thumbnail.alt = "";
    play.className = "video-embed-play";
    play.type = "button";
    icon.className = "video-embed-play-icon";
    icon.textContent = "▶";
    icon.setAttribute("aria-hidden", "true");
    text.textContent = "点击加载并播放外部视频";
    play.append(icon, text);
    thumbnail.addEventListener("error", () => {
      thumbnail.remove();
    });
    void resolveVideoThumbnailUrls(video).then((urls) => {
      if (currentUrl !== url || !urls[0] || stage.querySelector("iframe")) {
        releaseVideoThumbnailUrls(urls);
        return;
      }
      thumbnailUrls = urls;
      thumbnail.src = urls[0];
      stage.append(thumbnail);
    });
    play.addEventListener("click", () => {
      if (currentUrl !== url) return;
      const iframe = document.createElement("iframe");
      iframe.className = "video-embed-frame";
      iframe.src = video.embedUrl;
      iframe.title = displayLabel;
      iframe.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
      iframe.allowFullscreen = true;
      iframe.loading = "lazy";
      iframe.referrerPolicy = "strict-origin-when-cross-origin";
      stage.replaceChildren(iframe);
    }, { once: true });
    stage.append(play);
  };

  render(node.attrs.url, node.attrs.label);

  return {
    dom,
    ignoreMutation: () => true,
    selectNode: () => dom.classList.add("selected"),
    deselectNode: () => dom.classList.remove("selected"),
    stopEvent: (event) => event.target instanceof HTMLButtonElement
      || event.target instanceof HTMLIFrameElement
      || stage.contains(event.target as Node),
    update: (updatedNode) => {
      if (updatedNode.type !== node.type) return false;
      render(updatedNode.attrs.url, updatedNode.attrs.label);
      return true;
    },
    destroy: () => releaseVideoThumbnailUrls(thumbnailUrls),
  };
});

export function videoEmbed(editor: Editor) {
  editor
    .use(remarkVideoEmbed)
    .use(videoEmbedSchema)
    .use(videoPastePlugin)
    .use(videoEmbedView);
}
