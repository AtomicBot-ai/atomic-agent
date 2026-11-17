/**
 * ATO-1014 — "Hand off to Claude Code / Codex", the way back from
 * handoff.ts (ATO-1156).
 *
 * A chat here hits a wall (the local model is not strong enough for this
 * step, say) and the person wants Claude Code or Codex to take it from
 * there. The brief is the agent's own `atag handoff --to` (ATO-1158,
 * src/cli/handoff-command.ts): a Markdown file with the task, what was done
 * and what is left. It never writes their session formats, and neither does
 * this file. Here we only build its argv, read the file it wrote, and offer
 * the next steps:
 *
 *   atag handoff --to <claude|codex> --session <chat id> --out <file>
 *     exit 0, stderr "Wrote the … handoff for chat <id> to <file>"
 *     exit 1, stderr "No Atomic Agent chat with id <id>."
 *     exit 2, stderr "unknown flag: --to" on an agent from before ATO-1158
 *
 * The file goes into the app's own folder (<userData>/handoffs), one per chat
 * and target, so a second hand-off of the same chat replaces the first.
 *
 * "Open in Terminal" types `claude "$(cat '<file>')"` into a new Terminal
 * window (terminal-open.ts; it types, never runs). Both CLIs take the first
 * prompt as an argument. Only the path we chose ourselves is in that line,
 * single-quoted, so nothing from the chat ever reaches the shell as code.
 *
 * Connected to an agent on another computer, the chat lives in THAT
 * computer's database, which this computer's `atag` cannot read — refused
 * in words, as handoff.ts does.
 *
 * No Electron import: main.ts passes ipcMain, the runner and shell in, so the
 * unit tests (test/handoff-out.test.mjs) drive it as plain Node.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export type HandoffOutTarget = "claude" | "codex";
export const HANDOFF_OUT_TARGETS: readonly HandoffOutTarget[] = ["claude", "codex"];
export const HANDOFF_OUT_LABELS: Record<HandoffOutTarget, string> = { claude: "Claude Code", codex: "Codex" };

/** Said when the app runs chats on another computer. */
export const HANDOFF_OUT_REMOTE =
  "This app is connected to an agent on another computer. Hand the chat off there with atag handoff --to.";
/** Said by an agent from before `atag handoff --to`. */
export const HANDOFF_OUT_TOO_OLD = "This agent version cannot hand a chat to Claude Code or Codex. Update Atomic Agent.";

/** The same id rule as handoff.ts: no leading dash, no spaces, no quotes. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
/** Over this the brief is too long to pass as one argument (macOS ARG_MAX is 1 MB with the environment). */
export const TERMINAL_BRIEF_MAX_BYTES = 200 * 1024;
/** Kept for the renderer's Copy; a brief is a few KB, this only stops a runaway file. */
const BRIEF_MAX_BYTES = 4 * 1024 * 1024;
const PREVIEW_CHARS = 1200;

type Failure = { ok: false; error: string };

export function isHandoffOutTarget(value: unknown): value is HandoffOutTarget {
  return typeof value === "string" && (HANDOFF_OUT_TARGETS as readonly string[]).includes(value);
}

export function isHandoffChatId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

/** `<dir>/<chat id>-<target>.md`; a colon in the id (`hermes:2026…`) becomes `_`. */
export function handoffOutFile(dir: string, to: HandoffOutTarget, sessionId: string): string {
  return join(dir, `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}-${to}.md`);
}

export function handoffOutArgs(to: unknown, sessionId: unknown, outFile: unknown): { ok: true; args: string[] } | Failure {
  if (!isHandoffOutTarget(to)) return { ok: false, error: "target must be claude or codex" };
  if (!isHandoffChatId(sessionId)) return { ok: false, error: "chat id is not valid" };
  if (typeof outFile !== "string" || !isAbsolute(outFile) || /[\n\r\0]/.test(outFile)) {
    return { ok: false, error: "the brief file path is not valid" };
  }
  return { ok: true, args: ["handoff", "--to", to, "--session", sessionId, "--out", outFile] };
}

/** POSIX single quotes: the only character to escape inside them is the quote itself. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The line typed into Terminal: the CLI with the brief as its first prompt. */
export function handoffTerminalCommand(to: HandoffOutTarget, file: string): string {
  return `${to} "$(cat ${shellQuote(file)})"`;
}

