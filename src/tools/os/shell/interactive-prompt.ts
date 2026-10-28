/**
 * Commands that wait for a person (ATO-1252).
 *
 * `os.shell.run` gives a command no terminal and an already-closed
 * stdin, so most prompts end at once on EOF. Two kinds do not:
 *
 *  - a sign-in that waits for the user somewhere else — a device code
 *    to enter on a web page, a browser consent page whose callback the
 *    command listens for. These sit quietly until the turn's timeout;
 *  - a prompt that keeps waiting on input that never comes (a pager, a
 *    "Press any key" loop, a question repeated after EOF).
 *
 * And some fail fast but say so in a way a model reads as "I cannot do
 * this": `sudo` with no terminal, `docker run -it`, a password prompt.
 *
 * Each match carries one line for the user — what the step needs from
 * them — so the agent hands over exactly that step instead of the whole
 * install. Patterns are matched against the END of the output only: a
 * build log that mentions a password three screens up is not a prompt.
 */

export type InteractivePromptKind =
  /** The command waits for the user to finish a sign-in in a browser. */
  | "sign_in"
  /** The command needs a password, a terminal, or an answer typed in one. */
  | "needs_input";

export interface InteractivePrompt {
  kind: InteractivePromptKind;
  /** What the step needs from the user, in one line. */
  need: string;
  /** A sign-in URL the output printed, if any. */
  url?: string;
  /** A device / one-time code the output printed, if any. */
  code?: string;
}

/** How much of the end of the output is looked at. */
const TAIL_CHARS = 1_500;

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/;

/**
 * A device code: `ABCD-1234`, `WDJB-MJHT`, 8–9 characters with a dash.
 * Read only from a line that also says "code", so a version number or a
 * hash in a log is never picked up.
 */
const DEVICE_CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4,5})\b/;

interface PromptPattern {
  kind: InteractivePromptKind;
  re: RegExp;
  need: string;
  /**
   * `running`: a still-running command that went quiet on this is
   * waiting for a person. `exited`: only a command that already failed
   * with it is read as one (a "not a tty" warning mid-build is not).
   * `last_line`: matched against the final line only.
   */
  when: "running" | "exited" | "both";
  lastLine?: boolean;
}

/** Checked in order; the first match wins. */
const PATTERNS: readonly PromptPattern[] = [
  {
    kind: "needs_input",
    re: /sudo: (?:a terminal is required|a password is required|no tty present)|sudo: \d+ incorrect password|\[sudo\] password for /i,
    need: "it runs with sudo and needs your computer password — run it in your own terminal",
    when: "exited",
  },
  {
    kind: "sign_in",
    re: /(?:one[- ]time code|device code|user code|enter (?:the |this )?code|verification (?:code|ur[il]))|\/login\/device\b|\/device\b.*\bcode\b/i,
    need: "it needs you to sign in: open the link and enter the code",
    when: "running",
  },
  {
    kind: "sign_in",
    re: /(?:authori[sz]|authenticat|sign[- ]?in|log[- ]?in|consent|oauth)[^\n]*(?:browser|https?:\/\/)|(?:browser|https?:\/\/)[^\n]*(?:authori[sz]|authenticat|sign[- ]?in|log[- ]?in|consent|oauth)|waiting for (?:the )?(?:authenti[cz]ation|authori[sz]ation|oauth|callback|sign[- ]?in|login|browser)/i,
    need: "it needs you to sign in in the browser it opened",
    when: "running",
  },
  {
    kind: "needs_input",
    re: /the input device is not a tty|not a tty|stdin is not a (?:tty|terminal)|inappropriate ioctl for device|must be run (?:from|in) a terminal|requires an interactive (?:terminal|shell)|no tty available|cannot prompt|non-?interactive mode/i,
    need: "it needs a real terminal to ask you something — run it in your own terminal",
    when: "exited",
  },
  {
    kind: "needs_input",
    re: /(?:password|passphrase|passcode|pin)(?: for [^\n:]{1,80})?:\s*$/i,
    need: "it asks for a password — run it in your own terminal",
    when: "both",
    lastLine: true,
  },
  {
    kind: "needs_input",
    re: /(?:press (?:any key|enter|return)\b[^\n]*|\[(?:y\/n|yes\/no)\]\s*[?:]?\s*|\((?:y\/n|yes\/no)\)\s*[?:]?\s*|\?\s*)$/i,
    need: "it stopped at a question that needs your answer — pass a flag that answers it (e.g. --yes) if one fits, otherwise ask the user to run it in their own terminal",
    when: "running",
    lastLine: true,
  },
];

/**
 * Whether the end of `output` shows a command waiting for a person:
 * `state: "running"` for one that is still running and went quiet,
 * `"exited"` for one that already failed.
 */
export function detectInteractivePrompt(
  output: string,
  state: "running" | "exited",
): InteractivePrompt | null {
  const tail = output.slice(-TAIL_CHARS).replace(/\r/g, "\n").trimEnd();
  if (tail.length === 0) return null;
  const lastLines = tail.split("\n").slice(-12).join("\n");
  for (const pattern of PATTERNS) {
    if (pattern.when !== "both" && pattern.when !== state) continue;
    const subject = pattern.lastLine === true ? lastLine(lastLines) : lastLines;
    if (!pattern.re.test(subject)) continue;
    const found: InteractivePrompt = { kind: pattern.kind, need: pattern.need };
    if (pattern.kind === "sign_in") {
      const url = lastLines.match(URL_RE)?.[0];
      if (url !== undefined) found.url = url.replace(/[.,;:]+$/, "");
      const codeLine = lastLines
        .split("\n")
        .find((line) => /code/i.test(line) && DEVICE_CODE_RE.test(line));
      const code = codeLine?.match(DEVICE_CODE_RE)?.[1];
      if (code !== undefined) found.code = code;
    }
    return found;
  }
  return null;
}

function lastLine(text: string): string {
  const lines = text.split("\n");
  return lines[lines.length - 1] ?? "";
}

/**
 * The handoff line placed at the top of the result: what the step needs
 * and what the agent should do next. Worded for the model, which relays
 * the need to the user — never "run these steps", only this one.
 */
export function formatInteractiveHandoff(
  prompt: InteractivePrompt,
  commandLine: string,
  outcome: { jobId: number } | { ended: "stopped" | "failed" },
): string {
  const parts = [`this step needs the user: ${prompt.need}`];
  if (prompt.url !== undefined) parts.push(`link: ${prompt.url}`);
  if (prompt.code !== undefined) parts.push(`code: ${prompt.code}`);
  if ("jobId" in outcome) {
    const { jobId } = outcome;
    parts.push(
      `the command is still waiting as job ${jobId} (kept) — reply with the link${prompt.code !== undefined ? " and code" : ""} and ask the user to finish there, then os.shell.run {"wait": ${jobId}} to see it complete; do not start it again`,
    );
  } else {
    parts.push(
      `the command ${outcome.ended === "stopped" ? "was stopped" : "failed"} — hand the user only this one step (\`${headOf(commandLine)}\`), keep doing every other step yourself, and continue once they confirm`,
    );
  }
  return parts.join("; ");
}

function headOf(commandLine: string, max = 120): string {
  const line = commandLine.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
