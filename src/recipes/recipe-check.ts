import { createHash } from "node:crypto";

import {
  scanSkillFiles,
  type SkillScanFinding,
  type SkillScanVerdict,
} from "../skills/hub/skill-security-scanner.js";
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
 * Like the skill scan it is a best-effort tripwire, not a guarantee; the
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
}

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

/* Plain-English lines for the findings, grouped so each shows once. */
const RULE_SENTENCES: Array<[readonly string[], string]> = [
  [["hidden-characters"], "Holds invisible characters, so the text may not say what it shows."],
  [["remote-exec", "decode-exec", "eval"], "Asks the agent to download or build code and run it."],
  [["secret-exfil", "secret-and-network", "credential-read", "image-url-leak"], "Asks the agent to read keys or passwords, or to send data to a web address."],
  [["recursive-delete", "disk-wipe", "fork-bomb", "chmod-root", "history-wipe"], "Asks the agent to delete files, wipe a disk or damage the system."],
  [["prompt-injection", "prompt-override", "hide-from-user", "approval-bypass"], "Tries to change the agent's rules, skip approvals or hide steps from you."],
  [["network-fetch", "netcat"], "Asks the agent to fetch from or connect to the internet."],
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
  const verdict: SkillScanVerdict = findings.some((f) => f.severity === "dangerous")
    ? "dangerous"
    : findings.length > 0 ? "caution" : "ok";
  return { verdict, findings, scanId: recipeScanIdOf(recipe, verdict, findings), willDo: willDoLines(recipe, findings) };
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
