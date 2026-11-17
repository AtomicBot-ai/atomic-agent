/**
 * Regenerates the settings reference (ATO-41):
 *
 *   - `src/config/settings-docs.generated.ts`: the type and the one-paragraph
 *     description of every `config.json` key, read from the JSDoc on
 *     `UserConfigFile` and the domain types it is built from. The runtime
 *     cannot read comments (they are stripped from `dist/`), so this file
 *     carries them into `atomic-agent config list --describe`, the TUI's
 *     `/settings` and the desktop's "All settings" list.
 *   - `docs/user/settings-reference.md`: the same list for people, plus the
 *     table of environment variables (`src/config/env-settings.ts`).
 *
 * Usage:
 *   npx tsx scripts/gen-settings-reference.ts           # rewrite both files
 *   npx tsx scripts/gen-settings-reference.ts --check   # exit 1 when stale
 *
 * `scripts/gen-settings-reference.test.ts` runs the same extraction and
 * fails when either checked-in file differs, so a new key or a changed
 * comment cannot ship without the reference catching up.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { listConfigLeaves } from "../src/config/config-paths.js";
import { ENV_SETTINGS } from "../src/config/env-settings.js";
import { USER_CONFIG_VERSION } from "../src/config/config-schema.js";
import {
  buildSettingsReference,
  renderSettingsReferenceMarkdown,
  type SettingDoc,
} from "../src/config/settings-reference.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMA_FILE = resolve(ROOT, "src/config/config-schema.ts");
export const GENERATED_MODULE = resolve(ROOT, "src/config/settings-docs.generated.ts");
export const REFERENCE_DOC = resolve(ROOT, "docs/user/settings-reference.md");

/** Longest description kept; longer first paragraphs are cut at a sentence end. */
const MAX_DESCRIPTION = 360;

/**
 * Comment text as a one-paragraph description: the first paragraph only
 * (the rest is usually rationale for maintainers), `{@link X}` as `X`,
 * schema-history notes such as "(config v67)" dropped, whitespace folded.
 */
export function cleanDescription(raw: string): string {
  const firstParagraph = raw.trim().split(/\n\s*\n/, 1)[0] ?? "";
  let text = firstParagraph
    .replace(/\{@link(?:code|plain)?\s+([^}|\s]+)(?:[\s|][^}]*)?\}/g, "$1")
    .replace(/\s*\((?:added in )?config v\d+[^)]*\)/gi, "")
    .replace(/\s*Added in config v\d+[^.]*\.\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > MAX_DESCRIPTION) {
    const cut = text.lastIndexOf(". ", MAX_DESCRIPTION);
    text = cut > 40 ? text.slice(0, cut + 1) : `${text.slice(0, MAX_DESCRIPTION).trimEnd()}…`;
  }
  return text;
}

/**
 * The part of a block's comment that describes one of its fields, for
 * blocks documented as a whole (`memory.links`, `skills`, `tui`): either a
 * paragraph that opens with `` `name` `` or a bullet `` - `name` text``
 * with its continuation lines. Empty when the block says nothing about it.
 */
