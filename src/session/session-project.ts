/**
 * ATO-42: the project a chat belongs to, as the agent sees it.
 *
 * A project (desktop: a group of chats with one work folder and its own
 * instructions) is owned by the client: the desktop keeps the list and
 * which chat is in which project. The agent only needs the project's
 * instructions, which every chat of the project shares. The client sends
 * them with each turn (`project_instructions`, `project_name` on
 * `POST /v1/chat/completions`), and they are stamped on the session under
 * a reserved metadata key, inside the session's turn lock
 * (`runTurn`'s `project` option), so an edit to the project reaches its
 * chats on their next turn.
 *
 * They render like a folder's AGENTS.md: a `project` section of the cloud
 * context and a `### project` block ahead of the local prompt's
 * conversation. Like project files they grant no tool permissions, and
 * system instructions and the person's explicit requests take precedence.
 */
import type { SessionState } from "./session-state.js";

/** Reserved `SessionState.metadata` key the project lives under. */
export const SESSION_PROJECT_METADATA_KEY = "project";
/** Instructions longer than this are refused, not cut: the client keeps the full text. */
export const PROJECT_INSTRUCTIONS_MAX_CHARS = 16_000;
export const PROJECT_NAME_MAX_CHARS = 80;

export interface SessionProject {
  /** The project's name, for the model's orientation only; null when the client sent none. */
  name: string | null;
  /** The person's instructions for every chat of the project; never empty. */
  instructions: string;
}

/**
 * The request's project fields. `undefined`: the client said nothing, the
 * session keeps what it has (a plain OpenAI client, an older desktop).
 * `null`: the chat is in no project (or its project has no instructions),
 * clear it. Otherwise the project to stamp.
 */
export function parseProjectFields(
  instructions: unknown,
  name: unknown,
): { ok: true; value: SessionProject | null | undefined } | { ok: false; error: string; param: string } {
  if (instructions === undefined) return { ok: true, value: undefined };
  if (instructions === null) return { ok: true, value: null };
  if (typeof instructions !== "string") {
    return { ok: false, error: "project_instructions must be a string or null", param: "project_instructions" };
  }
  if (instructions.length > PROJECT_INSTRUCTIONS_MAX_CHARS) {
    return {
      ok: false,
      error: `project_instructions is longer than ${PROJECT_INSTRUCTIONS_MAX_CHARS} characters`,
      param: "project_instructions",
    };
  }
  if (name !== undefined && name !== null && typeof name !== "string") {
    return { ok: false, error: "project_name must be a string or null", param: "project_name" };
  }
  const text = instructions.trim();
  if (!text) return { ok: true, value: null };
  return { ok: true, value: { name: cleanName(name), instructions: text } };
}

function cleanName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  // One line, cut by characters so an emoji is never split.
  const one = Array.from(name.replace(/\s+/g, " ").trim()).slice(0, PROJECT_NAME_MAX_CHARS).join("");
  return one || null;
}

/** Stamp (or clear, for null) the project on the session; undefined leaves it alone. */
export function applySessionProject(state: SessionState, project: SessionProject | null | undefined): void {
  if (project === undefined) return;
  if (project === null) {
    if (SESSION_PROJECT_METADATA_KEY in state.metadata) delete state.metadata[SESSION_PROJECT_METADATA_KEY];
    return;
  }
  state.metadata[SESSION_PROJECT_METADATA_KEY] = { name: project.name, instructions: project.instructions };
}

/** The session's project, or null when there is none or the stored value is not one. */
export function readSessionProject(state: Pick<SessionState, "metadata">): SessionProject | null {
  const raw = state.metadata?.[SESSION_PROJECT_METADATA_KEY];
  if (!raw || typeof raw !== "object") return null;
  const { name, instructions } = raw as { name?: unknown; instructions?: unknown };
  if (typeof instructions !== "string" || !instructions.trim()) return null;
  return {
    name: typeof name === "string" && name ? name : null,
    instructions: instructions.slice(0, PROJECT_INSTRUCTIONS_MAX_CHARS),
  };
}

/** The body of the prompt's project block (no header), or null when the session has no project. */
export function renderSessionProjectBody(state: Pick<SessionState, "metadata">): string | null {
  const project = readSessionProject(state);
  if (!project) return null;
  const label = project.name ? `the project "${project.name}"` : "the project";
  return [
    `This chat belongs to ${label}. The person wrote these instructions for every chat in it.`,
    "They apply like the working folder's AGENTS.md: system instructions and the person's explicit requests take precedence, and they grant no tool permissions.",
    "",
    project.instructions,
  ].join("\n");
}