/** The chat's folder, from the brief's own "- Folder: `…`" line (handoff-export.ts). */
export function briefFolder(brief: string): string | null {
  const m = /^- Folder: `([^`\n]+)`$/m.exec(brief);
  return m ? m[1]! : null;
}

export interface HandoffOutDone {
  ok: true;
  to: HandoffOutTarget;
  label: string;
  path: string;
  brief: string;
  preview: string;
  folder: string | null;
  /** Null off macOS (terminal-open.ts is macOS only) or for a brief too long for one argument. */
  terminal: { command: string; cwd: string | null } | null;
}

type CliRes = { ok: boolean; stdout: string; stderr: string; error?: string };

/** An agent without `--to` says "unknown flag: --to"; one without `handoff` at all, "unknown command". */
function tooOld(res: CliRes): boolean {
  const text = `${res.stdout}\n${res.stderr}\n${res.error ?? ""}`;
  return /unknown command[:\s]+handoff/i.test(text) || /unknown flag:\s*--to\b/i.test(text);
}

/** The run's answer plus the file it wrote (null when unreadable) → what the sheet shows. */
export function parseHandoffOut(
  res: CliRes,
  input: { to: HandoffOutTarget; path: string; brief: string | null; platform: NodeJS.Platform },
): HandoffOutDone | Failure {
  if (tooOld(res)) return { ok: false, error: HANDOFF_OUT_TOO_OLD };
  if (!res.ok) {
    const said = res.stderr.trim().split("\n").filter(Boolean).at(-1);
    return { ok: false, error: said || res.error || "the handoff failed" };
  }
  const brief = input.brief;
  if (brief === null || brief.trim() === "") return { ok: false, error: "the agent did not write the brief" };
  const folder = briefFolder(brief);
  const fits = Buffer.byteLength(brief, "utf8") <= TERMINAL_BRIEF_MAX_BYTES;
  return {
    ok: true,
    to: input.to,
    label: HANDOFF_OUT_LABELS[input.to],
    path: input.path,
    brief,
    preview: brief.length > PREVIEW_CHARS ? `${brief.slice(0, PREVIEW_CHARS).trimEnd()}\n…` : brief,
    folder,
    terminal: input.platform === "darwin" && fits
      ? { command: handoffTerminalCommand(input.to, input.path), cwd: folder }
      : null,
  };
}

type Run = (args: string[], timeout: number) => Promise<CliRes>;

export interface HandoffOutDeps {
  run: Run;
  remote: () => boolean;
  /** The folder briefs go to, e.g. join(app.getPath("userData"), "handoffs"). */
  dir: () => string;
  platform: NodeJS.Platform;
  readFile?: (p: string) => string | null;
  mkdir?: (p: string) => void;
}

function readBrief(p: string): string | null {
  try {
    const text = readFileSync(p, "utf8");
    return Buffer.byteLength(text, "utf8") > BRIEF_MAX_BYTES ? null : text;
  } catch {
    return null;
  }
}

/** The files this run of the app wrote: Reveal shows only those. */
const written = new Set<string>();

export async function handoffOut(deps: HandoffOutDeps, to: unknown, sessionId: unknown): Promise<HandoffOutDone | Failure> {
  if (deps.remote()) return { ok: false, error: HANDOFF_OUT_REMOTE };
  if (!isHandoffOutTarget(to)) return { ok: false, error: "target must be claude or codex" };
  if (!isHandoffChatId(sessionId)) return { ok: false, error: "chat id is not valid" };
  const dir = deps.dir();
  const path = handoffOutFile(dir, to, sessionId);
  const built = handoffOutArgs(to, sessionId, path);
  if (!built.ok) return built;
  try {
    (deps.mkdir ?? ((p: string) => void mkdirSync(p, { recursive: true, mode: 0o700 })))(dir);
  } catch (err) {
    return { ok: false, error: `could not make the handoff folder: ${err instanceof Error ? err.message : String(err)}` };
  }
  const res = await deps.run(built.args, 60_000);
  const brief = res.ok ? (deps.readFile ?? readBrief)(path) : null;
  const out = parseHandoffOut(res, { to, path, brief, platform: deps.platform });
  if (out.ok) written.add(path);
  return out;
}

/** Reveal a brief in Finder / Explorer: only a file this app wrote. */
export function handoffReveal(reveal: (p: string) => void, p: unknown): { ok: true } | Failure {
  if (typeof p !== "string" || !written.has(p)) return { ok: false, error: "no such handoff file" };
  reveal(p);
  return { ok: true };
}

export interface HandoffOutIpc extends HandoffOutDeps {
  ipcMain: { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => void };
  reveal: (p: string) => void;
}

export function registerHandoffOutIpc(deps: HandoffOutIpc): void {
  deps.ipcMain.handle("cli:handoffTo", (_event, to, sessionId) => handoffOut(deps, to, sessionId));
  deps.ipcMain.handle("cli:handoffReveal", (_event, p) => handoffReveal(deps.reveal, p));
}
