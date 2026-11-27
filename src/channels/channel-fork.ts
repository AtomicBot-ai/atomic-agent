import type { AgentRuntime } from "../runtime/runtime-contract.js";
import { planFork, type ForkRefusal } from "../session/session-fork.js";
import { countQuestions } from "../session/session-previous-replies.js";
import type { SessionState } from "../session/session-state.js";

/**
 * `/fork` in a messenger channel (ATO-2235): copy the chat's session
 * into a new one, the same copy the desktop's Fork makes
 * (`POST /api/sessions/{id}/fork`, ATO-1058), taken at the chat's last
 * question so the whole conversation comes along.
 *
 * Only the session state is copied: the working folder is not cloned
 * and the source's compaction summary is carried as it is, never
 * re-generated. The source session is not touched; the caller saves the
 * fork and decides where it lives (a new Telegram topic, a new Slack
 * thread, or this chat with the source kept in its history).
 *
 * Precedent: OpenClaw v2026.11.10 conversation-fork (Telegram topic per
 * fork, same copy as its UI fork).
 */

export type ChannelForkResult =
  | { ok: true; source: SessionState; state: SessionState; title: string }
  | { ok: false; message: string };

const REFUSALS: Record<ForkRefusal, string> = {
  turn_in_progress: "A turn is running here. Wait for it to finish (or cancel it), then fork.",
  point_compacted: "This chat cannot be forked: its last message is inside the compacted summary.",
  point_mismatch: "Nothing to fork yet: send a message first.",
};

export function planChannelFork(
  runtime: Pick<AgentRuntime, "sessionStore" | "turnController">,
  sourceId: string | null,
): ChannelForkResult {
  if (!sourceId) return { ok: false, message: "No session here yet: send a message first." };
  const source = runtime.sessionStore.load(sourceId);
  if (!source) return { ok: false, message: `Session ${sourceId} is missing, nothing to fork.` };
  if (runtime.turnController.isBusy(source.id)) {
    return { ok: false, message: REFUSALS.turn_in_progress };
  }
  const questions = countQuestions(source.turns);
  if (questions === 0) return { ok: false, message: REFUSALS.point_mismatch };
  const plan = planFork(source, { priorQuestions: questions - 1 });
  if (!plan.ok) return { ok: false, message: REFUSALS[plan.code] };
  return { ok: true, source, state: plan.state, title: plan.title };
}
