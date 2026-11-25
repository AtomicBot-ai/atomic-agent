import {
  isFinalReplyTurn,
  isStoppedTurnMarker,
  type ConversationTurn,
} from "../../session/conversation-turn.js";
import type { SessionState } from "../../session/session-state.js";

/**
 * `atag handoff --to claude|codex` (ATO-1158): the reverse of
 * `--from`. An Atomic Agent chat becomes a Markdown brief another agent
 * can pick up: the task, what was decided, what is still open, and which
 * files were changed.
 *
 * Deliberately a plain document, not their session format: their
 * transcript files are undocumented and change between versions, so
 * nothing is ever written into `~/.claude` or `~/.codex`. The person
 * gives this brief to the other agent themselves.
 */
export const HANDOFF_TARGETS = ["claude", "codex"] as const;
export type HandoffTarget = (typeof HANDOFF_TARGETS)[number];

export const HANDOFF_TARGET_LABEL: Record<HandoffTarget, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/** `claude-code` is accepted too, to match `--from`. */
export function parseHandoffTarget(value: string): HandoffTarget | null {
  if (value === "claude" || value === "claude-code") return "claude";
  if (value === "codex") return "codex";
  return null;
}

/** How many of the agent's last answers go under "Decisions so far". */
export const HANDOFF_EXPORT_REPLIES = 5;
/** Per-entry clip, so one long answer cannot bury the rest. */
export const HANDOFF_EXPORT_ENTRY_CHARS = 1500;

/** Tools whose successful call changed a file, and how to read its paths. */
const FILE_CHANGE_PATHS: Record<string, (args: Record<string, unknown>) => string[]> = {
  "os.fs.write": (args) => stringsOf(args.path),
  "os.fs.edit": (args) => stringsOf(args.path),
  "os.fs.move": (args) => {
    const moves = Array.isArray(args.moves) ? args.moves : [args];
    return moves.flatMap((move) =>
      move !== null && typeof move === "object"
        ? [...stringsOf((move as Record<string, unknown>).from), ...stringsOf((move as Record<string, unknown>).to)]
        : [],
    );
  },
  "os.fs.patch": (args) => (args.apply === true ? patchTargets(args.patch) : []),
};

function stringsOf(value: unknown): string[] {
  return typeof value === "string" && value.trim().length > 0 ? [value.trim()] : [];
}

/** The `+++ b/<path>` targets of a unified diff (`/dev/null` = a deletion). */
function patchTargets(patch: unknown): string[] {
  if (typeof patch !== "string") return [];
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    const match = /^\+\+\+ (?:b\/)?(.+?)(?:\t.*)?$/.exec(line);
    const target = match?.[1]?.trim();
    if (target && target !== "/dev/null") out.push(target);
  }
  return out;
}

function clip(text: string, max = HANDOFF_EXPORT_ENTRY_CHARS): string {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Quote block that keeps the text's own line breaks. */
function quote(text: string): string {
  return clip(text)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/**
 * Files changed by tool calls that succeeded, in first-touched order.
 * Shell commands are not parsed, so a file changed only through the
 * shell is not listed (the brief says so).
 */
export function changedFilesOf(turns: readonly ConversationTurn[]): string[] {
  const seen = new Set<string>();
  let pending: Extract<ConversationTurn, { kind: "assistant_tool_call" }> | null = null;
  for (const turn of turns) {
    if (turn.kind === "assistant_tool_call") {
      pending = turn;
      continue;
    }
    if (turn.kind === "tool_result" && pending !== null && pending.tool === turn.tool) {
      const read = FILE_CHANGE_PATHS[turn.tool];
      if (turn.status === "ok" && read) {
        for (const path of read(pending.args)) seen.add(path);
      }
      pending = null;
    }
  }
  return [...seen];
}

export interface HandoffBriefInput {
  session: SessionState;
  to: HandoffTarget;
  /** Clock for the header; injectable for tests. */
  now?: Date;
}

/** The Markdown brief for one chat. Pure: reads the session, writes nothing. */
export function buildHandoffBrief(input: HandoffBriefInput): string {
  const { session, to } = input;
  const turns = session.turns;
  const users = turns.filter(
    (turn): turn is Extract<ConversationTurn, { kind: "user" }> => turn.kind === "user",
  );
  const firstTask = users.find((turn) => turn.steered !== true) ?? users[0];
  const lastUser = users.at(-1);
  const replies = turns.filter(
    (turn): turn is Extract<ConversationTurn, { kind: "assistant_reply" }> =>
      isFinalReplyTurn(turn) && !isStoppedTurnMarker(turn) && turn.text.trim().length > 0,
  );
  const lastTurn = turns.at(-1);
  const unfinished = lastTurn !== undefined && !isFinalReplyTurn(lastTurn);
  const stopped = isStoppedTurnMarker(lastTurn);
  const files = changedFilesOf(turns);
  const title = typeof session.metadata.title === "string" ? session.metadata.title.trim() : "";
  const label = HANDOFF_TARGET_LABEL[to];

  const lines: string[] = [
    `# Handoff: ${title.length > 0 ? title : "Atomic Agent chat"}`,
    "",
    `Continued from an Atomic Agent chat for ${label}.`,
    "",
    `- Folder: \`${session.workingDir}\``,
    `- Atomic Agent chat: \`${session.id}\``,
    `- Written: ${(input.now ?? new Date()).toISOString()}`,
    "",
    "## Task",
    "",
    firstTask ? quote(firstTask.text) : "_No request in this chat yet._",
  ];
  if (lastUser && lastUser !== firstTask) {
    lines.push("", "Latest request:", "", quote(lastUser.text));
  }

  lines.push("", "## Decisions so far", "");
  const recent = replies.slice(-HANDOFF_EXPORT_REPLIES);
  if (recent.length === 0) {
    lines.push("_The agent has not answered yet._");
  } else {
    if (replies.length > recent.length) {
      lines.push(`The agent's last ${recent.length} of ${replies.length} answers, oldest first.`, "");
    }
    recent.forEach((reply, i) => {
      if (i > 0) lines.push("");
      lines.push(quote(reply.text));
    });
  }

  lines.push("", "## Open items", "");
  if (stopped) {
    lines.push("- The last turn was stopped by the user before it finished.");
  } else if (unfinished) {
    lines.push("- The last turn did not finish: pick up the latest request above.");
  } else {
    lines.push("- Nothing left open in the chat itself. Check the task against the files below.");
  }

  lines.push("", "## Changed files", "");
  if (files.length === 0) {
    lines.push("_No file changes recorded by the agent's file tools._");
  } else {
    for (const file of files) lines.push(`- \`${file}\``);
  }
  lines.push(
    "",
    "_Files changed through shell commands are not listed; check `git status` in the folder._",
    "",
    "## How to continue",
    "",
    `Open ${label} in the folder above and give it this file as the first message, then ask it to continue the task.`,
    "",
  );
  return lines.join("\n");
}
