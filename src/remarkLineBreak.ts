type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
};

const BR_TAG = /^<br\s*\/?>$/i;
// 这些容器的直接子节点是块级节点，独占一行的 <br> 只承担空行作用，直接移除
const BLOCK_CONTAINERS = new Set(["root", "blockquote", "listItem"]);

function transformLineBreaks(node: MarkdownNode) {
  if (!node.children) return;

  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    if (child.type === "html" && BR_TAG.test((child.value ?? "").trim())) {
      if (BLOCK_CONTAINERS.has(node.type)) {
        node.children.splice(index, 1);
        index -= 1;
      } else {
        node.children[index] = { type: "break" };
      }
      continue;
    }
    transformLineBreaks(child);
  }
}

export function remarkLineBreak() {
  return (tree: MarkdownNode) => {
    transformLineBreaks(tree);
  };
}
