/**
 * Atomic Chat Core is the default local engine, and with it selected a failed
 * Core install or start leaves no local engine at all: the agent has no
 * automatic fallback (src/local-llm/core/core-state.ts). Every such failure
 * the agent reports ends with its retry hint, and its structured
 * CoreUnavailableError names a stage (download | verify | backend | start).
 *
 * The desktop reads that text, wherever a start, an install or a switch came
 * back with it, and turns it into one plain sentence for the recovery card
 * ("The local engine isn't ready", with Download again). llama.cpp is never
 * offered in the app: it stays a support-only CLI command.
 * Text, not a type: it crosses a process boundary as stderr, and the window
 * must not be left on a spinner because a field it waited for never came.
 */

/** The agent's retry hint, printed at the end of every Core failure (CORE_RETRY_HINT). */
export const CORE_RETRY = "Retry with: atomic-agent models update";
/* Every hint the agent ends a Core failure with: the retry
   (src/local-llm/core/core-errors.ts), and the older wordings still accepted
   from earlier agents (the llama.cpp way back, and the Core 0.11 one). */
const CORE_HINTS = [
  CORE_RETRY,
  "Or use llama.cpp: atomic-agent models engine llama-server",
  "Switch back with: atomic-agent models engine llama-server",
];

/* The agent's CoreUnavailableError sentences, one per stage
   (STAGE_TEXT in src/local-llm/core/core-errors.ts). */
const STAGE_SENTENCES: ReadonlyArray<[RegExp, "download" | "verify" | "backend" | "start"]> = [
  [/The Atomic Chat engine could not be downloaded/i, "download"],
  [/The downloaded Atomic Chat engine did not pass verification/i, "verify"],
  [/Atomic Chat could not install its inference backend/i, "backend"],
  [/The Atomic Chat engine could not start/i, "start"],
];

export type EngineFailureStage = "download" | "verify" | "backend" | "blocked" | "start";
export interface EngineFailure {
  stage: EngineFailureStage;
  /** One plain sentence: why the engine is not ready. */
  why: string;
  /** The agent's first line, without the hint, for the log and a tooltip. */
  detail: string;
}

const WHY: Record<EngineFailureStage, string> = {
  download: "The engine download failed. Check your connection and try again.",
  verify: "The downloaded engine did not pass its safety check, so it was not installed.",
  backend: "The engine could not get the parts it needs for this computer.",
  blocked: "This computer blocked the engine from running.",
  start: "The engine could not start on this computer.",
};

/* Not failures: a precondition the person resolves (stop the models first),
   or a stop on purpose. Neither earns the recovery card. */
const NOT_A_FAILURE = /Stop local models before (?:updating|switching) the engine|was stopped before it finished|was cancelled|AbortError/i;

/**
 * The engine failure a piece of agent output describes, or null. Only Core's
 * own failures count: its retry hint (or an older hint), one of its stage
 * sentences, or a line naming Atomic Core.
 */
export function engineFailureIn(text: string | null | undefined): EngineFailure | null {
  const all = String(text ?? "");
  if (!all.trim()) return null;
  const hintAt = CORE_HINTS.map((h) => all.indexOf(h)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (hintAt === undefined && !STAGE_SENTENCES.some(([re]) => re.test(all))
    && !/Atomic (?:Chat )?Core|atomic-chat-core|CoreUnavailable/i.test(all)) return null;
  if (NOT_A_FAILURE.test(all)) return null;
  const stage = stageOf(all);
  const detail = (hintAt === undefined ? all : all.slice(0, hintAt))
    // The agent's own sentence: not a stack frame, not a progress bar line, not the update's "current → latest".
    .split(/\r?\n/).map((l) => l.trim()).reverse().find((l) => l && !/^at\s/.test(l) && !/^\[[= ]*\]/.test(l) && !/^current: /.test(l)) ?? "";
  return { stage, why: WHY[stage], detail: detail.replace(/\s*\(TUI:[^)]*\)\.?\s*$/, "").slice(0, 300) };
}

function stageOf(text: string): EngineFailureStage {
  // The structured error says its stage outright; take it when it is there.
  const named = /\bstage[\s:="']+(download|verify|backend|start)\b/i.exec(text)?.[1]?.toLowerCase();
  // Blocked first: a download or start the OS refused is that, whatever stage it was in.
  if (/\bEACCES\b|\bEPERM\b|not permitted|permission denied|quarantin|code signature|signature is invalid|SmartScreen|antivirus|blocked|killed: 9|SIGKILL/i.test(text)) return "blocked";
  if (named) return named as EngineFailureStage;
  // The agent's own stage sentence says it next: "could not start: fetch failed" is a start.
  const said = STAGE_SENTENCES.find(([re]) => re.test(text))?.[1];
  if (said) return said;
  if (/failed checksum verification|checksum mismatch|does not match its release|did not pass verification/i.test(text)) return "verify";
  if (/no compatible inference backend|installed a backend without|invalid backend selection|could not install its inference backend/i.test(text)) return "backend";
  if (/download|fetch|network|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|offline|\(\d{3}\)/i.test(text)) return "download";
  return "start";
}

/**
 * The failure in an IPC answer: the strings a result carries (`error`,
 * `stderr`, `refusal`, a switch's `daemonLine`), one level deep. Anything
 * else in it is not read.
 */
export function engineFailureOf(value: unknown): EngineFailure | null {
  if (!value || typeof value !== "object") return typeof value === "string" ? engineFailureIn(value) : null;
  const v = value as Record<string, unknown>;
  if (v["ok"] === true && v["daemon"] !== "start-failed") return null;
  const said = ["error", "stderr", "refusal", "daemonLine", "daemonError"]
    .map((k) => v[k]).filter((s): s is string => typeof s === "string" && s.length > 0);
  return said.length ? engineFailureIn(said.join("\n")) : null;
}
