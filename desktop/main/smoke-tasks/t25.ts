import { BrowserWindow } from "electron";

/**
 * Release-fix checks for backlog item 25 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=25`.
 *
 * 25 — after a chat switch, the controls that act on "the running turn" and on
 * "the open approval" acted on another chat. S.turnId is the turn the window
 * started last, and it outlives a chat switch: Ctrl+., Run › Stop, /abort, the
 * Stop button and Escape in one chat cancelled the turn of another, and Abort
 * run on an approval card cancelled that turn too instead of the one that
 * asked. openSession kept the previous chat's S.busy and S.pending for a chat
 * whose turn was live, so right after a sidebar click (focus on the row, not
 * in the editor) y and n answered the previous chat's request, whose card was
 * no longer on screen. Coming back to a chat waiting on its own request showed
 * no card to answer, the end of a turn in a chat that was left (or another
 * chat's request) took "busy" from the chat on screen, a chat could be deleted
 * mid-turn (the turn ran on with nothing left to stop it from, and its request
 * stayed answerable from the empty view), and with two cards up either card's
 * buttons answered the newest request. Now each of them acts on the chat on
 * screen and the card it is on, a chat waiting on its request shows the card
 * again when it is opened, without taking the focus from the box, and, as in
 * the TUI, a chat whose turn is running is not deleted until it is stopped.
 *
 * Nothing reaches the agent. As in t24, the window's own IPC (asked before
 * ipcMain's; a probe proves it first) answers GET /api/sessions/{id} and stands
 * in for every call these cases can make: the chat, a steer, an approval
 * verdict, a cancel, a delete, the context preview, the parked steers and the
 * local model list. They are recorded, never forwarded. Chats are staged rows
 * opened by clicking them; turns start from messages typed into the composer
 * and sent with Enter; approval requests and a turn's end come on the real
 * agent:approval and agent:chat channels and Run › Stop on app:menu; keys are
 * pressed with focus outside the editor, where a sidebar click leaves it. What
 * the check staged comes back out, and the window is put back as it was.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Sent = { channel: "chat" | "steer" | "approve" | "cancel" | "delete"; sessionId: string | null; text: string };
type View = {
  sessionId: string; agentSession: string | null; busy: boolean; pending: string | null; card: boolean;
  waitingStrip: boolean; stop: boolean; settings: boolean; running: string[]; waiting: string[]; rows: string[];
};
type Handler = (event: unknown, arg: unknown) => unknown;

const PREFIX = "smoke-t25-";
const PROBE = `${PREFIX}probe`;
const REFUSAL = "smoke t25: the stand-in runs no turns";
const QUIET = "smoke t25: not answered while the check runs";
const q = (v: unknown) => JSON.stringify(v);
const show = (x: unknown) => JSON.stringify(x);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* Finished turns as the store keeps them: a question, then its reply. */
const turns = (tag: string) => [
  { kind: "user", text: `smoke t25: ${tag} question 1` },
  { kind: "assistant_reply", text: `smoke t25: ${tag} answer 1` },
];
const loaded = (id: string, tag: string) => ({ ok: true, data: { id, turns: turns(tag) } });

/** The agent as these cases need it: every call they can make, on the window's own IPC. */
class StandIn {
  readonly sent: Sent[] = [];
  /** agent:chat answers with a running turn instead of refusing. */
  turns = false;
  private turnSeq = 0;
  private readonly answers = new Map<string, unknown>();

  /** GET /api/sessions/{id}: at once for a ready() chat. */
  readonly session: Handler = (_e, id) => {
    const sid = typeof id === "string" ? id : "";
    if (sid === PROBE) return { ok: true, data: { id: sid, turns: [], smokeT25: true } };
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
    const p = (payload ?? {}) as { approvalId?: unknown; decision?: unknown };
    this.sent.push({ channel: "approve", sessionId: null, text: `${String(p.approvalId)} ${String(p.decision)}` });
    return { ok: true, data: { resolved: true } };
  };

  readonly cancel: Handler = (_e, turnId) => {
    this.sent.push({ channel: "cancel", sessionId: null, text: String(turnId) });
    return true;
  };

  readonly remove: Handler = (_e, id) => {
    this.sent.push({ channel: "delete", sessionId: typeof id === "string" ? id : null, text: "" });
    return { ok: true };
  };

  private readonly quiet: Handler = () => ({ ok: false, error: QUIET });
  private readonly noParked: Handler = () => ({ ok: true, data: { undelivered: [], discarded: 0 } });

  private channels(): Array<[string, Handler]> {
    return [
      ["agent:session", this.session], ["agent:chat", this.chat], ["agent:steer", this.steer],
      ["agent:approve", this.approve], ["agent:cancel", this.cancel], ["agent:deleteSession", this.remove],
      ["cli:chatModelsList", this.quiet], ["agent:contextPreview", this.quiet],
      ["agent:undeliveredSteers", this.noParked], ["agent:ackSteers", this.quiet],
    ];
  }

