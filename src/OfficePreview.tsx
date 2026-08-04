import { useEffect, useRef, useState } from "react";

type OfficePreviewProps = {
  data: ArrayBuffer;
  name: string;
};

type OfficeViewer = {
  destroy: () => void;
  load: (source: string | ArrayBuffer) => Promise<void>;
};

type OfficeFormat = "docx" | "xlsx" | "pptx";

function officeFormat(name: string): OfficeFormat | null {
  const extension = name.split(".").pop()?.toLowerCase();
  return extension === "docx" || extension === "xlsx" || extension === "pptx" ? extension : null;
}

function previewError(reason: unknown) {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

export default function OfficePreview({ data, name }: OfficePreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const container = containerRef.current;
    const format = officeFormat(name);
    if (!container || !format) {
      setLoading(false);
      setError("不支持该 Office 文件格式");
      return;
    }

    let cancelled = false;
    let viewer: OfficeViewer | null = null;
    setLoading(true);
    setError("");
    container.replaceChildren();

    const reportError = (reason: unknown) => {
      if (!cancelled) {
        setLoading(false);
        setError(`Office 文件预览失败：${previewError(reason)}`);
      }
    };

    const load = async () => {
      if (format === "docx") {
        const { DocxScrollViewer } = await import("@silurus/ooxml/docx");
        if (cancelled) return;
        viewer = new DocxScrollViewer(container, { onError: reportError });
      } else if (format === "xlsx") {
        const { XlsxViewer } = await import("@silurus/ooxml/xlsx");
        if (cancelled) return;
        viewer = new XlsxViewer(container, { onError: reportError });
      } else {
        const { PptxScrollViewer } = await import("@silurus/ooxml/pptx");
        if (cancelled) return;
        viewer = new PptxScrollViewer(container, { onError: reportError });
      }

      await viewer.load(data.slice(0));
      if (!cancelled) setLoading(false);
    };

    void load().catch(reportError);

    return () => {
      cancelled = true;
      viewer?.destroy();
      container.replaceChildren();
    };
  }, [data, name]);

  return (
    <section className="office-preview" aria-label={`${name} Office 预览`}>
      {loading && <div className="office-preview-state">正在渲染 {name}…</div>}
      {error && <div className="office-preview-state error">{error}</div>}
      <div ref={containerRef} className="office-preview-container" />
    </section>
  );
}
