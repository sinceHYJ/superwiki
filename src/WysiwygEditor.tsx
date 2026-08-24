import { memo, useEffect, useRef } from "react";
import { CrepeBuilder } from "@milkdown/crepe/builder";
import { codeMirror } from "@milkdown/crepe/feature/code-mirror";
import { Compartment } from "@codemirror/state";
import { EditorView as CodeMirrorEditorView } from "@codemirror/view";
import { cursor } from "@milkdown/crepe/feature/cursor";
import { imageBlock } from "@milkdown/crepe/feature/image-block";
import { linkTooltip } from "@milkdown/crepe/feature/link-tooltip";
import { listItem } from "@milkdown/crepe/feature/list-item";
import { placeholder } from "@milkdown/crepe/feature/placeholder";
import { table } from "@milkdown/crepe/feature/table";
import { toolbar } from "@milkdown/crepe/feature/toolbar";
import { topBar } from "@milkdown/crepe/feature/top-bar";
import { editorViewOptionsCtx } from "@milkdown/kit/core";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { supportedCodeLanguages } from "./editorLanguages";
import { DEFAULT_CODE_BLOCK_TITLE, extractCodeBlockTitles, serializeCodeBlockTitles } from "./codeBlockMetadata";
import { htmlEmbed } from "./htmlEmbed";
import { videoEmbed } from "./videoEmbed";
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

const codeWrapCompartment = new Compartment();

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

function enhanceCodeBlockToolbar(
  block: HTMLElement,
  initialTitle: string,
  onTitleChange: () => void,
) {
  const tools = block.querySelector<HTMLElement>(":scope > .tools");
  if (!tools) return;

  let titleInput = tools.querySelector<HTMLInputElement>(":scope > .code-block-title");
  const createdTitleInput = !titleInput;
  if (!titleInput) {
    titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.className = "code-block-title";
    titleInput.placeholder = DEFAULT_CODE_BLOCK_TITLE;
    titleInput.setAttribute("aria-label", "代码块标题");
    titleInput.addEventListener("input", onTitleChange);
    tools.prepend(titleInput);
  }
  if (createdTitleInput && initialTitle) titleInput.value = initialTitle;

  const languageButton = tools.querySelector<HTMLElement>(":scope > .language-button");
  const languagePicker = tools.querySelector<HTMLElement>(":scope > .language-picker");
  if (languageButton && languagePicker && !tools.querySelector(":scope > .code-block-language-control")) {
    const languageControl = document.createElement("div");
    languageControl.className = "code-block-language-control";
    tools.insertBefore(languageControl, languageButton);
    languageControl.append(languageButton, languagePicker);
  }

  const group = tools.querySelector<HTMLElement>(":scope > .tools-button-group");
  if (!group || group.querySelector(":scope > .wrap-toggle-button")) return;

  const wrapButton = document.createElement("button");
  wrapButton.type = "button";
  wrapButton.className = "wrap-toggle-button";
  wrapButton.textContent = "自动换行";
  wrapButton.title = "切换自动换行";
  const isWrapped = block.classList.contains("code-block-wrap-enabled");
  wrapButton.setAttribute("aria-pressed", String(isWrapped));
  wrapButton.addEventListener("click", () => {
    const enabled = !block.classList.contains("code-block-wrap-enabled");
    block.classList.toggle("code-block-wrap-enabled", enabled);
    wrapButton.setAttribute("aria-pressed", String(enabled));
    const codeMirror = block.querySelector<HTMLElement>(".cm-editor");
    const view = CodeMirrorEditorView.findFromDOM(codeMirror ?? block);
    if (!view) return;
    view.dispatch({
      effects: codeWrapCompartment.reconfigure(enabled ? CodeMirrorEditorView.lineWrapping : []),
    });
    view.requestMeasure();
  });
  group.prepend(wrapButton);
}

