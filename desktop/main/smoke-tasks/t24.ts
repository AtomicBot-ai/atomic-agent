import { BrowserWindow } from "electron";

/**
 * Release-fix checks for backlog item 24 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=24`.
 *
 * 24 — a message sent while a chat was still opening went to another chat.
 * openSession points the window at the chat at once (its row, the "loading
 * session…" line) but takes the chat's session only when the transcript is
 * back, and nothing held the composer in between. Enter sent the message with
 * the PREVIOUS chat's session (or a fresh one), steered the previous chat's
 * running turn, or denied its open approval in the words typed here. The same
 * gap had four more ways in: a turn ending under the loading line drained its
 * queued message with that session; a message held at the local model check
 * went out into whatever chat was open by the time the check answered; a new
 * chat's first turn reporting its session after the person had moved on made
 * it the session of the chat they moved to; and a chat that failed to open
 * left the previous session in place for good. Now the message waits in the
 * box until the chat has loaded, and a queued message waits for the chat it
 * was queued in.
 *
 * Nothing reaches the agent. The window's own IPC (asked before ipcMain's, as
 * in t22; a probe proves it first) answers GET /api/sessions/{id}, holding an
 * answer until the check lets it go, and stands in for every call a message can
 * make: the chat, a steer, an approval, a cancel, the context preview, the
 * parked steers and the local model list the gate waits on. Those are recorded,
 * never forwarded. Chats are staged rows opened by clicking them, messages are
 * typed into the composer and sent with Enter, and a turn's frames come on the
 * real agent:chat channel. What the check staged comes back out, and the window
 * is put back as it was.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Sent = { channel: "chat" | "steer" | "approve" | "cancel"; sessionId: string | null; text: string };
type Button = { cls: string; disabled: boolean; title: string };
type View = {
  sessionId: string; agentSession: string | null; busy: boolean; rows: string[];
  draft: string; entry: string | null; button: Button | null; toasts: string[]; queued: string[];
};
type Handler = (event: unknown, arg: unknown) => unknown;

const PREFIX = "smoke-t24-";
const PROBE = `${PREFIX}probe`;
const REFUSAL = "smoke t24: the stand-in runs no turns";
const QUIET = "smoke t24: not answered while the check runs";
const LOADING = "system:loading session…";
const q = (v: unknown) => JSON.stringify(v);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(ok: () => boolean, ms = 3000): Promise<boolean> {
  const t0 = Date.now();
  while (!ok() && Date.now() - t0 < ms) await wait(20);
  return ok();
}

/* Finished turns as the store keeps them: a question, then its reply. */
const turns = (tag: string, n: number) => Array.from({ length: n }, (_, i) => [
  { kind: "user", text: `smoke t24: ${tag} question ${i + 1}` },
  { kind: "assistant_reply", text: `smoke t24: ${tag} answer ${i + 1}` },
]).flat();
const loaded = (id: string, list: unknown[]) => ({ ok: true, data: { id, turns: list } });

/** The agent as this check needs it: every call a message can make, on the window's own IPC. */
class StandIn {
  readonly sent: Sent[] = [];
  /** agent:chat answers with a running turn instead of refusing. */
  turns = false;
  holdModels = false;
  modelsAsked = 0;
  private turnSeq = 0;
  private readonly answers = new Map<string, unknown>();
  private readonly holds = new Map<string, number>();
  private readonly asked = new Map<string, number>();
  private readonly held: Array<{ id: string; answer: (value: unknown) => void }> = [];
  private readonly heldModels: Array<(value: unknown) => void> = [];

  /** GET /api/sessions/{id}: held when asked for with hold(), at once for a ready() chat. */
  readonly session: Handler = (_e, id) => {
    const sid = typeof id === "string" ? id : "";
    if (sid === PROBE) return { ok: true, data: { id: sid, turns: [], smokeT24: true } };
    const n = this.holds.get(sid) ?? 0;
    if (n > 0) {
      this.holds.set(sid, n - 1);
      this.asked.set(sid, (this.asked.get(sid) ?? 0) + 1);
      return new Promise((answer) => { this.held.push({ id: sid, answer }); });
    }
    // Anything else (a row being named, the context chip) is not part of the check.
    return this.answers.has(sid) ? this.answers.get(sid) : { ok: false, error: QUIET };
  };