export function fieldNoteFromBlockDoc(raw: string, name: string): string {
  const tick = `\`${name}\``;
  for (const paragraph of raw.split(/\n\s*\n/)) {
    if (paragraph.trim().startsWith(tick)) return capitalize(paragraph.trim().slice(tick.length));
  }
  const lines = raw.split("\n");
  const bullet = /^\s*[-*•]\s*`/;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim().replace(/^[-*•]\s*/, "");
    if (!bullet.test(lines[i]!) || !trimmed.startsWith(tick)) continue;
    const parts = [trimmed.slice(tick.length)];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j]!;
      if (next.trim() === "" || bullet.test(next)) break;
      parts.push(next.trim());
    }
    return capitalize(parts.join(" "));
  }
  return "";
}

/** Drop a leading `(config v38, …)` or dash left after the field name, capitalize. */
function capitalize(rest: string): string {
  const text = rest
    .replace(/^\s*\([^)]*\)/, "")
    .replace(/^\s*[—:–-]?\s*/, "")
    .trim();
  return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

/**
 * Walk `UserConfigFile` along every dotted key `config list` knows and
 * collect the declared type and JSDoc of each leaf. Keys the type does
 * not describe (none today) are simply left out; `buildSettingsReference`
 * then falls back to the type of the default value.
 */
export function extractSettingDocs(schemaFile: string = SCHEMA_FILE): Record<string, SettingDoc> {
  const program = ts.createProgram([schemaFile], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    resolveJsonModule: true,
    esModuleInterop: true,
    jsx: ts.JsxEmit.ReactJSX,
    types: [],
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(schemaFile);
  if (!source) throw new Error(`cannot read ${schemaFile}`);
  const findInterface = (name: string): ts.InterfaceDeclaration => {
    let found: ts.InterfaceDeclaration | undefined;
    ts.forEachChild(source, (node) => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === name) found = node;
    });
    if (!found) throw new Error(`${name} not found in config-schema.ts`);
    return found;
  };
  // The file's own type is the authority; the runtime config type often
  // carries the comment for the same path (`memory.*`, `http.*`), so it
  // is the fallback for a key whose file-side declaration has none.
  const userRoot = findInterface("UserConfigFile");
  const runtimeRoot = findInterface("AtomicAgentConfig");

  const walk = (root: ts.InterfaceDeclaration, key: string): { symbol: ts.Symbol; type: ts.Type } | null => {
    let type: ts.Type | undefined = checker.getTypeAtLocation(root);
    let symbol: ts.Symbol | undefined;
    for (const part of key.split(".")) {
      if (!type) return null;
      symbol = checker.getNonNullableType(type).getProperty(part);
      type = symbol ? checker.getTypeOfSymbolAtLocation(symbol, root) : undefined;
    }
    return symbol && type ? { symbol, type } : null;
  };
  const rawDocOf = (symbol: ts.Symbol): string =>
    ts.displayPartsToString(symbol.getDocumentationComment(checker));
  const docOf = (symbol: ts.Symbol): string => cleanDescription(rawDocOf(symbol));

  const docs: Record<string, SettingDoc> = {};
  const leaves = listConfigLeaves();
  for (const leaf of leaves) {
    const own = walk(userRoot, leaf.key);
    if (!own) continue;
    let description = docOf(own.symbol);
    if (description === "") {
      const runtime = walk(runtimeRoot, leaf.key);
      if (runtime) description = docOf(runtime.symbol);
    }
    const dot = leaf.key.lastIndexOf(".");
    if (description === "" && dot !== -1) {
      // A block documented as a whole: look for this field in its comment.
      const name = leaf.key.slice(dot + 1);
      for (const root of [userRoot, runtimeRoot]) {
        const parent = walk(root, leaf.key.slice(0, dot));
        const note = parent ? fieldNoteFromBlockDoc(rawDocOf(parent.symbol), name) : "";
        if (note !== "") {
          description = cleanDescription(note);
          break;
        }
      }
      // A one-field block (`analytics.enabled`): the block's comment is the field's.
      const prefix = `${leaf.key.slice(0, dot)}.`;
      const siblings = leaves.filter((other) => other.key.startsWith(prefix));
      if (description === "" && siblings.length === 1) {
        const parent = walk(userRoot, leaf.key.slice(0, dot));
        if (parent) description = docOf(parent.symbol);
      }
    }
    const typeText = checker
      .typeToString(
        own.type,
        undefined,
        ts.TypeFormatFlags.InTypeAlias | ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType,
      )
      // Optional properties read as `T | undefined`; the file never stores undefined.
      .replace(/ \| undefined$/, "");
    // `5 | 2 | 1 | 3 | 4` reads better in order.
    const sorted = /^\d+( \| \d+)+$/.test(typeText)
      ? typeText.split(" | ").sort((a, b) => Number(a) - Number(b)).join(" | ")
      : typeText;
    docs[leaf.key] = { type: sorted, description };
  }
  return docs;
}

/** The generated module's full text; stable key order (declaration order). */
export function renderGeneratedModule(docs: Record<string, SettingDoc>): string {
  const lines = [
    "// GENERATED by scripts/gen-settings-reference.ts from the JSDoc on UserConfigFile.",
    "// Do not edit by hand: change the comment on the key, then run",
    "// `npx tsx scripts/gen-settings-reference.ts`.",
    "",
    'import type { SettingDoc } from "./settings-reference.js";',
    "",
    "export const SETTINGS_DOCS: Readonly<Record<string, SettingDoc>> = {",
  ];
  for (const [key, doc] of Object.entries(docs)) {
    lines.push(`  ${JSON.stringify(key)}: { type: ${JSON.stringify(doc.type)}, description: ${JSON.stringify(doc.description)} },`);
  }
  lines.push("};", "");
  return lines.join("\n");
}

/** Both outputs, from one extraction. */
export function renderAll(): { module: string; markdown: string } {
  const docs = extractSettingDocs();
  const entries = buildSettingsReference(listConfigLeaves(), docs, ENV_SETTINGS);
  return {
    module: renderGeneratedModule(docs),
    markdown: renderSettingsReferenceMarkdown(entries, ENV_SETTINGS, USER_CONFIG_VERSION),
  };
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

if (argv[1] && resolve(argv[1]) === fileURLToPath(import.meta.url)) {
  const { module, markdown } = renderAll();
  if (argv.includes("--check")) {
    const stale = [
      readOrEmpty(GENERATED_MODULE) === module ? null : GENERATED_MODULE,
      readOrEmpty(REFERENCE_DOC) === markdown ? null : REFERENCE_DOC,
    ].filter((path): path is string => path !== null);
    if (stale.length > 0) {
      stderr.write(`stale: ${stale.join(", ")}\nrun: npx tsx scripts/gen-settings-reference.ts\n`);
      exit(1);
    }
    stdout.write("settings reference is up to date\n");
  } else {
    writeFileSync(GENERATED_MODULE, module);
    writeFileSync(REFERENCE_DOC, markdown);
    stdout.write(`wrote ${GENERATED_MODULE}\nwrote ${REFERENCE_DOC}\n`);
  }
}
