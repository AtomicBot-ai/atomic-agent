import { buildCloudSubcallRequest } from "../llm/provider/cloud-subcall.js";
import type {
  CompletionRequest,
  CompletionResult,
  ToolCallTransport,
} from "../llm/provider/completion-types.js";
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

/**
 * The single synthetic function a cloud sub-call emits into.
 *
 * `emit_*` with one string field, like every other sub-call on this
 * path — see `buildCloudSubcallRequest`.
 */
export const SESSION_TITLE_EMIT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "The session title, at most six words.",
    },
  },
  required: ["title"],
  additionalProperties: false,
};

/**
 * Output bound for the naming call. A title is six words; anything
 * beyond this is a reasoning model talking to itself, and it pays for
 * the tokens either way.
 */
export const SESSION_TITLE_MAX_TOKENS = 512;

/**
 * The title out of a completion, whichever shape it came back in.
 *
 * On `native_tools` the answer is in `tool_calls[0].arguments`; a
 * thinking model that ignores the tool and answers in prose lands in
 * `content`, and a fallover to a grammar link does too. Both are read,
 * because this is a nicety that must not depend on which link served
 * it.
 */
export function extractSessionTitleText(
  completion: Pick<CompletionResult, "content" | "toolCalls">,
): string {
  const args = completion.toolCalls?.[0]?.function?.arguments;
  if (typeof args === "string" && args.length > 0) {
    try {
      const parsed = JSON.parse(args) as { title?: unknown };
      if (typeof parsed.title === "string") return parsed.title;
    } catch {
      // Fall through to the prose answer.
    }
  }
  return completion.content;
}

export interface SessionTitleDeps {
  complete: (
    params: CompletionRequest & {
      grammar: string;
      slotId: number;
      sessionId: string;
    },
  ) => Promise<Pick<CompletionResult, "content" | "toolCalls">>;
  slotId: () => number;
  /**
   * Wire shape of the link that will serve this call.
   *
   * Load-bearing, not cosmetic: on `native_tools` a bare prompt with no
   * tools comes back with an EMPTY `content` — the provider answers in
   * `tool_calls`, and every other sub-call on this path already goes
   * through `buildCloudSubcallRequest` for exactly that reason. Without
   * it, naming silently produced nothing on every cloud provider, which
   * is what most operators run.
   */
  toolTransport?: ToolCallTransport;
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
  const sessionId = `${SESSION_TITLE_SESSION_PREFIX}${state.id}`;
  const text = buildSessionTitlePrompt(prompt);
  const request =
    deps.toolTransport === "native_tools"
      ? {
          ...buildCloudSubcallRequest({
            prompt: text,
            emitFunctionName: "emit_session_title",
            argsSchema: SESSION_TITLE_EMIT_SCHEMA,
            description: "Emit the session title",
            sessionId,
            maxTokens: SESSION_TITLE_MAX_TOKENS,
          }),
          sessionId,
          grammar: "",
          // No slot affinity on a cloud link, and no prefix worth
          // keeping: this prompt is used once.
          slotId: -1,
        }
      : {
          prompt: text,
          sessionId,
          grammar: "",
          slotId: deps.slotId(),
        };
  try {
    const result = await deps.complete(request);
    const title = sanitizeSessionTitle(extractSessionTitleText(result) ?? "");
    if (title === null) {
      // Reported, not swallowed. An empty answer and a thrown request
      // look identical from outside — the session simply stays unnamed
      // — and the difference between "the provider refused" and "the
      // provider answered in a shape we did not read" is the whole
      // diagnosis. This one cost a full release cycle to find.
      deps.onError?.(new Error("the model returned no usable title"));
    }
    return title;
  } catch (err) {
    deps.onError?.(err);
    return null;
  }
}
