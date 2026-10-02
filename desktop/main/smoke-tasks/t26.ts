import { BrowserWindow } from "electron";

/**
 * Release-fix checks for backlog item 26 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=26`.
 *
 * 26 — the message queue was the window's, not the chat's. A message typed
 * while a chat's turn ran (a steer the agent could not take, or one typed
 * before a new chat's first turn reported its session) was parked in one list
 * for the whole window: the tray showed it in every chat, and the next turn to
 * end ran it in whatever chat was on screen. Type a follow-up in chat A, open
 * chat B (or start a new chat), let A's turn end, and the follow-up ran in B.
 * Now every chat has its own queue: the tray shows only the chat on screen's,
 * and a message waits for the chat it was typed in and runs there when the
 * person is back.
 *
 * Nothing reaches the agent. As in t24, the window's own IPC (asked before
 * ipcMain's; a probe proves it first) answers GET /api/sessions/{id} and
 * stands in for every call a message can make: the chat, a steer (refused,
 * taken, or held until the check lets it go), the steer ack, the delete, the
 * context preview, the parked steers and the local model list. Those are
 * recorded, never forwarded. Chats are staged rows opened by clicking them,
 * messages are typed into the composer and sent with Enter, and a turn's
 * frames come on the real agent:chat channel. What the check staged comes back
 * out, and the window is put back as it was.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Sent = { channel: "chat" | "steer" | "ack" | "delete"; sessionId: string | null; text: string };
type View = {
  sessionId: string; agentSession: string | null; busy: boolean; rows: string[];
  entry: string | null; toasts: string[]; queued: string[]; tray: string[];
};
type Handler = (event: unknown, arg: unknown) => unknown;

const PREFIX = "smoke-t26-";
const PROBE = `${PREFIX}probe`;
const REFUSAL = "smoke t26: the stand-in runs no turns";
const QUIET = "smoke t26: not answered while the check runs";
const q = (v: unknown) => JSON.stringify(v);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(ok: () => boolean, ms = 3000): Promise<boolean> {
  const t0 = Date.now();
  while (!ok() && Date.now() - t0 < ms) await wait(20);
  return ok();
}

/* Finished turns as the store keeps them: a question, then its reply. */
const turns = (tag: string, n: number) => Array.from({ length: n }, (_, i) => [
  { kind: "user", text: `smoke t26: ${tag} question ${i + 1}` },
  { kind: "assistant_reply", text: `smoke t26: ${tag} answer ${i + 1}` },
]).flat();
const loaded = (id: string, list: unknown[]) => ({ ok: true, data: { id, turns: list } });

/** The agent as this check needs it: every call a message can make, on the window's own IPC. */
class StandIn {
  readonly sent: Sent[] = [];
  /** agent:chat answers with a running turn instead of refusing. */
  turns = false;
  /** How agent:steer answers: the turn takes it, or cannot. */
  steer: "take" | "refuse" = "refuse";
  /** agent:steer answers only when the check lets it go (releaseSteers). */
  holdSteers = false;
  private turnSeq = 0;
  private readonly answers = new Map<string, unknown>();
  private readonly heldSteers: Array<() => void> = [];

  /** GET /api/sessions/{id}: at once for a ready() chat. */
  readonly session: Handler = (_e, id) => {
    const sid = typeof id === "string" ? id : "";
    if (sid === PROBE) return { ok: true, data: { id: sid, turns: [], smokeT26: true } };
    // Anything else (a row being named, the context chip) is not part of the check.
    return this.answers.has(sid) ? this.answers.get(sid) : { ok: false, error: QUIET };
  };

  readonly chat: Handler = (_e, payload) => {
    const p = (payload ?? {}) as { messages?: Array<{ content?: unknown }>; sessionId?: unknown };
    this.sent.push({ channel: "chat", sessionId: typeof p.sessionId === "string" ? p.sessionId : null,
      text: String(p.messages?.[0]?.content ?? "") });
    return this.turns ? { ok: true, turnId: `${PREFIX}turn-${++this.turnSeq}` } : { ok: false, error: REFUSAL };
  };

  readonly steerTo: Handler = (_e, payload) => {
    const p = (payload ?? {}) as { sessionId?: unknown; text?: unknown };
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : null;
    this.sent.push({ channel: "steer", sessionId, text: String(p.text ?? "") });
    const answer = this.steer === "take" ? { ok: true, steered: true, sessionId }
      : { ok: false, steered: false, error: "smoke t26: the turn is not taking steers" };
    if (!this.holdSteers) return answer;
    return new Promise((res) => { this.heldSteers.push(() => res(answer)); });
  };

