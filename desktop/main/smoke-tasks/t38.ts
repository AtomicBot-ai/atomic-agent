import { BrowserWindow } from "electron";

/**
 * Release-fix checks for backlog item 38 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=38`.
 *
 * 38 — a chat opened again while its turn ran showed "this session has no
 * turns yet" and "a turn is still running here — the reply lands when it
 * finishes", without the message just sent or anything of the reply (Nadya,
 * on a build with 1a407f45: a message in a new chat, then another chat and a
 * message there, then back in the first). The agent stores a turn when it
 * ends, and the window dropped the turn's rows with the chat and every frame
 * of it after that. Now the chat shows the turn: its message, what it did so
 * far (what came while the chat was not open too), and the rest streams on
 * into it. A turn that ended meanwhile is read from the store, once; a first
 * turn that failed shows the message and why, with no card left spinning;
 * and on a local model that serves one chat at a time, a chat waiting while
 * another one gets its words says so. The review cases: the plan bar goes
 * with the stance its own turn started in, a steer keeps one bubble, opening
 * a chat after many calls paints a few times, and Clear Transcript keeps the
 * turn that is running.
 *
 * Nothing reaches the agent. As in t26 and t27, the window's own IPC (asked
 * before ipcMain's; a probe proves it first) answers the chat, the session
 * list and the transcript fetch, every other call a message can make, and the
 * local server's /props read. Those are recorded, never forwarded. Chats are
 * opened by clicking their sidebar rows, messages are typed into the composer
 * and sent with Enter, and a turn's frames come on the real agent:chat
 * channel. What the check staged comes back out, and the window is put back
 * as it was.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Sent = { sessionId: string | null; text: string };
type View = {
  sessionId: string; agentSession: string | null; busy: boolean; stop: boolean;
  rows: string[]; working: string | null; errs: string[]; lastErr: boolean;
  spinning: number; planBars: number; steered: string[];
};
type Handler = (event: unknown, arg: unknown) => unknown;
type Listed = { id: string; turnCount: number; title: string | null; updatedAt: number };

const PREFIX = "smoke-t38-";
const PROBE = `${PREFIX}probe`;
const QUIET = "smoke t38: not answered while the check runs";
const WAITING = "Waiting for the local model · another chat is using it";
const q = (v: unknown) => JSON.stringify(v);
const show = (x: unknown) => JSON.stringify(x);

/* Finished turns as the store keeps them: a question, then its reply. */
const turns = (tag: string, n: number) => Array.from({ length: n }, (_, i) => [
  { kind: "user", text: `smoke t38: ${tag} question ${i + 1}` },
  { kind: "assistant_reply", text: `smoke t38: ${tag} answer ${i + 1}` },
]).flat();
const listed = (id: string, turnCount: number, title: string | null = null): Listed =>
  ({ id, turnCount, title, updatedAt: Date.now() });

/** The agent as this check needs it: every call a message can make, on the window's own IPC. */
class StandIn {
  readonly sent: Sent[] = [];
  /** The turn ids agent:chat hands out, in order; with none left it refuses the turn. */
  readonly turns: string[] = [];
  /** Rows the session list carries, ahead of the agent's own. */
  rows: Listed[] = [];
  /** Transcripts the session fetch answers, by id. */
  readonly transcripts = new Map<string, unknown[]>();
  /** The request slots the local server's /props reports. */
  slots: number | null = null;
  /** How many times /props was read. */
  props = 0;
  /** How agent:steer answers: the turn takes it, or cannot. */
  steer: "take" | "refuse" = "refuse";

  constructor(private readonly real: unknown[]) {}

  readonly chat: Handler = (_e, payload) => {
    const p = (payload ?? {}) as { messages?: Array<{ content?: unknown }>; sessionId?: unknown };
    this.sent.push({ sessionId: typeof p.sessionId === "string" ? p.sessionId : null, text: String(p.messages?.[0]?.content ?? "") });
    const turnId = this.turns.shift();
    return turnId ? { ok: true, turnId } : { ok: false, error: "smoke t38: no turn staged" };
  };

  readonly sessions: Handler = () => ({ ok: true, data: { sessions: [...this.rows, ...this.real], smokeT38: true } });

  readonly session: Handler = (_e, id) => {
    const sid = typeof id === "string" ? id : "";
    if (sid === PROBE) return { ok: true, data: { id: sid, turns: [], smokeT38: true } };
    const list = this.transcripts.get(sid);
    // Anything else (a real row being named, the context chip) is not part of the check.
    return list ? { ok: true, data: { id: sid, turns: list, metadata: {} } } : { ok: false, error: QUIET };
  };

  readonly llamaProps: Handler = () => {
    this.props += 1;
    return { ok: true, n_ctx: 32768, model: null, slots: this.slots };
  };

  readonly steerTo: Handler = (_e, payload) => {
    const p = (payload ?? {}) as { sessionId?: unknown };
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : null;
    return this.steer === "take" ? { ok: true, steered: true, sessionId }
      : { ok: false, steered: false, error: "smoke t38: the turn is not taking steers" };
  };