  readonly chat: Handler = (_e, payload) => {
    const p = (payload ?? {}) as { messages?: Array<{ content?: unknown }>; sessionId?: unknown };
    this.sent.push({ channel: "chat", sessionId: typeof p.sessionId === "string" ? p.sessionId : null,
      text: String(p.messages?.[0]?.content ?? "") });
    return this.turns ? { ok: true, turnId: `${PREFIX}turn-${++this.turnSeq}` } : { ok: false, error: REFUSAL };
  };

  readonly steer: Handler = (_e, payload) => {
    const p = (payload ?? {}) as { sessionId?: unknown; text?: unknown };
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : null;
    this.sent.push({ channel: "steer", sessionId, text: String(p.text ?? "") });
    return { ok: true, steered: true, sessionId };
  };

  readonly approve: Handler = (_e, payload) => {
    const p = (payload ?? {}) as { approvalId?: unknown; decision?: unknown; reason?: unknown };
    this.sent.push({ channel: "approve", sessionId: null, text: `${String(p.approvalId)} ${String(p.decision)}: ${String(p.reason ?? "")}` });
    return { ok: true };
  };

  readonly cancel: Handler = (_e, turnId) => {
    this.sent.push({ channel: "cancel", sessionId: null, text: String(turnId) });
    return true;
  };

  /** The local model list the gate's snapshot asks for; held while holdModels is up. */
  readonly models: Handler = () => {
    this.modelsAsked += 1;
    if (!this.holdModels) return { ok: false, error: QUIET };
    return new Promise((answer) => { this.heldModels.push(answer); });
  };

  private readonly quiet: Handler = () => ({ ok: false, error: QUIET });
  private readonly noParked: Handler = () => ({ ok: true, data: { undelivered: [], discarded: 0 } });

  private channels(): Array<[string, Handler]> {
    return [
      ["agent:session", this.session], ["agent:chat", this.chat], ["agent:steer", this.steer],
      ["agent:approve", this.approve], ["agent:cancel", this.cancel], ["cli:chatModelsList", this.models],
      ["agent:contextPreview", this.quiet], ["agent:undeliveredSteers", this.noParked], ["agent:ackSteers", this.quiet],
    ];
  }

  install(wins: BrowserWindow[]): void {
    for (const x of wins) for (const [ch, fn] of this.channels()) { x.webContents.ipc.removeHandler(ch); x.webContents.ipc.handle(ch, fn); }
  }

  uninstall(wins: BrowserWindow[]): void {
    for (const x of wins) if (!x.isDestroyed()) for (const [ch] of this.channels()) x.webContents.ipc.removeHandler(ch);
  }

  ready(id: string, value: unknown): void { this.answers.set(id, value); }

  hold(id: string): void { this.holds.set(id, (this.holds.get(id) ?? 0) + 1); }

  /** Until `count` loads of `id` are being held, at most three seconds. */
  waitFor(id: string, count: number): Promise<boolean> { return until(() => (this.asked.get(id) ?? 0) >= count); }

  /** Answers the oldest held load of `id`. */
  release(id: string, value: unknown): void {
    const at = this.held.findIndex((h) => h.id === id);
    if (at >= 0) this.held.splice(at, 1)[0]!.answer(value);
  }

  /** The held model list comes back as a failure: the snapshot learns nothing and the gate moves on. */
  releaseModels(): void {
    this.holdModels = false;
    for (const answer of this.heldModels.splice(0)) answer({ ok: false, error: QUIET });
  }

  releaseAll(): void {
    this.holds.clear();
    for (const h of this.held.splice(0)) h.answer({ ok: false, error: "smoke t24: let go at the end of the check" });
    this.releaseModels();
  }

  since(mark: number): Sent[] { return this.sent.slice(mark); }
}

/* Shared by every probe below. */
const H = String.raw`
  const tick = (ms) => new Promise((res) => setTimeout(res, ms));
  const mine = (x) => typeof x === 'string' && x.indexOf('smoke-t24-') === 0;
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
  // The messages queued in chat id, on screen or not (backlog 26 gave every chat its own queue).
  const waiting = (id) => typeof queuedIn === 'function' ? queuedIn(id).slice() : S.queued.slice();
  const view = () => {
    const b = document.querySelector('#composer .sendbtn'), e = document.getElementById('entry');
    return {sessionId: S.sessionId, agentSession: S.agentSession, busy: !!S.busy,
      rows: S.log.map((m) => m.k + ':' + String(m.text || '').slice(0, 80)),
      draft: S.draft, entry: e ? e.value : null,
      button: b ? {cls: b.className, disabled: !!b.disabled, title: b.getAttribute('title') || ''} : null,
      toasts: S.toasts.map((x) => x.t + ' | ' + (x.s || '')), queued: S.queued.slice()};
  };
`;
const VIEW = `(() => { ${H} return view(); })()`;

