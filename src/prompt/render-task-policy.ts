import type { ConversationTurn } from "../session/conversation-turn.js";

export type TaskPolicyKind =
  | "code_edit"
  | "debug"
  | "broad_exploration"
  | "multi_step";

export interface RenderTaskPolicyInput {
  userMessage?: string | null;
  turns: readonly ConversationTurn[];
}

export interface RenderedTaskPolicy {
  kind: TaskPolicyKind;
  body: string;
}

export function renderTaskPolicy(
  input: RenderTaskPolicyInput,
): RenderedTaskPolicy | null {
  const userMessage = resolveUserMessage(input);
  if (userMessage.length === 0) return null;
  const kind = classifyTaskPolicy(userMessage);
  if (kind === null) return null;
  return { kind, body: formatTaskPolicy(kind) };
}

function resolveUserMessage(input: RenderTaskPolicyInput): string {
  if (input.userMessage && input.userMessage.trim().length > 0) {
    return input.userMessage.trim();
  }
  for (let i = input.turns.length - 1; i >= 0; i -= 1) {
    const turn = input.turns[i];
    if (turn?.kind === "user" && turn.text.trim().length > 0) {
      return turn.text.trim();
    }
  }
  return "";
}

function classifyTaskPolicy(message: string): TaskPolicyKind | null {
  const text = message.toLowerCase();
  if (/\b(debug|failing|failure|failed|error|bug|regression|stack trace|test failure)\b/.test(text)) {
    return "debug";
  }
  if (/\b(fix|implement|refactor|edit|change|update|add|wire|modify)\b/.test(text)) {
    if (/\b(code|src\/|test|tests|file|files|module|function|class|typescript|javascript)\b/.test(text)) {
      return "code_edit";
    }
    return "multi_step";
  }
  if (/\b(explore|investigate|research|find out|where|how does|understand|trace)\b/.test(text)) {
    return "broad_exploration";
  }
  if (/\b(plan|migrate|architecture|design|multi-file|multiple files)\b/.test(text)) {
    return "multi_step";
  }
  return null;
}

function formatTaskPolicy(kind: TaskPolicyKind): string {
  const common = [
    "- Keep exploration bounded: gather only the files, traces, or commands needed to choose the next action.",
    "- Prefer parallel read-only calls when inputs are independent.",
    "- Do not reply until the requested outcome is either complete or blocked by a concrete missing input.",
  ];
  const finalCheck = [
    "- Final check before `reply`: verify the requested outcome, note any tool errors, and state validation run/not run.",
    "- If code changed, mention the focused tests or lint commands run; if none were run, say so plainly.",
  ];
  const byKind: Record<TaskPolicyKind, readonly string[]> = {
    code_edit: [
      "kind: code_edit",
      "- Inspect relevant files and nearest module exports/tests before editing.",
      "- Preserve public interfaces unless the user explicitly asked to change them.",
      "- Before final reply, run focused validation when available; if not run, report that fact.",
      ...common,
      ...finalCheck,
    ],
    debug: [
      "kind: debug",
      "- Reproduce or inspect the failing path before changing code when a command/test is available.",
      "- Identify the smallest code path that explains the observed failure.",
      "- After editing, rerun the focused failing check when practical.",
      ...common,
      ...finalCheck,
    ],
    broad_exploration: [
      "kind: broad_exploration",
      "- Start with maps and symbol searches, then read only the strongest candidates.",
      "- Summarize the discovered structure before proposing risky changes.",
      ...common,
    ],
    multi_step: [
      "kind: multi_step",
      "- Split the work into discovery, change, validation, and final report.",
      "- Keep each tool step tied to the current subgoal and adjust after observations.",
      ...common,
      ...finalCheck,
    ],
  };
  return byKind[kind].join("\n");
}