  readonly ack: Handler = (_e, payload) => {
    const p = (payload ?? {}) as { sessionId?: unknown; through?: unknown };
    this.sent.push({ channel: "ack", sessionId: typeof p.sessionId === "string" ? p.sessionId : null, text: String(p.through) });
    return { ok: true };
  };

  readonly remove: Handler = (_e, id) => {
    this.sent.push({ channel: "delete", sessionId: typeof id === "string" ? id : null, text: "" });
    return { ok: true };
  };

  private readonly quiet: Handler = () => ({ ok: false, error: QUIET });
  private readonly noParked: Handler = () => ({ ok: true, data: { undelivered: [], discarded: 0 } });
  private readonly nothing: Handler = () => true;

  private channels(): Array<[string, Handler]> {
    return [
      ["agent:session", this.session], ["agent:chat", this.chat], ["agent:steer", this.steerTo],
      ["agent:ackSteers", this.ack], ["agent:deleteSession", this.remove], ["agent:approve", this.quiet],
      ["agent:cancel", this.nothing], ["cli:chatModelsList", this.quiet], ["agent:contextPreview", this.quiet],
      ["agent:undeliveredSteers", this.noParked],
    ];
  }

  install(wins: BrowserWindow[]): void {
    for (const x of wins) for (const [ch, fn] of this.channels()) { x.webContents.ipc.removeHandler(ch); x.webContents.ipc.handle(ch, fn); }
  }

  uninstall(wins: BrowserWindow[]): void {
    for (const x of wins) if (!x.isDestroyed()) for (const [ch] of this.channels()) x.webContents.ipc.removeHandler(ch);
  }

  ready(id: string, value: unknown): void { this.answers.set(id, value); }

  /** Until `count` steers have been asked for since `mark`, at most three seconds. */
  steered(mark: number, count: number): Promise<boolean> {
    return until(() => this.since(mark).filter((s) => s.channel === "steer").length >= count);
  }

  /** The held steers are answered, as `steer` says. */
  releaseSteers(): void {
    this.holdSteers = false;
    for (const answer of this.heldSteers.splice(0)) answer();
  }

  since(mark: number): Sent[] { return this.sent.slice(mark); }
  chats(mark: number): Sent[] { return this.since(mark).filter((s) => s.channel === "chat"); }
}

/* Shared by every probe below. */
const H = String.raw`
  const tick = (ms) => new Promise((res) => setTimeout(res, ms));
  const mine = (x) => typeof x === 'string' && (x.indexOf('smoke-t26-') === 0 || x.indexOf('turn:smoke-t26-') === 0);
  const until = async (ok, ms) => { const t0 = Date.now(); while (!ok() && Date.now() - t0 < (ms || 3000)) await tick(20); return !!ok(); };
  // A chat in the sidebar as the agent's list carries it, already named, so nothing goes off to name it.
  const open = (id, t) => {
    for (let i = SESSIONS.length - 1; i >= 0; i--) if (SESSIONS[i].id === id) SESSIONS.splice(i, 1);
    SESSIONS.unshift({id, t, named: true, titled: true, updatedAt: Date.now(), status: '', turnCount: 2});
    render();
    const row = document.querySelector('#sidebar [data-ses="' + id + '"]');
    if (row) row.click();
    return !!row;
  };
  const newChat = () => {
    const b = document.querySelector('#sidebar .sb-new[data-act="session:new"]');
    if (b) b.click();
    return !!b;
  };
  // Typing, as the composer's own input listener hears it, and Enter on the box.
  const type = (t) => {
    const e = document.getElementById('entry');
    if (!e) return false;
    e.value = t; e.dispatchEvent(new Event('input', {bubbles: true}));
    return true;
  };
  const enter = () => {
    const e = document.getElementById('entry');
    if (e) e.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
    return !!e;
  };
  const view = () => {
    const e = document.getElementById('entry');
    return {sessionId: S.sessionId, agentSession: S.agentSession, busy: !!S.busy,
      rows: S.log.map((m) => m.k + ':' + String(m.text || '').slice(0, 80)),
      entry: e ? e.value : null, toasts: S.toasts.map((x) => x.t + ' | ' + (x.s || '')), queued: S.queued.slice(),
      tray: [...document.querySelectorAll('.qtray .qtx')].map((x) => x.textContent || '')};
  };
`;
const VIEW = `(() => { ${H} return view(); })()`;

/* The window as the check found it; RESTORE puts it back. submit() sends
   nothing while the agent is still starting, so the check says it is up:
   every call a message can make is stood in for anyway. */
