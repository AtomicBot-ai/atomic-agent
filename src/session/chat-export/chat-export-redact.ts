/**
 * Redaction for a chat that is about to leave the machine (ATO-581).
 *
 * The export already carries only what the two people said (user
 * messages and closing replies, `SessionStore.listChatLines`): no tool
 * results, no reasoning. This pass cleans the text itself:
 *
 * - credentials: the detector shared with tool output and error
 *   reporting (`src/error-reporting/secret-detector.ts`), with the
 *   exact values of the agent's own `.env`, then a looser layer for
 *   shapes that detector leaves alone (bot tokens, a short secret-named
 *   value). Over-masking a shared chat costs little; a leaked key costs
 *   a lot.
 * - local paths: any absolute path (the home folder, the project
 *   folder, `/Volumes/...`, `C:\Users\...`) becomes `[path]`. A path
 *   under the working directory keeps its tail as `<project>/src/x.ts`,
 *   so "I changed src/x.ts" still reads.
 * - who and where: emails, IPv4 addresses and URL query strings.
 * - reasoning that leaked into a reply as `<think>`, `<thinking>` or
 *   `<reasoning>` blocks.
 *
 * Pattern-based, so a best effort: the command shows the file before
 * any upload, and that look is the real gate.
 */

import {
  knownSecretsFromEnv,
  maskSecrets,
  type KnownSecret,
} from "../../error-reporting/secret-detector.js";

export interface ShareRedactionContext {
  /** `os.homedir()`. */
  homeDir: string;
  /** The session's working directory. */
  workingDir?: string;
  /** Exact secret values; defaults to the secret-named variables of `process.env`. */
  knownSecrets?: readonly KnownSecret[];
}

/** How many of each kind one pass replaced. */
export interface ShareRedactionCounts {
  secrets: number;
  paths: number;
  personal: number;
  reasoning: number;
}

export function emptyRedactionCounts(): ShareRedactionCounts {
  return { secrets: 0, paths: 0, personal: 0, reasoning: 0 };
}

export function addRedactionCounts(
  into: ShareRedactionCounts,
  more: ShareRedactionCounts,
): void {
  into.secrets += more.secrets;
  into.paths += more.paths;
  into.personal += more.personal;
  into.reasoning += more.reasoning;
}

const SECRET_MARK = "[secret]";
const PATH_MARK = "[path]";
const PROJECT_MARK = "<project>";

/** Not inside a marker an earlier pass already put there. */
const NOT_MARKER = String.raw`(?!\[redacted:|\[secret\])`;

/** Shapes the shared detector skips to keep false positives out of the model's view. */
const LOOSE_SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, SECRET_MARK],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, SECRET_MARK],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g, SECRET_MARK],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g, SECRET_MARK],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, SECRET_MARK],
  [/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g, SECRET_MARK],
  [/\bAKIA[0-9A-Z]{16}\b/g, SECRET_MARK],
  [new RegExp(String.raw`(\bbearer\s+)${NOT_MARKER}[A-Za-z0-9+/=._-]{16,}`, "gi"), `$1${SECRET_MARK}`],
  [
    new RegExp(
      String.raw`((?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["']?)${NOT_MARKER}[^\s"',}]{6,}`,
      "gi",
    ),
    `$1${SECRET_MARK}`,
  ],
  [/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${SECRET_MARK}@`],
];

const DETECTOR_MARKER = /\[redacted:[^\]]*\]/g;

const THINK_BLOCK = /<(think|thinking|reasoning)>[\s\S]*?(?:<\/\1>|$)/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const URL_QUERY = /(https?:\/\/[^\s?#"'<>]+)\?[^\s"'<>)]*/g;
/** `~/...` and `~` itself followed by a path. */
const TILDE_PATH = /(?<![\w/])~(?:[\\/][^\s\\/"'`:)\]>,]+)+/g;
/**
 * Any absolute path of two or more segments that is not a URL or the
 * project marker: `/Users/x/y`, `/opt/app/conf`, `C:\Users\x`, `\\host\share\x`.
 */
const ABSOLUTE_PATH =
  /(?<![\w<>~/.:\\\]])(?:[A-Za-z]:|\\(?=\\))?(?:[\\/][^\s\\/"'`:)\]>,]+){2,}/g;

/** One message's text, cleaned for sharing, plus what was replaced. */
export function redactForShare(
  text: string,
  ctx: ShareRedactionContext,
): { text: string; counts: ShareRedactionCounts } {
  const counts = emptyRedactionCounts();
  let out = text.replace(THINK_BLOCK, () => {
    counts.reasoning += 1;
    return "";
  });

  out = maskSecrets(out, ctx.knownSecrets ?? knownSecretsFromEnv());
  out = out.replace(DETECTOR_MARKER, () => {
    counts.secrets += 1;
    return SECRET_MARK;
  });
  for (const [pattern, replacement] of LOOSE_SECRET_PATTERNS) {
    out = out.replace(pattern, (...args: unknown[]) => {
      counts.secrets += 1;
      return expand(replacement, args);
    });
  }

  out = out.replace(URL_QUERY, (_m, base: string) => {
    counts.personal += 1;
    return `${base}?…`;
  });
  out = out.replace(EMAIL, () => {
    counts.personal += 1;
    return "[email]";
  });
  out = out.replace(IPV4, (ip) => {
    if (ip.startsWith("127.") || ip === "0.0.0.0") return ip;
    counts.personal += 1;
    return "[ip]";
  });

  const workingDir = ctx.workingDir ?? "";
  if (workingDir.length > 1 && !isHomeOrRoot(workingDir, ctx.homeDir)) {
    for (const form of pathForms(workingDir)) {
      out = replacePathPrefix(out, form, () => {
        counts.paths += 1;
        return PROJECT_MARK;
      });
    }
  }
  if (ctx.homeDir.length > 1) {
    for (const form of pathForms(ctx.homeDir)) {
      out = replacePathPrefix(out, form, () => {
        counts.paths += 1;
        return PATH_MARK;
      });
    }
  }
  out = out.replace(TILDE_PATH, () => {
    counts.paths += 1;
    return PATH_MARK;
  });
  out = out.replace(ABSOLUTE_PATH, () => {
    counts.paths += 1;
    return PATH_MARK;
  });
  // `[path]/rest` left over from a home prefix: the tail names folders too.
  out = out.replace(/\[path\](?:[\\/][^\s\\/"'`:)\]>,]+)+/g, PATH_MARK);

  return { text: out, counts };
}

/** `$1` in a replacement, for the callback form of `replace`. */
function expand(replacement: string, args: unknown[]): string {
  return replacement.replace(/\$(\d)/g, (_m, n: string) => {
    const group = args[Number(n)];
    return typeof group === "string" ? group : "";
  });
}

function pathForms(path: string): string[] {
  const forward = path.replace(/\\/g, "/");
  return forward === path ? [path] : [path, forward];
}

function isHomeOrRoot(dir: string, homeDir: string): boolean {
  const trimmed = dir.replace(/[\\/]+$/, "");
  return trimmed === "" || trimmed === homeDir.replace(/[\\/]+$/, "");
}

/**
 * Replace `prefix` only where it ends a path segment, so `/a/proj` does
 * not eat the front of `/a/proj-2/x`.
 */
function replacePathPrefix(
  text: string,
  prefix: string,
  replacement: () => string,
): string {
  if (!text.includes(prefix)) return text;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(
    new RegExp(`${escaped}(?=[\\/\\\\\\s"'\`:)\\]>,.]|$)`, "g"),
    replacement,
  );
}
