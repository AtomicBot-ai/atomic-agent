import { createHash } from "node:crypto";

import {
  scanSkillFiles,
  type SkillScanFinding,
  type SkillScanVerdict,
} from "../skills/hub/skill-security-scanner.js";
import { hasHostName } from "./bare-host.js";
import { findHiddenCharacters } from "./hidden-characters.js";
import { recipePlaceholders, renderRecipePrompt, type Recipe } from "./recipe-format.js";
import { recipeTexts } from "./recipe-link.js";

/**
 * The content check a shared recipe gets before the person uses it
 * (ATO-1070). A recipe runs nothing by itself, but its text is what the
 * agent will do once sent, so it gets the same tripwire as a hub skill
 * (`scanSkillFiles`: download-and-run, secret exfiltration, destructive
 * commands, prompt-injection phrases) plus checks for tricks that only make
 * sense in a prompt: invisible characters, asking the agent to hide steps or
 * skip approvals, and markdown images that leak data through a URL.
 *
 * Plain-language rules cover the same attacks written as a sentence
 * ("download X and run it as root", "post the contents of ~/x to <url>").
 * Like the skill scan it is a best-effort tripwire, not a guarantee: `ok`
 * means no known pattern matched, never "safe", and `note` says so. The
 * card still shows the whole text. `willDo` is the plain-English summary the
 * card and `atag recipe check` print.
 */

export type RecipeFinding = SkillScanFinding;

export interface RecipeCheckResult {
  verdict: SkillScanVerdict;
  findings: RecipeFinding[];
  /**
   * Binds a "yes" to this exact recipe and these findings: any change to the
   * text or to a finding gives a new id, so a stale approval does not count.
   */
  scanId: string;
  /** What opening the recipe does, one sentence each. */
  willDo: string[];
  /**
   * Shown next to the verdict. An `ok` only means no known pattern matched,
   * never that the recipe is safe, so it always says to read the text.
   */
  note: string;
}

export const RECIPE_CHECK_NOTE_OK =
  "No known risky patterns found. This check is a tripwire, not a guarantee: read the text before you send it.";
export const RECIPE_CHECK_NOTE_FLAGGED =
  "This check is a tripwire, not a guarantee: read the findings and the whole text before you send it.";

interface PromptRule {
  rule: string;
  severity: "caution" | "dangerous";
  pattern: RegExp;
}