const KEEP = `(() => {
  window.__t26keep = {log: S.log, sessionId: S.sessionId, agentSession: S.agentSession, busy: S.busy, pending: S.pending,
    history: S.history, room: S.room, streamId: S.streamId, turnId: S.turnId, reasonId: S.reasonId, stick: S.stick,
    settings: S.settings, overlay: S.overlay, menuOpen: S.menuOpen, slash: S.slash, draft: S.draft, toasts: S.toasts.slice(),
    queued: S.queued.slice(), ahead: STEER.ahead, mine: STEER.mine.slice(), live: S.live.state, gating: BSW.gating, gate: localTurnGate,
    owed: typeof DRAIN_OWED !== 'undefined' ? DRAIN_OWED : null,
    had: 'turnStartedAt' in S, started: S.turnStartedAt, fz: FZ.live,
    stamp: CTX055.stamp, plan: {on: PLAN.on, itemId: PLAN.itemId, sessionId: PLAN.sessionId, startedMode: PLAN.startedMode}};
  return true;
})()`;

/* What a case leaves of this check's own: its turns, rows, approvals, read
   stamps, and (with the fix) the queues of its chats. */
const FORGET = String.raw`
  for (const [turn, sid] of [...RUNNING]) if (mine(turn) || mine(sid)) RUNNING.delete(turn);
  for (const sid of [...PENDING_APPROVALS.keys()]) if (mine(sid)) PENDING_APPROVALS.delete(sid);
  if (typeof APPROVAL_CARDS !== 'undefined') for (const sid of [...APPROVAL_CARDS.keys()]) if (mine(sid)) APPROVAL_CARDS.delete(sid);
  for (const sid of [...ATTN]) if (mine(sid)) ATTN.delete(sid);
  if (typeof QUEUES !== 'undefined') for (const key of [...QUEUES.keys()]) if (mine(key)) QUEUES.delete(key);
`;

/* Before each case: an idle composer, an empty box, no toasts, nothing staged
   still running. The local model gate always says "run": it is not what
   these cases are about. */
const RESET = `(() => { ${H}
  S.busy = false; S.pending = null; S.turnId = null; S.streamId = null; S.reasonId = null;
  S.queued.length = 0; STEER.ahead = 0; STEER.mine.length = 0; BSW.gating = false;
  if (typeof OPENING !== 'undefined') OPENING = null;
  if (typeof DRAIN_OWED !== 'undefined') DRAIN_OWED = false;
  localTurnGate = () => ({kind: 'run'});
  S.settings = null; S.overlay = null; S.menuOpen = null; S.slash = false; S.room = 'chat';
  S.live.state = 'connected';
  S.draft = ''; const e = document.getElementById('entry'); if (e) e.value = '';
  S.toasts = []; renderToasts();
  ${FORGET}
  render();
  return true;
})()`;

const RESTORE = `(async () => { ${H}
  await tick(150);   // the answers let go just before this are dealt with first
  const k = window.__t26keep; delete window.__t26keep;
  if (typeof OPENING !== 'undefined') OPENING = null;
  if (k) {
    localTurnGate = k.gate; BSW.gating = k.gating;
    S.log = k.log; S.sessionId = k.sessionId; S.agentSession = k.agentSession; S.busy = k.busy; S.pending = k.pending;
    S.history = k.history; S.room = k.room; S.streamId = k.streamId; S.turnId = k.turnId; S.reasonId = k.reasonId;
    S.stick = k.stick; S.settings = k.settings; S.overlay = k.overlay; S.menuOpen = k.menuOpen; S.slash = k.slash;
    S.draft = k.draft; S.toasts = k.toasts;
    S.queued.length = 0; S.queued.push(...k.queued); STEER.ahead = k.ahead; STEER.mine.length = 0; STEER.mine.push(...k.mine);
    if (typeof DRAIN_OWED !== 'undefined') DRAIN_OWED = k.owed;
    if (k.live !== 'connected' && S.live.state === 'connected') S.live.state = k.live;
    if (k.had) S.turnStartedAt = k.started; else delete S.turnStartedAt;
    FZ.live = k.fz; CTX055.stamp = k.stamp; Object.assign(PLAN, k.plan);
  }
  ${FORGET}
  for (let i = SESSIONS.length - 1; i >= 0; i--) if (mine(SESSIONS[i].id)) SESSIONS.splice(i, 1);
  const seen = Object.keys(PREFS.seen).filter(mine);
  seen.forEach((sid) => { delete PREFS.seen[sid]; });
  if (seen.length) savePrefs();
  const e = document.getElementById('entry'); if (e) e.value = S.draft;
  renderToasts(); render();
  await refreshSessions();
  refreshContext();
  return true;
})()`;

