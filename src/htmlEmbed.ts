import type { Editor } from "@milkdown/kit/core";
import type { Node as MarkdownNode } from "@milkdown/kit/transformer";
import { imageBlockConfig } from "@milkdown/kit/component/image-block";
import { uploadConfig } from "@milkdown/kit/plugin/upload";
import { $nodeSchema, $remark, $view } from "@milkdown/kit/utils";

const HTML_EMBED_MARKER = "superwiki:html-embed";
const HTML_EMBED_NODE = "html-embed";

type HtmlEmbedFeatureConfig = {
  uploadHtml: (file: File) => Promise<string>;
  proxyHtml: (source: string) => Promise<string>;
  onAssetUploaded: () => void;
};

type MarkdownParent = MarkdownNode & { children?: MarkdownNode[] };
type MarkdownLink = MarkdownNode & {
  children?: Array<MarkdownNode & { value?: string }>;
  title?: string | null;
  url?: string;
};

function isHtmlFile(file: File) {
  return /\.html?$/i.test(file.name);
}

function transformHtmlEmbedLinks(node: MarkdownParent) {
  if (!node.children) return;

  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index] as MarkdownParent;
    if (child.type === "paragraph" && child.children?.length === 1) {
      const link = child.children[0] as MarkdownLink;
      if (link.type === "link" && link.title === HTML_EMBED_MARKER && link.url && /\.html?(?:[?#].*)?$/i.test(link.url)) {
        node.children[index] = {
          type: HTML_EMBED_NODE,
          url: link.url,
          name: link.children?.map((item) => item.value ?? "").join("") || "HTML 预览",
        } as MarkdownNode;
        continue;
      }
    }
    transformHtmlEmbedLinks(child);
  }
}

const remarkHtmlEmbed = $remark(
  "remark-superwiki-html-embed",
  () => () => (tree: MarkdownNode) => transformHtmlEmbedLinks(tree as MarkdownParent),
);

const htmlEmbedSchema = $nodeSchema(HTML_EMBED_NODE, () => ({
  atom: true,
  draggable: true,
  group: "block",
  isolating: true,
  marks: "",
  selectable: true,
  attrs: {
    src: { default: "", validate: "string" },
    name: { default: "HTML 预览", validate: "string" },
  },
  parseDOM: [{
    tag: `div[data-type="${HTML_EMBED_NODE}"]`,
    getAttrs: (dom) => ({
      src: dom.dataset.src ?? "",
      name: dom.dataset.name ?? "HTML 预览",
    }),
  }],
  toDOM: (node) => ["div", {
    "data-type": HTML_EMBED_NODE,
    "data-src": node.attrs.src,
    "data-name": node.attrs.name,
  }],
  parseMarkdown: {
    match: (node) => node.type === HTML_EMBED_NODE,
    runner: (state, node, type) => {
      state.addNode(type, {
        src: node.url as string,
        name: node.name as string,
      });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === HTML_EMBED_NODE,
    runner: (state, node) => {
      state.openNode("paragraph");
      state.addNode("link", [{ type: "text", value: node.attrs.name }], undefined, {
        title: HTML_EMBED_MARKER,
        url: node.attrs.src,
      });
      state.closeNode();
    },
  },
}));

function createHtmlEmbedView(config: HtmlEmbedFeatureConfig) {
  return $view(htmlEmbedSchema.node, () => (node) => {
    const dom = document.createElement("div");
    const header = document.createElement("div");
    const name = document.createElement("span");
    const state = document.createElement("span");
    const iframe = document.createElement("iframe");
    let currentSource = "";

    dom.className = "html-embed";
    dom.dataset.type = HTML_EMBED_NODE;
    dom.contentEditable = "false";
    header.className = "html-embed-header";
    name.className = "html-embed-name";
    state.className = "html-embed-state";
    iframe.className = "html-embed-frame";
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.setAttribute("loading", "lazy");
    header.append(name, state);
    dom.append(header, iframe);

    const load = (source: string, displayName: string) => {
      currentSource = source;
      dom.dataset.src = source;
      dom.dataset.name = displayName;
      name.textContent = displayName;
      state.textContent = "正在加载…";
      state.classList.remove("error");
      iframe.removeAttribute("src");

      void config.proxyHtml(source)
        .then((url) => {
          if (currentSource !== source) return;
          iframe.src = url;
          state.textContent = "HTML 内嵌预览";
        })
        .catch((error: unknown) => {
          if (currentSource !== source) return;
          state.textContent = `加载失败：${String(error)}`;
          state.classList.add("error");
        });
    };

    load(node.attrs.src, node.attrs.name);

    return {
      dom,
      ignoreMutation: () => true,
      selectNode: () => dom.classList.add("selected"),
      deselectNode: () => dom.classList.remove("selected"),
      stopEvent: (event) => event.target === iframe || iframe.contains(event.target as Node),
      update: (updatedNode) => {
        if (updatedNode.type !== node.type) return false;
        load(updatedNode.attrs.src, updatedNode.attrs.name);
        return true;
      },
    };
  });
}

export function htmlEmbed(editor: Editor, config?: HtmlEmbedFeatureConfig) {
  if (!config) return;

  editor
    .config((ctx) => {
      ctx.update(uploadConfig.key, (previous) => ({
        ...previous,
        uploader: async (files, schema, uploadCtx) => {
          const nodes = [];
          for (const file of Array.from(files)) {
            if (file.type.startsWith("image/")) {
              const nodeType = schema.nodes["image-block"] ?? schema.nodes.image;
              if (!nodeType) continue;
              const source = await uploadCtx.get(imageBlockConfig.key).onUpload(file);
              nodes.push(nodeType.createAndFill({ src: source }));
              continue;
            }
            if (!isHtmlFile(file)) continue;

            const nodeType = schema.nodes[HTML_EMBED_NODE];
            if (!nodeType) continue;
            const source = await config.uploadHtml(file);
            config.onAssetUploaded();
            nodes.push(nodeType.createAndFill({ src: source, name: file.name }));
          }
          return nodes.filter((node) => node !== null);
        },
      }));
    })
    .use(remarkHtmlEmbed)
    .use(htmlEmbedSchema)
    .use(createHtmlEmbedView(config));
}
