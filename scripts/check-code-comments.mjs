/**
 * 代码注释门禁：检查本次变更触及的 TypeScript、TSX 与 Rust 源文件是否具备基础文档注释。
 * 该脚本只验证注释的结构存在；注释内容是否准确仍由代码审查按 code-rules.MD 判断。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SOURCE_FILE = /^(src\/.+\.(?:ts|tsx)|src-tauri\/src\/.+\.rs)$/;

function changedFiles(base) {
  const range = base ? `${base}...HEAD` : "HEAD";
  return execFileSync("git", ["diff", "--name-only", "--diff-filter=AM", range], { encoding: "utf8" })
    .split("\n")
    .filter((file) => SOURCE_FILE.test(file));
}

function allSourceFiles() {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter((file) => SOURCE_FILE.test(file));
}

function isDocComment(line) {
  return line.trim().startsWith("/**") || line.trim().startsWith("///") || line.trim().startsWith("//! ");
}

function hasDocComment(lines, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const line = lines[cursor].trim();
    if (!line || line.startsWith("#") || line.startsWith("@") || line === "*/" || line.startsWith("*")) continue;
    return isDocComment(lines[cursor]);
  }
  return false;
}

function checkTypeScript(file, lines, errors) {
  let typeDepth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const declaration = /^\s*(?:export\s+)?(?:async\s+)?function\s+\w+|^\s*(?:export\s+)?const\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>|^\s*(?:export\s+)?(?:type|interface|enum|class)\s+\w+/.test(line);
    if (declaration && !hasDocComment(lines, index)) errors.push(`${file}:${index + 1} 缺少定义级文档注释`);

    if (/^\s*(?:export\s+)?(?:type|interface)\s+\w+.*=\s*\{\s*$/.test(line) || /^\s*(?:export\s+)?interface\s+\w+\s*\{\s*$/.test(line)) typeDepth = 1;
    else if (typeDepth > 0) {
      typeDepth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      if (/^\s*\w+\??:\s*.+[;,]?$/.test(line) && !hasDocComment(lines, index)) {
        errors.push(`${file}:${index + 1} 类型字段缺少文档注释`);
      }
      if (typeDepth <= 0) typeDepth = 0;
    }
  }
}

function checkRust(file, lines, errors) {
  let structDepth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const declaration = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+\w+|^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum)\s+\w+/.test(line);
    if (declaration && !hasDocComment(lines, index)) errors.push(`${file}:${index + 1} 缺少定义级文档注释`);

    if (/^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+\w+\s*\{\s*$/.test(line)) structDepth = 1;
    else if (structDepth > 0) {
      structDepth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      if (/^\s*(?:pub(?:\([^)]*\))?\s+)?\w+:\s*.+,$/.test(line) && !hasDocComment(lines, index)) {
        errors.push(`${file}:${index + 1} 结构体字段缺少文档注释`);
      }
      if (structDepth <= 0) structDepth = 0;
    }
  }
}

function checkFile(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const errors = [];
  const firstContent = lines.findIndex((line) => line.trim());
  if (firstContent === -1 || !isDocComment(lines[firstContent])) errors.push(`${file}:1 缺少文件级文档注释`);
  if (file.endsWith(".rs")) checkRust(file, lines, errors);
  else checkTypeScript(file, lines, errors);
  return errors;
}

const baseIndex = process.argv.indexOf("--changed");
const base = baseIndex === -1 ? undefined : process.argv[baseIndex + 1];
const requestedFiles = process.argv.slice(2).filter((argument) => argument !== "--changed" && argument !== base);
const files = base ? changedFiles(base) : requestedFiles.filter(SOURCE_FILE.test.bind(SOURCE_FILE));
const filesToCheck = files.length ? files : allSourceFiles();
if (!filesToCheck.length) process.exit(0);

const errors = filesToCheck.flatMap(checkFile);
if (errors.length) {
  console.error("代码注释检查失败：\n" + errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}
console.log(`代码注释检查通过：${filesToCheck.length} 个源文件`);
