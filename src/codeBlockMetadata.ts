export const DEFAULT_CODE_BLOCK_TITLE = "代码块";

type FenceState = {
  marker: string;
  length: number;
};

function getFenceStart(line: string): { indent: string; marker: string; length: number; info: string } | null {
  const match = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  return { indent: match[1], marker: match[2][0], length: match[2].length, info: match[3].trim() };
}

function isFenceEnd(line: string, fence: FenceState) {
  const trimmed = line.trim();
  return trimmed.startsWith(fence.marker.repeat(fence.length)) && /^[`~]+$/.test(trimmed);
}

export function parseCodeBlockTitle(info: string): string {
  const match = /(?:^|\s)title=(?:"((?:\\.|[^"])*)"|'([^']*)'|([^\s]+))/.exec(info);
  if (!match) return "";
  return (match[1] ?? match[2] ?? match[3] ?? "").replace(/\\(["\\])/g, "$1");
}

export function extractCodeBlockTitles(markdown: string): string[] {
  const titles: string[] = [];
  let fence: FenceState | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    if (fence) {
      if (isFenceEnd(line, fence)) fence = null;
      continue;
    }

    const start = getFenceStart(line);
    if (!start) continue;
    titles.push(parseCodeBlockTitle(start.info));
    fence = { marker: start.marker, length: start.length };
  }

  return titles;
}

export function serializeCodeBlockTitles(markdown: string, titles: string[]): string {
  const lines = markdown.split(/\r?\n/);
  let fence: FenceState | null = null;
  let codeBlockIndex = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      if (isFenceEnd(line, fence)) fence = null;
      continue;
    }

    const start = getFenceStart(line);
    if (!start) continue;

    const title = titles[codeBlockIndex] ?? "";
    const infoWithoutTitle = start.info
      .replace(/(?:^|\s)title=(?:"(?:\\.|[^"])*"|'[^']*'|[^\s]+)/, "")
      .trim();
    const escapedTitle = title.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const fenceLine = start.marker.repeat(start.length);
    const info = [infoWithoutTitle, escapedTitle ? `title="${escapedTitle}"` : ""].filter(Boolean).join(" ");
    lines[index] = `${start.indent}${fenceLine}${info ? ` ${info}` : ""}`;
    codeBlockIndex += 1;
    fence = { marker: start.marker, length: start.length };
  }

  return lines.join("\n");
}
