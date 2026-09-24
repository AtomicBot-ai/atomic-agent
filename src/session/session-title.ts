import type { SessionState } from "./session-state.js";

/**
 * Where a generated session name lives. Reserved metadata, set by the
 * runtime — the same shape `session-llm.ts` uses for its own stamp.
 */
export const SESSION_TITLE_METADATA_KEY = "title";

/**
 * Cells a title may take. The header draws it beside the brand and the
 * rail draws it in a narrow column, so this is a hard bound rather than
 * a suggestion — and a name that needs more than this is a description,
 * which is what the first prompt already is.
 */
export const SESSION_TITLE_MAX_CHARS = 48;

/** The stored title, or `null` when nothing has named this session. */
export function readSessionTitle(
  metadata: Record<string, unknown> | undefined,
): string | null {
  const raw = metadata?.[SESSION_TITLE_METADATA_KEY];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * One line, bounded, without the decorations a model reaches for.
 *
 * Models answer this kind of request with quotes, a trailing full stop,
 * a `Title:` prefix or a markdown heading, and all four read as noise in
 * a one-line bar. Stripped here rather than begged for in the prompt,
 * because the prompt cannot be enforced and this can.
 */
export function sanitizeSessionTitle(raw: string): string | null {
  let text = raw.replace(/\s+/g, " ").trim();
  text = text.replace(/^(?:title|название|заголовок)\s*[:—-]\s*/i, "");
  text = text.replace(/^#+\s*/, "");
  // Matching pairs only: a title that legitimately contains one quote
  // keeps it.
  text = text.replace(/^["'«“](.*)["'»”]$/u, "$1");
  text = text.replace(/[.!]+$/u, "").trim();
  if (text.length === 0) return null;
  return text.length > SESSION_TITLE_MAX_CHARS
    ? `${text.slice(0, SESSION_TITLE_MAX_CHARS - 1).trimEnd()}…`
    : text;
}

/**
 * Whether this session is ready to be named, and has not been.
 *
 * After the first *answered* turn, not before: the first prompt alone
 * is often "посмотри на это" with the substance in what the agent then
 * found. Naming once and keeping it is deliberate — a title that
 * rewrites itself as the thread grows is a moving label on a list the
 * operator navigates by memory.
 */
export function shouldNameSession(state: SessionState): boolean {
  if (readSessionTitle(state.metadata) !== null) return false;
  const firstUser = state.turns.find((turn) => turn.kind === "user");
  if (!firstUser) return false;
  return state.turns.some((turn) => turn.kind === "assistant_reply");
}

/** The first user turn's text, which is what the title is drawn from. */
export function firstPromptOf(state: SessionState): string | null {
  const firstUser = state.turns.find((turn) => turn.kind === "user");
  if (!firstUser || !("text" in firstUser)) return null;
  const text = String(firstUser.text ?? "").trim();
  return text.length > 0 ? text : null;
}

/**
 * Chars of the prompt the namer is shown. A long paste is a wall of
 * context whose first lines already say what the task is, and the whole
 * point of this call is that it is cheap.
 */
export const SESSION_TITLE_PROMPT_BUDGET = 1200;

export function buildSessionTitlePrompt(firstPrompt: string): string {
  const clipped =
    firstPrompt.length > SESSION_TITLE_PROMPT_BUDGET
      ? `${firstPrompt.slice(0, SESSION_TITLE_PROMPT_BUDGET)}…`
      : firstPrompt;
  return [
    "Name this work session.",
    "",
    "Answer with a title of at most six words that says what the task is.",
    "Write it in the language the request is written in.",
    "No quotes, no trailing period, no prefix — the title alone.",
    "",
    "The request:",
    clipped,
  ].join("\n");
}

/**
 * Deadline for the naming call. Nothing waits on it, so this is only
 * here to stop a hung request holding a side-call slot the next turn
 * would queue behind.
 */
export const SESSION_TITLE_TIMEOUT_MS = 20_000;

/**
 * Partition the naming call sits in, like `reflection:` / `rewriter:` /
 * `vote:`.
 *
 * The fallback chain keys its breaker state by session id. On the bare
 * id, a provider refusing THIS request would flip the turn's own sticky
 * override and send the next real step down the chain — a documented
 * trap this codebase has already paid for once. Naming a session must
 * not be able to reroute the conversation it names.
 */
export const SESSION_TITLE_SESSION_PREFIX = "title:";

export interface SessionTitleDeps {
  complete: (params: {
    prompt: string;
    sessionId: string;
    slotId: number;
  }) => Promise<{ content: string }>;
  slotId: () => number;
  timeoutMs?: number;
  onError?: (err: unknown) => void;
}

/**
 * Ask the model for a name. `null` on anything at all going wrong.
 *
 * Fire-and-forget by contract: naming a session is a nicety, and the
 * caller has already saved the turn. It must never delay a reply, never
 * fail one, and never retry — the untitled session simply keeps showing
 * its first prompt, which is what every session showed before.
 */
export async function generateSessionTitle(
  state: SessionState,
  deps: SessionTitleDeps,
): Promise<string | null> {
  const prompt = firstPromptOf(state);
  if (prompt === null) return null;
  try {
    const result = await deps.complete({
      prompt: buildSessionTitlePrompt(prompt),
      sessionId: `${SESSION_TITLE_SESSION_PREFIX}${state.id}`,
      slotId: deps.slotId(),
    });
    return sanitizeSessionTitle(result.content ?? "");
  } catch (err) {
    deps.onError?.(err);
    return null;
  }
}
