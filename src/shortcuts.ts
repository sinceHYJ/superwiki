export const SHORTCUT_STORAGE_KEY = "superwiki.shortcuts";

export type EditorShortcutId = "bold" | "italic" | "inlineCode" | "codeBlock" | "link" | "image";
export type AppShortcutId = "save" | "favorite" | "toggleSidebar" | "toggleOutline" | "toggleView" | "toggleFullscreen";
export type ShortcutId = EditorShortcutId | AppShortcutId;
export type ShortcutScope = "editor" | "app";

export type ShortcutDefinition = {
  id: ShortcutId;
  scope: ShortcutScope;
  label: string;
  defaultChord: string;
};

export type ShortcutBindings = Record<ShortcutId, string>;

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  { id: "bold", scope: "editor", label: "加粗", defaultChord: "Mod+KeyB" },
  { id: "italic", scope: "editor", label: "斜体", defaultChord: "Mod+KeyI" },
  { id: "inlineCode", scope: "editor", label: "行内代码", defaultChord: "Mod+KeyE" },
  { id: "codeBlock", scope: "editor", label: "代码块", defaultChord: "Mod+Alt+KeyC" },
  { id: "link", scope: "editor", label: "插入链接", defaultChord: "Mod+KeyK" },
  { id: "image", scope: "editor", label: "插入图片", defaultChord: "Mod+Alt+KeyI" },
  { id: "save", scope: "app", label: "保存当前文档", defaultChord: "Mod+KeyS" },
  { id: "favorite", scope: "app", label: "收藏/取消收藏", defaultChord: "Mod+Shift+KeyD" },
  { id: "toggleSidebar", scope: "app", label: "打开/关闭左侧栏", defaultChord: "Mod+Shift+KeyL" },
  { id: "toggleOutline", scope: "app", label: "打开/关闭右侧目录", defaultChord: "Mod+Shift+KeyO" },
  { id: "toggleView", scope: "app", label: "编辑/预览切换", defaultChord: "Mod+Shift+KeyE" },
  { id: "toggleFullscreen", scope: "app", label: "进入/退出只读全屏", defaultChord: "F11" },
];

const IS_MACOS = /Macintosh|Mac OS X/i.test(navigator.userAgent);
const FUNCTION_KEY = /^F(?:[1-9]|1[0-2])$/;
const RESERVED_SHORTCUTS: Record<string, string> = {
  "Mod+KeyC": "复制",
  "Mod+KeyX": "剪切",
  "Mod+KeyV": "粘贴",
  "Mod+KeyA": "全选",
  "Mod+KeyZ": "撤销",
  "Mod+KeyY": "重做",
  "Mod+Shift+KeyZ": "重做",
  "Mod+KeyF": "查找",
  "Mod+KeyP": "打印",
  "Mod+KeyR": "刷新",
  "Mod+KeyW": "关闭窗口",
  "Mod+KeyQ": "退出应用",
  "Alt+F4": "关闭窗口",
  F5: "刷新",
  Escape: "退出全屏或关闭弹层",
  "Mod+Alt+KeyX": "删除线（编辑器内置）",
  "Mod+Alt+Digit0": "正文（编辑器内置）",
  "Mod+Alt+Digit1": "标题 1（编辑器内置）",
  "Mod+Alt+Digit2": "标题 2（编辑器内置）",
  "Mod+Alt+Digit3": "标题 3（编辑器内置）",
  "Mod+Alt+Digit4": "标题 4（编辑器内置）",
  "Mod+Alt+Digit5": "标题 5（编辑器内置）",
  "Mod+Alt+Digit6": "标题 6（编辑器内置）",
  "Mod+Alt+Digit7": "有序列表（编辑器内置）",
  "Mod+Alt+Digit8": "无序列表（编辑器内置）",
  "Mod+Shift+KeyB": "引用（编辑器内置）",
  "Mod+BracketLeft": "减少列表缩进（编辑器内置）",
  "Mod+BracketRight": "增加列表缩进（编辑器内置）",
  "Mod+Enter": "表格换行（编辑器内置）",
  "Shift+Enter": "软换行（编辑器内置）",
  Tab: "列表或表格导航（编辑器内置）",
  "Shift+Tab": "列表或表格导航（编辑器内置）",
};