  install(wins: BrowserWindow[]): void {
    for (const x of wins) for (const [ch, fn] of this.channels()) { x.webContents.ipc.removeHandler(ch); x.webContents.ipc.handle(ch, fn); }
  }

  uninstall(wins: BrowserWindow[]): void {
    for (const x of wins) if (!x.isDestroyed()) for (const [ch] of this.channels()) x.webContents.ipc.removeHandler(ch);
  }

  ready(id: string, tag: string): void { this.answers.set(id, loaded(id, tag)); }

  since(mark: number): Sent[] { return this.sent.slice(mark); }
}

/* Shared by every probe below. */
const H = String.raw`
  const tick = (ms) => new Promise((res) => setTimeout(res, ms));
  const mine = (x) => typeof x === 'string' && x.indexOf('smoke-t25-') === 0;
  const until = async (ok, ms) => { const t0 = Date.now(); while (!ok() && Date.now() - t0 < (ms || 3000)) await tick(20); return !!ok(); };
  // A chat in the sidebar as the agent's list carries it, already named, so nothing goes off to name it.
  // A turn's end re-reads the real list, which has none of these, so a case puts its row back.
  const row = (id, t) => {
    for (let i = SESSIONS.length - 1; i >= 0; i--) if (SESSIONS[i].id === id) SESSIONS.splice(i, 1);
    SESSIONS.unshift({id, t, named: true, titled: true, updatedAt: Date.now(), status: '', turnCount: 2});
    render();
    return document.querySelector('#sidebar [data-ses="' + id + '"]');
  };
  const open = (id, t) => {
    const r = row(id, t);
    if (r) r.click();
    return !!r;
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
  // A key pressed with focus outside the editor, where a click on a sidebar row
  // or a button leaves it, and with the transcript at its bottom (the first
  // Escape in a transcript scrolled up only scrolls it down).
  const press = (key, mods) => {
    const a = document.activeElement;
    if (a && a !== document.body && a.blur) a.blur();
    const sc = document.getElementById('scroller');
    if (sc) sc.scrollTop = sc.scrollHeight;
    document.body.dispatchEvent(new KeyboardEvent('keydown', Object.assign({key, bubbles: true, cancelable: true}, mods || {})));
  };
  // A key pressed in the box, where the approval card's keys do not reach.
  const pressIn = (key) => {
    const e = document.getElementById('entry');
    if (!e) return false;
    e.focus();
    const sc = document.getElementById('scroller');
    if (sc) sc.scrollTop = sc.scrollHeight;
    e.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true}));
    return true;
  };
  const view = () => ({sessionId: S.sessionId, agentSession: S.agentSession, busy: !!S.busy,
    pending: S.pending ? String(S.pending.approvalId || '') : null,
    card: !!document.getElementById('apprcard'),
    waitingStrip: [...document.querySelectorAll('.statusstrip')].some((n) => /Waiting for your approval/.test(n.textContent || '')),
    stop: !!document.querySelector('#composer .sendbtn.stop'),
    settings: !!S.settings,
    running: [...RUNNING].filter(([t]) => mine(t)).map(([t, s]) => t + '>' + s),
    waiting: [...PENDING_APPROVALS.keys()].filter(mine),
    rows: S.log.map((m) => m.k + ':' + String(m.text || m.approvalId || '').slice(0, 80))});
`;
const VIEW = `(() => { ${H} return view(); })()`;

/* The window as the check found it; RESTORE puts it back. submit() sends
   nothing while the agent is still starting, so the check says it is up:
   every call a message can make is stood in for anyway. */
const KEEP = `(() => {
  window.__t25keep = {log: S.log, sessionId: S.sessionId, agentSession: S.agentSession, busy: S.busy, pending: S.pending,
    apprFocused: S.apprFocused, history: S.history, room: S.room, streamId: S.streamId, turnId: S.turnId, reasonId: S.reasonId,
    stick: S.stick, settings: S.settings, overlay: S.overlay, menuOpen: S.menuOpen, slash: S.slash, draft: S.draft,
    toasts: S.toasts.slice(), queued: S.queued.slice(), ahead: STEER.ahead, mine: STEER.mine.slice(), live: S.live.state,
    gating: BSW.gating, gate: localTurnGate, had: 'turnStartedAt' in S, started: S.turnStartedAt, fz: FZ.live,
    stamp: CTX055.stamp, plan: {on: PLAN.on, itemId: PLAN.itemId, sessionId: PLAN.sessionId, startedMode: PLAN.startedMode}};
  return true;
})()`;

/* What the cases leave in the window's books, taken out: by RESET before each
   case and by RESTORE at the end. APPROVAL_CARDS is the fix's own map, so it
   is looked for rather than assumed (the check also runs without the fix). */
const FORGET = String.raw`
  for (const [turn, sid] of [...RUNNING]) if (mine(turn) || mine(sid)) RUNNING.delete(turn);
  for (const sid of [...PENDING_APPROVALS.keys()]) if (mine(sid)) PENDING_APPROVALS.delete(sid);
  if (typeof APPROVAL_CARDS !== 'undefined') for (const sid of [...APPROVAL_CARDS.keys()]) if (mine(sid)) APPROVAL_CARDS.delete(sid);
`;