function readCodeBlockTitles(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll<HTMLInputElement>(".milkdown-code-block .code-block-title"), (input) => input.value);
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
    const editorScrollElement = root.closest<HTMLElement>(".wysiwyg-editor") ?? root.parentElement;
    let proseMirrorElement: HTMLElement | null = null;
    let pendingScrollTop: number | null = null;
    let restoreScrollFrame: number | null = null;

    const getSelectionRect = () => {
      const selection = root.ownerDocument.getSelection();
      if (!selection?.rangeCount || !selection.isCollapsed) return null;

      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      return rect.height > 0 ? rect : range.getClientRects()[0] ?? null;
    };

    const captureVisibleSelectionScroll = () => {
      const selectionRect = getSelectionRect();
      const editorRect = editorScrollElement?.getBoundingClientRect();
      if (!selectionRect || !editorRect) return;

      const selectionIsVisible = selectionRect.top >= editorRect.top
        && selectionRect.bottom <= editorRect.bottom;
      if (selectionIsVisible) pendingScrollTop = editorScrollElement?.scrollTop ?? null;
    };

    const restoreVisibleSelectionScroll = () => {
      if (restoreScrollFrame !== null) window.cancelAnimationFrame(restoreScrollFrame);
      restoreScrollFrame = window.requestAnimationFrame(() => {
        restoreScrollFrame = null;
        const scrollTop = pendingScrollTop;
        pendingScrollTop = null;
        if (scrollTop === null || !editorScrollElement) return;

        const selectionRect = getSelectionRect();
        const editorRect = editorScrollElement.getBoundingClientRect();
        const selectionIsVisible = selectionRect
          && selectionRect.top >= editorRect.top
          && selectionRect.bottom <= editorRect.bottom;
        if (selectionIsVisible) editorScrollElement.scrollTop = scrollTop;
      });
    };

    const captureVisibleEditorScroll = (event: MouseEvent) => {
      if (!proseMirrorElement || !event.target || !proseMirrorElement.contains(event.target as Node)) return;

      const targetNode = event.target as Node;
      const target = targetNode instanceof Element ? targetNode : targetNode.parentElement;
      const editorRect = editorScrollElement?.getBoundingClientRect();
      const targetRect = target?.getBoundingClientRect();
      if (!editorRect || !targetRect) return;

      const targetIsVisible = targetRect.top >= editorRect.top
        && targetRect.bottom <= editorRect.bottom;
      if (targetIsVisible) pendingScrollTop = editorScrollElement?.scrollTop ?? null;
    };

    const restoreOnSelectionChange = () => {
      if (!root.ownerDocument.activeElement || !root.contains(root.ownerDocument.activeElement)) return;
      restoreVisibleSelectionScroll();
    };

    root.addEventListener("beforeinput", captureVisibleSelectionScroll, true);
    root.addEventListener("input", restoreVisibleSelectionScroll, true);

    const crepe = new CrepeBuilder({ root, defaultValue: initialValue })
      .addFeature(codeMirror, {
        languages: supportedCodeLanguages,
        extensions: [codeWrapCompartment.of([])],
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
      .addFeature(videoEmbed)
      .addFeature(listItem)
      .addFeature(linkTooltip)
      .addFeature(placeholder, {
        text: "开始输入 Markdown 内容…",
        mode: "doc",
      })
      .addFeature(table)
      .addFeature(toolbar)
      .addFeature(topBar);

    crepe.editor.config((ctx) => {
      ctx.update(editorViewOptionsCtx.key, (options) => ({
        ...options,
        handleScrollToSelection: (view) => {
          const editorRect = editorScrollElement?.getBoundingClientRect();
          if (!editorRect) return true;

          const topBarRect = root.querySelector<HTMLElement>(".milkdown-top-bar")?.getBoundingClientRect();
          const visibleTop = Math.max(editorRect.top, topBarRect?.bottom ?? editorRect.top);
          const selectionRect = view.coordsAtPos(view.state.selection.head);

          if (selectionRect.top < visibleTop) {
            editorScrollElement.scrollTop -= visibleTop - selectionRect.top;
          } else if (selectionRect.bottom > editorRect.bottom) {
            editorScrollElement.scrollTop += selectionRect.bottom - editorRect.bottom;
          }

          return true;
        },
      }));
    });

    let topBarElement: HTMLElement | null = null;
    let codeBlockObserver: MutationObserver | null = null;
    const initialTitles = extractCodeBlockTitles(initialValue);

    crepe.on((listener) => {
      listener
        .mounted(() => {
          onReadyRef.current(() => serializeCodeBlockTitles(crepe.getMarkdown(), readCodeBlockTitles(root)));
          topBarElement = root.querySelector<HTMLElement>(".milkdown-top-bar");
          topBarElement?.addEventListener("wheel", scrollTopBarWithMouseWheel, { passive: false });
          proseMirrorElement = root.querySelector<HTMLElement>(".ProseMirror");
          proseMirrorElement?.addEventListener("mousedown", captureVisibleEditorScroll, true);
          root.ownerDocument.addEventListener("selectionchange", restoreOnSelectionChange, true);
          root.addEventListener("focusin", restoreOnSelectionChange, true);

          const decorateCodeBlocks = () => {
            root.querySelectorAll<HTMLElement>(".milkdown-code-block").forEach((block, index) => {
              enhanceCodeBlockToolbar(
                block,
                initialTitles[index] ?? "",
                () => onChangeRef.current(serializeCodeBlockTitles(crepe.getMarkdown(), readCodeBlockTitles(root))),
              );
            });
          };
          decorateCodeBlocks();
          codeBlockObserver = new MutationObserver(decorateCodeBlocks);
          codeBlockObserver.observe(root, { childList: true, subtree: true });
        })
        .markdownUpdated((_ctx, markdown) => onChangeRef.current(serializeCodeBlockTitles(markdown, readCodeBlockTitles(root))))
        .destroy(() => {
          topBarElement?.removeEventListener("wheel", scrollTopBarWithMouseWheel);
          codeBlockObserver?.disconnect();
          codeBlockObserver = null;
          root.removeEventListener("beforeinput", captureVisibleSelectionScroll, true);
          root.removeEventListener("input", restoreVisibleSelectionScroll, true);
          proseMirrorElement?.removeEventListener("mousedown", captureVisibleEditorScroll, true);
          root.ownerDocument.removeEventListener("selectionchange", restoreOnSelectionChange, true);
          root.removeEventListener("focusin", restoreOnSelectionChange, true);
          proseMirrorElement = null;
          if (restoreScrollFrame !== null) window.cancelAnimationFrame(restoreScrollFrame);
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
