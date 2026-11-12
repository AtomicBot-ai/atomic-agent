/**
 * What `atag data export-dataset` takes out of a chat before it writes it
 * to the training file (ATO-1104).
 *
 * The file is meant to leave the chat history and go somewhere else (a
 * fine-tuning run, a notebook, a friend), so it gets the strictest pass
 * the agent has:
 *
 *  1. The shared credential detector (`src/error-reporting/secret-detector.ts`,
 *     the one tool output and error reports use): vendor key shapes, PEM
 *     keys, bearer / basic / cookie headers, URL passwords, secret-named
 *     pairs and the exact values of the agent's own `.env`.
 *  2. A looser layer for the shapes that detector leaves alone to keep false
 *     positives out of the model's view: a digit-less `sk-` key, any
 *     three-part JWT, a short bearer token. The same list as the desktop's
 *     support report (`desktop/main/report-redact.ts`) and the TUI issue
 *     report (`src/tui/issue-report/redact.ts`); over-masking a training
 *     file costs a few words.
 *  3. Personal details: email addresses, and home folders (the user's own
 *     and any `/Users/<name>`, `/home/<name>`, `C:\Users\<name>`), which
 *     become `~`.
 *
 * Every replacement is counted by kind, so the command can say what it
 * took out. Pattern-based: a floor, not a promise, which is why the
 * command tells the user to read the file before sharing it.
 */

import {
  maskSecrets as maskSharedSecrets,
  redactedMarker,
  type KnownSecret,
} from "../../error-reporting/secret-detector.js";

export interface DatasetRedactionCounts {
  /** API keys, tokens, passwords and other credentials. */
  secrets: number;
  emails: number;
  /** Home folder paths turned into `~`. */
  homePaths: number;
}

export interface DatasetScrubber {
  scrub(text: string): string;
  /** What `scrub` has replaced so far, across every call. */
  readonly counts: Readonly<DatasetRedactionCounts>;
}

export interface DatasetScrubberOptions {
  /** `os.homedir()`. */
  homeDir: string;
  /** Exact secret values (the agent's `.env`, configured keys). */
  known?: readonly KnownSecret[];
}

const MARKER_PREFIX = "[redacted:";

/** Skips a marker an earlier rule already put there. */
const NOT_MARKER = String.raw`(?!\[redacted:)`;

/** The looser layer: each pattern and the label its marker carries. */
const LOOSE_SECRET_SHAPES: readonly (readonly [RegExp, string])[] = [
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "github-token"],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, "github-token"],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g, "api-key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "google-key"],
  [/\bhf_[A-Za-z0-9]{30,}\b/g, "hf-token"],
  [/\bxox[abeoprs]-[A-Za-z0-9-]{10,}\b/g, "slack-token"],
  [/(?<![0-9])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, "bot-token"],
  [
    /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
    "jwt",
  ],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "aws-access-key"],
];

/** `Authorization: Bearer x` and `Bearer x` anywhere: the scheme stays, the credential goes. */
const AUTHORIZATION = new RegExp(
  String.raw`(\bauthorization["']?[ \t]*[:=][ \t]*["']?(?:(?:bearer|basic|token)[ \t]+)?)${NOT_MARKER}([A-Za-z0-9+/=._~-]{8,})`,
  "gi",
);
/** Outside a header a bearer token needs a digit, so "Bearer authentication" stays prose. */
const BEARER = new RegExp(
  String.raw`(\bbearer[ \t]+)${NOT_MARKER}(?=[A-Za-z0-9+/=._~-]*\d)([A-Za-z0-9+/=._~-]{8,})`,
  "gi",
);

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
/**
 * Anyone's home folder under the common roots, not only the user's own.
 * Only where the path starts, so `/var/home/x` is not cut in the middle.
 */
const OTHER_HOMES = /(?<![A-Za-z0-9_.~-])(?:\/Users|\/home)\/[^/\s"'`]+/g;
/** The literal and the JSON-escaped Windows form. */
const WINDOWS_HOMES = /[A-Za-z]:(?:\\\\|\\)Users(?:\\\\|\\)[^\\\s"'`]+/g;

function countMarkers(text: string): number {
  let n = 0;
  for (let i = text.indexOf(MARKER_PREFIX); i !== -1; i = text.indexOf(MARKER_PREFIX, i + 1)) n++;
  return n;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `prefix` replaced only where it ends a path segment, so `/Users/v/proj`
 * does not eat the front of `/Users/v/proj-2`.
 */
function homePrefixPattern(prefix: string): RegExp | null {
  if (prefix.length <= 1) return null;
  return new RegExp(`${escapeRegExp(prefix)}(?=[\\\\/\\s"'\`:)\\]>,.]|$)`, "g");
}

export function createDatasetScrubber(options: DatasetScrubberOptions): DatasetScrubber {
  const known = options.known ?? [];
  const counts: DatasetRedactionCounts = { secrets: 0, emails: 0, homePaths: 0 };
  const homePatterns = [options.homeDir, options.homeDir.replace(/\\/g, "/")]
    .filter((p, i, all) => all.indexOf(p) === i)
    .map(homePrefixPattern)
    .filter((p): p is RegExp => p !== null);

  const replaceCounting = (
    text: string,
    pattern: RegExp,
    key: keyof DatasetRedactionCounts,
    replacement: (match: string, ...groups: string[]) => string,
  ): string =>
    text.replace(pattern, (match: string, ...groups: string[]) => {
      counts[key] += 1;
      return replacement(match, ...groups);
    });

  const scrub = (text: string): string => {
    if (!text) return text;
    const before = countMarkers(text);
    let out = maskSharedSecrets(text, known);
    counts.secrets += Math.max(0, countMarkers(out) - before);

    for (const [shape, label] of LOOSE_SECRET_SHAPES) {
      out = replaceCounting(out, shape, "secrets", () => redactedMarker(label));
    }
    out = replaceCounting(out, AUTHORIZATION, "secrets", (_m, head) => `${head}${redactedMarker("authorization")}`);
    out = replaceCounting(out, BEARER, "secrets", (_m, head) => `${head}${redactedMarker("bearer-token")}`);

    out = replaceCounting(out, EMAIL, "emails", () => "<email>");

    for (const pattern of homePatterns) out = replaceCounting(out, pattern, "homePaths", () => "~");
    out = replaceCounting(out, OTHER_HOMES, "homePaths", () => "~");
    out = replaceCounting(out, WINDOWS_HOMES, "homePaths", () => "~");
    return out;
  };

  return { scrub, counts };
}

/** The three counts added up. */
export function totalRedactions(counts: Readonly<DatasetRedactionCounts>): number {
  return counts.secrets + counts.emails + counts.homePaths;
}