/* Before each case: an idle composer, an empty box, no toasts, no window or
   menu open, nothing staged still running or waiting. The local model gate
   always says "run": on that route it waits for the disk snapshot, which is
   not what these cases are about. */
const RESET = `(() => { ${H}
  S.busy = false; S.pending = null; S.turnId = null; S.streamId = null; S.reasonId = null;
  S.queued.length = 0; STEER.ahead = 0; STEER.mine.length = 0; BSW.gating = false;
  if (typeof OPENING !== 'undefined') OPENING = null;
  if (typeof DRAIN_OWED !== 'undefined') DRAIN_OWED = null;
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
  await tick(150);   // whatever the last case set going is dealt with first
  const k = window.__t25keep; delete window.__t25keep;
  if (typeof OPENING !== 'undefined') OPENING = null;
  if (typeof DRAIN_OWED !== 'undefined') DRAIN_OWED = null;
  if (k) {
    localTurnGate = k.gate; BSW.gating = k.gating;
    S.log = k.log; S.sessionId = k.sessionId; S.agentSession = k.agentSession; S.busy = k.busy; S.pending = k.pending;
    S.apprFocused = k.apprFocused; S.history = k.history; S.room = k.room; S.streamId = k.streamId; S.turnId = k.turnId;
    S.reasonId = k.reasonId; S.stick = k.stick; S.settings = k.settings; S.overlay = k.overlay; S.menuOpen = k.menuOpen;
    S.slash = k.slash; S.draft = k.draft; S.toasts = k.toasts;
    S.queued.length = 0; S.queued.push(...k.queued); STEER.ahead = k.ahead; STEER.mine.length = 0; STEER.mine.push(...k.mine);
    if (k.live !== 'connected' && S.live.state === 'connected') S.live.state = k.live;
    if (k.had) S.turnStartedAt = k.started; else delete S.turnStartedAt;
    FZ.live = k.fz; CTX055.stamp = k.stamp; Object.assign(PLAN, k.plan);
  }
  ${FORGET}
  for (const sid of [...ATTN]) if (mine(sid)) ATTN.delete(sid);
  for (let i = SESSIONS.length - 1; i >= 0; i--) if (mine(SESSIONS[i].id)) SESSIONS.splice(i, 1);
  const seen = Object.keys(PREFS.seen).filter(mine);
  seen.forEach((sid) => { delete PREFS.seen[sid]; });
  const pinned = PREFS.pinned.filter(mine);
  if (pinned.length) PREFS.pinned = PREFS.pinned.filter((x) => !mine(x));
  if (seen.length || pinned.length) savePrefs();
  const e = document.getElementById('entry'); if (e) e.value = S.draft;
  renderToasts(); render();
  await refreshSessions();
  refreshContext();
  return true;
})()`;

/* Whatever the window does with an answer it was handed (the stand-ins answer
   at once, in order) happens before the reply to a later request; a beat on
   top for the repaint. */
async function settle(js: Js): Promise<void> {
  await js<unknown>(`BR.session(${q(PROBE)}).then(() => new Promise((res) => setTimeout(res, 150)))`);
}

/** Clicks a staged chat that answers at once, and waits until it is the chat on screen. */
function land(js: Js, id: string, title: string): Promise<boolean> {
  return js<boolean>(`(async () => { ${H}
    if (!open(${q(id)}, ${q(title)})) return false;
    return until(() => S.sessionId === ${q(id)} && S.agentSession === ${q(id)} && !S.log.some((m) => m.k === 'system' && m.text === 'loading session…'));
  })()`);
}

/** A message typed into the chat on screen and sent with Enter; the stand-in starts a turn for it. Its id, or null. */
async function start(js: Js, agent: StandIn, text: string): Promise<string | null> {
  agent.turns = true;
  try {
    return await js<string | null>(`(async () => { ${H}
      const before = S.turnId;
      type(${q(text)}); enter();
      return (await until(() => !!S.turnId && S.turnId !== before)) ? S.turnId : null;
    })()`);
  } finally {
    agent.turns = false;
  }
}

/* 05.10: the desktop's Allow once key for the card on screen, ⌘↩ (Ctrl+↩ off
   macOS). Bare y / n / Esc no longer answer a card here. */
const ALLOW: Record<string, boolean> = process.platform === "darwin" ? { metaKey: true } : { ctrlKey: true };

/** A key, pressed as press() does, then the window let to settle. */
async function key(js: Js, k: string, mods: Record<string, boolean> = {}): Promise<void> {
  await js<boolean>(`(() => { ${H} press(${q(k)}, ${q(mods)}); return true; })()`);
  await settle(js);
}

/** The agent's request for approval of a shell call in chat `sid`, on the real channel. */
async function ask(js: Js, w: BrowserWindow, sid: string, approvalId: string): Promise<void> {
  w.webContents.send("agent:approval", {
    approvalId, tool: "os.shell.run", category: "shell", reason: "smoke t25", preview: "echo smoke t25", sessionId: sid,
  });
  await settle(js);
}