  private readonly quiet: Handler = () => ({ ok: false, error: QUIET });
  private readonly noParked: Handler = () => ({ ok: true, data: { undelivered: [], discarded: 0 } });
  private readonly fine: Handler = () => ({ ok: true });
  private readonly nothing: Handler = () => true;

  private channels(): Array<[string, Handler]> {
    return [
      ["agent:chat", this.chat], ["agent:sessions", this.sessions], ["agent:session", this.session],
      ["agent:steer", this.steerTo], ["agent:ackSteers", this.fine], ["agent:cancel", this.nothing],
      ["agent:approve", this.quiet], ["agent:deleteSession", this.quiet], ["agent:undeliveredSteers", this.noParked],
      ["agent:contextPreview", this.quiet], ["cli:chatModelsList", this.quiet], ["agent:llamaProps", this.llamaProps],
    ];
  }

  install(wins: BrowserWindow[]): void {
    for (const x of wins) for (const [ch, fn] of this.channels()) { x.webContents.ipc.removeHandler(ch); x.webContents.ipc.handle(ch, fn); }
  }

  uninstall(wins: BrowserWindow[]): void {
    for (const x of wins) if (!x.isDestroyed()) for (const [ch] of this.channels()) x.webContents.ipc.removeHandler(ch);
  }
}

/* Shared by every probe below. */
const H = String.raw`
  const tick = (ms) => new Promise((res) => setTimeout(res, ms));
  const mine = (x) => typeof x === 'string' && (x.indexOf('smoke-t38-') === 0 || x.indexOf('turn:smoke-t38-') === 0);
  const until = async (ok, ms) => { const t0 = Date.now(); while (!ok() && Date.now() - t0 < (ms || 3000)) await tick(20); return !!ok(); };
  // A chat in the sidebar as the agent's list carries it, already named, so nothing goes off to name it.
  const open = (id, t) => {
    for (let i = SESSIONS.length - 1; i >= 0; i--) if (SESSIONS[i].id === id) SESSIONS.splice(i, 1);
    SESSIONS.unshift({id, t, named: true, titled: true, updatedAt: Date.now(), status: '', turnCount: 2});
    render();
    return click(id);
  };
  // A row the sidebar already shows (a new chat's, from its first message on).
  const click = (id) => {
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
  const landed = (id) => S.sessionId === id && S.agentSession === id && !S.log.some((m) => m.k === 'system' && m.text === 'loading session…');
  const view = () => {
    const label = document.querySelector('#scroller .tk-working .tk-work-t');
    const last = S.log[S.log.length - 1];
    return {sessionId: S.sessionId, agentSession: S.agentSession, busy: !!S.busy,
      stop: !!document.querySelector('#composer .sendbtn.stop'),
      rows: S.log.map((m) => m.k + ':' + String(m.k === 'tool' ? m.name : (m.text || m.approvalId || '')).slice(0, 100)),
      working: label ? label.textContent : null,
      errs: S.log.filter((m) => m.k === 'system' && m.sev === 'err').map((m) => String(m.text || '')),
      lastErr: !!last && last.k === 'system' && last.sev === 'err',
      spinning: document.querySelectorAll('#scroller .card.running').length,
      planBars: document.querySelectorAll('#scroller .planbar').length,
      steered: S.log.filter((m) => m.k === 'user' && m.steered).map((m) => String(m.text || ''))};
  };
`;
const VIEW = `(() => { ${H} return view(); })()`;

/* What a case leaves of this check's own: its turns, rows, read stamps, and
   the fix's own records where the build has them. */
const FORGET = String.raw`
  for (const [turn, sid] of [...RUNNING]) if (mine(turn) || mine(sid)) RUNNING.delete(turn);
  for (const sid of [...PENDING_APPROVALS.keys()]) if (mine(sid)) PENDING_APPROVALS.delete(sid);
  for (const sid of [...ATTN]) if (mine(sid)) ATTN.delete(sid);
  if (typeof QUEUES !== 'undefined') for (const key of [...QUEUES.keys()]) if (mine(key)) QUEUES.delete(key);
  if (typeof FIRST_TURNS !== 'undefined') for (const turn of [...FIRST_TURNS.keys()]) if (mine(turn)) FIRST_TURNS.delete(turn);
  if (typeof PENDING_CHATS !== 'undefined') for (const sid of [...PENDING_CHATS.keys()]) if (mine(sid)) PENDING_CHATS.delete(sid);
  if (typeof LIVE_TURNS !== 'undefined') for (const turn of [...LIVE_TURNS.keys()]) if (mine(turn)) LIVE_TURNS.delete(turn);
`;

/* The window as the check found it; RESTORE puts it back. submit() sends
   nothing while the agent is still starting, so the check says it is up:
   every call a message can make is stood in for anyway. */
