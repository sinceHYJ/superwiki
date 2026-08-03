/// <reference types="vite/client" />

declare module "@plantuml/core" {
  export function renderToString(
    lines: string[],
    onSuccess: (svg: string) => void,
    onError: (message: string) => void,
  ): void;
}

declare module "@plantuml/core/viz-global.js";