const cancels = (out: Sent[]) => out.filter((s) => s.channel === "cancel").map((s) => s.text);
const answered = (out: Sent[]) => out.filter((s) => s.channel === "approve").map((s) => s.text);

export async function checks25(js: Js, check: Check): Promise<void> {
  const wins = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed());
  const w = wins[0] ?? null;
  const agent = new StandIn();
  let kept = false;
  try {
    agent.install(wins);
    const probe = await js<{ data?: { smokeT25?: boolean } } | null>(`BR.session(${q(PROBE)})`).catch((e: unknown) => String(e));
    if (!w || typeof probe !== "object" || probe?.data?.smokeT25 !== true) {
      check("T25: a stand-in on the window's IPC answers the session fetch first", false, `${show(probe)}; nothing was staged`);
      return;
    }
    kept = await js<boolean>(KEEP);
    await stopInAnotherChat(js, check, agent, w);
    await stopAfterNewChat(js, check, agent);
    await stopInTheChatOnScreen(js, check, agent);
    await keysAfterOpeningARunningChat(js, check, agent, w);
    await backToAWaitingChat(js, check, agent, w);
    await abortRunOnAnotherChatsCard(js, check, agent, w);
    await aLeftTurnEnds(js, check, agent, w);
    await deleteWhileWorking(js, check, agent, w);
    await twoCardsOnScreen(js, check, agent, w);
    await typingWhileACardComesBack(js, check, agent, w);
    await aStaleEntryDoesNotHoldBusy(js, check, agent, w);
    await escapeInTheBoxUnderAnotherChatsCard(js, check, agent, w);
  } finally {
    /* The stand-ins come off before anything else is awaited: a renderer call
       that never settles here would otherwise leave them answering for the
       rest of the suite (guarded() moves on after 180 s, it does not stop this). */
    agent.uninstall(wins);
    if (kept) await js<unknown>(RESTORE);
    await wait(50);
  }
}

/* (a) Chat A has a turn running; the person opens chat B, which has none, and
   stops "the running turn" there in each of the three ways that do not need a
   Stop button on screen. */
async function stopInAnotherChat(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const a = `${PREFIX}a1`;
  const b = `${PREFIX}b1`;
  agent.ready(a, "A1");
  agent.ready(b, "B1");
  await js<boolean>(RESET);
  const inA = await land(js, a, "smoke t25: a chat whose turn runs on");
  const turnA = inA ? await start(js, agent, "smoke t25: a question in chat A") : null;
  const inB = await land(js, b, "smoke t25: a chat with no turn of its own");
  const mark = agent.sent.length;
  await key(js, ".", { ctrlKey: true });
  w.webContents.send("app:menu", "stop");
  await settle(js);
  await js<boolean>(`(async () => { ${H}
    const e = document.getElementById('entry');
    if (e) e.value = '/abort';
    S.draft = '/abort'; S.slash = false;
    enter();
    await tick(100);
    return true;
  })()`);
  await settle(js);
  const after = await js<View>(VIEW);
  const out = agent.since(mark);
  check(
    "T25: in a chat with no turn of its own, Ctrl+., Run › Stop and /abort cancel nothing, and the turn of the chat that was left runs on",
    inA && !!turnA && inB && out.length === 0 && after.sessionId === b && after.running.includes(`${turnA}>${a}`),
    `turn=${turnA} sent=${show(out)} after=${show(after)}`,
  );
}

/* (b) The same after New chat, which is how most people leave a chat that is
   still working. Then the new chat's own first turn, which has no session id
   until its first frame: Stop has to reach it all the same. */
async function stopAfterNewChat(js: Js, check: Check, agent: StandIn): Promise<void> {
  const a = `${PREFIX}a2`;
  agent.ready(a, "A2");
  await js<boolean>(RESET);
  const inA = await land(js, a, "smoke t25: a chat whose turn runs on");
  const turnA = inA ? await start(js, agent, "smoke t25: a question in chat A") : null;
  const fresh = await js<boolean>(`(async () => { ${H} const ok = newChat(); await tick(150); return ok; })()`);
  const mark = agent.sent.length;
  await key(js, ".", { ctrlKey: true });
  const mid = await js<View>(VIEW);
  const out = agent.since(mark);
  check(
    "T25: after New chat, Ctrl+. does not cancel the turn of the chat that was left",
    inA && !!turnA && fresh && out.length === 0 && mid.sessionId === "" && mid.running.includes(`${turnA}>${a}`),
    `turn=${turnA} fresh=${fresh} sent=${show(out)} mid=${show(mid)}`,
  );
  const turnN = await start(js, agent, "smoke t25: the first message of a new chat");
  const mark2 = agent.sent.length;
  await key(js, ".", { ctrlKey: true });
  const out2 = agent.since(mark2);
  check(
    "T25: Ctrl+. still stops the new chat's own first turn, before the agent has said its session",
    !!turnN && turnN !== turnA && show(cancels(out2)) === show([turnN]) && out2.length === 1,
    `turn=${turnN} sent=${show(out2)}`,
  );
}