/* Whatever the window does with an answer it was handed happens before the
   reply to a later request on the same channel; a beat on top for the repaint. */
async function settle(js: Js): Promise<void> {
  await js<unknown>(`BR.session(${q(PROBE)}).then(() => new Promise((res) => setTimeout(res, 150)))`);
}

/** Clicks a staged chat that answers at once, and waits until it is the chat on screen. */
async function land(js: Js, id: string, title: string): Promise<boolean> {
  const ok = await js<boolean>(`(async () => { ${H}
    if (!open(${q(id)}, ${q(title)})) return false;
    return until(() => S.sessionId === ${q(id)} && S.agentSession === ${q(id)});
  })()`);
  await settle(js);
  return ok;
}

/** Starts a new chat from the sidebar. */
async function newChat(js: Js): Promise<boolean> {
  const ok = await js<boolean>(`(async () => { ${H} const ok = newChat(); await tick(150); return ok && S.sessionId === ''; })()`);
  await settle(js);
  return ok;
}

/** Types into the composer, presses Enter, and reads the window once the steer chain has run. */
function typeAndEnter(js: Js, text: string): Promise<View> {
  return js<View>(`(async () => { ${H}
    type(${q(text)}); enter();
    await tick(200); await STEER.chain;
    return view();
  })()`);
}

/** Types and presses Enter without waiting for the steer chain (a steer held by the stand-in). */
function typeAndEnterOnly(js: Js, text: string): Promise<boolean> {
  return js<boolean>(`(async () => { ${H} const ok = type(${q(text)}) && enter(); await tick(50); return ok; })()`);
}

/** The question that starts a turn in the chat on screen, sent with Enter; the stand-in runs it. */
async function startTurn(js: Js, agent: StandIn, text: string): Promise<string | null> {
  agent.turns = true;
  try {
    return await js<string | null>(`(async () => { ${H}
      const before = S.turnId;
      type(${q(text)}); enter();
      const ok = await until(() => !!S.turnId && S.turnId !== before);
      return ok ? S.turnId : null;
    })()`);
  } finally {
    agent.turns = false;
  }
}

/** A frame of the turn, on the real agent:chat channel, dealt with. */
async function frame(js: Js, w: BrowserWindow, ev: Record<string, unknown>): Promise<void> {
  w.webContents.send("agent:chat", ev);
  await settle(js);
}

const has = (v: View, tag: string) => v.rows.some((r) => r.includes(`smoke t26: ${tag}`));
const queuedFollowUp = (v: View, text: string) => v.queued.includes(text) && v.tray.includes(text);
const show = (x: unknown) => JSON.stringify(x);

export async function checks26(js: Js, check: Check): Promise<void> {
  const wins = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed());
  const w = wins[0] ?? null;
  const agent = new StandIn();
  let kept = false;
  try {
    agent.install(wins);
    const probe = await js<{ data?: { smokeT26?: boolean } } | null>(`BR.session(${q(PROBE)})`).catch((e: unknown) => String(e));
    if (!w || typeof probe !== "object" || probe?.data?.smokeT26 !== true) {
      check("T26: a stand-in on the window's IPC answers the session fetch first", false, `${show(probe)}; nothing was staged`);
      return;
    }
    kept = await js<boolean>(KEEP);
    await openedAnother(js, check, agent, w);
    await newChatMeanwhile(js, check, agent, w);
    await otherChatsTurn(js, check, agent, w);
    await steerInFlight(js, check, agent, w);
    await undeliveredWhileAway(js, check, agent, w);
    await newChatSessionLate(js, check, agent, w);
    await newChatNeverStarted(js, check, agent, w);
    await deletedWhileWaiting(js, check, agent, w);
    await underAnotherChatsCard(js, check, agent, w);
    await backWhileRunning(js, check, agent, w);
  } finally {
    /* The held answers are let go and the stand-ins come off before anything
       else is awaited (see t24). */
    agent.releaseSteers();
    agent.uninstall(wins);
    if (kept) await js<unknown>(RESTORE);
  }
}

/* (a) The report. Chat A's turn runs and the person types a follow-up the
   turn cannot take, so it is queued; then they open chat B, and A's turn
   ends while they read B. */
