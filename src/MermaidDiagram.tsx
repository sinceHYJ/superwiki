import { memo, useEffect, useState } from "react";
import { mermaidErrorMessage, renderMermaid } from "./mermaidRenderer";

type MermaidDiagramProps = {
  source: string;
};

function MermaidDiagram({ source }: MermaidDiagramProps) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setSvg("");
    setError("");

    void renderMermaid(source)
      .then((result) => {
        if (!cancelled) setSvg(result);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(mermaidErrorMessage(reason));
      });

    return () => {
      cancelled = true;
    };
  }, [source]);

  if (error) {
    return (
      <div className="mermaid-error" role="alert">
        <strong>Mermaid 图表渲染失败</strong>
        <span>{error}</span>
      </div>
    );
  }

  if (!svg) return <div className="mermaid-loading">正在渲染 Mermaid 图表…</div>;

  return (
    <div
      className="mermaid-diagram"
      aria-label="Mermaid 图表"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export default memo(MermaidDiagram);