/* The window as the check found it; RESTORE puts it back. submit() sends
   nothing while the agent is still starting, so the check says it is up:
   every call a message can make is stood in for anyway. */
const KEEP = `(() => {
  window.__t24keep = {log: S.log, sessionId: S.sessionId, agentSession: S.agentSession, busy: S.busy, pending: S.pending,
    history: S.history, room: S.room, streamId: S.streamId, turnId: S.turnId, reasonId: S.reasonId, stick: S.stick,
    settings: S.settings, overlay: S.overlay, menuOpen: S.menuOpen, slash: S.slash, draft: S.draft, toasts: S.toasts.slice(),
    queued: S.queued.slice(), ahead: STEER.ahead, mine: STEER.mine.slice(), live: S.live.state, gating: BSW.gating, gate: localTurnGate,
    had: 'turnStartedAt' in S, started: S.turnStartedAt, fz: FZ.live,
    stamp: CTX055.stamp, plan: {on: PLAN.on, itemId: PLAN.itemId, sessionId: PLAN.sessionId, startedMode: PLAN.startedMode}};
  return true;
})()`;

/* Before each case: an idle composer, an empty box, no toasts, nothing staged
   still running. The local model gate always says "run" here except where a
   case sets window.__t24gate: on this route it waits for the disk snapshot,
   which is the gate's own business and not what these cases are about. */
const RESET = `(() => { ${H}
  S.busy = false; S.pending = null; S.turnId = null; S.streamId = null; S.reasonId = null;
  S.queued.length = 0; STEER.ahead = 0; STEER.mine.length = 0; BSW.gating = false;
  if (typeof OPENING !== 'undefined') OPENING = null;
  if (typeof DRAIN_OWED !== 'undefined') DRAIN_OWED = null;
  window.__t24gate = 'run';
  localTurnGate = () => ({kind: window.__t24gate || 'run'});
  S.settings = null; S.overlay = null; S.menuOpen = null; S.slash = false; S.room = 'chat';
  S.live.state = 'connected';
  S.draft = ''; const e = document.getElementById('entry'); if (e) e.value = '';
  S.toasts = []; renderToasts();
  for (const [turn, sid] of [...RUNNING]) if (mine(turn) || mine(sid)) RUNNING.delete(turn);
  for (const sid of [...PENDING_APPROVALS.keys()]) if (mine(sid)) PENDING_APPROVALS.delete(sid);
  if (typeof QUEUES !== 'undefined') for (const key of [...QUEUES.keys()]) if (mine(key)) QUEUES.delete(key);
  render();
  return true;
})()`;