async function openedAnother(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const a = `${PREFIX}a-a`;
  const b = `${PREFIX}b-a`;
  const first = "smoke t26: the question that starts chat A's turn";
  const follow = "smoke t26: a follow-up typed in chat A while its turn ran";
  agent.ready(a, loaded(a, turns("A", 1)));
  agent.ready(b, loaded(b, turns("B", 1)));
  await js<boolean>(RESET);
  const mark = agent.sent.length;
  const onA = await land(js, a, "smoke t26: chat A");
  const turn = await startTurn(js, agent, first);
  agent.steer = "refuse";
  const typed = await typeAndEnter(js, follow);
  const onB = await land(js, b, "smoke t26: chat B");
  const inB = await js<View>(VIEW);
  check(
    "T26: a message queued in a chat is shown in that chat's queue only, not in another chat's",
    onA && !!turn && queuedFollowUp(typed, follow) && onB && has(inB, "B answer 1") && inB.queued.length === 0 && inB.tray.length === 0,
    `turn=${turn} typed=${show(typed)} inB=${show(inB)}`,
  );
  if (turn) await frame(js, w, { turnId: turn, kind: "done" });
  const ended = await js<View>(VIEW);
  const away = agent.chats(mark);
  check(
    "T26: when that chat's turn ends while another chat is open, the message is not sent into the open chat",
    away.length === 1 && away[0]!.text === first && away[0]!.sessionId === a
      && ended.sessionId === b && !ended.rows.includes(`user:${follow}`) && ended.tray.length === 0,
    `chats=${show(away)} ended=${show(ended)}`,
  );
  const back = await land(js, a, "smoke t26: chat A");
  const after = await js<View>(VIEW);
  const all = agent.chats(mark);
  check(
    "T26: back in the chat it was typed in, the message runs there, with that chat's session, shown in its transcript",
    back && all.length === 2 && all[1]!.text === follow && all[1]!.sessionId === a
      && after.rows.includes(`user:${follow}`) && after.tray.length === 0,
    `chats=${show(all)} after=${show(after)}`,
  );
}

/* (b) The same, with New chat instead of another chat: the new chat must not
   get the message when A's turn ends, nor after its own first turn. */
async function newChatMeanwhile(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const a = `${PREFIX}a-b`;
  const first = "smoke t26: the question that starts chat A's turn (b)";
  const follow = "smoke t26: a follow-up typed in chat A before New chat";
  const fresh = "smoke t26: the first message of the new chat";
  agent.ready(a, loaded(a, turns("A", 1)));
  await js<boolean>(RESET);
  const mark = agent.sent.length;
  const onA = await land(js, a, "smoke t26: chat A (b)");
  const turn = await startTurn(js, agent, first);
  agent.steer = "refuse";
  const typed = await typeAndEnter(js, follow);
  const started = await newChat(js);
  if (turn) await frame(js, w, { turnId: turn, kind: "done" });
  const inNew = await js<View>(VIEW);
  await typeAndEnter(js, fresh);
  await settle(js);
  const away = agent.chats(mark);
  check(
    "T26: a new chat opened meanwhile gets neither that message nor its tray when A's turn ends, and its own first message goes alone",
    onA && !!turn && queuedFollowUp(typed, follow) && started && inNew.tray.length === 0 && !inNew.rows.includes(`user:${follow}`)
      && away.length === 2 && away[0]!.text === first && away[1]!.text === fresh && away[1]!.sessionId === null,
    `turn=${turn} inNew=${show(inNew)} chats=${show(away)}`,
  );
  const back = await land(js, a, "smoke t26: chat A (b)");
  const all = agent.chats(mark);
  check(
    "T26: back in chat A after the new chat, the message runs in A",
    back && all.length === 3 && all[2]!.text === follow && all[2]!.sessionId === a,
    `chats=${show(all)}`,
  );
}

/* (c) Chat B runs a turn of its own after the person opens it, so A's turn is
   no longer the window's last one, and B's turn ends after A's. The queue used
   to drain behind whichever turn ended on screen. */
async function otherChatsTurn(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const a = `${PREFIX}a-c`;
  const b = `${PREFIX}b-c`;
  const first = "smoke t26: the question that starts chat A's turn (c)";
  const follow = "smoke t26: a follow-up typed in chat A, then B ran a turn";
  const inB = "smoke t26: the question that starts chat B's turn";
  agent.ready(a, loaded(a, turns("A", 1)));
  agent.ready(b, loaded(b, turns("B", 1)));
  await js<boolean>(RESET);
  const mark = agent.sent.length;
  const onA = await land(js, a, "smoke t26: chat A (c)");
  const turnA = await startTurn(js, agent, first);
  agent.steer = "refuse";
  const typed = await typeAndEnter(js, follow);
  const onB = await land(js, b, "smoke t26: chat B (c)");
  const turnB = await startTurn(js, agent, inB);
  if (turnA) await frame(js, w, { turnId: turnA, kind: "done" });
  if (turnB) await frame(js, w, { turnId: turnB, kind: "done" });
  const ended = await js<View>(VIEW);
  const away = agent.chats(mark);
  const back = await land(js, a, "smoke t26: chat A (c)");
  const all = agent.chats(mark);
  check(
    "T26: a turn of the chat on screen ending does not run another chat's queued message there; it runs in its own chat",
    onA && !!turnA && queuedFollowUp(typed, follow) && onB && !!turnB
      && away.length === 2 && away[1]!.text === inB && away[1]!.sessionId === b && !ended.rows.includes(`user:${follow}`)
      && back && all.length === 3 && all[2]!.text === follow && all[2]!.sessionId === a,
    `turnA=${turnA} turnB=${turnB} ended=${show(ended)} chats=${show(all)}`,
  );
}

