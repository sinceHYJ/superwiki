/**
 * 快捷键模型与校验：定义默认绑定、保留组合键及覆盖项的恢复规则。
 * SQLite 仅保存非默认覆盖；读取时拒绝已检测到的保留键和动作冲突。当前尚未校验 chord 格式。
 */

/** 编辑器内置格式化动作的快捷键标识。 */
export type EditorShortcutId = "bold" | "italic" | "inlineCode" | "codeBlock" | "link" | "image";
/** 应用级界面动作的快捷键标识。 */
export type AppShortcutId = "save" | "favorite" | "toggleSidebar" | "toggleOutline" | "toggleView" | "toggleFullscreen";
/** 编辑器与应用级动作的并集。 */
export type ShortcutId = EditorShortcutId | AppShortcutId;
/** 快捷键作用范围：编辑器输入区或整个应用。 */
export type ShortcutScope = "editor" | "app";

/** 单个可配置快捷键的标识、作用范围、展示名和默认组合键。 */
export type ShortcutDefinition = {
  /** 唯一的快捷键动作标识。 */
  id: ShortcutId;
  /** 该组合键的生效区域。 */
  scope: ShortcutScope;
  /** 设置界面显示的中文动作名称。 */
  label: string;
  /** 未覆盖时使用的标准 chord 字符串。 */
  defaultChord: string;
};

/** 完整快捷键表；key 为每个动作 ID，value 为其唯一 chord。 */
export type ShortcutBindings = Record<ShortcutId, string>;

/** 系统支持的全部动作定义，数组顺序也是覆盖恢复时的确定性遍历顺序。 */
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

/** 是否运行在 macOS；决定 `Mod` 修饰键和显示符号。 */
const IS_MACOS = /Macintosh|Mac OS X/i.test(navigator.userAgent);
/** 可单独触发快捷键的功能键范围，仅允许 F1 至 F12。 */
const FUNCTION_KEY = /^F(?:[1-9]|1[0-2])$/;
/**
 * 禁止用户覆盖的系统或编辑器内置 chord 映射。
 * key：标准 chord 字符串；value：冲突时显示的占用功能名称。缺少 key 表示不属于已知保留键。
 */
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

/** 所有动作的默认绑定；key 为动作 ID，value 为默认 chord。 */
export const DEFAULT_SHORTCUT_BINDINGS = Object.fromEntries(
  SHORTCUT_DEFINITIONS.map((definition) => [definition.id, definition.defaultChord]),
) as ShortcutBindings;

/**
 * 判断动作是否只在编辑器区域生效。
 *
 * @param id 待判断的快捷键动作标识。
 * @returns `true` 时将 `id` 收窄为 `EditorShortcutId`。
 */
export function isEditorShortcut(id: ShortcutId): id is EditorShortcutId {
  return SHORTCUT_DEFINITIONS.some((definition) => definition.id === id && definition.scope === "editor");
}

/**
 * 查找已注册动作的定义。
 *
 * @param id 已受 `ShortcutId` 类型约束的动作标识。
 * @returns 对应的 `ShortcutDefinition`；所有合法 ID 都必须有定义。
 */
export function shortcutDefinition(id: ShortcutId) {
  return SHORTCUT_DEFINITIONS.find((definition) => definition.id === id)!;
}

/**
 * 将存储用 chord 转换为当前操作系统可读的展示文本。
 *
 * @param chord 以 `+` 分隔、包含 `Mod`/`KeyX` 等代码的标准组合键。
 * @returns macOS 使用符号、其他系统使用文字和 `+` 分隔的展示字符串。
 */
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

/**
 * 生成同时包含动作名称与格式化快捷键的控件标题。
 *
 * @param label 动作的展示名称。
 * @param chord 标准 chord 字符串。
 * @returns `动作（快捷键）` 格式的中文标题。
 */
export function shortcutTitle(label: string, chord: string) {
  return `${label}（${displayShortcut(chord)}）`;
}

/**
 * 从浏览器键盘事件提取可保存的标准 chord。
 *
 * @param event 原生键盘事件；单独修饰键、非主平台修饰键和普通字符键返回无效。
 * @returns 合法 chord，或不应绑定为快捷键时返回 `null`。
 */
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

/**
 * 检查候选 chord 是否占用系统保留键或其他动作。
 *
 * @param bindings 当前完整快捷键表。
 * @param id 正在修改的动作 ID；自身已有绑定不算冲突。
 * @param chord 待写入的标准组合键。
 * @returns 冲突时返回中文原因；无冲突时为 `null`。
 */
export function findShortcutConflict(bindings: ShortcutBindings, id: ShortcutId, chord: string) {
  const reserved = RESERVED_SHORTCUTS[chord];
  if (reserved) return `与“${reserved}”冲突`;

  const conflict = SHORTCUT_DEFINITIONS.find((definition) => (
    definition.id !== id && bindings[definition.id] === chord
  ));
  return conflict ? `与“${conflict.label}”冲突` : null;
}

/**
 * 在无冲突时返回包含候选绑定的新快照，冲突时保持原快照。
 *
 * @param bindings 当前完整快捷键表，不会被原地修改。
 * @param id 待设置的动作 ID。
 * @param chord 待设置的标准组合键。
 * @returns `{ bindings, error }`；`error` 为 `null` 表示可提交，非空时 `bindings` 保持原值。
 */
export function setShortcutBinding(bindings: ShortcutBindings, id: ShortcutId, chord: string) {
  const error = findShortcutConflict(bindings, id, chord);
  return error ? { bindings, error } : { bindings: { ...bindings, [id]: chord }, error: null };
}

/**
 * 从持久化覆盖恢复完整快捷键表；已检测到的冲突会抛错，避免静默使用损坏配置。
 *
 * @param overrides 非默认绑定映射；缺少动作 ID 时恢复其默认 chord。
 * @returns 包含全部动作的有效 `ShortcutBindings`。
 * @throws 覆盖项与已有动作或保留 chord 冲突时抛出错误。
 * @remarks 当前未校验 chord 的格式，因此格式非法但不冲突的字符串会被接受。
 */
export function readShortcutBindings(overrides: Partial<Record<ShortcutId, string>> = {}): ShortcutBindings {
  const bindings = { ...DEFAULT_SHORTCUT_BINDINGS };
  for (const definition of SHORTCUT_DEFINITIONS) {
    const value = overrides[definition.id];
    if (typeof value !== "string") continue;
    const result = setShortcutBinding(bindings, definition.id, value);
    if (result.error) throw new Error(`快捷键“${definition.label}”配置无效：${result.error}`);
    Object.assign(bindings, result.bindings);
  }
  return bindings;
}

/**
 * 仅提取偏离默认值的组合键，供 SQLite 以最小快照持久化。
 *
 * @param bindings 当前完整快捷键表。
 * @returns 仅含非默认动作 ID 的覆盖映射；无覆盖时返回空对象。
 */
export function shortcutOverrides(bindings: ShortcutBindings) {
  return Object.fromEntries(
    SHORTCUT_DEFINITIONS
      .filter((definition) => bindings[definition.id] !== definition.defaultChord)
      .map((definition) => [definition.id, bindings[definition.id]]),
  ) as Partial<Record<ShortcutId, string>>;
}