const KEEP = `(() => {
  window.__t38keep = {log: S.log, sessionId: S.sessionId, agentSession: S.agentSession, busy: S.busy, pending: S.pending,
    history: S.history, room: S.room, streamId: S.streamId, turnId: S.turnId, reasonId: S.reasonId, stick: S.stick,
    settings: S.settings, overlay: S.overlay, menuOpen: S.menuOpen, slash: S.slash, draft: S.draft, toasts: S.toasts.slice(),
    queued: S.queued.slice(), ahead: STEER.ahead, mine: STEER.mine.slice(), live: S.live.state, gating: BSW.gating, gate: localTurnGate,
    owed: typeof DRAIN_OWED !== 'undefined' ? DRAIN_OWED : null, had: 'turnStartedAt' in S, started: S.turnStartedAt, fz: FZ.live,
    wait: WAIT, stamp: CTX055.stamp, plan: {on: PLAN.on, itemId: PLAN.itemId, sessionId: PLAN.sessionId, startedMode: PLAN.startedMode},
    cfg: LIVE_CONFIG, caps: LIVE_CAPS, want: SWX.want, mode: {known: MODE.known, current: MODE.current},
    slots: typeof LLAMA_SLOTS !== 'undefined' ? Object.assign({}, LLAMA_SLOTS) : null,
    unverified: UNVERIFIED, deferred: DL.deferred};
  // A staged turn's end must not clear a key's badge or activate a parked download (as t27).
  UNVERIFIED = []; DL.deferred = null;
  return true;
})()`;

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
  WAIT = null; if (WAIT_TICK) { clearInterval(WAIT_TICK); WAIT_TICK = 0; }
  FZ.live = []; clearPlanOffer();
  S.draft = ''; const e = document.getElementById('entry'); if (e) e.value = '';
  S.toasts = []; renderToasts();
  ${FORGET}
  render();
  return true;
})()`;

const RESTORE = `(async () => { ${H}
  await tick(150);   // the answers let go just before this are dealt with first
  const k = window.__t38keep; delete window.__t38keep;
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
    LIVE_CONFIG = k.cfg; LIVE_CAPS = k.caps; SWX.want = k.want; MODE.known = k.mode.known; MODE.current = k.mode.current;
    if (k.slots && typeof LLAMA_SLOTS !== 'undefined') Object.assign(LLAMA_SLOTS, k.slots);
    UNVERIFIED = k.unverified; DL.deferred = k.deferred;
  }
  // A wait a staged turn was left in goes; the window's own comes back.
  WAIT = k ? k.wait : null;
  if (!WAIT && WAIT_TICK) { clearInterval(WAIT_TICK); WAIT_TICK = 0; }
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

/** A frame of turn `turnId`, on the real agent:chat channel, dealt with. */
async function frame(js: Js, w: BrowserWindow, turnId: string, kind: string, extra: Record<string, unknown> = {}): Promise<void> {
  w.webContents.send("agent:chat", { turnId, kind, ...extra });
  await settle(js);
}
/** The agent's session_id frame, shaped as agent-client.ts relays it; true once the window has it. */
async function named(js: Js, w: BrowserWindow, turnId: string, sid: string): Promise<boolean> {
  await frame(js, w, turnId, "session_id", { payload: { id: "chatcmpl-smoke-t38", object: "chat.completion.session", session_id: sid } });
  return js<boolean>(`(async () => { ${H} return until(() => RUNNING.get(${q(turnId)}) === ${q(sid)}); })()`);
}
const reasoning = (text: string) => ({ payload: { object: "chat.completion.reasoning_progress", text } });
const tool = (name: string, label: string) => ({ payload: { object: "chat.completion.tool_progress", tool: name, label } });

/** Clicks a staged chat and waits until it is the chat on screen. */
async function land(js: Js, id: string, title: string): Promise<boolean> {
  const ok = await js<boolean>(`(async () => { ${H} return open(${q(id)}, ${q(title)}) && until(() => landed(${q(id)})); })()`);
  await settle(js);
  return ok;
}
/** Clicks the row the sidebar shows for chat `id` (a new chat's) and waits until it is the chat on screen. */
async function back(js: Js, id: string): Promise<boolean> {
  const ok = await js<boolean>(`(async () => { ${H} return click(${q(id)}) && until(() => landed(${q(id)})); })()`);
  await settle(js);
  return ok;
}
/** Starts a new chat from the sidebar. */
async function newChat(js: Js): Promise<boolean> {
  const ok = await js<boolean>(`(async () => { ${H} const ok = newChat(); await tick(150); return ok && S.sessionId === ''; })()`);
  await settle(js);
  return ok;
}
/** A message typed into the chat on screen and sent with Enter; the stand-in runs it as turn `turnId`. */
async function send(js: Js, agent: StandIn, turnId: string, text: string): Promise<boolean> {
  agent.turns.push(turnId);
  const ok = await js<boolean>(`(async () => { ${H} type(${q(text)}); enter(); return until(() => S.turnId === ${q(turnId)}); })()`);
  await settle(js);
  return ok;
}
/** Until the "Working…" line on screen reads `label`, at most `ms`; what it read last. */
function workingReads(js: Js, label: string, ms: number): Promise<string | null> {
  return js<string | null>(`(async () => { ${H}
    const read = () => { const n = document.querySelector('#scroller .tk-working .tk-work-t'); return n ? n.textContent : null; };
    await until(() => read() === ${q(label)}, ${ms});
    return read();
  })()`);
}

const count = (v: View, row: string) => v.rows.filter((r) => r === row).length;
const neverSaid = (v: View) => !v.rows.some((r) => r.includes("no turns yet") || r.includes("still running here"));

export async function checks38(js: Js, check: Check): Promise<void> {
  const wins = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed());
  const w = wins[0] ?? null;
  // The agent's own list, read through the real handler before the stand-ins go on.
  const before = await js<{ ok?: boolean; data?: { sessions?: unknown[] } } | null>("BR.sessions()").catch(() => null);
  const agent = new StandIn(before?.ok && Array.isArray(before.data?.sessions) ? before.data!.sessions! : []);
  let kept = false;
  try {
    agent.install(wins);
    const probe = await js<{ session?: { data?: { smokeT38?: boolean } }; list?: { data?: { smokeT38?: boolean } } } | string>(
      `Promise.all([BR.session(${q(PROBE)}), BR.sessions()]).then(([session, list]) => ({session, list}))`,
    ).catch((e: unknown) => String(e));
    if (!w || typeof probe !== "object" || probe.session?.data?.smokeT38 !== true || probe.list?.data?.smokeT38 !== true) {
      check("T38: stand-ins on the window's IPC answer the session list and the session fetch first", false, `${show(probe)}; nothing was staged`);
      return;
    }
    kept = await js<boolean>(KEEP);
    await theReport(js, check, agent, w);
    await leftAndBackTwice(js, check, agent, w);
    await endedWhileAway(js, check, agent, w);
    await firstTurnFailed(js, check, agent, w);
    await localModelTaken(js, check, agent, w);
    await planStanceOfItsOwn(js, check, agent, w);
    await steerBubbleOnce(js, check, agent, w);
    await paintsOnceOnOpening(js, check, agent, w);
    await clearMidTurn(js, check, agent, w);
  } finally {
    agent.uninstall(wins);
    if (kept) await js<unknown>(RESTORE);
  }
}