/* (d) Two messages typed in chat A, the first still waiting on the agent's
   answer to its steer, the second waiting behind it in the window's steer
   chain, when the person opens chat B. Both are A's: the steer of the second
   used to go out with B's session. */
async function steerInFlight(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const a = `${PREFIX}a-d`;
  const b = `${PREFIX}b-d`;
  const first = "smoke t26: the question that starts chat A's turn (d)";
  const one = "smoke t26: typed in A, its steer still out when B was opened";
  const two = "smoke t26: typed in A right after it";
  agent.ready(a, loaded(a, turns("A", 1)));
  agent.ready(b, loaded(b, turns("B", 1)));
  await js<boolean>(RESET);
  const mark = agent.sent.length;
  const onA = await land(js, a, "smoke t26: chat A (d)");
  const turn = await startTurn(js, agent, first);
  agent.steer = "refuse";
  agent.holdSteers = true;
  const typed = (await typeAndEnterOnly(js, one)) && (await agent.steered(mark, 1)) && (await typeAndEnterOnly(js, two));
  const onB = await land(js, b, "smoke t26: chat B (d)");
  agent.releaseSteers();
  await js<unknown>("STEER.chain");
  await settle(js);
  const inB = await js<View>(VIEW);
  const steers = agent.since(mark).filter((s) => s.channel === "steer");
  check(
    "T26: messages typed in a chat just before another was opened are steered and queued as that chat's, not the open chat's",
    onA && !!turn && typed && onB && steers.length === 2 && steers.every((s) => s.sessionId === a)
      && steers[0]!.text === one && steers[1]!.text === two && inB.tray.length === 0 && inB.queued.length === 0
      && agent.chats(mark).length === 1,
    `turn=${turn} typed=${typed} steers=${show(steers)} inB=${show(inB)} chats=${show(agent.chats(mark))}`,
  );
  if (turn) await frame(js, w, { turnId: turn, kind: "done" });
  const back = await land(js, a, "smoke t26: chat A (d)");
  const after = await js<View>(VIEW);
  const all = agent.chats(mark);
  check(
    "T26: back in that chat the first of them runs there, and the second waits in that chat's queue",
    back && all.length === 2 && all[1]!.text === one && all[1]!.sessionId === a && after.tray.length === 1 && after.tray[0] === two,
    `chats=${show(all)} after=${show(after)}`,
  );
}

/* (e) A steer the turn accepted and never read (the turn ended first) comes
   back at the turn's end as `steer_undelivered`, while the person is in
   another chat. */
async function undeliveredWhileAway(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const a = `${PREFIX}a-e`;
  const b = `${PREFIX}b-e`;
  const first = "smoke t26: the question that starts chat A's turn (e)";
  const late = "smoke t26: a steer A's turn took and ended before reading";
  agent.ready(a, loaded(a, turns("A", 1)));
  agent.ready(b, loaded(b, turns("B", 1)));
  await js<boolean>(RESET);
  const mark = agent.sent.length;
  const onA = await land(js, a, "smoke t26: chat A (e)");
  const turn = await startTurn(js, agent, first);
  agent.steer = "take";
  await typeAndEnter(js, late);
  agent.steer = "refuse";
  const onB = await land(js, b, "smoke t26: chat B (e)");
  if (turn) {
    await frame(js, w, { turnId: turn, kind: "steer_undelivered", payload: { undelivered: [{ text: late, seq: 4 }] } });
    await frame(js, w, { turnId: turn, kind: "done" });
  }
  const inB = await js<View>(VIEW);
  const away = agent.chats(mark);
  const acks = agent.since(mark).filter((s) => s.channel === "ack");
  const back = await land(js, a, "smoke t26: chat A (e)");
  const all = agent.chats(mark);
  check(
    "T26: a steer the turn never read, coming back while another chat is open, waits for its own chat and runs there",
    onA && !!turn && onB && inB.tray.length === 0 && !inB.rows.includes(`user:${late}`) && away.length === 1
      && acks.length === 1 && acks[0]!.sessionId === a
      && back && all.length === 2 && all[1]!.text === late && all[1]!.sessionId === a,
    `turn=${turn} inB=${show(inB)} acks=${show(acks)} chats=${show(all)}`,
  );
}

