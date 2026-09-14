export type ContentWidth = "default" | "full";

export const CONTENT_WIDTH_STORAGE_KEY = "superwiki.contentWidth";

export function parseContentWidth(value: string | null): ContentWidth {
  return value === "full" ? "full" : "default";
}