/* (a) The report. New chat, a message; New chat, a message; back in the
   first. The agent holds both chats with no stored turn. Then the first
   turn's frames come while it is on screen, and it ends; then the second
   chat is opened again. */
async function theReport(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const a = `${PREFIX}new-a`;
  const b = `${PREFIX}new-b`;
  const turnA = `${PREFIX}turn-new-a`;
  const turnB = `${PREFIX}turn-new-b`;
  const saidA = "smoke t38: the first message of a new chat";
  const saidB = "smoke t38: a message in the chat opened next";
  agent.transcripts.set(a, []);
  agent.transcripts.set(b, []);
  await js<boolean>(RESET);
  const startedA = (await newChat(js)) && (await send(js, agent, turnA, saidA)) && (await named(js, w, turnA, a));
  const startedB = (await newChat(js)) && (await send(js, agent, turnB, saidB)) && (await named(js, w, turnB, b));
  const backA = await back(js, a);
  const inA = await js<View>(VIEW);
  check(
    "T38: back in a new chat whose first turn still runs, its message is there with the reply being written under it, not \"no turns yet\"",
    startedA && startedB && backA && show(inA.rows) === show([`user:${saidA}`, "assistant:"]) && inA.working === "Working…"
      && inA.busy && inA.stop && neverSaid(inA),
    `started=${startedA},${startedB} sent=${show(agent.sent)} back=${backA} inA=${show(inA)}`,
  );

  await frame(js, w, turnA, "reasoning_progress", reasoning("smoke t38: thinking about A"));
  await frame(js, w, turnA, "tool_progress", tool("os.fs.list_dir", '{"path":"."}'));
  await frame(js, w, turnA, "delta", { text: "smoke t38: the answer for A" });
  const streamed = await js<View>(VIEW);
  check(
    "T38: the turn streams on into it: its reasoning, its tool and its reply land under the message",
    show(streamed.rows) === show([`user:${saidA}`, "reason:smoke t38: thinking about A", "tool:os.fs.list_dir", "assistant:smoke t38: the answer for A"])
      && streamed.working === null && streamed.busy,
    show(streamed),
  );

  // The turn ends: the store has it now (with the call's time, which the end's card reconciliation matches on).
  agent.transcripts.set(a, [
    { kind: "user", text: saidA },
    { kind: "assistant_tool_call", tool: "os.fs.list_dir", args: { path: "." }, at: Date.now() },
    { kind: "tool_result", tool: "os.fs.list_dir", status: "ok", summary: "smoke t38: two files", at: Date.now() },
    { kind: "assistant_reply", text: "smoke t38: the answer for A" },
  ]);
  agent.rows = [listed(a, 1, saidA)];
  await frame(js, w, turnA, "done");
  await js<boolean>(`(async () => { ${H} return until(() => !RUNNING.has(${q(turnA)})); })()`);
  await settle(js);
  const ended = await js<View>(VIEW);
  // Without the fix the same holds (the end reloads the stored chat): it guards against showing the turn twice.
  check(
    "T38: when that turn ends, its message and its reply are there once, and the chat is idle",
    count(ended, `user:${saidA}`) === 1 && count(ended, "assistant:smoke t38: the answer for A") === 1
      && !ended.busy && ended.working === null && neverSaid(ended),
    show(ended),
  );

  const backB = await back(js, b);
  const inB = await js<View>(VIEW);
  check(
    "T38: the other chat, opened again while its turn runs, shows its own message and its reply being written",
    backB && show(inB.rows) === show([`user:${saidB}`, "assistant:"]) && inB.busy && inB.stop && !!inB.working && neverSaid(inB),
    `back=${backB} inB=${show(inB)}`,
  );
  await frame(js, w, turnB, "done");
}

