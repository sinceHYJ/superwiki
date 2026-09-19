/**
 * 内容宽度配置：定义可持久化的宽度枚举并将未知值回退到安全默认值。
 * 设置存储层使用该类型约束 `contentWidth` 偏好。
 */

/** 内容区布局：默认宽度或占满可用工作区。 */
export type ContentWidth = "default" | "full";

/**
 * 将未知存储值安全收敛为支持的内容宽度。
 *
 * @param value 设置存储返回的原始值；`null`、`default` 或未知字符串都视为默认宽度。
 * @returns `full` 仅在输入严格等于该值时返回；其余情况返回 `default`。
 */
export function parseContentWidth(value: string | null): ContentWidth {
  return value === "full" ? "full" : "default";
}
