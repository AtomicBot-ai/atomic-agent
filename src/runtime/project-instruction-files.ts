import { readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readWorkspaceFile, isWithinWorkspace } from "../skills/workspace-files.js";

/**
 * Which files count as project instructions, and how they rank: names,
 * scopes, priorities, Cursor rules, `@path` imports and the credential guard.
 * The loader in project-instructions.ts decides what is read and when.
 */
export const rootNames = ["AGENTS.md", "AGENT.md", "CLAUDE.md", ".claude/CLAUDE.md"];
/** Rules written for other tools: root only, lowest priority, never expanded for imports. */
export const foreignRootNames = ["GEMINI.md", ".cursorrules", ".github/copilot-instructions.md"];
export const cursorRulesDir = ".cursor/rules";
/** Only this many Cursor rule files (sorted by name) are considered, so a large folder stays bounded. */
const maxCursorRules = 16;
const FOREIGN_PRIORITY = 0;

/**
 * Imports never pull credentials into the prompt, ignored by Git or not.
 * Names: dotenv and direnv files, package/registry/database logins, kubeconfig,
 * `secrets.*`, private keys and keystores, Terraform variables and state.
 * Service-account keys are matched by a name containing "service account"
 * (`service-account.json`, `firebase-serviceAccountKey.json`); a broader
 * suffix such as `*-sa.json` would also hit ordinary data files.
 */
const sensitiveName = /^(\.env(\..*)?|\.envrc|\.npmrc|\.netrc|\.pgpass|\.pypirc|\.git-credentials|\.htpasswd|credentials\.json|application_default_credentials\.json|kubeconfig(\..*)?|\.?secrets(\..*)?|.*service[-_.]?account.*\.json|id_(rsa|dsa|ecdsa|ed25519)(\..*)?|.*\.(pem|key|p12|pfx|jks|keystore|tfvars|tfstate|kdbx)(\.backup)?)$/i;
/** Folders whose every file is a credential or key: AWS, SSH, Kubernetes, GnuPG. */
const sensitiveDirs = new Set([".aws", ".ssh", ".kube", ".gnupg"]);

/** True for a workspace-relative path (forward slashes) that an instruction import must never read. */
export function isSensitive(relPath: string): boolean {
  const parts = relPath.split("/");
  return sensitiveName.test(parts[parts.length - 1]!) || parts.some(part => sensitiveDirs.has(part))
    || relPath === ".docker/config.json" || relPath.endsWith("/.docker/config.json");
}

/** Root-relative path with forward slashes. */
export function slashed(path: string): string { return path.split("\\").join("/"); }

export function isCursorRule(path: string): boolean {
  const parts = slashed(path).split("/");
  return parts.length >= 3 && parts.slice(-3, -1).join("/") === cursorRulesDir;
}

export function isForeign(path: string): boolean {
  return foreignRootNames.includes(slashed(path)) || isCursorRule(path);
}

export function priorityOf(path: string): number {
  if (isForeign(path)) return FOREIGN_PRIORITY;
  return basename(path) === "AGENTS.md" ? 4 : basename(path) === "AGENT.md" ? 3 : basename(dirname(path)) === ".claude" ? 1 : 2;
}

/**
 * Order of a workspace-relative scope from most general to most specific:
 * folders above the workspace (`../..` before `..`), then the workspace
 * root `.`, then nested folders by depth.
 */
export function scopeRank(scope: string): number {
  const parts = slashed(scope).split("/");
  if (parts[0] === "..") return -parts.filter(part => part === "..").length;
  return scope === "." ? 0 : parts.length;
}

/**
 * Folders strictly above `root` up to and including `top` (the repository
 * top level), outermost first. Empty when `root` is the top or lies outside it.
 */
export function ancestorDirs(root: string, top: string): string[] {
  if (root === top || !isWithinWorkspace(top, root)) return [];
  const dirs: string[] = [];
  for (let dir = dirname(root); isWithinWorkspace(top, dir); dir = dirname(dir)) {
    dirs.unshift(dir);
    if (dir === top || dirname(dir) === dir) break;
  }
  return dirs;
}

/**
 * Top-level `.cursor/rules/*.mdc` and `*.md` files, sorted by name and capped.
 * The folder is listed only when it resolves inside the workspace. Rules that
 * are not always on are dropped here, so they never take a file slot from a
 * nested instruction file; the loader checks again on the real pass.
 */
export function listCursorRules(root: string, report: (category: string, item: string) => void): string[] {
  const dir = join(root, cursorRulesDir);
  let names: string[];
  try {
    const actual = realpathSync(dir);
    if (!isWithinWorkspace(root, actual) || !statSync(actual).isDirectory()) return [];
    names = readdirSync(actual).filter(name => /\.(mdc|md)$/i.test(name) && !name.startsWith(".")).sort();
  } catch { return []; }
  if (names.length > maxCursorRules) {
    for (const dropped of names.slice(maxCursorRules)) report(`Cursor rules exceed ${maxCursorRules} files; later files were not loaded`, `${cursorRulesDir}/${dropped}`);
    names = names.slice(0, maxCursorRules);
  }
  return names.map(name => `${cursorRulesDir}/${name}`).filter(path => {
    let file: { path: string; content: string } | null;
    // Unreadable or odd files stay in the list; the loader reports them.
    try { file = readWorkspaceFile(root, join(root, path)); } catch { return true; }
    if (!file || file.content.includes("\0") || cursorRuleAlwaysApplies(file.content)) return true;
    report("Skipped Cursor rules that apply only to matching files or on request", path);
    return false;
  });
}

/**
 * Cursor applies a rule on every request only with `alwaysApply: true`; rules
 * scoped by `globs`, chosen by `description` or attached by hand are not
 * loaded. A plain file without frontmatter is treated as always on.
 */
export function cursorRuleAlwaysApplies(content: string): boolean {
  const match = /^\uFEFF?---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/.exec(content);
  if (!match) return true;
  return /^alwaysApply:\s*["']?true["']?\s*$/im.test(match[1] ?? "");
}

/** Cuts to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const cut = Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes)).toString("utf8");
  return cut.endsWith("\uFFFD") && !text.startsWith(cut) ? cut.slice(0, -1) : cut;
}

export function instructionImports(body: string): string[] {
  const plain: string[] = [];
  let fence: string | undefined;
  let indentedCode = false;
  let previousBlank = true;
  for (const line of body.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined; previousBlank = false; continue; }
    if (fence) continue;
    const blank = line.trim() === "";
    // An indented code block starts after a blank line and continues through blank lines.
    indentedCode = /^( {4}|\t)/.test(line) ? indentedCode || previousBlank : indentedCode && blank;
    previousBlank = blank;
    if (!indentedCode) plain.push(line);
  }
  const text = plain.join("\n").replace(/(`+)[\s\S]*?\1/g, "");
  return [...text.matchAll(/(?:^|[\s(])@((?:\\ |[^\s`"'<>])+)/g)].map(match => match[1]!.replace(/\\ /g, " ").replace(/[),;]+$/, ""));
}