/* (c) Turns run in chats A, B and C, started in that order, so the window's
   last-started turn is C's. Back in A, and then in B, the person stops the
   turn running there: with Escape, and with the composer's Stop button. */
async function stopInTheChatOnScreen(js: Js, check: Check, agent: StandIn): Promise<void> {
  const a = `${PREFIX}a3`;
  const b = `${PREFIX}b3`;
  const c = `${PREFIX}c3`;
  agent.ready(a, "A3");
  agent.ready(b, "B3");
  agent.ready(c, "C3");
  await js<boolean>(RESET);
  const ids: Array<string | null> = [];
  for (const [id, tag] of [[a, "A"], [b, "B"], [c, "C"]] as const) {
    const ok = await land(js, id, `smoke t25: chat ${tag}, its turn runs on`);
    ids.push(ok ? await start(js, agent, `smoke t25: a question in chat ${tag}`) : null);
  }
  const [turnA, turnB, turnC] = ids;
  const backA = (await land(js, a, "smoke t25: chat A, its turn runs on")) ? await js<View>(VIEW) : null;
  const mark = agent.sent.length;
  await key(js, "Escape");
  const outEsc = agent.since(mark);
  /* 0.6.7 item 38: a chat opened again while its turn runs shows that turn,
     its question and its reply row still being written, where it used to say
     "a turn is still running here" over the stored transcript alone. That is
     what tells this view the turn is still running, so it is read instead. */
  check(
    "T25: back in a chat whose turn still runs here, Escape stops that chat's turn, not the turn started last in another chat",
    !!turnA && !!turnB && !!turnC && !!backA && backA.busy && backA.stop
      && backA.rows.includes("user:smoke t25: a question in chat A") && backA.rows[backA.rows.length - 1] === "assistant:"
      && show(cancels(outEsc)) === show([turnA]),
    `turns=${show(ids)} backA=${show(backA)} sent=${show(outEsc)}`,
  );
  const backB = (await land(js, b, "smoke t25: chat B, its turn runs on")) ? await js<View>(VIEW) : null;
  const mark2 = agent.sent.length;
  const clicked = await js<boolean>(`(() => {
    const s = document.querySelector('#composer .sendbtn.stop');
    if (s) s.click();
    return !!s;
  })()`);
  await settle(js);
  const outBtn = agent.since(mark2);
  check(
    "T25: and the composer's Stop button there stops that chat's own turn too",
    !!backB && backB.busy && clicked && show(cancels(outBtn)) === show([turnB]),
    `turns=${show(ids)} backB=${show(backB)} clicked=${clicked} sent=${show(outBtn)}`,
  );
}

/* (d) Chat B has a turn running. In chat A a turn asks for approval, and its
   card is up. The person clicks B's row: focus is on the row, not in the
   editor, and they press y, then n, then Escape. */
async function keysAfterOpeningARunningChat(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const a = `${PREFIX}a4`;
  const b = `${PREFIX}b4`;
  const approval = `${PREFIX}approval-4`;
  agent.ready(a, "A4");
  agent.ready(b, "B4");
  await js<boolean>(RESET);
  const inB = await land(js, b, "smoke t25: a chat whose turn runs on");
  const turnB = inB ? await start(js, agent, "smoke t25: a question in chat B") : null;
  const inA = await land(js, a, "smoke t25: a chat whose turn asks for approval");
  const turnA = inA ? await start(js, agent, "smoke t25: a question in chat A") : null;
  if (turnA) await ask(js, w, a, approval);
  const asked = await js<View>(VIEW);
  const onB = (await land(js, b, "smoke t25: a chat whose turn runs on")) ? await js<View>(VIEW) : null;
  const mark = agent.sent.length;
  await key(js, "Enter", ALLOW);
  const keys = await js<View>(VIEW);
  const out = agent.since(mark);
  check(
    "T25: ⌘↩ pressed right after opening a chat whose turn runs here does not answer another chat's approval, whose card is not on screen",
    !!turnB && !!turnA && asked.pending === approval && asked.card && !!onB && onB.busy
      && out.length === 0 && keys.pending === null && !keys.card && !keys.waitingStrip && keys.waiting.includes(a),
    `turns=${turnA},${turnB} asked=${show(asked)} onB=${show(onB)} sent=${show(out)} keys=${show(keys)}`,
  );
  const mark2 = agent.sent.length;
  await key(js, "Escape");
  const after = await js<View>(VIEW);
  const out2 = agent.since(mark2);
  check(
    "T25: Escape there stops that chat's own turn and leaves the other chat's request open",
    show(cancels(out2)) === show([turnB]) && answered(out2).length === 0 && after.waiting.includes(a),
    `turns=${turnA},${turnB} sent=${show(out2)} after=${show(after)}`,
  );
}

/* (e) Chat A's turn asks for approval; the person goes to another chat and
   comes back. */