/* (b) A later turn of a chat already on the list. Some of it comes while the
   chat is on screen, some while another chat is; the person comes back, goes
   away again while more comes, and comes back again. */
async function leftAndBackTwice(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const a = `${PREFIX}a-b`;
  const b = `${PREFIX}b-b`;
  const turnA = `${PREFIX}turn-a-b`;
  const said = "smoke t38: a later question in chat A";
  agent.transcripts.set(a, turns("A", 1));
  agent.transcripts.set(b, turns("B", 1));
  agent.rows = [listed(a, 2, "smoke t38: chat A"), listed(b, 2, "smoke t38: chat B")];
  await js<boolean>(RESET);
  const onA = (await land(js, a, "smoke t38: chat A")) && (await send(js, agent, turnA, said));
  await frame(js, w, turnA, "reasoning_progress", reasoning("smoke t38: first thought"));
  await frame(js, w, turnA, "delta", { text: "smoke t38: part one. " });
  const away = await land(js, b, "smoke t38: chat B");
  await frame(js, w, turnA, "tool_progress", tool("os.fs.read_file", '{"path":"notes.txt"}'));
  await frame(js, w, turnA, "delta", { text: "smoke t38: part two. " });
  const inB = await js<View>(VIEW);
  const back1 = await land(js, a, "smoke t38: chat A");
  const once = await js<View>(VIEW);
  const stored = ["user:smoke t38: A question 1", "assistant:smoke t38: A answer 1", `user:${said}`];
  check(
    "T38: a later turn of a chat left and opened again: the stored chat, then that turn's message and all it did, also what came while the chat was not open",
    onA && away && !inB.rows.some((r) => r.includes("part two")) && back1
      && show(once.rows) === show([...stored, "reason:smoke t38: first thought", "tool:os.fs.read_file", "assistant:smoke t38: part one. smoke t38: part two. "])
      && once.busy && once.stop && neverSaid(once),
    `onA=${onA} away=${away} inB=${show(inB.rows)} back=${back1} once=${show(once)}`,
  );

  const away2 = await land(js, b, "smoke t38: chat B");
  await frame(js, w, turnA, "reasoning_progress", reasoning(" and more"));
  await frame(js, w, turnA, "delta", { text: "smoke t38: part three." });
  const back2 = await land(js, a, "smoke t38: chat A");
  const twice = await js<View>(VIEW);
  check(
    "T38: left and opened again a second time, all of it is there once, in order, and it streams on",
    away2 && back2
      && show(twice.rows) === show([...stored, "reason:smoke t38: first thought and more", "tool:os.fs.read_file",
        "assistant:smoke t38: part one. smoke t38: part two. smoke t38: part three."])
      && twice.busy && neverSaid(twice),
    `away=${away2} back=${back2} twice=${show(twice)}`,
  );
  agent.transcripts.set(a, [...turns("A", 1), { kind: "user", text: said },
    { kind: "assistant_tool_call", tool: "os.fs.read_file", args: { path: "notes.txt" }, at: Date.now() },
    { kind: "tool_result", tool: "os.fs.read_file", status: "ok", summary: "smoke t38: notes", at: Date.now() },
    { kind: "assistant_reply", text: "smoke t38: part one. smoke t38: part two. smoke t38: part three." }]);
  await frame(js, w, turnA, "done");
}

/* (c) A turn ends while its chat is not open; the store has it by then. */
async function endedWhileAway(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const a = `${PREFIX}a-c`;
  const b = `${PREFIX}b-c`;
  const turnA = `${PREFIX}turn-a-c`;
  const said = "smoke t38: a question whose turn ends while chat A is not open";
  agent.transcripts.set(a, turns("A", 1));
  agent.transcripts.set(b, turns("B", 1));
  agent.rows = [listed(a, 2, "smoke t38: chat A (c)"), listed(b, 2, "smoke t38: chat B (c)")];
  await js<boolean>(RESET);
  const onA = (await land(js, a, "smoke t38: chat A (c)")) && (await send(js, agent, turnA, said));
  await frame(js, w, turnA, "delta", { text: "smoke t38: half" });
  const away = await land(js, b, "smoke t38: chat B (c)");
  await frame(js, w, turnA, "delta", { text: " and the rest" });
  agent.transcripts.set(a, [...turns("A", 1), { kind: "user", text: said }, { kind: "assistant_reply", text: "smoke t38: half and the rest" }]);
  await frame(js, w, turnA, "done");
  const backA = await land(js, a, "smoke t38: chat A (c)");
  const after = await js<View>(VIEW);
  // Without the fix the same holds: it guards against the kept turn being shown over the stored one.
  check(
    "T38: a turn that ended while its chat was not open is read from the store, once, and the chat is idle",
    onA && away && backA
      && show(after.rows) === show(["user:smoke t38: A question 1", "assistant:smoke t38: A answer 1", `user:${said}`, "assistant:smoke t38: half and the rest"])
      && !after.busy && after.working === null && neverSaid(after),
    `onA=${onA} away=${away} back=${backA} after=${show(after)}`,
  );
}

