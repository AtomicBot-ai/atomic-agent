import type { LanguageRegistration } from "@shikijs/core";
import css from "@shikijs/langs/css";
import diff from "@shikijs/langs/diff";
import docker from "@shikijs/langs/docker";
import dotenv from "@shikijs/langs/dotenv";
import go from "@shikijs/langs/go";
import html from "@shikijs/langs/html";
import ini from "@shikijs/langs/ini";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import jsonc from "@shikijs/langs/jsonc";
import markdown from "@shikijs/langs/markdown";
import python from "@shikijs/langs/python";
import rust from "@shikijs/langs/rust";
import shellscript from "@shikijs/langs/shellscript";
import sql from "@shikijs/langs/sql";
import toml from "@shikijs/langs/toml";
import tsx from "@shikijs/langs/tsx";
import typescript from "@shikijs/langs/typescript";
import yaml from "@shikijs/langs/yaml";

/**
 * ATO-653: the TextMate grammars bundled for terminal code blocks.
 *
 * Each grammar is a static import of one `@shikijs/langs/<id>` file so
 * esbuild (scripts/bundle-sea.ts) embeds only these into the SEA binary,
 * not all ~250 shiki languages. The set is the languages a model writes
 * most (TS/JS, Rust, Go, Python, shell) plus config and data formats.
 * About 1 MB of grammar JSON in total; a fence outside the set still gets
 * the older `cli-highlight` colouring (see syntax-highlight.ts).
 *
 * `jsx` maps onto the `javascript` grammar: shiki's `source.js` is the
 * VS Code "JavaScript (with React support)" grammar, so it already reads
 * JSX and a separate ~190 KB `jsx` grammar would add nothing.
 */
export const SHIKI_GRAMMARS: readonly LanguageRegistration[] = [
  ...typescript,
  ...tsx,
  ...javascript,
  ...rust,
  ...go,
  ...python,
  ...shellscript,
  ...json,
  ...jsonc,
  ...yaml,
  ...toml,
  ...ini,
  ...dotenv,
  ...docker,
  ...css,
  ...html,
  ...markdown,
  ...diff,
  ...sql,
];

/** Fence names a model writes, mapped to the shiki language id that reads them. */
const FENCE_TO_SHIKI: Readonly<Record<string, string>> = {
  ts: "typescript",
  typescript: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  node: "javascript",
  rs: "rust",
  rust: "rust",
  go: "go",
  golang: "go",
  py: "python",
  python: "python",
  python3: "python",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  shellscript: "shellscript",
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  properties: "ini",
  env: "dotenv",
  dotenv: "dotenv",
  dockerfile: "docker",
  docker: "docker",
  css: "css",
  html: "html",
  htm: "html",
  md: "markdown",
  markdown: "markdown",
  diff: "diff",
  patch: "diff",
  sql: "sql",
};

/**
 * The shiki language id for a fence's language tag, or `undefined` when
 * the bundled grammars do not cover it. Case and surrounding spaces are
 * ignored, as is anything after the first space (` ```ts title="a.ts" `).
 */
export function resolveShikiLanguage(fence: string): string | undefined {
  const tag = fence.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (tag.length === 0) return undefined;
  return Object.prototype.hasOwnProperty.call(FENCE_TO_SHIKI, tag)
    ? FENCE_TO_SHIKI[tag]
    : undefined;
}

/** Every shiki id the fence map can resolve to (for the grammar-coverage test). */
export function mappedShikiLanguages(): readonly string[] {
  return [...new Set(Object.values(FENCE_TO_SHIKI))];
}
