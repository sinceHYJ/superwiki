import { memo, useEffect, useRef } from "react";
import { CrepeBuilder } from "@milkdown/crepe/builder";
import { codeMirror } from "@milkdown/crepe/feature/code-mirror";
import { cursor } from "@milkdown/crepe/feature/cursor";
import { imageBlock } from "@milkdown/crepe/feature/image-block";
import { linkTooltip } from "@milkdown/crepe/feature/link-tooltip";
import { listItem } from "@milkdown/crepe/feature/list-item";
import { placeholder } from "@milkdown/crepe/feature/placeholder";
import { table } from "@milkdown/crepe/feature/table";
import { toolbar } from "@milkdown/crepe/feature/toolbar";
import { topBar } from "@milkdown/crepe/feature/top-bar";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { supportedCodeLanguages } from "./editorLanguages";
import { htmlEmbed } from "./htmlEmbed";
import { isMermaidLanguage, mermaidErrorMessage, renderMermaid } from "./mermaidRenderer";
import { isPlantUmlLanguage, plantUmlErrorMessage, renderPlantUml } from "./plantumlRenderer";
import { proxyWorkspaceImage, uploadWorkspaceImage } from "./workspaceImages";
import { proxyWorkspaceHtml, uploadWorkspaceHtml } from "./workspaceHtml";
import "@milkdown/crepe/theme/common/reset.css";
import "@milkdown/crepe/theme/common/prosemirror.css";
import "@milkdown/crepe/theme/common/code-mirror.css";
import "@milkdown/crepe/theme/common/cursor.css";
import "@milkdown/crepe/theme/common/image-block.css";
import "@milkdown/crepe/theme/common/link-tooltip.css";
import "@milkdown/crepe/theme/common/list-item.css";
import "@milkdown/crepe/theme/common/placeholder.css";
import "@milkdown/crepe/theme/common/table.css";
import "@milkdown/crepe/theme/common/toolbar.css";
import "@milkdown/crepe/theme/common/top-bar.css";
import "@milkdown/crepe/theme/frame.css";

type WysiwygEditorProps = {
  documentId: string;
  workspaceRoot: string;
  documentPath: string;
  initialValue: string;
  onChange: (markdown: string) => void;
  onReady: (getMarkdown: (() => string) | null) => void;
  onAssetUploaded: () => void;
};

function scrollTopBarWithMouseWheel(event: WheelEvent) {
  const element = event.currentTarget as HTMLElement;
  if (element.scrollWidth <= element.clientWidth || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;

  event.preventDefault();
  event.stopPropagation();
  element.scrollLeft = Math.max(
    0,
    Math.min(element.scrollLeft + event.deltaY, element.scrollWidth - element.clientWidth),
  );
}

function WysiwygEditorInner({
  workspaceRoot,
  documentPath,
  initialValue,
  onChange,
  onReady,
  onAssetUploaded,
}: WysiwygEditorProps) {
  const onChangeRef = useRef(onChange);
  const onReadyRef = useRef(onReady);
  const onAssetUploadedRef = useRef(onAssetUploaded);
  const imageUrlCache = useRef(new Map<string, string>());
  const htmlUrlCache = useRef(new Map<string, string>());

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    onAssetUploadedRef.current = onAssetUploaded;
  }, [onAssetUploaded]);

  useEffect(() => () => {
    for (const url of imageUrlCache.current.values()) URL.revokeObjectURL(url);
    imageUrlCache.current.clear();
    for (const url of htmlUrlCache.current.values()) URL.revokeObjectURL(url);
    htmlUrlCache.current.clear();
  }, []);

  useEditor((root) => {
    const crepe = new CrepeBuilder({ root, defaultValue: initialValue })
      .addFeature(codeMirror, {
        languages: supportedCodeLanguages,
        searchPlaceholder: "搜索语言",
        noResultText: "未找到语言",
        copyText: "复制",
        previewToggleText: (previewOnly) => previewOnly ? "编辑" : "隐藏预览",
        previewLabel: "图表预览",
        previewLoading: "正在渲染图表…",
        renderPreview: (language, markdown, applyPreview) => {
          const renderer = isMermaidLanguage(language)
            ? { name: "Mermaid", render: renderMermaid, errorMessage: mermaidErrorMessage, errorClass: "mermaid-error" }
            : isPlantUmlLanguage(language)
              ? { name: "PlantUML", render: renderPlantUml, errorMessage: plantUmlErrorMessage, errorClass: "plantuml-error" }
              : null;
          if (!renderer) return null;

          void renderer.render(markdown)
            .then(applyPreview)
            .catch((error: unknown) => {
              const message = document.createElement("div");
              message.className = renderer.errorClass;
              message.textContent = `${renderer.name} 图表渲染失败：${renderer.errorMessage(error)}`;
              applyPreview(message);
            });
        },
      })
      .addFeature(cursor)
      .addFeature(imageBlock, {
        onUpload: async (file) => {
          const source = await uploadWorkspaceImage(workspaceRoot, documentPath, file);
          onAssetUploadedRef.current();
          return source;
        },
        proxyDomURL: (url) => proxyWorkspaceImage(workspaceRoot, documentPath, url, imageUrlCache.current),
        inlineUploadButton: "上传图片",
        inlineUploadPlaceholderText: "或粘贴图片链接",
        blockUploadButton: "上传图片",
        blockUploadPlaceholderText: "或粘贴图片链接",
        blockCaptionPlaceholderText: "图片说明",
        blockConfirmButton: "确认",
      })
      .addFeature(htmlEmbed, {
        uploadHtml: (file) => uploadWorkspaceHtml(workspaceRoot, documentPath, file),
        proxyHtml: (source) => proxyWorkspaceHtml(workspaceRoot, documentPath, source, htmlUrlCache.current),
        onAssetUploaded: () => onAssetUploadedRef.current(),
      })
      .addFeature(listItem)
      .addFeature(linkTooltip)
      .addFeature(placeholder, {
        text: "开始输入 Markdown 内容…",
        mode: "doc",
      })
      .addFeature(table)
      .addFeature(toolbar)
      .addFeature(topBar);

    let topBarElement: HTMLElement | null = null;

    crepe.on((listener) => {
      listener
        .mounted(() => {
          onReadyRef.current(() => crepe.getMarkdown());
          topBarElement = root.querySelector<HTMLElement>(".milkdown-top-bar");
          topBarElement?.addEventListener("wheel", scrollTopBarWithMouseWheel, { passive: false });
        })
        .markdownUpdated((_ctx, markdown) => onChangeRef.current(markdown))
        .destroy(() => {
          topBarElement?.removeEventListener("wheel", scrollTopBarWithMouseWheel);
          onReadyRef.current(null);
        });
    });

    return crepe;
  }, []);

  return <Milkdown />;
}

function WysiwygEditor(props: WysiwygEditorProps) {
  return (
    <div className="wysiwyg-editor">
      <MilkdownProvider>
        <WysiwygEditorInner {...props} />
      </MilkdownProvider>
    </div>
  );
}


export default memo(
  WysiwygEditor,
  (previous, next) => previous.documentId === next.documentId,
);