/* (d) A new chat's first turn fails while the person is in another chat. The
   agent lost it (the store holds the chat with no turn), or stored it (its
   message, as a classified failure is). Then the chat is opened again. */
async function firstTurnFailed(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const b = `${PREFIX}b-d`;
  agent.transcripts.set(b, turns("B", 1));
  for (const stored of [false, true]) {
    const a = `${PREFIX}new-d-${stored ? "stored" : "lost"}`;
    const turnA = `${PREFIX}turn-d-${stored ? "stored" : "lost"}`;
    const said = `smoke t38: a first message whose turn fails (${stored ? "stored" : "lost"})`;
    agent.transcripts.set(a, []);
    agent.rows = [listed(b, 2, "smoke t38: chat B (d)")];
    await js<boolean>(RESET);
    const started = (await newChat(js)) && (await send(js, agent, turnA, said)) && (await named(js, w, turnA, a));
    const away = await land(js, b, "smoke t38: chat B (d)");
    // A call it made while the chat was not open, which the stream never says the end of.
    await frame(js, w, turnA, "tool_progress", tool("os.fs.list_dir", '{"path":"."}'));
    if (stored) {
      agent.transcripts.set(a, [{ kind: "user", text: said }]);
      agent.rows = [listed(a, 1, said), listed(b, 2, "smoke t38: chat B (d)")];
    }
    await frame(js, w, turnA, "error", { error: "smoke t38: the turn failed", category: "agent" });
    const backA = await back(js, a);
    const after = await js<View>(VIEW);
    check(
      stored
        ? "T38: a new chat whose first turn failed, stored by the agent: opened again, its message is there once, and why the turn failed under it"
        : "T38: a new chat whose first turn failed and was lost by the agent: opened again, its message and its call are there, the call not spinning, and why the turn failed, not \"no turns yet\"",
      started && away && backA && count(after, `user:${said}`) === 1 && after.errs.length === 1 && after.lastErr
        && (stored || after.rows.includes("tool:os.fs.list_dir")) && after.spinning === 0
        && !after.busy && after.working === null && neverSaid(after),
      `started=${started} away=${away} back=${backA} after=${show(after)}`,
    );
  }

  /* The same message as the turn before it ("continue"), and this time the
     agent lost the turn: the stored chat ends on the earlier one. */
  const c = `${PREFIX}c-d`;
  const turnC = `${PREFIX}turn-c-d`;
  const again = "smoke t38: continue";
  agent.transcripts.set(c, [{ kind: "user", text: again }, { kind: "assistant_reply", text: "smoke t38: the earlier answer" }]);
  agent.rows = [listed(c, 1, "smoke t38: chat C (d)"), listed(b, 2, "smoke t38: chat B (d)")];
  await js<boolean>(RESET);
  const sent = (await land(js, c, "smoke t38: chat C (d)")) && (await send(js, agent, turnC, again));
  const away = await land(js, b, "smoke t38: chat B (d)");
  await frame(js, w, turnC, "error", { error: "smoke t38: the retry failed", category: "agent" });
  const backC = await land(js, c, "smoke t38: chat C (d)");
  const after = await js<View>(VIEW);
  check(
    "T38: a failed turn the agent lost, sent with the same words as the stored turn before it, shows both messages and why it failed",
    sent && away && backC && count(after, `user:${again}`) === 2 && after.rows[1] === "assistant:smoke t38: the earlier answer"
      && after.errs.length === 1 && after.lastErr && !after.busy,
    `sent=${sent} away=${away} back=${backC} after=${show(after)}`,
  );
}

/* (e) Two chats run at once on a local model server that answers one at a
   time (/props: one slot). The person is in the chat whose turn has nothing
   yet while the other chat's turn gets its words; then the other one goes
   quiet. Then the same with two slots. */
