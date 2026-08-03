import { memo, useEffect, useState } from "react";
import { plantUmlErrorMessage, renderPlantUml } from "./plantumlRenderer";

type PlantUmlDiagramProps = {
  source: string;
};

function PlantUmlDiagram({ source }: PlantUmlDiagramProps) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setSvg("");
    setError("");

    void renderPlantUml(source)
      .then((result) => {
        if (!cancelled) setSvg(result);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(plantUmlErrorMessage(reason));
      });

    return () => {
      cancelled = true;
    };
  }, [source]);

  if (error) {
    return (
      <div className="plantuml-error" role="alert">
        <strong>PlantUML 图表渲染失败</strong>
        <span>{error}</span>
      </div>
    );
  }

  if (!svg) return <div className="plantuml-loading">正在渲染 PlantUML 图表…</div>;

  return (
    <div
      className="plantuml-diagram"
      aria-label="PlantUML 图表"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export default memo(PlantUmlDiagram);