async function backToAWaitingChat(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const a = `${PREFIX}a5`;
  const c = `${PREFIX}c5`;
  const approval = `${PREFIX}approval-5`;
  agent.ready(a, "A5");
  agent.ready(c, "C5");
  await js<boolean>(RESET);
  const inA = await land(js, a, "smoke t25: a chat whose turn asks for approval");
  const turnA = inA ? await start(js, agent, "smoke t25: a question in chat A") : null;
  if (turnA) await ask(js, w, a, approval);
  const away = (await land(js, c, "smoke t25: another chat")) ? await js<View>(VIEW) : null;
  const back = (await land(js, a, "smoke t25: a chat whose turn asks for approval")) ? await js<View>(VIEW) : null;
  const mark = agent.sent.length;
  await key(js, "Enter", ALLOW);
  const after = await js<View>(VIEW);
  const out = agent.since(mark);
  check(
    "T25: back in a chat that waits on its own approval, the card is on screen again and ⌘↩ allows that call",
    !!turnA && !!away && away.pending === null && !away.card && !away.waitingStrip
      && !!back && back.card && back.pending === approval && back.waitingStrip
      && show(answered(out)) === show([`${approval} allow-once`]) && cancels(out).length === 0
      && after.pending === null && after.busy && !after.waiting.includes(a),
    `turn=${turnA} away=${show(away)} back=${show(back)} sent=${show(out)} after=${show(after)}`,
  );
}

/* (f) Chats A and B both have a turn running, B's started last and streaming
   on screen. A's turn asks for approval. Q60: its card is not drawn in B,
   where the person is (it waits for A, whose dot says so), so Escape there
   stops B's own turn and answers nothing; A's card is in A. */
async function abortRunOnAnotherChatsCard(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const a = `${PREFIX}a6`;
  const b = `${PREFIX}b6`;
  const approval = `${PREFIX}approval-6`;
  agent.ready(a, "A6");
  agent.ready(b, "B6");
  await js<boolean>(RESET);
  const inA = await land(js, a, "smoke t25: a chat whose turn asks for approval");
  const turnA = inA ? await start(js, agent, "smoke t25: a question in chat A") : null;
  const inB = await land(js, b, "smoke t25: the chat on screen, its turn running");
  const turnB = inB ? await start(js, agent, "smoke t25: a question in chat B") : null;
  if (turnA && turnB) await ask(js, w, a, approval);
  const asked = await js<View>(VIEW);
  const mark = agent.sent.length;
  await key(js, "Escape");
  const after = await js<View>(VIEW);
  const out = agent.since(mark);
  const inA2 = (await land(js, a, "smoke t25: a chat whose turn asks for approval")) ? await js<View>(VIEW) : null;
  check(
    "T25: another chat's approval is not drawn in the chat on screen; Escape there stops that chat's own turn, and the request stays open for its own chat, where its card is",
    !!turnA && !!turnB && asked.sessionId === b && !asked.card && asked.pending === null && asked.waiting.includes(a)
      && answered(out).length === 0 && show(cancels(out)) === show([turnB])
      && after.waiting.includes(a) && after.running.includes(`${turnA}>${a}`)
      && !!inA2 && inA2.card && inA2.pending === approval,
    `turns=${turnA},${turnB} asked=${show(asked)} sent=${show(out)} after=${show(after)} inA=${show(inA2)}`,
  );
}

/* (g) Chat B's turn was started first, chat A's last. The person is back in B
   when A's turn ends. */
async function aLeftTurnEnds(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const a = `${PREFIX}a7`;
  const b = `${PREFIX}b7`;
  agent.ready(a, "A7");
  agent.ready(b, "B7");
  await js<boolean>(RESET);
  const inB = await land(js, b, "smoke t25: the chat the person comes back to");
  const turnB = inB ? await start(js, agent, "smoke t25: a question in chat B") : null;
  const inA = await land(js, a, "smoke t25: a chat whose turn ends meanwhile");
  const turnA = inA ? await start(js, agent, "smoke t25: a question in chat A") : null;
  const back = await land(js, b, "smoke t25: the chat the person comes back to");
  if (turnA) w.webContents.send("agent:chat", { turnId: turnA, kind: "done" });
  await settle(js);
  const after = await js<View>(VIEW);
  check(
    "T25: when the turn of a chat the person left ends, the chat on screen still shows its own turn running, with its Stop button",
    !!turnB && !!turnA && back && after.sessionId === b && after.busy && after.stop
      && after.running.includes(`${turnB}>${b}`) && !after.running.some((r) => r.startsWith(`${turnA}>`)),
    `turns=${turnA},${turnB} after=${show(after)}`,
  );
  const mark = agent.sent.length;
  await key(js, "Escape");
  const esc = await js<View>(VIEW);
  const out = agent.since(mark);
  check(
    "T25: and Escape still stops that turn",
    show(cancels(out)) === show([turnB]) && !esc.settings,
    `turns=${turnA},${turnB} sent=${show(out)} after=${show(esc)}`,
  );
}