/* (f) A new chat's first turn has not reported its session yet when the person
   queues a follow-up there and opens chat B; the session comes after, then the
   turn ends. The chat appears in the list, and opening it runs the follow-up
   in it. */
async function newChatSessionLate(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const fresh = `${PREFIX}new-f`;
  const b = `${PREFIX}b-f`;
  const first = "smoke t26: the first message of a new chat (f)";
  const follow = "smoke t26: queued before the new chat had its session";
  agent.ready(fresh, loaded(fresh, turns("NEW", 1)));
  agent.ready(b, loaded(b, turns("B", 1)));
  await js<boolean>(RESET);
  const mark = agent.sent.length;
  const started = await newChat(js);
  const turn = await startTurn(js, agent, first);
  const typed = await typeAndEnter(js, follow);
  const onB = await land(js, b, "smoke t26: chat B (f)");
  if (turn) {
    await frame(js, w, { turnId: turn, kind: "session_id", payload: { sessionId: fresh } });
    await frame(js, w, { turnId: turn, kind: "done" });
  }
  const inB = await js<View>(VIEW);
  const away = agent.chats(mark);
  const back = await land(js, fresh, "smoke t26: the new chat (f)");
  const all = agent.chats(mark);
  check(
    "T26: a follow-up queued before a new chat had its session waits for that chat, not the chat opened meanwhile, and runs there",
    started && !!turn && queuedFollowUp(typed, follow) && onB && inB.tray.length === 0 && away.length === 1
      && back && all.length === 2 && all[1]!.text === follow && all[1]!.sessionId === fresh,
    `turn=${turn} typed=${show(typed)} inB=${show(inB)} chats=${show(all)}`,
  );
}

/* (g) The same, but the new chat's first turn fails before it reports a
   session, so there is no chat to go back to. The message is not sent
   anywhere, and the person is told. */
async function newChatNeverStarted(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const b = `${PREFIX}b-g`;
  const first = "smoke t26: the first message of a new chat that never starts";
  const follow = "smoke t26: queued in a new chat that never started";
  agent.ready(b, loaded(b, turns("B", 1)));
  await js<boolean>(RESET);
  const mark = agent.sent.length;
  const started = await newChat(js);
  const turn = await startTurn(js, agent, first);
  const typed = await typeAndEnter(js, follow);
  const onB = await land(js, b, "smoke t26: chat B (g)");
  if (turn) await frame(js, w, { turnId: turn, kind: "error", error: "smoke t26: the first turn failed before it began" });
  const inB = await js<View>(VIEW);
  const all = agent.chats(mark);
  check(
    "T26: a follow-up queued in a new chat whose first turn never started is sent nowhere, and a toast says so",
    started && !!turn && queuedFollowUp(typed, follow) && onB && all.length === 1 && inB.tray.length === 0
      && !inB.rows.includes(`user:${follow}`) && inB.toasts.some((t) => t.startsWith("Queued message not sent")),
    `turn=${turn} inB=${show(inB)} chats=${show(all)}`,
  );
}

/* (h) Chat A's turn ended while the person was in chat B, with a follow-up
   waiting for A; then A is deleted. The message goes with it: it runs in no
   other chat. */
async function deletedWhileWaiting(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const a = `${PREFIX}a-h`;
  const b = `${PREFIX}b-h`;
  const c = `${PREFIX}c-h`;
  const first = "smoke t26: the question that starts chat A's turn (h)";
  const follow = "smoke t26: a follow-up for chat A, which is deleted";
  agent.ready(a, loaded(a, turns("A", 1)));
  agent.ready(b, loaded(b, turns("B", 1)));
  agent.ready(c, loaded(c, turns("C", 1)));
  await js<boolean>(RESET);
  const mark = agent.sent.length;
  const onA = await land(js, a, "smoke t26: chat A (h)");
  const turn = await startTurn(js, agent, first);
  agent.steer = "refuse";
  const typed = await typeAndEnter(js, follow);
  const onB = await land(js, b, "smoke t26: chat B (h)");
  if (turn) await frame(js, w, { turnId: turn, kind: "done" });
  await js<boolean>(`(() => { act(${q(`del:${a}`)}); return true; })()`);
  await settle(js);
  const deleted = agent.since(mark).some((s) => s.channel === "delete" && s.sessionId === a);
  const fresh = await newChat(js);
  const onC = await land(js, c, "smoke t26: chat C (h)");
  const kept = await js<boolean | null>(`typeof QUEUES !== 'undefined' ? QUEUES.has(${q(a)}) : null`);
  const all = agent.chats(mark);
  check(
    "T26: a deleted chat's waiting message goes with it and runs in no other chat",
    onA && !!turn && queuedFollowUp(typed, follow) && onB && deleted && fresh && onC && kept === false
      && all.length === 1 && all[0]!.text === first,
    `turn=${turn} deleted=${deleted} kept=${kept} chats=${show(all)}`,
  );
}

