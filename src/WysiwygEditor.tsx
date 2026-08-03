import { memo, useEffect, useRef } from "react";
import { CrepeBuilder } from "@milkdown/crepe/builder";
import { codeMirror } from "@milkdown/crepe/feature/code-mirror";
import { cursor } from "@milkdown/crepe/feature/cursor";
import { linkTooltip } from "@milkdown/crepe/feature/link-tooltip";
import { listItem } from "@milkdown/crepe/feature/list-item";
import { placeholder } from "@milkdown/crepe/feature/placeholder";
import { table } from "@milkdown/crepe/feature/table";
import { toolbar } from "@milkdown/crepe/feature/toolbar";
import { topBar } from "@milkdown/crepe/feature/top-bar";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { supportedCodeLanguages } from "./editorLanguages";
import "@milkdown/crepe/theme/common/reset.css";
import "@milkdown/crepe/theme/common/prosemirror.css";
import "@milkdown/crepe/theme/common/code-mirror.css";
import "@milkdown/crepe/theme/common/cursor.css";
import "@milkdown/crepe/theme/common/link-tooltip.css";
import "@milkdown/crepe/theme/common/list-item.css";
import "@milkdown/crepe/theme/common/placeholder.css";
import "@milkdown/crepe/theme/common/table.css";
import "@milkdown/crepe/theme/common/toolbar.css";
import "@milkdown/crepe/theme/common/top-bar.css";
import "@milkdown/crepe/theme/frame.css";

type WysiwygEditorProps = {
  documentId: string;
  initialValue: string;
  onChange: (markdown: string) => void;
  onReady: (getMarkdown: (() => string) | null) => void;
};

function WysiwygEditorInner({ initialValue, onChange, onReady }: WysiwygEditorProps) {
  const onChangeRef = useRef(onChange);
  const onReadyRef = useRef(onReady);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEditor((root) => {
    const crepe = new CrepeBuilder({ root, defaultValue: initialValue })
      .addFeature(codeMirror, {
        languages: supportedCodeLanguages,
        searchPlaceholder: "搜索语言",
        noResultText: "未找到语言",
        copyText: "复制",
        previewToggleText: (previewOnly) => previewOnly ? "编辑" : "隐藏预览",
      })
      .addFeature(cursor)
      .addFeature(listItem)
      .addFeature(linkTooltip)
      .addFeature(placeholder, {
        text: "开始输入 Markdown 内容…",
        mode: "doc",
      })
      .addFeature(table)
      .addFeature(toolbar)
      .addFeature(topBar);

    crepe.on((listener) => {
      listener
        .mounted(() => onReadyRef.current(() => crepe.getMarkdown()))
        .markdownUpdated((_ctx, markdown) => onChangeRef.current(markdown))
        .destroy(() => onReadyRef.current(null));
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
