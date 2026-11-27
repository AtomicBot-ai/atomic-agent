/**
 * ATO-2519: what the agent's busy turns are, named for the quit question.
 *
 * ATO-1758 (PR 1842) could only subtract: `/health` busyTurns, less this
 * window's chats, less the running tasks, was "a reply in Telegram or
 * another channel", and an API request got the same words. An agent with
 * ATO-2519 lists each running turn's origin (`/health` busyTurnOrigins),
 * so the question names it: "a reply in Discord", "an API request". An
 * older agent sends no list, and the quit keeps the ATO-1758 words.
 *
 * Origins and where they go:
 * - a channel (`telegram`, `discord`, ...): a reply in that channel, by name;
 * - `http`: the OpenAI-compatible and AG-UI routes, this window's own chats
 *   among them; what is left after the window's chats is an API request;
 * - `scheduler`: a task's turn, already counted from `/api/tasks`;
 * - `fusion`, `subagent`: a worker of another turn, counted with that turn;
 * - anything else (`cli`, `tui`, `sidecar`, a name this build does not
 *   know): other agent work, so a quit never stops it without a word.
 */

/** One running turn as `/health` busyTurnOrigins reports it. */
export interface BusyOrigin {
  origin: string;
  wakeReason?: string;
}

/** One named kind of background work and its words, ready for quitQuestion. */
export interface NamedQuitWork {
  n: number;
  /** The dialog's message when this is all that runs. */
  message: string;
  /** What the quit does to it, the dialog's detail. */
  stops: string;
  /** This work as an item of the "Still running:" list. */
  item: string;
}

/** The channel origins the agent has (src/runtime/turn-controller.ts TurnOrigin), as people call them. */
const CHANNEL_NAMES: Readonly<Record<string, string>> = {
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
  signal: "Signal",
  imessage: "iMessage",
  matrix: "Matrix",
  googlechat: "Google Chat",
  msteams: "Microsoft Teams",
  whatsapp: "WhatsApp",
  linear: "Linear",
};

/** Origins whose turns are counted elsewhere: a task (from /api/tasks) or a worker of another turn. */
const COUNTED_ELSEWHERE = new Set(["scheduler", "fusion", "subagent"]);

/** `busyTurnOrigins` out of a /health body, or null when it is not there (an agent before ATO-2519, or no body). */
export function busyOriginsOf(health: unknown): BusyOrigin[] | null {
  const list = (health as { busyTurnOrigins?: unknown } | null | undefined)?.busyTurnOrigins;
  if (!Array.isArray(list)) return null;
  const out: BusyOrigin[] = [];
  for (const entry of list) {
    const origin = (entry as { origin?: unknown } | null)?.origin;
    if (typeof origin !== "string" || origin.length === 0) continue;
    const wake = (entry as { wakeReason?: unknown }).wakeReason;
    out.push(typeof wake === "string" && wake.length > 0 ? { origin, wakeReason: wake } : { origin });
  }
  return out;
}

/**
 * The agent's busy turns that are not this window's and not a task's,
 * by kind: each channel by name (in the order the agent listed them),
 * then API requests, then other agent work. Empty when there are none.
 */
export function namedBackgroundWork(windowChats: number, origins: readonly BusyOrigin[]): NamedQuitWork[] {
  const channels = new Map<string, number>();
  let http = 0;
  let other = 0;
  for (const { origin } of origins) {
    if (COUNTED_ELSEWHERE.has(origin)) continue;
    const name = CHANNEL_NAMES[origin];
    if (name) channels.set(name, (channels.get(name) ?? 0) + 1);
    else if (origin === "http") http += 1;
    else other += 1;
  }
  const window = Number.isFinite(windowChats) && windowChats > 0 ? Math.floor(windowChats) : 0;
  const api = Math.max(0, http - window);
  const out: NamedQuitWork[] = [...channels].map(([name, n]) => channelWork(name, n));
  if (api > 0) out.push(apiWork(api));
  if (other > 0) out.push(otherWork(other));
  return out;
}

function channelWork(name: string, n: number): NamedQuitWork {
  return n === 1
    ? { n, message: `A reply in ${name} is still being written`, stops: "Quitting now cuts it off before it is sent.", item: `a reply in ${name}` }
    : { n, message: `${n} replies in ${name} are still being written`, stops: "Quitting now cuts them off before they are sent.", item: `${n} replies in ${name}` };
}

function apiWork(n: number): NamedQuitWork {
  return n === 1
    ? { n, message: "An API request is still being answered", stops: "Quitting now cuts its answer off before it is done.", item: "an API request" }
    : { n, message: `${n} API requests are still being answered`, stops: "Quitting now cuts their answers off before they are done.", item: `${n} API requests` };
}

function otherWork(n: number): NamedQuitWork {
  return { n, message: "Other agent work is still running", stops: "Quitting now stops it before it is done.", item: "other agent work" };
}