async function localModelTaken(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const a = `${PREFIX}a-e`;
  const b = `${PREFIX}b-e`;
  const turnA = `${PREFIX}turn-a-e`;
  const turnB = `${PREFIX}turn-b-e`;
  agent.transcripts.set(a, turns("A", 1));
  agent.transcripts.set(b, turns("B", 1));
  agent.rows = [listed(a, 2, "smoke t38: chat A (e)"), listed(b, 2, "smoke t38: chat B (e)")];
  agent.slots = 1;
  await js<boolean>(RESET);
  // The local route, in the window's copy of the config only; nothing is written. The server's address is a stand-in too.
  await js<boolean>(`(() => {
    const llm = (LIVE_CONFIG && LIVE_CONFIG.llm) || {};
    LIVE_CONFIG = Object.assign({}, LIVE_CONFIG || {}, {llm: Object.assign({}, llm, {activeTextProvider: 'local-llama'})});
    LIVE_CAPS = Object.assign({}, LIVE_CAPS || {}, {llama: Object.assign({}, (LIVE_CAPS && LIVE_CAPS.llama) || {}, {url: 'http://127.0.0.1:9/smoke-t38'})});
    SWX.want = null;
    if (typeof LLAMA_SLOTS !== 'undefined') { LLAMA_SLOTS.n = null; LLAMA_SLOTS.busy = false; }
    render();
    return true;
  })()`);
  const startedA = (await land(js, a, "smoke t38: chat A (e)")) && (await send(js, agent, turnA, "smoke t38: chat A's question (e)"));
  const startedB = (await land(js, b, "smoke t38: chat B (e)")) && (await send(js, agent, turnB, "smoke t38: chat B's question, which waits (e)"));
  await frame(js, w, turnA, "delta", { text: "smoke t38: A is answering" });
  const taken = await workingReads(js, WAITING, 2500);
  // A goes quiet (a tool running there, say): nothing tells the wait apart any more.
  const quiet = await workingReads(js, "Working…", 7000);
  check(
    "T38: on a local model that answers one chat at a time, the chat waiting while another chat gets its words says so, and only while it does",
    startedA && startedB && taken === WAITING && quiet === "Working…",
    `started=${startedA},${startedB} /props reads=${agent.props} while A answers=${show(taken)} once A is quiet=${show(quiet)}`,
  );

  agent.slots = 2;
  const reread = (await land(js, a, "smoke t38: chat A (e)")) && (await land(js, b, "smoke t38: chat B (e)"));
  await frame(js, w, turnA, "delta", { text: " and more" });
  const two = await workingReads(js, WAITING, 2500);
  await frame(js, w, turnB, "delta", { text: "smoke t38: B's words" });
  const gone = await js<boolean>(`(async () => { ${H} return until(() => !document.querySelector('#scroller .tk-working'), 2000); })()`);
  /* It guards against saying so where the server takes both chats. It fails
     without the fix as well, for another reason: a chat opened again had no
     reply row then, so no "Working…" line at all. */
  check(
    "T38: where the local model takes two chats at once it stays Working…, and the line goes at the chat's own first words",
    reread && two === "Working…" && gone,
    `reread=${reread} with two slots=${show(two)} gone=${gone}`,
  );
  await frame(js, w, turnA, "done");
  await frame(js, w, turnB, "done");
}

/* (f) The plan hand-off bar is offered at the end of a turn that started in
   plan mode. Chat A's turn starts in another mode; the person opens chat B,
   switches to plan mode there (the window's stance) and sends; then back in
   A, A's turn ends; then B's. The stance is the window's copy only: nothing
   goes to the agent. */
async function planStanceOfItsOwn(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const a = `${PREFIX}a-f`;
  const b = `${PREFIX}b-f`;
  const turnA = `${PREFIX}turn-a-f`;
  const turnB = `${PREFIX}turn-b-f`;
  agent.transcripts.set(a, turns("A", 1));
  agent.transcripts.set(b, turns("B", 1));
  agent.rows = [listed(a, 2, "smoke t38: chat A (f)"), listed(b, 2, "smoke t38: chat B (f)")];
  await js<boolean>(RESET);
  const stance = (mode: string) => js<boolean>(`(() => { MODE.known = true; MODE.current = ${q(mode)}; SWX.want = null; render(); return true; })()`);
  const startedA = (await stance("default")) && (await land(js, a, "smoke t38: chat A (f)"))
    && (await send(js, agent, turnA, "smoke t38: a task in chat A (f)"));
  const startedB = (await land(js, b, "smoke t38: chat B (f)")) && (await stance("plan"))
    && (await send(js, agent, turnB, "smoke t38: plan something in chat B (f)"));
  const backA = await land(js, a, "smoke t38: chat A (f)");
  await frame(js, w, turnA, "delta", { text: "smoke t38: A's answer" });
  await frame(js, w, turnA, "done");
  const inA = await js<View>(VIEW);
  const backB = await land(js, b, "smoke t38: chat B (f)");
  await frame(js, w, turnB, "delta", { text: "smoke t38: B's plan" });
  await frame(js, w, turnB, "done");
  const inB = await js<View>(VIEW);
  check(
    "T38: the plan bar comes under the turn that started in plan mode, not under another chat's turn that ended after it",
    startedA && startedB && backA && backB && inA.rows.includes("assistant:smoke t38: A's answer") && inA.planBars === 0
      && inB.rows.includes("assistant:smoke t38: B's plan") && inB.planBars === 1,
    `started=${startedA},${startedB} back=${backA},${backB} inA=${show(inA)} inB=${show(inB)}`,
  );
  await js<boolean>("(() => { clearPlanOffer(); render(); return true; })()");
}

/* (g) A steer typed into chat A's running turn has its bubble at once. The
   person opens chat B before the agent applies it; B's turn runs and ends
   there (a turn's end clears the window's list of steers it sent), and A's
   steer_applied frame comes while A is not open. Then back in A. */
