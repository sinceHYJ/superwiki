import { parseVideoUrl } from "./videoUrl";

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MarkdownNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, string>;
  };
};

function textContent(node: MarkdownNode): string {
  if (typeof node.value === "string") return node.value;
  return node.children?.map(textContent).join("") ?? "";
}

export function remarkVideoEmbed() {
  return (tree: MarkdownNode) => {
    for (const node of tree.children ?? []) {
      if (node.type !== "paragraph" || node.children?.length !== 1) continue;
      const link = node.children[0];
      if (link.type !== "link" || !link.url || !parseVideoUrl(link.url)) continue;

      node.data = {
        ...node.data,
        hName: "div",
        hProperties: {
          "data-video-embed": "true",
          "data-video-url": link.url,
          "data-video-label": textContent(link) || link.url,
        },
      };
    }
  };
}