export const DEFAULT_SHORTCUT_BINDINGS = Object.fromEntries(
  SHORTCUT_DEFINITIONS.map((definition) => [definition.id, definition.defaultChord]),
) as ShortcutBindings;

export function isEditorShortcut(id: ShortcutId): id is EditorShortcutId {
  return SHORTCUT_DEFINITIONS.some((definition) => definition.id === id && definition.scope === "editor");
}

export function shortcutDefinition(id: ShortcutId) {
  return SHORTCUT_DEFINITIONS.find((definition) => definition.id === id)!;
}

export function displayShortcut(chord: string) {
  return chord.split("+").map((part) => {
    if (part === "Mod") return IS_MACOS ? "⌘" : "Ctrl";
    if (part === "Alt") return IS_MACOS ? "⌥" : "Alt";
    if (part === "Shift") return IS_MACOS ? "⇧" : "Shift";
    if (part.startsWith("Key")) return part.slice(3);
    if (part.startsWith("Digit")) return part.slice(5);
    if (part === "BracketLeft") return "[";
    if (part === "BracketRight") return "]";
    return part;
  }).join(IS_MACOS ? "" : "+");
}

export function shortcutTitle(label: string, chord: string) {
  return `${label}（${displayShortcut(chord)}）`;
}

export function chordFromKeyboardEvent(event: KeyboardEvent) {
  const code = event.code;
  if (!code || ["ControlLeft", "ControlRight", "MetaLeft", "MetaRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight"].includes(code)) return null;

  const primaryPressed = IS_MACOS ? event.metaKey : event.ctrlKey;
  const hasUnexpectedPrimary = IS_MACOS ? event.ctrlKey : event.metaKey;
  if (hasUnexpectedPrimary) return null;

  const modifiers = [
    primaryPressed ? "Mod" : null,
    event.altKey ? "Alt" : null,
    event.shiftKey ? "Shift" : null,
  ].filter((value): value is string => value !== null);

  if (!primaryPressed && !event.altKey && !FUNCTION_KEY.test(code)) return null;
  return [...modifiers, code].join("+");
}

export function findShortcutConflict(bindings: ShortcutBindings, id: ShortcutId, chord: string) {
  const reserved = RESERVED_SHORTCUTS[chord];
  if (reserved) return `与“${reserved}”冲突`;

  const conflict = SHORTCUT_DEFINITIONS.find((definition) => (
    definition.id !== id && bindings[definition.id] === chord
  ));
  return conflict ? `与“${conflict.label}”冲突` : null;
}

export function setShortcutBinding(bindings: ShortcutBindings, id: ShortcutId, chord: string) {
  const error = findShortcutConflict(bindings, id, chord);
  return error ? { bindings, error } : { bindings: { ...bindings, [id]: chord }, error: null };
}

export function readShortcutBindings(): ShortcutBindings {
  const bindings = { ...DEFAULT_SHORTCUT_BINDINGS };
  try {
    const stored = localStorage.getItem(SHORTCUT_STORAGE_KEY);
    if (!stored) return bindings;
    const parsed = JSON.parse(stored) as Partial<Record<ShortcutId, unknown>>;
    if (!parsed || typeof parsed !== "object") return bindings;

    for (const definition of SHORTCUT_DEFINITIONS) {
      const value = parsed[definition.id];
      if (typeof value !== "string") continue;
      const result = setShortcutBinding(bindings, definition.id, value);
      if (!result.error) Object.assign(bindings, result.bindings);
    }
  } catch {
    // 配置损坏时使用默认值，不影响应用启动。
  }
  return bindings;
}

export function saveShortcutBindings(bindings: ShortcutBindings) {
  const overrides = Object.fromEntries(
    SHORTCUT_DEFINITIONS
      .filter((definition) => bindings[definition.id] !== definition.defaultChord)
      .map((definition) => [definition.id, bindings[definition.id]]),
  );
  localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(overrides));
}
