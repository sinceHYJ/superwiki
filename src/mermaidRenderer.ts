let mermaidModule: Promise<typeof import("mermaid").default> | null = null;
let renderQueue: Promise<void> = Promise.resolve();
let renderId = 0;

export function isMermaidLanguage(language?: string) {
  return language?.trim().toLowerCase() === "mermaid";
}

async function getMermaid() {
  if (!mermaidModule) {
    mermaidModule = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "neutral",
      });
      return mermaid;
    });
  }

  return mermaidModule;
}

export function renderMermaid(source: string) {
  const render = renderQueue.then(async () => {
    const mermaid = await getMermaid();
    const { svg } = await mermaid.render(`superwiki-mermaid-${++renderId}`, source);
    return svg;
  });

  renderQueue = render.then(() => undefined, () => undefined);
  return render;
}

export function mermaidErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "图表语法无效";
}