/* (h) The chat on screen waits on an approval, its turn running, when the
   person picks Delete… on its row (the row menu sends delask:<id> on
   app:menu), and the question's own Delete is sent as well. As in the TUI, a
   chat whose turn is running is not deleted: the agent's DELETE would neither
   refuse nor stop the turn, and the turn's end would write the chat back.
   Then the person stops it, the agent's aborted frame comes, and Delete…
   goes through. */
async function deleteWhileWorking(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const a = `${PREFIX}a8`;
  const approval = `${PREFIX}approval-8`;
  const okButton = `#overlays .alertbox [data-act="del:${a}"]`;
  agent.ready(a, "A8");
  await js<boolean>(RESET);
  const inA = await land(js, a, "smoke t25: a chat deleted while it works");
  const turnA = inA ? await start(js, agent, "smoke t25: a question in chat A") : null;
  if (turnA) await ask(js, w, a, approval);
  const mark = agent.sent.length;
  w.webContents.send("app:menu", `delask:${a}`);
  await settle(js);
  const asked = await js<{ question: boolean; toast: string }>(`(() => {
    const t = S.toasts.length ? S.toasts[S.toasts.length - 1] : null;
    return {question: !!S.alert, toast: t ? t.t + ' | ' + (t.s || '') : ''};
  })()`);
  await js<boolean>(`(() => { act(${q(`del:${a}`)}); return true; })()`);
  await settle(js);
  const held = await js<View>(VIEW);
  const out = agent.since(mark);
  check(
    "T25: a chat whose turn is running is not deleted: Delete… says to stop it first, and nothing goes to the agent",
    !!turnA && !asked.question && asked.toast.startsWith("This chat is still working") && out.length === 0
      && held.sessionId === a && held.card && held.pending === approval && held.running.includes(`${turnA}>${a}`),
    `turn=${turnA} asked=${show(asked)} sent=${show(out)} held=${show(held)}`,
  );
  const mark2 = agent.sent.length;
  const stopped = await js<boolean>(`(() => {
    const s = document.querySelector('#composer .sendbtn.stop');
    if (s) s.click();
    return !!s;
  })()`);
  if (turnA) w.webContents.send("agent:chat", { turnId: turnA, kind: "aborted", error: null });
  await settle(js);
  // The card of the stopped turn says so; and the row comes back after the list was re-read.
  const card = await js<string>(`(async () => { ${H}
    await refreshSessions();
    row(${q(a)}, 'smoke t25: a chat deleted while it works');
    const d = document.querySelector('#scroller .appr.done .apprlbl');
    return d ? (d.textContent || '') : '';
  })()`);
  w.webContents.send("app:menu", `delask:${a}`);
  await settle(js);
  const deleted = await js<boolean>(`(() => {
    const b = document.querySelector(${q(okButton)});
    if (b) b.click();
    return !!b;
  })()`);
  await settle(js);
  await key(js, "Enter", ALLOW);
  const after = await js<View>(VIEW);
  const out2 = agent.since(mark2);
  check(
    "T25: once its turn is stopped, its card says so, Delete… asks and deletes the chat, and ⌘↩ in the empty view answers nothing",
    stopped && card.startsWith("Not answered — the run was stopped") && deleted && show(cancels(out2)) === show([turnA])
      && out2.some((s) => s.channel === "delete" && s.sessionId === a)
      && answered(out2).length === 0 && after.sessionId === "" && after.pending === null && !after.waitingStrip && !after.busy,
    `turn=${turnA} stopped=${stopped} card=${show(card)} deleted=${deleted} sent=${show(out2)} after=${show(after)}`,
  );
}

/* (i) Two cards on screen at once. Chat B's turn, on screen, asks for
   approval, and then chat A's turn asks too: A's card is drawn under B's and
   A's request is the newest. The person clicks Allow once on the first card,
   B's own. */
async function twoCardsOnScreen(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const a = `${PREFIX}a9`;
  const b = `${PREFIX}b9`;
  const askA = `${PREFIX}approval-9a`;
  const askB = `${PREFIX}approval-9b`;
  agent.ready(a, "A9");
  agent.ready(b, "B9");
  await js<boolean>(RESET);
  const inA = await land(js, a, "smoke t25: a chat whose turn asks second");
  const turnA = inA ? await start(js, agent, "smoke t25: a question in chat A") : null;
  const inB = await land(js, b, "smoke t25: the chat on screen, its turn asks first");
  const turnB = inB ? await start(js, agent, "smoke t25: a question in chat B") : null;
  if (turnA && turnB) {
    await ask(js, w, b, askB);
    await ask(js, w, a, askA);
  }
  const mark = agent.sent.length;
  const cards = await js<number>(`(() => {
    const yes = [...document.querySelectorAll('#scroller [data-appr="y"]')];
    if (yes.length) yes[0].click();
    return yes.length;
  })()`);
  await settle(js);
  const after = await js<View>(VIEW);
  const out = agent.since(mark);
  // Q60: A's request is A's: only B's own card is in B, and its Allow once answers it.
  check(
    "T25: with another chat's request open too, only the chat on screen's own card is drawn there, and Allow once answers that card",
    !!turnA && !!turnB && cards === 1 && show(answered(out)) === show([`${askB} allow-once`]) && cancels(out).length === 0
      && after.pending === null && after.waiting.includes(a) && !after.waiting.includes(b),
    `turns=${turnA},${turnB} cards=${cards} sent=${show(out)} after=${show(after)}`,
  );
}

