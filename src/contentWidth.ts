export type ContentWidth = "default" | "full";

export function parseContentWidth(value: string | null): ContentWidth {
  return value === "full" ? "full" : "default";
}
