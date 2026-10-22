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
 *
 * Two refinements: a failure "Download again" cannot change (no space, an
 * unsupported computer, a version this app does not expect, no backend build
 * for this machine) says so and offers nothing (`retryable: false`); and a
 * start or install the app itself ended on its time limit while Core was
 * still downloading is a download that did not finish (`reason: incomplete`),
 * not a generic error.
 *
 * ATO-374: a model Core could not load (Core's MODEL_LOAD_FAILED, or the
 * model server's own "failed to load model") is not an engine problem either:
 * downloading the engine again changes nothing, so it reads as its own
 * sentence with no action (`reason: load`). And when the agent switched a
 * start to the CPU build because the GPU build could not serve the model
 * (today the managed llama.cpp start prints it; Core's own fallback is
 * ATO-344), the window says so in one line (CPU_FALLBACK_LINE).
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
/**
 * Why, when it changes what the card offers. The first four are the agent's
 * non-retryable reason codes (NOT_RETRYABLE in src/local-llm/core/core-errors.ts):
 * nothing "Download again" can change, so the card says so instead of offering
 * it. `incomplete`: a start or an install the app ended on its time limit
 * while Core was still downloading. `load`: Core is installed and running,
 * but the model itself did not load (ATO-374).
 */
export type EngineFailureReason = "unsupported" | "version" | "no_backend" | "disk" | "incomplete" | "load";
export interface EngineFailure {
  stage: EngineFailureStage;
  /** One plain sentence: why the engine is not ready. */
  why: string;
  /** The agent's first line, without the hint, for the log and a tooltip. */
  detail: string;
  /** Whether "Download again" can help. False: the card shows `why` alone. */
  retryable: boolean;
  reason?: EngineFailureReason;
  /** The agent had switched this start to the CPU build before it failed: the card adds CPU_FALLBACK_LINE. */
  cpuFallback?: boolean;
}

/** What the reader knows besides the text: `core`, the managed engine is Atomic Core. */
export interface EngineFailureContext {
  core?: boolean;
}

/** The one line for a start the agent moved to the CPU build (ATO-374, Nadya's wording). */
export const CPU_FALLBACK_LINE = "The model couldn't load on your graphics card. Switched to the CPU build, it will be slower.";
/* The agent's words when it moves a start to the CPU build: the managed
   llama.cpp start's "falling back to the CPU build" / "retrying start on the
   CPU build" (src/cli/models-handlers.ts), and the plainer "switched to the
   CPU build" a Core fallback (ATO-344) is expected to print. */
const CPU_FALLBACK = /falling back to the CPU build|retrying start on the CPU build|switch(?:ed|ing) to the CPU build/i;

/* A model Core is running but could not load: Core's error code, and the
   model server's own wordings (llama.cpp prints "failed to load model" and
   "error loading model"). Read only with Core in play: under llama.cpp the
   same words are the supervisor's business, not this card's. */
const MODEL_LOAD = /\bMODEL_LOAD_FAILED\b|failed to load (?:the )?model|(?:could not|couldn't|unable to) load (?:the )?model\b|error loading model|llama_model_load|model load(?:ing)? failed/i;
const WHY_LOAD = "The model couldn't load on this computer. Try a smaller model, or use a cloud model.";

const WHY: Record<EngineFailureStage, string> = {
  download: "The engine download failed. Check your connection and try again.",
  verify: "The downloaded engine did not pass its safety check, so it was not installed.",
  backend: "The engine could not get the parts it needs for this computer.",
  blocked: "This computer blocked the engine from running.",
  start: "The engine could not start on this computer.",
};

/* The agent's wording for its non-retryable failures (core-errors.ts
   NOT_RETRYABLE; core-install.ts, core-backend.ts, platform-assets.ts). An
   agent from after this change prints these without the retry hint; an
   older one prints the hint anyway, so the wording decides, not the hint. */
const NOT_RETRYABLE: ReadonlyArray<[RegExp, Exclude<EngineFailureReason, "incomplete">]> = [
  [/\bENOSPC\b|\bEDQUOT\b|\bEROFS\b|no space left|not enough (?:free )?(?:disk )?space|disk (?:is )?full|read-only file system/i, "disk"],
  [/Atomic Core does not support \S+|Local models are not available yet for Windows on ARM/i, "unsupported"],
  [/does not match its release version|is not supported by this Agent build/i, "version"],
  [/found no compatible inference backend/i, "no_backend"],
];
const WHY_NOT_RETRYABLE: Record<Exclude<EngineFailureReason, "incomplete">, string> = {
  disk: "There is not enough free disk space for the local engine. Free some space, then start the model again.",
  unsupported: "The local engine does not run on this computer yet. Cloud models still work.",
  version: "The local engine does not match this version of the app. Update the app to fix it.",
  no_backend: "The local engine found no build that runs on this computer. Cloud models still work.",
};

/* A start or an install the APP ended on its time limit (agent-cli.ts cli's
   "did not answer … within", modelsUpdateStream's "made no progress … and was
   stopped") after Core had printed download progress: the agent never got
   to say why, but the bar says what it was doing. */
const CORE_PROGRESS = /\[[= ]{20}\]\s+\d{1,3}%[^\n]*(?:Atomic Chat engine|Atomic Core)/i;
const APP_TIME_LIMIT = /did not answer `atag models (?:start|update)` within|made no progress for \d+ s and was stopped/i;
const WHY_INCOMPLETE = "The engine download did not finish. Check your connection and try again.";

/* Not failures: a precondition the person resolves (stop the models first),
   or a stop on purpose. Neither earns the recovery card. */
const NOT_A_FAILURE = /Stop local models before (?:updating|switching) the engine|was stopped before it finished|was cancelled|AbortError/i;

/**
 * The engine failure a piece of agent output describes, or null. Only Core's
 * own failures count: its retry hint (or an older hint), one of its stage
 * sentences, or a line naming Atomic Core.
 */
export function engineFailureIn(text: string | null | undefined, ctx: EngineFailureContext = {}): EngineFailure | null {
  const all = String(text ?? "");
  if (!all.trim()) return null;
  if (CORE_PROGRESS.test(all) && APP_TIME_LIMIT.test(all)) {
    const line = all.split(/\r?\n/).map((l) => l.trim()).find((l) => APP_TIME_LIMIT.test(l)) ?? "";
    return { stage: "download", why: WHY_INCOMPLETE, detail: line.slice(0, 300), retryable: true, reason: "incomplete" };
  }
  const hintAt = CORE_HINTS.map((h) => all.indexOf(h)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  const loadFailed = MODEL_LOAD.test(all);
  if (hintAt === undefined && !STAGE_SENTENCES.some(([re]) => re.test(all))
    && !/Atomic (?:Chat )?Core|atomic-chat-core|CoreUnavailable|\bMODEL_LOAD_FAILED\b/i.test(all)
    && !(ctx.core && loadFailed)) return null;
  if (NOT_A_FAILURE.test(all)) return null;
  const stage = stageOf(all);
  const detail = (hintAt === undefined ? all : all.slice(0, hintAt))
    // The agent's own sentence: not a stack frame, not a progress bar line, not the update's "current → latest".
    .split(/\r?\n/).map((l) => l.trim()).reverse().find((l) => l && !/^at\s/.test(l) && !/^\[[= ]*\]/.test(l) && !/^current: /.test(l)) ?? "";
  const clean = detail.replace(/\s*\(TUI:[^)]*\)\.?\s*$/, "").slice(0, 300);
  const structured = /"retryable"\s*:\s*false/.test(all);
  const fixed = NOT_RETRYABLE.find(([re]) => re.test(all))?.[1];
  const fellBack = CPU_FALLBACK.test(all) ? { cpuFallback: true } : {};
  if (fixed) return { stage, why: WHY_NOT_RETRYABLE[fixed], detail: clean, retryable: false, reason: fixed, ...fellBack };
  // The engine is there and the model is what failed: Download again cannot help.
  if (loadFailed && stage !== "blocked") return { stage: "start", why: WHY_LOAD, detail: clean, retryable: false, reason: "load", ...fellBack };
  return { stage, why: WHY[stage], detail: clean, retryable: !structured, ...fellBack };
}

/** Whether a piece of agent output says the start was moved to the CPU build. */
export function cpuFallbackIn(text: string | null | undefined): boolean {
  return CPU_FALLBACK.test(String(text ?? ""));
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
export function engineFailureOf(value: unknown, ctx: EngineFailureContext = {}): EngineFailure | null {
  if (!value || typeof value !== "object") return typeof value === "string" ? engineFailureIn(value, ctx) : null;
  const v = value as Record<string, unknown>;
  if (v["ok"] === true && v["daemon"] !== "start-failed") return null;
  const said = saidIn(v);
  return said ? engineFailureIn(said, ctx) : null;
}

/**
 * Whether an IPC answer, failed or not, says the agent moved the start to
 * the CPU build. A start that then served is the common case: no failure
 * card, but the person should know why replies are slow.
 */
export function cpuFallbackOf(value: unknown): boolean {
  if (!value || typeof value !== "object") return typeof value === "string" && cpuFallbackIn(value);
  return cpuFallbackIn(saidIn(value as Record<string, unknown>));
}

function saidIn(v: Record<string, unknown>): string {
  return ["error", "stderr", "refusal", "daemonLine", "daemonError"]
    .map((k) => v[k]).filter((s): s is string => typeof s === "string" && s.length > 0).join("\n");
}
