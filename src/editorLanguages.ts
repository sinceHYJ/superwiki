import { LanguageDescription, LanguageSupport, StreamLanguage } from "@codemirror/language";

export const supportedCodeLanguages = [
  LanguageDescription.of({
    name: "Mermaid",
    alias: ["mermaid"],
    load: async () => (await import("@codemirror/lang-markdown")).markdown(),
  }),
  LanguageDescription.of({
    name: "PlantUML",
    alias: ["plantuml", "puml"],
    load: async () => (await import("@codemirror/lang-markdown")).markdown(),
  }),
  LanguageDescription.of({
    name: "JavaScript",
    alias: ["js", "javascript", "node"],
    extensions: ["js", "mjs", "cjs"],
    load: async () => (await import("@codemirror/lang-javascript")).javascript(),
  }),
  LanguageDescription.of({
    name: "JSX",
    alias: ["jsx"],
    extensions: ["jsx"],
    load: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
  }),
  LanguageDescription.of({
    name: "TypeScript",
    alias: ["ts", "typescript"],
    extensions: ["ts", "mts", "cts"],
    load: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }),
  }),
  LanguageDescription.of({
    name: "TSX",
    alias: ["tsx"],
    extensions: ["tsx"],
    load: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true }),
  }),
  LanguageDescription.of({
    name: "Rust",
    alias: ["rs", "rust"],
    extensions: ["rs"],
    load: async () => (await import("@codemirror/lang-rust")).rust(),
  }),
  LanguageDescription.of({
    name: "Python",
    alias: ["py", "python"],
    extensions: ["py"],
    load: async () => (await import("@codemirror/lang-python")).python(),
  }),
  LanguageDescription.of({
    name: "Java",
    alias: ["java"],
    extensions: ["java"],
    load: async () => (await import("@codemirror/lang-java")).java(),
  }),
  LanguageDescription.of({
    name: "Go",
    alias: ["go", "golang"],
    extensions: ["go"],
    load: async () => (await import("@codemirror/lang-go")).go(),
  }),
  LanguageDescription.of({
    name: "HTML",
    alias: ["html"],
    extensions: ["html", "htm"],
    load: async () => (await import("@codemirror/lang-html")).html(),
  }),
  LanguageDescription.of({
    name: "CSS",
    alias: ["css"],
    extensions: ["css"],
    load: async () => (await import("@codemirror/lang-css")).css(),
  }),
  LanguageDescription.of({
    name: "JSON",
    alias: ["json", "jsonc"],
    extensions: ["json", "jsonc"],
    load: async () => (await import("@codemirror/lang-json")).json(),
  }),
  LanguageDescription.of({
    name: "YAML",
    alias: ["yaml", "yml"],
    extensions: ["yaml", "yml"],
    load: async () => (await import("@codemirror/lang-yaml")).yaml(),
  }),
  LanguageDescription.of({
    name: "TOML",
    alias: ["toml"],
    extensions: ["toml"],
    load: async () => {
      const { toml } = await import("@codemirror/legacy-modes/mode/toml");
      return new LanguageSupport(StreamLanguage.define(toml));
    },
  }),
  LanguageDescription.of({
    name: "Markdown",
    alias: ["md", "markdown"],
    extensions: ["md", "markdown"],
    load: async () => (await import("@codemirror/lang-markdown")).markdown(),
  }),
  LanguageDescription.of({
    name: "SQL",
    alias: ["sql"],
    extensions: ["sql"],
    load: async () => (await import("@codemirror/lang-sql")).sql(),
  }),
  LanguageDescription.of({
    name: "Shell",
    alias: ["sh", "bash", "zsh", "shell"],
    extensions: ["sh", "bash", "zsh"],
    load: async () => {
      const { shell } = await import("@codemirror/legacy-modes/mode/shell");
      return new LanguageSupport(StreamLanguage.define(shell));
    },
  }),
];