async function steerBubbleOnce(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const a = `${PREFIX}a-g`;
  const b = `${PREFIX}b-g`;
  const turnA = `${PREFIX}turn-a-g`;
  const turnB = `${PREFIX}turn-b-g`;
  const steer = "smoke t38: a steer into chat A's turn";
  agent.transcripts.set(a, turns("A", 1));
  agent.transcripts.set(b, turns("B", 1));
  agent.rows = [listed(a, 2, "smoke t38: chat A (g)"), listed(b, 2, "smoke t38: chat B (g)")];
  await js<boolean>(RESET);
  const startedA = (await land(js, a, "smoke t38: chat A (g)")) && (await send(js, agent, turnA, "smoke t38: a question in chat A (g)"));
  agent.steer = "take";
  const steered = await js<string[]>(`(async () => { ${H} type(${q(steer)}); enter(); await tick(100); await STEER.chain; return view().steered; })()`);
  agent.steer = "refuse";
  const startedB = (await land(js, b, "smoke t38: chat B (g)")) && (await send(js, agent, turnB, "smoke t38: a question in chat B (g)"));
  await frame(js, w, turnB, "done");
  await frame(js, w, turnA, "steer_applied", { text: steer, stepIndex: 1 });
  const backA = await land(js, a, "smoke t38: chat A (g)");
  const inA = await js<View>(VIEW);
  check(
    "T38: a steer a chat's turn took while the chat was open has one bubble when it is opened again, after another chat's turn ended meanwhile",
    startedA && show(steered) === show([steer]) && startedB && backA && show(inA.steered) === show([steer]) && inA.busy,
    `started=${startedA},${startedB} steered=${show(steered)} back=${backA} inA=${show(inA)}`,
  );
  await frame(js, w, turnA, "done");
}

/* (h) Chat A's turn makes forty tool calls while the person is in chat B.
   Opening A draws every one of them, and paints the transcript a few times,
   not once per call. */
async function paintsOnceOnOpening(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const a = `${PREFIX}a-h`;
  const b = `${PREFIX}b-h`;
  const turnA = `${PREFIX}turn-a-h`;
  const calls = 40;
  agent.transcripts.set(a, turns("A", 1));
  agent.transcripts.set(b, turns("B", 1));
  agent.rows = [listed(a, 2, "smoke t38: chat A (h)"), listed(b, 2, "smoke t38: chat B (h)")];
  await js<boolean>(RESET);
  const startedA = (await land(js, a, "smoke t38: chat A (h)")) && (await send(js, agent, turnA, "smoke t38: a long task in chat A (h)"));
  const away = await land(js, b, "smoke t38: chat B (h)");
  for (let i = 0; i < calls; i++) w.webContents.send("agent:chat", { turnId: turnA, kind: "tool_progress", ...tool("os.fs.list_dir", `{"path":"dir-${i}"}`) });
  await frame(js, w, turnA, "delta", { text: "smoke t38: still working" });
  // The transcript's paints, counted while A opens.
  await js<boolean>(`(() => {
    window.__t38paint = {real: renderContent, n: 0};
    renderContent = function () { window.__t38paint.n++; return window.__t38paint.real.apply(this, arguments); };
    return true;
  })()`);
  let backA = false;
  let paints = -1;
  try {
    backA = await land(js, a, "smoke t38: chat A (h)");
  } finally {
    paints = await js<number>("(() => { const p = window.__t38paint; delete window.__t38paint; if (p) renderContent = p.real; return p ? p.n : -1; })()");
  }
  const inA = await js<View>(VIEW);
  check(
    "T38: a chat opened again after forty tool calls came while it was not open shows all of them, and paints a few times, not once per call",
    startedA && away && backA && count(inA, "tool:os.fs.list_dir") === calls && inA.rows.includes("assistant:smoke t38: still working")
      && paints >= 1 && paints <= 10,
    `started=${startedA} away=${away} back=${backA} paints=${paints} tools=${count(inA, "tool:os.fs.list_dir")}`,
  );
  await frame(js, w, turnA, "done");
}

/* (i) Clear Transcript in a chat whose turn is running: the history goes,
   the turn's own rows stay, and it streams on there. */
async function clearMidTurn(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const a = `${PREFIX}a-i`;
  const turnA = `${PREFIX}turn-a-i`;
  const said = "smoke t38: a question in chat A, then Clear Transcript (i)";
  agent.transcripts.set(a, turns("A", 1));
  agent.rows = [listed(a, 2, "smoke t38: chat A (i)")];
  await js<boolean>(RESET);
  const startedA = (await land(js, a, "smoke t38: chat A (i)")) && (await send(js, agent, turnA, said));
  await frame(js, w, turnA, "delta", { text: "smoke t38: before the clear" });
  await js<boolean>("(() => { act('clear'); return true; })()");
  await frame(js, w, turnA, "delta", { text: " and after it" });
  const after = await js<View>(VIEW);
  check(
    "T38: Clear Transcript while a chat's turn runs clears the history and keeps that turn, which goes on streaming",
    startedA && show(after.rows) === show([`user:${said}`, "assistant:smoke t38: before the clear and after it"]) && after.busy && after.stop,
    `started=${startedA} after=${show(after)}`,
  );
  await frame(js, w, turnA, "done");
}