/* (j) The person opens a chat that waits on its approval and puts the caret
   in the box before the chat has landed (the box takes typing while a chat
   loads). The card comes back without taking the focus, so the y typed next
   is a letter in the box, not an Allow once. */
async function typingWhileACardComesBack(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const a = `${PREFIX}a10`;
  const c = `${PREFIX}c10`;
  const approval = `${PREFIX}approval-10`;
  agent.ready(a, "A10");
  agent.ready(c, "C10");
  await js<boolean>(RESET);
  const inA = await land(js, a, "smoke t25: a chat whose turn asks for approval");
  const turnA = inA ? await start(js, agent, "smoke t25: a question in chat A") : null;
  if (turnA) await ask(js, w, a, approval);
  const away = await land(js, c, "smoke t25: another chat");
  const mark = agent.sent.length;
  const typed = await js<{ focus: string; card: boolean; pending: string | null } | null>(`(async () => { ${H}
    if (!open(${q(a)}, 'smoke t25: a chat whose turn asks for approval')) return null;
    const e = document.getElementById('entry');
    if (!e) return null;
    e.focus();
    await until(() => S.agentSession === ${q(a)} && !!document.getElementById('apprcard'));
    const at = document.activeElement;
    const seen = {focus: at ? (at.id || at.tagName) : '', card: !!document.getElementById('apprcard'),
      pending: S.pending ? String(S.pending.approvalId) : null};
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', {key: 'y', bubbles: true, cancelable: true}));
    return seen;
  })()`);
  await settle(js);
  const out = agent.since(mark);
  check(
    "T25: when a waiting chat's card comes back while the caret is in the box, the box keeps the focus and the y typed there answers nothing",
    !!turnA && away && !!typed && typed.card && typed.pending === approval && typed.focus === "entry" && out.length === 0,
    `turn=${turnA} typed=${show(typed)} sent=${show(out)}`,
  );
}

/* (k) The chat on screen still has an entry in the running list from a turn
   whose end never came (a turn started while the agent restarted can leave
   one). The chat's own next turn ends. */
async function aStaleEntryDoesNotHoldBusy(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const b = `${PREFIX}b11`;
  agent.ready(b, "B11");
  await js<boolean>(RESET);
  const inB = await land(js, b, "smoke t25: a chat with a stale running entry");
  const turnB = inB ? await start(js, agent, "smoke t25: a question in chat B") : null;
  await js<boolean>(`(() => { RUNNING.set(${q(`${PREFIX}turn-stale`)}, ${q(b)}); return true; })()`);
  if (turnB) w.webContents.send("agent:chat", { turnId: turnB, kind: "done" });
  await settle(js);
  const after = await js<View>(VIEW);
  check(
    "T25: when the chat on screen's own turn ends, an older running entry that never got its end does not keep it busy",
    !!turnB && after.sessionId === b && !after.busy && !after.stop,
    `turn=${turnB} after=${show(after)}`,
  );
}

/* (l) Chat B's own turn runs on screen when chat A's turn asks for approval.
   Q60: A's card is not drawn in B. The person presses Escape in the box. */
async function escapeInTheBoxUnderAnotherChatsCard(js: Js, check: Check, agent: StandIn, w: BrowserWindow): Promise<void> {
  const a = `${PREFIX}a12`;
  const b = `${PREFIX}b12`;
  const approval = `${PREFIX}approval-12`;
  agent.ready(a, "A12");
  agent.ready(b, "B12");
  await js<boolean>(RESET);
  const inA = await land(js, a, "smoke t25: a chat whose turn asks for approval");
  const turnA = inA ? await start(js, agent, "smoke t25: a question in chat A") : null;
  const inB = await land(js, b, "smoke t25: the chat on screen, its turn running");
  const turnB = inB ? await start(js, agent, "smoke t25: a question in chat B") : null;
  if (turnA && turnB) await ask(js, w, a, approval);
  const asked = await js<View>(VIEW);
  const mark = agent.sent.length;
  await js<boolean>(`(() => { ${H} return pressIn('Escape'); })()`);
  await settle(js);
  const after = await js<View>(VIEW);
  const out = agent.since(mark);
  check(
    "T25: Escape in the box stops the turn of the chat on screen and leaves another chat's request open, its card not drawn there",
    !!turnA && !!turnB && asked.busy && asked.pending === null && !asked.card
      && show(cancels(out)) === show([turnB]) && answered(out).length === 0
      && after.pending === null && !after.card && after.waiting.includes(a),
    `turns=${turnA},${turnB} asked=${show(asked)} sent=${show(out)} after=${show(after)}`,
  );
}
