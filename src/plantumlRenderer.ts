let plantUmlModule: Promise<typeof import("@plantuml/core")> | null = null;
let renderQueue: Promise<void> = Promise.resolve();

export function isPlantUmlLanguage(language?: string) {
  const normalized = language?.trim().toLowerCase();
  return normalized === "plantuml" || normalized === "puml";
}

async function getPlantUml() {
  if (!plantUmlModule) {
    plantUmlModule = import("@plantuml/core/viz-global.js")
      .then(() => import("@plantuml/core"));
  }

  return plantUmlModule;
}

export function renderPlantUml(source: string) {
  const render = renderQueue.then(async () => {
    const { renderToString } = await getPlantUml();
    return new Promise<string>((resolve, reject) => {
      renderToString(
        source.split(/\r\n|\r|\n/),
        resolve,
        (message) => reject(new Error(message)),
      );
    });
  });

  renderQueue = render.then(() => undefined, () => undefined);
  return render;
}

export function plantUmlErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "图表语法无效";
}