const RESTORE = `(async () => { ${H}
  await tick(150);   // the answers let go just before this are dealt with first
  const k = window.__t24keep; delete window.__t24keep; delete window.__t24gate;
  if (typeof OPENING !== 'undefined') OPENING = null;
  if (typeof DRAIN_OWED !== 'undefined') DRAIN_OWED = null;
  if (k) {
    localTurnGate = k.gate; BSW.gating = k.gating;
    S.log = k.log; S.sessionId = k.sessionId; S.agentSession = k.agentSession; S.busy = k.busy; S.pending = k.pending;
    S.history = k.history; S.room = k.room; S.streamId = k.streamId; S.turnId = k.turnId; S.reasonId = k.reasonId;
    S.stick = k.stick; S.settings = k.settings; S.overlay = k.overlay; S.menuOpen = k.menuOpen; S.slash = k.slash;
    S.draft = k.draft; S.toasts = k.toasts;
    S.queued.length = 0; S.queued.push(...k.queued); STEER.ahead = k.ahead; STEER.mine.length = 0; STEER.mine.push(...k.mine);
    if (k.live !== 'connected' && S.live.state === 'connected') S.live.state = k.live;
    if (k.had) S.turnStartedAt = k.started; else delete S.turnStartedAt;
    FZ.live = k.fz; CTX055.stamp = k.stamp; Object.assign(PLAN, k.plan);
  }
  for (const [turn, sid] of [...RUNNING]) if (mine(turn) || mine(sid)) RUNNING.delete(turn);
  for (const sid of [...PENDING_APPROVALS.keys()]) if (mine(sid)) PENDING_APPROVALS.delete(sid);
  for (const sid of [...ATTN]) if (mine(sid)) ATTN.delete(sid);
  if (typeof QUEUES !== 'undefined') for (const key of [...QUEUES.keys()]) if (mine(key)) QUEUES.delete(key);
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
function land(js: Js, id: string, title: string): Promise<boolean> {
  return js<boolean>(`(async () => { ${H}
    if (!open(${q(id)}, ${q(title)})) return false;
    return until(() => S.sessionId === ${q(id)} && S.agentSession === ${q(id)});
  })()`);
}

/** Types into the composer, presses Enter, and reads the window once the steer chain has run. */
function typeAndEnter(js: Js, text: string): Promise<View> {
  return js<View>(`(async () => { ${H}
    type(${q(text)}); enter();
    await tick(200); await STEER.chain;
    return view();
  })()`);
}

/** Enter on whatever the box holds; the view is read before it. */
function enterAgain(js: Js): Promise<View> {
  return js<View>(`(async () => { ${H}
    const v = view(); enter();
    await tick(200); await STEER.chain;
    return v;
  })()`);
}

const has = (v: View, tag: string) => v.rows.some((r) => r.includes(`smoke t24: ${tag}`));
const toasted = (v: View, title: string) => v.toasts.some((t) => t.startsWith(title));
const locked = (v: View) => !!v.button && v.button.disabled && v.button.cls.includes("locked");
const show = (x: unknown) => JSON.stringify(x);

export async function checks24(js: Js, check: Check): Promise<void> {
  const wins = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed());
  const w = wins[0] ?? null;
  const agent = new StandIn();
  let kept = false;
  try {
    agent.install(wins);
    const probe = await js<{ data?: { smokeT24?: boolean } } | null>(`BR.session(${q(PROBE)})`).catch((e: unknown) => String(e));
    if (!w || typeof probe !== "object" || probe?.data?.smokeT24 !== true) {
      check("T24: a stand-in on the window's IPC answers the session fetch first", false, `${show(probe)}; nothing was staged`);
      return;
    }
    const stale = await js<boolean>("typeof openHoldsComposer === 'function' && openHoldsComposer()");
    check("T24: the composer is not held when the check starts (no chat left loading by an earlier check)", !stale);
    kept = await js<boolean>(KEEP);
    await sendWhileOpening(js, check, agent);
    await runningChatWhileOpening(js, check, agent);
    await approvalWhileOpening(js, check, agent);
    await turnEndsWhileOpening(js, check, agent, w);
    await sessionReportedLate(js, check, agent, w);
    await gatedThenSwitched(js, check, agent);
    await gatedThenCleared(js, check, agent);
    await openFailed(js, check, agent);
    await liveOpenFailed(js, check, agent);
    await reloadFailed(js, check, agent);
  } finally {
    /* The held answers are let go and the stand-ins come off before anything
       else is awaited: a renderer call that never settles here would
       otherwise leave them answering for the rest of the suite (guarded()
       moves on after 180 s, it does not stop this). */
    agent.releaseAll();
    agent.uninstall(wins);
    if (kept) await js<unknown>(RESTORE);
  }
}

/* (a) The plain case. One chat is on screen, another is clicked and its
   transcript is slow; the person types and presses Enter under the loading
   line. Then the transcript lands, and Enter again. */
async function sendWhileOpening(js: Js, check: Check, agent: StandIn): Promise<void> {
  const left = `${PREFIX}left-a`;
  const slow = `${PREFIX}slow-a`;
  const said = "smoke t24: typed while the chat was opening";
  agent.ready(left, loaded(left, turns("LEFT", 1)));
  await js<boolean>(RESET);
  const landed = await land(js, left, "smoke t24: the chat the person leaves");
  agent.hold(slow);
  const clicked = await js<boolean>(`(() => { ${H} return open(${q(slow)}, 'smoke t24: a chat that opens slowly'); })()`);
  const held = clicked && (await agent.waitFor(slow, 1));
  const mark = agent.sent.length;
  const during = await typeAndEnter(js, said);
  const out = agent.since(mark);
  check(
    "T24: Enter while a chat is still opening sends nothing, keeps the message in the box and says why",
    landed && held && during.rows[0] === LOADING && out.length === 0 && during.entry === said && during.draft === said
      && locked(during) && toasted(during, "This chat is still loading"),
    `landed=${landed} held=${held} sent=${show(out)} during=${show(during)}`,
  );
  agent.release(slow, loaded(slow, turns("SLOW", 1)));
  await settle(js);
  const mark2 = agent.sent.length;
  const after = await enterAgain(js);
  const out2 = agent.since(mark2);
  check(
    "T24: once that chat has loaded, Enter sends the same message with that chat's session",
    after.agentSession === slow && has(after, "SLOW answer 1") && after.entry === said && !!after.button && !after.button.disabled
      && out2.length === 1 && out2[0]!.channel === "chat" && out2[0]!.sessionId === slow && out2[0]!.text === said,
    `after=${show(after)} sent=${show(out2)}`,
  );
}

/* (b) The chat on screen has a turn running, and so does the one being
   opened: openSession leaves S.busy up for a chat whose turn is live, so
   Enter under the loading line took the steer path, with the session of the
   chat that was left. */
async function runningChatWhileOpening(js: Js, check: Check, agent: StandIn): Promise<void> {
  const left = `${PREFIX}left-b`;
  const live = `${PREFIX}live-b`;
  const said = "smoke t24: typed while a chat with a running turn was opening";
  agent.ready(left, loaded(left, turns("LEFT", 1)));
  await js<boolean>(RESET);
  const landed = await land(js, left, "smoke t24: a chat with a turn running");
  await js<boolean>(`(() => {
    S.busy = true; S.turnId = ${q(`${PREFIX}turn-left-b`)};
    RUNNING.set(${q(`${PREFIX}turn-left-b`)}, ${q(left)}); RUNNING.set(${q(`${PREFIX}turn-live-b`)}, ${q(live)});
    render(); return true;
  })()`);
  agent.hold(live);
  const clicked = await js<boolean>(`(() => { ${H} return open(${q(live)}, 'smoke t24: a chat whose turn runs here'); })()`);
  const held = clicked && (await agent.waitFor(live, 1));
  const mark = agent.sent.length;
  const during = await typeAndEnter(js, said);
  const out = agent.since(mark);
  check(
    "T24: Enter while a chat whose turn runs here is opening does not steer the turn of the chat that was left",
    landed && held && out.length === 0 && during.entry === said && locked(during) && toasted(during, "This chat is still loading"),
    `landed=${landed} held=${held} sent=${show(out)} during=${show(during)}`,
  );
  agent.release(live, loaded(live, turns("LIVE", 1)));
  await settle(js);
  const mark2 = agent.sent.length;
  const after = await enterAgain(js);
  const out2 = agent.since(mark2);
  check(
    "T24: once it has loaded, Enter steers that chat's own turn",
    after.agentSession === live && after.busy && after.rows.some((r) => r.includes("Still answering your last message")) && after.entry === said
      && out2.length === 1 && out2[0]!.channel === "steer" && out2[0]!.sessionId === live && out2[0]!.text === said,
    `after=${show(after)} sent=${show(out2)}`,
  );
}

/* (c) The chat on screen is waiting on an approval when a chat whose turn
   runs here is opened. The approval card stays in the window's state for a
   live chat, so the typed words became the reason that approval was denied. */
async function approvalWhileOpening(js: Js, check: Check, agent: StandIn): Promise<void> {
  const left = `${PREFIX}left-c`;
  const live = `${PREFIX}live-c`;
  const ask = `${PREFIX}approval-c`;
  const said = "smoke t24: typed while a chat waiting on an approval was being left";
  agent.ready(left, loaded(left, turns("LEFT", 1)));
  await js<boolean>(RESET);
  const landed = await land(js, left, "smoke t24: a chat waiting on an approval");
  const asked = await js<boolean>(`(() => {
    onApprovalEvent({approvalId: ${q(ask)}, tool: 'os.shell.run', category: 'shell', reason: 'smoke t24',
      preview: 'echo smoke t24', sessionId: ${q(left)}});
    RUNNING.set(${q(`${PREFIX}turn-live-c`)}, ${q(live)});
    return !!S.pending && S.pending.approvalId === ${q(ask)};
  })()`);
  agent.hold(live);
  const clicked = await js<boolean>(`(() => { ${H} return open(${q(live)}, 'smoke t24: a chat whose turn runs here'); })()`);
  const held = clicked && (await agent.waitFor(live, 1));
  const mark = agent.sent.length;
  const during = await typeAndEnter(js, said);
  const out = agent.since(mark);
  agent.release(live, loaded(live, turns("LIVE", 1)));
  await settle(js);
  check(
    "T24: Enter while it opens does not answer the approval of the chat that was left with what was typed",
    landed && asked && held && out.length === 0 && during.entry === said && locked(during) && toasted(during, "This chat is still loading"),
    `landed=${landed} asked=${asked} held=${held} sent=${show(out)} during=${show(during)}`,
  );
}

/* (d) The chat on screen has a turn running and a message queued behind it.
   Another chat is opened, and the turn ends while that one is still loading.
   The message was queued for the turn that ended, so it waits for its own
   chat: it does not run in the chat that was loading, in a new chat, or in
   another chat opened after, and it runs once the person is back in it. */
async function turnEndsWhileOpening(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const left = `${PREFIX}left-d`;
  const slow = `${PREFIX}slow-d`;
  const other = `${PREFIX}other-d`;
  const turn = `${PREFIX}turn-left-d`;
  const queued = "smoke t24: queued behind the turn that ends";
  agent.ready(left, loaded(left, turns("LEFT", 1)));
  agent.ready(other, loaded(other, turns("OTHER", 1)));
  await js<boolean>(RESET);
  const landed = await land(js, left, "smoke t24: a chat with a message queued");
  await js<boolean>(`(() => {
    S.busy = true; S.turnId = ${q(turn)}; RUNNING.set(${q(turn)}, ${q(left)});
    S.queued.push(${q(queued)}); render(); return true;
  })()`);
  agent.hold(slow);
  const clicked = await js<boolean>(`(() => { ${H} return open(${q(slow)}, 'smoke t24: a chat that opens slowly'); })()`);
  const held = clicked && (await agent.waitFor(slow, 1));
  const mark = agent.sent.length;
  w.webContents.send("agent:chat", { turnId: turn, kind: "done" });
  await settle(js);
  const during = await js<View>(VIEW);
  const out = agent.since(mark);
  const waits = () => js<string[]>(`(() => { ${H} return waiting(${q(left)}); })()`);
  const left1 = await waits();
  check(
    "T24: a turn that ends while a chat is opening does not send its queued message from under the loading line",
    landed && held && out.length === 0 && during.rows[0] === LOADING && left1.length === 1 && left1[0] === queued,
    `landed=${landed} held=${held} sent=${show(out)} during=${show(during)} waiting=${show(left1)}`,
  );
  agent.release(slow, loaded(slow, turns("SLOW", 1)));
  await settle(js);
  const onSlow = await js<View>(VIEW);
  const left2 = await waits();
  const fresh = await js<boolean>(`(async () => { ${H} const ok = newChat(); await tick(150); return ok; })()`);
  const elsewhere = await land(js, other, "smoke t24: a chat opened after");
  await settle(js);
  const away = agent.since(mark);
  check(
    "T24: that message does not run in the chat that was loading, in a new chat, or in another chat opened after",
    has(onSlow, "SLOW answer 1") && left2.length === 1 && left2[0] === queued && fresh && elsewhere && away.length === 0,
    `onSlow=${show(onSlow)} waiting=${show(left2)} fresh=${fresh} elsewhere=${elsewhere} sent=${show(away)}`,
  );
  const back = await land(js, left, "smoke t24: a chat with a message queued");
  await settle(js);
  const after = await js<View>(VIEW);
  const all = agent.since(mark);
  check(
    "T24: back in the chat it was queued in, it runs there, with that chat's session, shown in its transcript",
    back && all.length === 1 && all[0]!.channel === "chat" && all[0]!.sessionId === left && all[0]!.text === queued
      && after.sessionId === left && after.rows.includes(`user:${queued}`) && has(after, "LEFT answer 1") && after.queued.length === 0,
    `back=${back} after=${show(after)} sent=${show(all)}`,
  );
}

/* (e) A new chat's first turn reports its session (the `session_id` frame)
   only after the person has opened another chat. */
async function sessionReportedLate(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const other = `${PREFIX}other-e`;
  const fresh = `${PREFIX}fresh-e`;
  const first = "smoke t24: the first message of a new chat";
  const next = "smoke t24: the next message, in the chat opened meanwhile";
  agent.ready(other, loaded(other, turns("OTHER", 1)));
  await js<boolean>(RESET);
  agent.turns = true;
  const started = await js<string | null>(`(async () => { ${H}
    if (!newChat()) return null;
    await tick(50); type(${q(first)}); enter();
    await until(() => !!S.turnId);
    return S.turnId;
  })()`);
  agent.turns = false;
  const landed = !!started && (await land(js, other, "smoke t24: the chat opened before the first turn said its session"));
  if (started) w.webContents.send("agent:chat", { turnId: started, kind: "session_id", payload: { sessionId: fresh } });
  await settle(js);
  const mid = await js<View>(VIEW);
  const dot = started ? await js<string | null>(`RUNNING.get(${q(started)}) || null`) : null;
  const mark = agent.sent.length;
  await typeAndEnter(js, next);
  const out = agent.since(mark);
  check(
    "T24: a new chat's first turn reporting its session after another chat was opened does not take that chat's next message",
    landed && mid.sessionId === other && mid.agentSession === other && dot === fresh
      && out.length === 1 && out[0]!.channel === "chat" && out[0]!.sessionId === other && out[0]!.text === next,
    `started=${started} landed=${landed} dot=${dot} mid=${show(mid)} sent=${show(out)}`,
  );
}

/* (f) On the managed local route the first message can wait for the disk
   snapshot of the model list (the local model check). The person opens
   another chat before it answers. */
async function gatedThenSwitched(js: Js, check: Check, agent: StandIn): Promise<void> {
  const left = `${PREFIX}left-f`;
  const other = `${PREFIX}other-f`;
  const said = "smoke t24: held at the local model check";
  agent.ready(left, loaded(left, turns("LEFT", 1)));
  agent.ready(other, loaded(other, turns("OTHER", 1)));
  await js<boolean>(RESET);
  const landed = await land(js, left, "smoke t24: the chat a held message was typed in");
  agent.holdModels = true;
  const asked = agent.modelsAsked;
  const gating = await js<boolean>(`(async () => { ${H}
    window.__t24gate = 'pending';
    type(${q(said)}); enter();
    await tick(50);
    return BSW.gating;
  })()`);
  const waiting = gating && (await until(() => agent.modelsAsked > asked));
  const moved = await land(js, other, "smoke t24: the chat opened before the check answered");
  await js<boolean>("(() => { window.__t24gate = 'run'; return true; })()");
  const mark = agent.sent.length;
  agent.releaseModels();
  await settle(js);
  const after = await js<View>(VIEW);
  const out = agent.since(mark);
  check(
    "T24: a message held at the local model check is not sent into a chat opened before the check answered, and comes back to the box",
    landed && gating && waiting && moved && out.length === 0 && after.sessionId === other && after.entry === said
      && toasted(after, "Not sent"),
    `landed=${landed} gating=${gating} waiting=${waiting} moved=${moved} sent=${show(out)} after=${show(after)}`,
  );
}

/* (g) The chat clicked does not open: its load ends in an error. */
async function openFailed(js: Js, check: Check, agent: StandIn): Promise<void> {
  const left = `${PREFIX}left-g`;
  const gone = `${PREFIX}gone-g`;
  const said = "smoke t24: typed under a chat that did not open";
  agent.ready(left, loaded(left, turns("LEFT", 1)));
  await js<boolean>(RESET);
  const landed = await land(js, left, "smoke t24: the chat the person leaves");
  agent.hold(gone);
  const clicked = await js<boolean>(`(() => { ${H} return open(${q(gone)}, 'smoke t24: a chat that does not open'); })()`);
  const held = clicked && (await agent.waitFor(gone, 1));
  agent.release(gone, { ok: false, error: "smoke t24: the agent did not answer" });
  await settle(js);
  const mark = agent.sent.length;
  const during = await typeAndEnter(js, said);
  const out = agent.since(mark);
  check(
    "T24: a chat that did not open keeps the message in the box instead of sending it to the chat that was left",
    landed && held && during.sessionId === gone && (during.rows[0] ?? "").startsWith("system:could not open that session")
      && out.length === 0 && during.entry === said && locked(during) && toasted(during, "This chat did not open"),
    `landed=${landed} held=${held} sent=${show(out)} during=${show(during)}`,
  );
  agent.ready(gone, loaded(gone, turns("GONE", 1)));
  const retried = await land(js, gone, "smoke t24: a chat that does not open");
  const mark2 = agent.sent.length;
  const after = await enterAgain(js);
  const out2 = agent.since(mark2);
  check(
    "T24: opening that chat again lets the same message go, with its session",
    retried && has(after, "GONE answer 1") && after.entry === said
      && out2.length === 1 && out2[0]!.channel === "chat" && out2[0]!.sessionId === gone && out2[0]!.text === said,
    `retried=${retried} after=${show(after)} sent=${show(out2)}`,
  );
}

/* (f2) The same local model check, and the person stays in the chat but
   clears its transcript (Clear Transcript) before the check answers. The
   chat did not change, so the message goes, with this chat's session, and is
   shown above its turn. */
async function gatedThenCleared(js: Js, check: Check, agent: StandIn): Promise<void> {
  const here = `${PREFIX}here-f2`;
  const said = "smoke t24: held at the local model check, then the transcript was cleared";
  agent.ready(here, loaded(here, turns("HERE", 1)));
  await js<boolean>(RESET);
  const landed = await land(js, here, "smoke t24: the chat a held message was typed in");
  agent.holdModels = true;
  const asked = agent.modelsAsked;
  const gating = await js<boolean>(`(async () => { ${H}
    window.__t24gate = 'pending';
    type(${q(said)}); enter();
    await tick(50);
    return BSW.gating;
  })()`);
  const waiting = gating && (await until(() => agent.modelsAsked > asked));
  await js<boolean>("(() => { act('clear'); window.__t24gate = 'run'; return true; })()");
  const mark = agent.sent.length;
  agent.releaseModels();
  await settle(js);
  const after = await js<View>(VIEW);
  const out = agent.since(mark);
  check(
    "T24: a message held at the local model check still goes when the person only cleared the transcript, and is shown",
    landed && gating && waiting && out.length === 1 && out[0]!.channel === "chat" && out[0]!.sessionId === here && out[0]!.text === said
      && after.rows.includes(`user:${said}`) && !toasted(after, "Not sent"),
    `landed=${landed} gating=${gating} waiting=${waiting} sent=${show(out)} after=${show(after)}`,
  );
}

/* (h) A chat whose turn runs here does not open (its load errors). Enter is
   held, and clicking the chat again opens it although it is the chat on
   screen and its turn is live: that click is how a failed open is retried. */
async function liveOpenFailed(js: Js, check: Check, agent: StandIn): Promise<void> {
  const left = `${PREFIX}left-h`;
  const live = `${PREFIX}live-h`;
  const said = "smoke t24: typed under a running chat that did not open";
  agent.ready(left, loaded(left, turns("LEFT", 1)));
  await js<boolean>(RESET);
  const landed = await land(js, left, "smoke t24: the chat the person leaves");
  await js<boolean>(`(() => { RUNNING.set(${q(`${PREFIX}turn-live-h`)}, ${q(live)}); return true; })()`);
  agent.hold(live);
  const clicked = await js<boolean>(`(() => { ${H} return open(${q(live)}, 'smoke t24: a running chat that does not open'); })()`);
  const held = clicked && (await agent.waitFor(live, 1));
  agent.release(live, { ok: false, error: "smoke t24: the agent did not answer" });
  await settle(js);
  const mark = agent.sent.length;
  const during = await typeAndEnter(js, said);
  const out = agent.since(mark);
  agent.ready(live, loaded(live, turns("LIVE", 1)));
  const retried = await land(js, live, "smoke t24: a running chat that does not open");
  const mark2 = agent.sent.length;
  const after = await enterAgain(js);
  const out2 = agent.since(mark2);
  check(
    "T24: a running chat that did not open holds the message, and clicking it again opens it and lets the message steer its turn",
    landed && held && out.length === 0 && during.entry === said && toasted(during, "This chat did not open")
      && retried && has(after, "LIVE answer 1") && after.busy
      && out2.length === 1 && out2[0]!.channel === "steer" && out2[0]!.sessionId === live && out2[0]!.text === said,
    `landed=${landed} held=${held} sent=${show(out)} during=${show(during)} retried=${retried} after=${show(after)} sent2=${show(out2)}`,
  );
}

/* (i) The chat on screen is clicked again, and that reload errors. The next
   message already goes with this chat's session, so nothing is held: only the
   transcript is missing, and the message goes to the right place. */
async function reloadFailed(js: Js, check: Check, agent: StandIn): Promise<void> {
  const here = `${PREFIX}here-i`;
  const said = "smoke t24: typed after a reload of this chat failed";
  agent.ready(here, loaded(here, turns("HERE", 1)));
  await js<boolean>(RESET);
  const landed = await land(js, here, "smoke t24: the chat on screen");
  agent.hold(here);
  const clicked = await js<boolean>(`(() => { ${H} return open(${q(here)}, 'smoke t24: the chat on screen'); })()`);
  const held = clicked && (await agent.waitFor(here, 1));
  agent.release(here, { ok: false, error: "smoke t24: the agent did not answer" });
  await settle(js);
  const mark = agent.sent.length;
  const after = await typeAndEnter(js, said);
  const out = agent.since(mark);
  check(
    "T24: a failed reload of the chat already on screen holds nothing, and the message goes to that chat",
    landed && held && (after.rows[0] ?? "").startsWith("system:could not open that session")
      && out.length === 1 && out[0]!.channel === "chat" && out[0]!.sessionId === here && out[0]!.text === said
      && !toasted(after, "This chat"),
    `landed=${landed} held=${held} sent=${show(out)} after=${show(after)}`,
  );
}