/* (i) Chat A's turn runs while the person is in chat B, where nothing runs,
   and A's turn asks for an approval. Its card used to come up in B, so Enter
   there took the steer path and the message waited on A's turn. Q60: A's
   card is A's, B shows none, so a message typed in B is B's own and runs in
   B at once: no steer, nothing queued behind another chat's turn. */
async function underAnotherChatsCard(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const a = `${PREFIX}a-i`;
  const b = `${PREFIX}b-i`;
  const first = "smoke t26: the question that starts chat A's turn (i)";
  const typed = "smoke t26: typed in B under chat A's approval card";
  agent.ready(a, loaded(a, turns("A", 1)));
  agent.ready(b, loaded(b, turns("B", 1)));
  await js<boolean>(RESET);
  const mark = agent.sent.length;
  const onA = await land(js, a, "smoke t26: chat A (i)");
  const turn = await startTurn(js, agent, first);
  const onB = await land(js, b, "smoke t26: chat B (i)");
  const asked = await js<boolean>(`(() => {
    onApprovalEvent({approvalId: ${q(`${PREFIX}approval-i`)}, tool: 'os.shell.run', category: 'shell', reason: 'smoke t26',
      preview: 'echo smoke t26', sessionId: ${q(a)}});
    return !S.pending && PENDING_APPROVALS.get(${q(a)}) === ${q(`${PREFIX}approval-i`)} && !document.getElementById('apprcard');
  })()`);
  agent.steer = "refuse";
  const sentNow = await typeAndEnter(js, typed);
  const all = agent.chats(mark);
  const steers = agent.since(mark).filter((s) => s.channel === "steer");
  if (turn) await frame(js, w, { turnId: turn, kind: "done" });
  check(
    "T26: another chat's approval is not drawn in a chat that runs no turn, and a message typed there runs in that chat at once",
    onA && !!turn && onB && asked && steers.length === 0 && !queuedFollowUp(sentNow, typed)
      && all.length === 2 && all[1]!.text === typed && all[1]!.sessionId === b && sentNow.rows.includes(`user:${typed}`),
    `turn=${turn} asked=${asked} steers=${show(steers)} sent=${show(sentNow)} chats=${show(all)}`,
  );
}

/* (j) The person leaves chat A while its turn runs, with a follow-up queued,
   runs a turn in chat B, and comes back to A before A's turn ends. A's tray
   has the follow-up again. A's turn, no longer the window's last one, ends,
   and the follow-up runs in A once the chat has reloaded. */
async function backWhileRunning(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const a = `${PREFIX}a-j`;
  const b = `${PREFIX}b-j`;
  const first = "smoke t26: the question that starts chat A's turn (j)";
  const follow = "smoke t26: a follow-up typed in chat A, which the person came back to";
  const inB = "smoke t26: the question that starts chat B's turn (j)";
  agent.ready(a, loaded(a, turns("A", 1)));
  agent.ready(b, loaded(b, turns("B", 1)));
  await js<boolean>(RESET);
  const mark = agent.sent.length;
  const onA = await land(js, a, "smoke t26: chat A (j)");
  const turnA = await startTurn(js, agent, first);
  agent.steer = "refuse";
  const typed = await typeAndEnter(js, follow);
  const onB = await land(js, b, "smoke t26: chat B (j)");
  const turnB = await startTurn(js, agent, inB);
  const back = await land(js, a, "smoke t26: chat A (j)");
  const inA = await js<View>(VIEW);
  if (turnA) await frame(js, w, { turnId: turnA, kind: "done" });
  await settle(js);
  const after = await js<View>(VIEW);
  const all = agent.chats(mark);
  check(
    "T26: back in a chat whose turn still runs, its queued message is in its tray, and runs there when that turn ends",
    onA && !!turnA && queuedFollowUp(typed, follow) && onB && !!turnB && back && inA.busy && inA.tray.includes(follow)
      && all.length === 3 && all[2]!.text === follow && all[2]!.sessionId === a && after.rows.includes(`user:${follow}`),
    `turnA=${turnA} turnB=${turnB} inA=${show(inA)} chats=${show(all)} after=${show(after)}`,
  );
}
