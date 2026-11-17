import { readFileSync, statSync } from "node:fs";

import {
  checkRecipe,
  parseRecipe,
  parseRecipeLink,
  recipeToLink,
  RECIPE_FILE_MAX_BYTES,
  type RecipeCheckResult,
  type RecipeParseResult,
} from "../recipes/index.js";

/**
 * ATO-1070 — `atag recipe check|link`: look at a recipe before it is used,
 * and turn a recipe file into the `atomicagent://recipe/open` link the
 * desktop opens. Read-only: nothing is run, sent or downloaded. A web
 * address is refused on purpose: a v1 recipe travels inside its link, so
 * there is nothing to fetch.
 */
const HELP = [
  "Usage:",
  "  atomic-agent recipe check <file|-|atomicagent://recipe/open?...> [--json]",
  "  atomic-agent recipe link <file|->",
  "",
  "A recipe is a shareable task: a title, an optional description, the task text",
  "with {{key}} placeholders, and up to 16 params, as YAML or JSON. Opening one puts",
  "the filled text into a new chat; you send it yourself. A recipe cannot choose the",
  "model, tools, MCP servers, skills or permissions.",
  "",
  "check   Validates the recipe and scans its text (download-and-run, secret theft,",
  "        prompt injection, invisible characters), then says what it will do.",
  "        Exit 0 for ok or caution, 1 for an invalid or dangerous recipe.",
  "        --json prints {ok, recipe, verdict, findings, scanId, willDo} or {ok:false, error}.",
  "link    Prints the shareable atomicagent://recipe/open link. Refuses a dangerous",
  "        recipe; a caution is printed on stderr.",
  "",
  "`-` reads the recipe from stdin. Web addresses are not fetched.",
].join("\n");

export interface RecipeCommandDeps {
  write?: (text: string) => void;
  writeErr?: (text: string) => void;
  /** Defaults to reading the file with a size cap. */
  readFile?: (path: string) => string;
  /** Defaults to reading process.stdin with a size cap. */
  readStdin?: () => Promise<string>;
}

export async function recipeCommand(args: string[], deps: RecipeCommandDeps = {}): Promise<number> {
  const write = deps.write ?? ((t: string) => { process.stdout.write(t); });
  const writeErr = deps.writeErr ?? ((t: string) => { process.stderr.write(t); });
  const [sub, ...rest] = args;
  if (!sub || sub === "-h" || sub === "--help") {
    write(`${HELP}\n`);
    return 0;
  }
  if (sub !== "check" && sub !== "link") {
    writeErr(`unknown recipe command: ${sub}\n\n${HELP}\n`);
    return 2;
  }
  if (rest.includes("-h") || rest.includes("--help")) {
    write(`${HELP}\n`);
    return 0;
  }
  const json = sub === "check" && rest.includes("--json");
  const positional = sub === "check" ? rest.filter((a) => a !== "--json") : rest;
  const odd = positional.find((a) => a.startsWith("--"));
  if (odd !== undefined) {
    writeErr(`unknown option ${odd}\n\n${HELP}\n`);
    return 2;
  }
  if (positional.length !== 1) {
    writeErr(`recipe ${sub} takes one file (or - for stdin)\n\n${HELP}\n`);
    return 2;
  }
  const source = positional[0]!;
  if (/^https?:\/\//i.test(source)) {
    writeErr("recipes are not downloaded: a v1 recipe travels inside its atomicagent://recipe/open link. Save the file and pass its path, or pass the link itself to `recipe check`.\n");
    return 2;
  }
  const parsed = await load(source, sub === "check", deps);
  if (!parsed.ok) {
    if (json) write(`${JSON.stringify({ ok: false, error: parsed.error })}\n`);
    else writeErr(`${parsed.error}\n`);
    return 1;
  }
  const check = checkRecipe(parsed.recipe);
  if (sub === "check") {
    if (json) write(`${JSON.stringify({ ok: true, recipe: parsed.recipe, ...check })}\n`);
    else write(formatCheck(parsed.recipe.title, check));
    return check.verdict === "dangerous" ? 1 : 0;
  }
  if (check.verdict === "dangerous") {
    writeErr(`${formatCheck(parsed.recipe.title, check)}No link made: the check found this recipe dangerous.\n`);
    return 1;
  }
  const link = recipeToLink(parsed.recipe);
  if (!link.ok) {
    writeErr(`${link.error}\n`);
    return 1;
  }
  if (check.verdict === "caution") {
    writeErr(`caution: ${check.findings.map((f) => f.rule).filter((r, i, all) => all.indexOf(r) === i).join(", ")} (run \`recipe check\` for details)\n`);
  }
  write(`${link.link}\n`);
  return 0;
}

async function load(source: string, allowLink: boolean, deps: RecipeCommandDeps): Promise<RecipeParseResult> {
  if (/^atomicagent:\/\//i.test(source)) {
    if (!allowLink) return { ok: false, error: "recipe link takes a recipe file; this is already a link." };
    return parseRecipeLink(source);
  }
  let text: string;
  try {
    text = source === "-"
      ? await (deps.readStdin ?? readStdinCapped)()
      : (deps.readFile ?? readFileCapped)(source);
  } catch (err) {
    return { ok: false, error: `cannot read ${source === "-" ? "stdin" : source}: ${err instanceof Error ? err.message : String(err)}` };
  }
  return parseRecipe(text);
}

function readFileCapped(path: string): string {
  // Checked before reading, so a huge file is never pulled into memory.
  if (statSync(path).size > RECIPE_FILE_MAX_BYTES) throw new Error(`larger than ${RECIPE_FILE_MAX_BYTES / 1024} KiB`);
  return readFileSync(path, "utf8");
}

async function readStdinCapped(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > RECIPE_FILE_MAX_BYTES) throw new Error(`larger than ${RECIPE_FILE_MAX_BYTES / 1024} KiB`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function formatCheck(title: string, check: RecipeCheckResult): string {
  const lines = [`Recipe: ${title}`, `Verdict: ${check.verdict}`, "", "What it will do:"];
  for (const line of check.willDo) lines.push(`  - ${line}`);
  if (check.findings.length > 0) {
    lines.push("", "Findings:");
    for (const f of check.findings) lines.push(`  - ${f.severity} ${f.rule} (${f.file}, line ${f.line}): ${f.excerpt}`);
  }
  lines.push("", `Scan id: ${check.scanId}`);
  return `${lines.join("\n")}\n`;
}
