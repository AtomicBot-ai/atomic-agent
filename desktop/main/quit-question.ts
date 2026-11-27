/**
 * ATO-1696 (ATO-1688): what a quit asks before it goes, as one question.
 *
 * ATO-135 asked only when messages were still queued in a chat. A turn that
 * was running (in the chat on screen or in one left in the background) was
 * stopped by the quit without a word: the person came back to a chat whose
 * reply had been cut off. A quit now asks about both, in one dialog, and
 * asks nothing when there is neither.
 *
 * ATO-1758: the window's own turns were all it counted. A scheduled task
 * running, or a reply the agent writes to Telegram or Discord, is a turn
 * this window never streams, and the quit stopped it without a word too.
 * The agent itself knows them: `GET /api/tasks?status=running` names the
 * tasks, and `/health` counts every busy turn (`busyTurns`, agent 0.6.6).
 * What is left of that count after this window's chats and the tasks is a
 * reply in a channel (or an API call). The question names each kind, as VS
 * Code's "a task is still running" quit prompt does.
 */

import { settleWithin } from "./quit-shutdown.js";

export interface QuitWork {
  /** Messages queued in the chats, waiting for their chat's turn to end (ATO-135). */
  queued: number;
  /** Chats whose turn is running now (main's liveTurns, counted by chat). */
  working: number;
  /** ATO-1758: scheduled tasks the agent is running now. Omitted: none known. */
  tasks?: number;
  /** ATO-1758: the agent's other busy turns, none of them this window's: a Telegram or Discord reply, an API call. */
  background?: number;
}

export interface QuitQuestion {
  message: string;
  detail: string;
}

type Kind = "chats" | "tasks" | "background";

/** The dialog's text, or null when the quit should go without asking. */
export function quitQuestion(work: QuitWork): QuitQuestion | null {
  const queued = count(work.queued);
  const kinds: Array<[Kind, number]> = [["chats", count(work.working)], ["tasks", count(work.tasks ?? 0)], ["background", count(work.background ?? 0)]];
  const running = kinds.filter(([, n]) => n > 0);
  if (queued === 0 && running.length === 0) return null;
  if (running.length === 0) {
    return {
      message: queued === 1 ? "A queued message has not been sent" : `${queued} queued messages have not been sent`,
      detail: "They wait for their chat's turn to end. Quitting now drops them.",
    };
  }
  const drops = queued === 0 ? ""
    : queued === 1 ? " A queued message is dropped too." : ` ${queued} queued messages are dropped too.`;
  if (running.length === 1) {
    const [kind, n] = running[0]!;
    const one = single(kind, n);
    return { message: one.message, detail: `${one.stops}${drops}` };
  }
  const list = running.map(([kind, n]) => named(kind, n));
  return {
    message: "Atomic Agent is still working",
    detail: `Still running: ${joinWords(list)}. Quitting now stops all of it before it is done.${drops}`,
  };
}

/** One kind of work on its own: the ATO-1696 words for chats, the ATO-1758 ones for the rest. */
function single(kind: Kind, n: number): { message: string; stops: string } {
  if (kind === "chats") {
    return {
      message: n === 1 ? "A chat is still working" : `${n} chats are still working`,
      stops: n === 1 ? "Quitting now stops its reply before it is done." : "Quitting now stops their replies before they are done.",
    };
  }
  if (kind === "tasks") {
    return {
      message: n === 1 ? "A scheduled task is still running" : `${n} scheduled tasks are still running`,
      stops: n === 1 ? "Quitting now stops it before it is done." : "Quitting now stops them before they are done.",
    };
  }
  return {
    message: n === 1 ? "A reply in Telegram or another channel is still being written" : `${n} replies in Telegram or other channels are still being written`,
    stops: n === 1 ? "Quitting now cuts it off before it is sent." : "Quitting now cuts them off before they are sent.",
  };
}

/** One kind of work as an item of the "Still running:" list. */
function named(kind: Kind, n: number): string {
  if (kind === "chats") return n === 1 ? "a chat" : `${n} chats`;
  if (kind === "tasks") return n === 1 ? "a scheduled task" : `${n} scheduled tasks`;
  return n === 1 ? "a reply in Telegram or another channel" : `${n} replies in Telegram or other channels`;
}

function joinWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The chats with a turn running: one per chat, a new chat's first turn on its own (it has no id yet). */
export function workingChatCount(turns: Iterable<{ turnId: string; sessionId: string | null }>): number {
  const chats = new Set<string>();
  for (const t of turns) chats.add(t.sessionId ? `s:${t.sessionId}` : `t:${t.turnId}`);
  return chats.size;
}

/* ---- ATO-1758: what the agent runs that this window does not see ---- */

/** What the agent said when asked: null for an answer that did not come, or came from an agent that cannot say. */
export interface AgentBusySample {
  /** `GET /api/tasks?status=running`, as a count. */
  tasks: number | null;
  /** `/health` busyTurns: every session with a turn in flight, this window's included. */
  busyTurns: number | null;
}

/** The two asks main makes, each answering a count or null. */
export interface AgentBusyProbe {
  tasks: () => Promise<number | null>;
  busyTurns: () => Promise<number | null>;
}

/** How long a quit waits for the agent's answer. Both routes answer in milliseconds; a stall must not hold the quit. */
export const QUIT_PROBE_MS = 1_500;

/** `busyTurns` out of a /health body, or null when it is not there (an agent before 0.6.6, or no body). */
export function busyTurnsOf(health: unknown): number | null {
  const n = (health as { busyTurns?: unknown } | null | undefined)?.busyTurns;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * Both asks at once, bounded. An answer that does not come in time, or
 * fails, counts as none (as keep-awake's workRunning reads it): a stalled
 * agent must not make every quit ask about work that is not there.
 */
export async function sampleAgentBusy(probe: AgentBusyProbe, ms: number = QUIT_PROBE_MS): Promise<AgentBusySample> {
  const ask = (run: () => Promise<number | null>) => settleWithin(Promise.resolve().then(run), ms, null);
  const [tasks, busyTurns] = await Promise.all([ask(probe.tasks), ask(probe.busyTurns)]);
  return { tasks, busyTurns };
}

/**
 * The quit's counts of the work this window does not stream. The tasks are
 * the agent's own count. The busy turns the agent counted include this
 * window's chats and the tasks' turns; what is left over is a reply in a
 * channel or an API call. Never below zero: a task claimed before its turn
 * began, or a window turn whose session the agent already closed, must not
 * invent background work.
 */
export function backgroundQuitWork(windowChats: number, sample: AgentBusySample): { tasks: number; background: number } {
  const tasks = count(sample.tasks ?? 0);
  const busy = count(sample.busyTurns ?? 0);
  return { tasks, background: Math.max(0, busy - count(windowChats) - tasks) };
}

function count(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