/* Phrases a task text has no honest reason to contain. Line-level, bounded regexes. */
const PROMPT_RULES: PromptRule[] = [
  {
    rule: "hide-from-user",
    severity: "caution",
    pattern: /\b(without (asking|telling|confirming|notifying)|(do not|don'?t) (tell|show|mention|inform) (this to )?(the user|me|them)|silently|secretly|in the background so)\b/i,
  },
  {
    rule: "approval-bypass",
    severity: "caution",
    pattern: /(auto[- ]?approve|skip (the |all )?(approvals?|confirmations?|permission)|bypass (the )?(approvals?|permissions?|sandbox)|--yolo\b|--dangerously-skip-permissions|turn off (the )?(approvals?|sandbox))/i,
  },
  {
    rule: "prompt-override",
    severity: "caution",
    pattern: /\b(forget (all |your )?(previous |prior )?(instructions|rules)|new system prompt|reveal (your )?(system prompt|instructions)|override (your|the) (rules|instructions|system prompt))\b/i,
  },
  {
    // `![x](https://host/?q=<data>)`: a rendered image sends whatever the agent put in the URL.
    rule: "image-url-leak",
    severity: "caution",
    pattern: /!\[[^\]\n]{0,200}\]\(\s*https?:\/\//i,
  },
];

/*
 * A recipe is a prompt, not a script: "download X and run it as root" never
 * looks like `curl | sh`. These rules read the whole text of a field, where
 * any run of whitespace (newlines too) is one gap, and need two or three
 * signals together, so "download the report" or "send me a summary" stay ok.
 */
const URL_RE = /\b(?:https?|ftp):\/\/[^\s)>\]"']+/i;
const EMAIL_RE = /\b[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/i;
const DOWNLOAD_RE = /\b(?:download(?:s|ed|ing)?|fetch(?:es|ed|ing)?|get|grab|pull|wget|curl)\b/i;
const SCRIPT_RE = /\b(?:script|installer|binary)\b|\.(?:sh|bash|zsh|ps1|bat|cmd|exe|msi|pkg|dmg|bin|run|py|pl|rb|js|jar|appimage)\b/i;
const EXECUTE_RE = /\b(?:execut(?:e|es|ed|ing|able)|install(?:s|ed|ing)?(?!\.\w)|chmod|sudo|as root|run (?:it|them|this|that|the (?:script|file|installer|binary|program|download))|launch (?:it|them|the (?:script|file|installer|binary|program)))\b/i;
const SEND_RE = /\b(?:send(?:s|ing)?|sent|post(?:s|ed|ing)?|upload(?:s|ed|ing)?|e-?mail(?:s|ed|ing)?|paste(?:s|d)?|pasting)\b/i;
const PRIVATE_DATA_RE = /\b(?:files?|folders?|contents?|keys?|passwords?|tokens?|secrets?|credentials?)\b|(?:^|[\s"'(])\.env\b|~\//i;
const PIPE_TO_SHELL_RE = /\|\s*(?:sudo\s+)?(?:sh|bash|zsh|powershell|pwsh|iex)\b/i;
/*
 * ATO-1649: more ways to say the same thing. A URL without `https://` counts
 * as a target (bare-host.ts), and so do installer words and package files.
 * "download and run" is both signals in one phrase; `bash a.sh` and
 * `./a.sh` are run words. Pipes also catch `| sudo -E bash`, `| /bin/sh`,
 * `| dash`, a download piped into python, node, perl, ruby or php (as the
 * shell guard's `curl_pipe_sh`), and process substitution:
 * `bash <(curl …)`, `sh -c "$(curl …)"`, `source <(wget …)`, `eval "$(curl …)"`
 * (the shell guard's `curl_process_substitution`).
 */
const SCRIPT_EXTRA_RE = /\b(?:setup\s+(?:file|program|wizard|script|package)|install(?:ation)?\s+(?:file|package|program))\b|\.(?:deb|rpm|apk|ipa|msix|appx|vbs|scr|command|xpi|crx)\b/i;
const EXECUTE_EXTRA_RE = /\b(?:run|start|launch) the setup\b|\b(?:open|start|launch|double[- ]click) (?:the )?(?:installer|setup(?: file| program)?|package)\b|\bdouble[- ]click (?:it|them|this|that)\b|\b(?:ba|z|k|da)?sh\s+(?:-\S+\s+){0,2}[^\s|;&]*\.(?:sh|bash|zsh)\b|\bsource\s+[^\s|;&]+\.(?:sh|bash|zsh)\b|(?:^|[\s;&("'`])\.\/[\w.-]+\.(?:sh|bash|zsh|run|bin|appimage|command)\b/i;
const DOWNLOAD_AND_RUN_RE = /\b(?:download|grab)(?:\s*,\s*|\s+(?:and|&|then|and then)\s+)(?:run|execute|launch|install)\b/i;
const PIPE_TO_SHELL_EXTRA_RE = /\|\s*(?:sudo\s+(?:-\S+\s+){1,4})?(?:(?:\/usr)?\/bin\/)?(?:sh|bash|zsh|ksh|dash|powershell|pwsh)\b/i;
const FETCH_PIPE_INTERPRETER_RE = /\b(?:curl|wget)\b[^|]{0,300}\|\s*(?:sudo\s+(?:-\S+\s+){0,4})?(?:python[0-9.]*|node|perl|ruby|php)(?![\w.-])(?!\s+-m\b)/i;
const FETCH_SUBSTITUTION_RE = /(?:\b(?:ba|z|k|da)?sh|\bsource|\beval|(?:^|\s)\.)\s+(?:-\S+\s+){0,3}["']?(?:<\s*)?(?:<\(|\$\(|`)\s*(?:curl|wget)\b/i;
/*
 * Installing a package by name runs code someone else published (a typo
 * name is enough). Caution, not dangerous: plenty of honest tasks do it.
 * A bare `npm install` (the project's own dependencies) and
 * `pip install -r requirements.txt` stay ok.
 */
const PACKAGE_INSTALL_RE = /\b(?:(?:pip[0-9.]*|pipx|uv\s+pip|conda|mamba|npm|gem|cargo|brew|apt(?:-get)?|dnf|yum|winget|choco|scoop|go)\s+install|npm\s+i|(?:yarn|pnpm|bun|poetry|uv)\s+(?:global\s+)?add|pacman\s+-S|npx|uvx|bunx|pnpm\s+dlx|pipx\s+run)\s+(?:-(?![re]\b)\S+\s+){0,3}(?!-[re]\b)(?!(?:and|then|to|in|for|with|from|the|it|on|all|deps|dependencies)\b)[\w@~+.:\/-]/i;

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function findingAt(rule: string, file: string, text: string, index: number, severity: RecipeFinding["severity"] = "dangerous"): RecipeFinding {
  const line = lineOf(text, index);
  const trimmed = (text.split("\n")[line - 1] ?? "").trim();
  return {
    severity,
    rule,
    file,
    line,
    excerpt: trimmed.length <= 160 ? trimmed : `${trimmed.slice(0, 159)}…`,
  };
}

function scanPlainLanguage(file: string, text: string): RecipeFinding[] {
  const out: RecipeFinding[] = [];
  // Matching is done on the raw text with \s, which already spans newlines,
  // so line numbers stay true to what the person sees.
  const pipe = PIPE_TO_SHELL_RE.exec(text)
    ?? PIPE_TO_SHELL_EXTRA_RE.exec(text)
    ?? FETCH_PIPE_INTERPRETER_RE.exec(text)
    ?? FETCH_SUBSTITUTION_RE.exec(text);
  if (pipe) out.push(findingAt("pipe-to-shell", file, text, pipe.index));
  // Both rules below need two or three signals, so a plain `attacker.com`
  // (hasHostName, looser than hasBareHost) counts as their host.
  const hostName = hasHostName(text);
  const target = URL_RE.test(text) || SCRIPT_RE.test(text) || SCRIPT_EXTRA_RE.test(text) || hostName;
  const download = DOWNLOAD_RE.exec(text);
  const downloadAndRun = DOWNLOAD_AND_RUN_RE.exec(text);
  if (downloadAndRun) out.push(findingAt("download-and-run", file, text, downloadAndRun.index));
  else if (download && target && (EXECUTE_RE.test(text) || EXECUTE_EXTRA_RE.test(text))) {
    out.push(findingAt("download-and-run", file, text, download.index));
  }
  const send = SEND_RE.exec(text);
  if (send && PRIVATE_DATA_RE.test(text) && (URL_RE.test(text) || EMAIL_RE.test(text) || hostName)) {
    out.push(findingAt("send-out-data", file, text, send.index));
  }
  const pkg = PACKAGE_INSTALL_RE.exec(text);
  if (pkg) out.push(findingAt("package-install", file, text, pkg.index, "caution"));
  return out;
}

/* Plain-English lines for the findings, grouped so each shows once. */
const RULE_SENTENCES: Array<[readonly string[], string]> = [
  [["hidden-characters"], "Holds invisible characters, so the text may not say what it shows."],
  [["remote-exec", "decode-exec", "eval", "pipe-to-shell", "download-and-run"], "Asks the agent to download or build code and run it."],
  [["secret-exfil", "secret-and-network", "credential-read", "image-url-leak", "send-out-data"], "Asks the agent to read keys or passwords, or to send data to a web address."],
  [["recursive-delete", "disk-wipe", "fork-bomb", "chmod-root", "history-wipe"], "Asks the agent to delete files, wipe a disk or damage the system."],
  [["prompt-injection", "prompt-override", "hide-from-user", "approval-bypass"], "Tries to change the agent's rules, skip approvals or hide steps from you."],
  [["network-fetch", "netcat"], "Asks the agent to fetch from or connect to the internet."],
  [["package-install"], "Asks the agent to install a package or tool by name."],
];

/** Check one recipe. Pure: no I/O, never throws on a parsed recipe. */
export function checkRecipe(recipe: Recipe): RecipeCheckResult {
  const texts = recipeTexts(recipe);
  const findings: RecipeFinding[] = [];
  for (const [file, text] of texts) {
    const hidden = findHiddenCharacters(text);
    for (const h of hidden) {
      findings.push({
        severity: "dangerous",
        rule: "hidden-characters",
        file,
        line: h.line,
        excerpt: `${h.codePoint} at column ${h.column}`,
      });
    }
  }
  findings.push(...scanSkillFiles(texts.map(([path, content]) => ({ path, content }))).findings);
  // A command split between the text and a default (`Run {{x}} | sh` with x
  // = `curl https://…`) only shows once they are put together.
  if (recipe.params.some((p) => p.default !== undefined)) {
    const seen = new Set(findings.map((f) => f.rule));
    const joined = scanSkillFiles([{ path: "prompt with defaults", content: renderRecipePrompt(recipe) }]).findings;
    findings.push(...joined.filter((f) => !seen.has(f.rule)));
  }
  for (const [file, text] of texts) findings.push(...scanPromptRules(file, text));
  for (const [file, text] of texts) {
    for (const f of scanPlainLanguage(file, text)) {
      // `curl … | sh` on one line is already a remote-exec finding there.
      const dup = f.rule === "pipe-to-shell" && findings.some((g) => g.rule === "remote-exec" && g.file === f.file && g.line === f.line);
      if (!dup) findings.push(f);
    }
  }
  if (recipe.params.some((p) => p.default !== undefined)) {
    const seen = new Set(findings.map((f) => f.rule));
    findings.push(...scanPlainLanguage("prompt with defaults", renderRecipePrompt(recipe)).filter((f) => !seen.has(f.rule)));
  }
  const verdict: SkillScanVerdict = findings.some((f) => f.severity === "dangerous")
    ? "dangerous"
    : findings.length > 0 ? "caution" : "ok";
  return {
    verdict,
    findings,
    scanId: recipeScanIdOf(recipe, verdict, findings),
    willDo: willDoLines(recipe, findings),
    note: verdict === "ok" ? RECIPE_CHECK_NOTE_OK : RECIPE_CHECK_NOTE_FLAGGED,
  };
}

function scanPromptRules(file: string, text: string): RecipeFinding[] {
  const out: RecipeFinding[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const rule of PROMPT_RULES) {
      if (!rule.pattern.test(line)) continue;
      const trimmed = line.trim();
      out.push({
        severity: rule.severity,
        rule: rule.rule,
        file,
        line: i + 1,
        excerpt: trimmed.length <= 160 ? trimmed : `${trimmed.slice(0, 159)}…`,
      });
    }
  }
  return out;
}

function willDoLines(recipe: Recipe, findings: readonly RecipeFinding[]): string[] {
  const lines = ["Puts this text into a new chat. You send it yourself."];
  const asks = recipePlaceholders(recipe.prompt).map((k) => k.replace(/_/g, " "));
  if (asks.length > 0) lines.push(`Asks you for: ${asks.join(", ")}`);
  lines.push("Does not choose the model, tools, servers, skills or permissions: your own settings apply.");
  const rules = new Set(findings.map((f) => f.rule));
  for (const [group, sentence] of RULE_SENTENCES) {
    if (group.some((r) => rules.has(r))) lines.push(sentence);
  }
  return lines;
}

/**
 * Like the skill hub's `scanIdOf`, plus the recipe itself: a skill's id
 * changes with its folder through the findings, but a clean recipe has no
 * findings, so its text goes into the hash too.
 */
export function recipeScanIdOf(recipe: Recipe, verdict: SkillScanVerdict, findings: readonly RecipeFinding[]): string {
  const canonical = JSON.stringify({
    recipe: [recipe.version, recipe.title, recipe.description ?? "", recipe.prompt, recipe.params.map((p) => [p.key, p.default ?? null, p.description ?? ""])],
    verdict,
    findings: findings.map((f) => [f.severity, f.rule, f.file, f.line, f.excerpt]),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}
