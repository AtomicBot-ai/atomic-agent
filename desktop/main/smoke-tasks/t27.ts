import { BrowserWindow } from "electron";

/**
 * Release-fix checks for backlog item 27 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=27`.
 *
 * 27 — A new chat was not on the sidebar until its first reply landed.
 * GET /api/sessions holds a new chat from its first message, but with no
 * turn: the store writes a turn when it ends. applySessions skips a row with
 * no turn, and the window reads the list again only when a turn ends. So New
 * chat, then a message, left the list without the chat for as long as the
 * first turn took: 30-90 s on a local model, minutes on a turn waiting for a
 * provider. The TUI puts a stand-in on its rail the instant the first prompt
 * goes (chat-orchestrator.ts noteFirstPrompt); the window does the same from
 * the turn's session_id frame, which the agent sends before the turn starts.
 *
 * No turn reaches the agent and nothing is written to it. BR.chat, the
 * session list and the transcript fetch are answered by stand-ins on the
 * window's own IPC (a webContents handler is asked before ipcMain's; a probe
 * proves it before anything relies on it). The list they answer is the
 * agent's own, read before they went on, with the check's staged rows on top.
 * A turn's frames go down the real agent:chat channel. New chat is the
 * sidebar's own button; a message goes through startLiveTurn as submit()
 * hands it over. What the check staged comes back out, and the window is put
 * back as it was.
 *
 * 29 (its desktop half, checked here with the same staged turn) — a turn
 * parked on a provider that is not answering said "Waiting for <the picked
 * provider>" and turned every `fetch failed` into "no connection", although
 * the provider waited on can be another one: with a fallback chain it is the
 * last link, and the local server the chain appends may be one the person
 * never chose. A newer agent names the provider waited on and the cause on
 * its provider_waiting frame (`provider_id`, `cause`); the strip and the
 * transcript line say those, and without them every word is as before.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Row = { id: string; name: string; dot: string };
type View = {
  sessionId: string; agentSession: string | null; busy: boolean; turnId: string | null;
  rows: Row[]; on: string[]; drawn: string[];
};
type Payload = { sessionId?: unknown; messages?: Array<{ content?: unknown }> };
type Listed = { id: string; turnCount: number; title: string | null; updatedAt: number };
type Probe = { session?: { data?: { smokeT27?: boolean } }; list?: { data?: { smokeT27?: boolean } }; error?: string };

const PREFIX = "smoke-t27-";
const PROBE = `${PREFIX}probe`;
const q = (v: unknown) => JSON.stringify(v);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** BR.chat, GET /api/sessions and GET /api/sessions/{id}, answered by the check. */
class StandIns {
  /** What BR.chat was handed, in order. */
  readonly sent: Payload[] = [];
  /** The turn ids BR.chat hands out, in order. */
  readonly turns: string[] = [];
  /** The staged rows the list carries, ahead of the agent's own. */
  rows: Listed[] = [];
  /** How many times the list was read through the stand-in. */
  listReads = 0;
  /** Transcripts a session fetch answers, by id. */
  readonly transcripts = new Map<string, unknown[]>();
  private readonly holding = new Set<string>();
  private readonly held: Array<{ id: string; answer: (value: unknown) => void }> = [];

  constructor(private readonly real: unknown[]) {}

  readonly chat = (_event: unknown, payload: unknown): unknown => {
    this.sent.push((payload ?? {}) as Payload);
    const turnId = this.turns.shift();
    return turnId ? { ok: true, turnId } : { ok: false, error: "smoke t27: no turn staged" };
  };

  readonly sessions = (): unknown => {
    this.listReads += 1;
    return { ok: true, data: { sessions: [...this.rows, ...this.real], smokeT27: true } };
  };

  readonly session = (_event: unknown, id: unknown): unknown => {
    const sid = typeof id === "string" ? id : "";
    if (sid === PROBE) return { ok: true, data: { id: sid, turns: [], smokeT27: true } };
    if (this.holding.has(sid)) return new Promise((answer) => { this.held.push({ id: sid, answer }); });
    const turns = this.transcripts.get(sid);
    if (turns) return { ok: true, data: { id: sid, turns, metadata: {} } };
    // Anything else (a real row being named, the context chip) is not part of the check.
    return { ok: false, error: "smoke t27: not answered while the check runs" };
  };

  /** Session fetches of `id` wait until release(id). */
  hold(id: string): void {
    this.holding.add(id);
  }

  release(id: string): void {
    this.holding.delete(id);
    for (let i = this.held.length - 1; i >= 0; i--) {
      const h = this.held[i]!;
      if (h.id !== id) continue;
      this.held.splice(i, 1);
      h.answer(this.session(null, id));
    }
  }

  releaseAll(): void {
    this.holding.clear();
    for (const h of this.held.splice(0)) h.answer({ ok: false, error: "smoke t27: let go at the end of the check" });
  }
}

/* Shared by every probe below. */
const H = String.raw`
  const tick = (ms) => new Promise((res) => setTimeout(res, ms));
  const mine = (x) => typeof x === 'string' && x.indexOf('smoke-t27-') === 0;
  const newChat = () => {
    const b = document.querySelector('#sidebar .sb-new[data-act="session:new"]');
    if (b) b.click();
    return !!b;
  };
  // As submit() hands a message over once its gates have let it through.
  const send = (said) => { S.log.push({id: nid(), k: 'user', text: said}); startLiveTurn(said); return true; };
  const view = () => ({sessionId: S.sessionId, agentSession: S.agentSession, busy: !!S.busy, turnId: S.turnId,
    rows: window.__sidebar().chats.filter((c) => mine(c.id)).map((c) => ({id: c.id, name: c.name, dot: c.dot})),
    on: [...document.querySelectorAll('#sidebar .sesrow.on')].map((n) => n.dataset.ses),
    drawn: [...document.querySelectorAll('#sidebar [data-ses]')].map((n) => n.dataset.ses).filter(mine)});
`;
const VIEW = `(() => { ${H} return view(); })()`;

/* The window as the check found it; RESTORE puts it back. */
const KEEP = `(() => {
  window.__t27keep = {log: S.log, sessionId: S.sessionId, agentSession: S.agentSession, busy: S.busy, pending: S.pending,
    history: S.history, room: S.room, streamId: S.streamId, turnId: S.turnId, reasonId: S.reasonId, stick: S.stick,
    settings: S.settings, toasts: S.toasts.slice(), queued: S.queued.slice(), had: 'turnStartedAt' in S, started: S.turnStartedAt,
    fz: FZ.live, stamp: CTX055.stamp, plan: {on: PLAN.on, itemId: PLAN.itemId, sessionId: PLAN.sessionId, startedMode: PLAN.startedMode},
    wait: WAIT};
  return true;
})()`;
const RESTORE = `(async () => { ${H}
  await tick(150);   // the answers let go just before this are dealt with first
  const k = window.__t27keep; delete window.__t27keep;
  if (k) {
    S.log = k.log; S.sessionId = k.sessionId; S.agentSession = k.agentSession; S.busy = k.busy; S.pending = k.pending;
    S.history = k.history; S.room = k.room; S.streamId = k.streamId; S.turnId = k.turnId; S.reasonId = k.reasonId;
    S.stick = k.stick; S.settings = k.settings; S.toasts = k.toasts; S.queued = k.queued;
    if (k.had) S.turnStartedAt = k.started; else delete S.turnStartedAt;
    FZ.live = k.fz; CTX055.stamp = k.stamp; Object.assign(PLAN, k.plan);
  }
  // A wait a staged turn was left in (the check stopped between its frames) goes; the window's own comes back.
  WAIT = k ? k.wait : null;
  if (!WAIT && WAIT_TICK) { clearInterval(WAIT_TICK); WAIT_TICK = 0; }
  for (const [turn, sid] of [...RUNNING]) if (mine(turn) || mine(sid)) RUNNING.delete(turn);
  for (const sid of [...PENDING_APPROVALS.keys()]) if (mine(sid)) PENDING_APPROVALS.delete(sid);
  for (const sid of [...ATTN]) if (mine(sid)) ATTN.delete(sid);
  // The fix's own maps, where the build has them.
  if (typeof FIRST_TURNS !== 'undefined') for (const turn of [...FIRST_TURNS.keys()]) if (mine(turn)) FIRST_TURNS.delete(turn);
  if (typeof PENDING_CHATS !== 'undefined') for (const sid of [...PENDING_CHATS.keys()]) if (mine(sid)) PENDING_CHATS.delete(sid);
  for (let i = SESSIONS.length - 1; i >= 0; i--) if (mine(SESSIONS[i].id)) SESSIONS.splice(i, 1);
  const seen = Object.keys(PREFS.seen).filter(mine);
  seen.forEach((sid) => { delete PREFS.seen[sid]; });
  if (seen.length) savePrefs();
  renderToasts(); render();
  await refreshSessions();
  refreshContext();
  return true;
})()`;

/** A frame of the turn `turnId`, down the real agent:chat channel. */
function frame(w: BrowserWindow, turnId: string, kind: string, extra: Record<string, unknown> = {}): void {
  w.webContents.send("agent:chat", { turnId, kind, ...extra });
}
/** The agent's session_id frame, shaped as agent-client.ts relays it. */
function named(w: BrowserWindow, turnId: string, sid: string): void {
  frame(w, turnId, "session_id", { payload: { id: "chatcmpl-smoke-t27", object: "chat.completion.session", session_id: sid } });
}

/* Whatever the window asked for while it handled a frame (the list read a
   turn's end starts) is answered before the reply to a later request on the
   same channel; a beat on top for the repaint. */
async function settle(js: Js): Promise<void> {
  await js<unknown>(`BR.session(${q(PROBE)}).then(() => new Promise((res) => setTimeout(res, 150)))`);
}

/** Until `expr` (renderer code) is true, at most three seconds. */
async function until(js: Js, expr: string): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    if ((await js<boolean>(`!!(${expr})`)) === true) return true;
    await wait(25);
  }
  return false;
}
/** BR.chat answered `turnId` and the window took it. */
const turnTaken = (js: Js, turnId: string) => until(js, `S.turnId === ${q(turnId)}`);
/** The window handled the turn's session_id frame (its running-dot bookkeeping names the session). */
const frameNamed = (js: Js, turnId: string, sid: string) => until(js, `RUNNING.get(${q(turnId)}) === ${q(sid)}`);
/** The window handled the turn's last frame, and with it sent off the list read that follows a turn. */
const frameEnded = (js: Js, turnId: string) => until(js, `!RUNNING.has(${q(turnId)})`);

const listed = (id: string, turnCount: number, title: string | null = null): Listed =>
  ({ id, turnCount, title, updatedAt: Date.now() });
const only = (v: View, id: string) => v.rows.filter((r) => r.id === id);

export async function checks27(js: Js, check: Check): Promise<void> {
  const wins = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed());
  const w = wins[0] ?? null;
  // The agent's own list, read through the real handler before the stand-ins go on.
  const before = await js<{ ok?: boolean; data?: { sessions?: unknown[] } } | null>("BR.sessions()").catch(() => null);
  const agent = new StandIns(before?.ok && Array.isArray(before.data?.sessions) ? before.data!.sessions! : []);
  let kept = false;
  try {
    for (const x of wins) {
      x.webContents.ipc.handle("agent:chat", agent.chat);
      x.webContents.ipc.handle("agent:sessions", agent.sessions);
      x.webContents.ipc.handle("agent:session", agent.session);
    }
    const probe = await js<Probe>(
      `Promise.all([BR.session(${q(PROBE)}), BR.sessions()]).then(([session, list]) => ({session, list}))`,
    ).catch((e: unknown): Probe => ({ error: String(e) }));
    if (!w || probe.session?.data?.smokeT27 !== true || probe.list?.data?.smokeT27 !== true) {
      check("T27: stand-ins on the window's IPC answer the session list and the session fetch first", false,
        `${JSON.stringify(probe)}; nothing was staged`);
      return;
    }
    kept = await js<boolean>(KEEP);
    await firstMessage(js, check, agent, w);
    await firstTurnLostByTheAgent(js, check, agent, w);
    await chatAlreadyListed(js, check, agent, w);
    await waitNamesItsProvider(js, check, agent, w);
  } finally {
    /* The held answers are let go and the stand-ins come off before anything
       else is awaited, so a renderer call that never settles cannot leave
       them answering for the rest of the suite. */
    agent.releaseAll();
    for (const x of wins) {
      if (x.isDestroyed()) continue;
      x.webContents.ipc.removeHandler("agent:chat");
      x.webContents.ipc.removeHandler("agent:sessions");
      x.webContents.ipc.removeHandler("agent:session");
    }
    if (kept) await js<unknown>(RESTORE);
  }
}

/* (a) New chat, then the first message. The agent names the session at once
   (its session_id frame) and holds it with no turn, which is what a read of
   the list in the middle of the turn finds. Then the turn ends: the list has
   the chat with its turn, and the transcript fetch that would name a row the
   list gives no title is held, so the row shows whatever the window already
   had for it. */
async function firstMessage(js: Js, check: Check, agent: StandIns, w: BrowserWindow): Promise<void> {
  const sid = `${PREFIX}new`;
  const turn = `${PREFIX}turn-new`;
  const said = "smoke t27: the first message of a new chat";
  agent.turns.push(turn);
  const pressed = await js<boolean>(`(() => { ${H} return newChat(); })()`);
  await js<boolean>(`(() => { ${H} return send(${q(said)}); })()`);
  const taken = await turnTaken(js, turn);
  named(w, turn, sid);
  const handled = await frameNamed(js, turn, sid);
  await settle(js);
  const during = await js<View>(VIEW);
  const row = only(during, sid);
  check(
    "T27: New chat, then a message: the chat is on the sidebar while its first turn runs, named by that message, running and current",
    pressed && taken && handled && agent.sent.length === 1 && !agent.sent[0]!.sessionId
      && row.length === 1 && row[0]!.name === said && row[0]!.dot === "running"
      && during.drawn.includes(sid) && during.on.length === 1 && during.on[0] === sid && during.sessionId === sid,
    `pressed=${pressed} taken=${taken} frame handled=${handled} sent=${JSON.stringify(agent.sent.map((p) => p.sessionId ?? null))} → ${JSON.stringify(during)}`,
  );

  // The list read again mid-turn (another chat's turn ending does it): the agent has this chat with no stored turn.
  agent.rows = [listed(sid, 0)];
  const reads = agent.listReads;
  await js<number>("window.__sessionsRefresh()");
  const reread = await js<View>(VIEW);
  const kept = only(reread, sid);
  check(
    "T27: reading the list again while that first turn runs keeps the chat on the sidebar",
    agent.listReads > reads && kept.length === 1 && kept[0]!.name === said && kept[0]!.dot === "running",
    JSON.stringify(reread),
  );

  // The turn ends: the store wrote it, the list has the chat with one turn and no title yet.
  agent.rows = [listed(sid, 1)];
  agent.transcripts.set(sid, [
    { kind: "user", text: said },
    { kind: "assistant_reply", text: "smoke t27: the reply" },
  ]);
  agent.hold(sid);
  const atEnd = agent.listReads;
  frame(w, turn, "delta", { text: "smoke t27: the reply" });
  frame(w, turn, "done");
  const ended = await frameEnded(js, turn);
  await settle(js);
  const after = await js<View>(VIEW);
  const landed = only(after, sid);
  check(
    "T27: when the first turn ends, the stored row takes the chat's place: one row, under the same name, not the session id",
    ended && agent.listReads > atEnd && landed.length === 1 && landed[0]!.name === said && landed[0]!.dot !== "running" && !after.busy,
    `frame handled=${ended} list reads=${agent.listReads - atEnd} → ${JSON.stringify(after)}`,
  );
  agent.release(sid);
  await settle(js);
}

/* (b) A first turn the agent loses: the stream ends in an error (the agent
   went away under it) and the list read after it does not have the chat.
   No row may stay behind for a chat that does not exist. */
async function firstTurnLostByTheAgent(js: Js, check: Check, agent: StandIns, w: BrowserWindow): Promise<void> {
  const sid = `${PREFIX}lost`;
  const turn = `${PREFIX}turn-lost`;
  agent.turns.push(turn);
  const pressed = await js<boolean>(`(() => { ${H} return newChat(); })()`);
  await js<boolean>(`(() => { ${H} return send('smoke t27: a first message whose turn is lost'); })()`);
  const taken = await turnTaken(js, turn);
  named(w, turn, sid);
  const handled = await frameNamed(js, turn, sid);
  const reads = agent.listReads;
  frame(w, turn, "error", { error: "smoke t27: the agent went away" });
  const ended = await frameEnded(js, turn);
  await settle(js);
  const after = await js<View>(VIEW);
  check(
    "T27: a first turn that ends with nothing stored leaves no row behind",
    pressed && taken && handled && ended && agent.listReads > reads && only(after, sid).length === 0 && !after.drawn.includes(sid),
    `pressed=${pressed} taken=${taken} frames handled=${handled},${ended} list reads=${agent.listReads - reads} → ${JSON.stringify(after)}`,
  );
}

/* (c) A message in a chat the list already has: the stream names that chat
   again, and it stays one row. */
async function chatAlreadyListed(js: Js, check: Check, agent: StandIns, w: BrowserWindow): Promise<void> {
  const sid = `${PREFIX}listed`;
  const turn = `${PREFIX}turn-listed`;
  const title = "smoke t27: a chat already on the list";
  agent.rows = [listed(sid, 2, title)];
  agent.transcripts.set(sid, [
    { kind: "user", text: "smoke t27: earlier question" },
    { kind: "assistant_reply", text: "smoke t27: earlier answer" },
  ]);
  await js<number>("window.__sessionsRefresh()");
  const opened = await js<boolean>(`(async () => { ${H}
    const row = document.querySelector('#sidebar [data-ses="' + ${q(sid)} + '"]');
    if (!row) return false;
    row.click();
    const t0 = Date.now();
    while (S.agentSession !== ${q(sid)} && Date.now() - t0 < 3000) await tick(25);
    return S.agentSession === ${q(sid)};
  })()`);
  agent.turns.push(turn);
  const sentBefore = agent.sent.length;
  await js<boolean>(`(() => { ${H} return send('smoke t27: a message in a listed chat'); })()`);
  const taken = await turnTaken(js, turn);
  named(w, turn, sid);
  const handled = await frameNamed(js, turn, sid);
  await settle(js);
  const during = await js<View>(VIEW);
  agent.rows = [listed(sid, 3, title)];
  frame(w, turn, "done");
  const ended = await frameEnded(js, turn);
  await settle(js);
  const after = await js<View>(VIEW);
  const payload = agent.sent[sentBefore];
  check(
    "T27: a message in a chat already on the list keeps it one row, during the turn and after it",
    opened && taken && handled && ended && payload?.sessionId === sid
      && only(during, sid).length === 1 && only(during, sid)[0]!.dot === "running"
      && only(after, sid).length === 1 && only(after, sid)[0]!.name === title,
    `opened=${opened} taken=${taken} frames handled=${handled},${ended} session=${JSON.stringify(payload?.sessionId ?? null)} during=${JSON.stringify(during)} → after=${JSON.stringify(after)}`,
  );
}

/* ---- 29: what a parked turn says it is waiting for ---- */

type Wait = { shown: boolean; ann: string; why: string; note: string; picked: string; before: string };

/** The strip and the newest wait line in the transcript, as a person reads them. */
const WAIT_VIEW = `(() => {
  const strip = document.querySelector('.statusstrip.waiting');
  const notes = S.log.filter((m) => m.k === 'system' && m.sev === 'pause' && m.note);
  const last = notes[notes.length - 1];
  return {shown: !!strip, ann: strip ? (strip.querySelector('.ann') || {}).textContent || '' : '',
    why: strip ? (strip.querySelector('.ss-why') || {}).textContent || '' : '',
    note: last ? String(last.text || '') : '', picked: String(selActiveProviderId() || ''),
    // What the strip said before item 29, for the provider picked now.
    before: 'Waiting for ' + (providerWord(selActiveProviderId()) || 'the provider')};
})()`;

/* The picked provider becomes a cloud one for the cases below (the window's
   copy of the config only; nothing is written), and comes back after. */
const PICK_CLOUD = `(() => {
  window.__t27pick = {cfg: LIVE_CONFIG, want: SWX.want};
  const llm = (LIVE_CONFIG && LIVE_CONFIG.llm) || {};
  const providers = (Array.isArray(llm.providers) ? llm.providers : []).filter((p) => p && p.id !== 'aimlapi');
  LIVE_CONFIG = Object.assign({}, LIVE_CONFIG || {}, {llm: Object.assign({}, llm,
    {activeTextProvider: 'aimlapi', providers: providers.concat([{id: 'aimlapi', kind: 'aimlapi'}])})});
  SWX.want = null;
  render();
  return {picked: selActiveProviderId(), name: providerWord('aimlapi')};
})()`;
const UNPICK = `(() => {
  const k = window.__t27pick; delete window.__t27pick;
  if (k) { LIVE_CONFIG = k.cfg; SWX.want = k.want; }
  render();
  return true;
})()`;

/** A provider_waiting frame as the agent writes it; `extra` adds the newer agent's fields. */
const waiting = (sid: string, extra: Record<string, unknown> = {}) => ({
  payload: {
    object: "atomic.provider_waiting", session_id: sid, attempt: 1, waited_ms: 0,
    max_wait_ms: 300_000, next_retry_ms: 30_000, reason: "fetch failed", ...extra,
  },
});
const TAIL = ". The turn is paused and retries on its own for up to 5 min. Stop ends it.";

/** One wait, from its frame to its end: what it showed while it lasted. */
async function oneWait(js: Js, w: BrowserWindow, turn: string, sid: string, extra?: Record<string, unknown>): Promise<Wait & { started: boolean }> {
  frame(w, turn, "provider_waiting", waiting(sid, extra));
  const started = await until(js, "!!WAIT");
  await settle(js);
  const seen = await js<Wait>(WAIT_VIEW);
  frame(w, turn, "provider_recovered", { payload: { object: "atomic.provider_recovered", session_id: sid, waited_ms: 1000 } });
  await until(js, "!WAIT");
  return { ...seen, started };
}

/* (d) A turn on screen parks three times: on a frame with no provider or
   cause (an older agent); on one naming the local server, refused, while
   the picked provider is a cloud one; and on one naming that cloud provider,
   unreachable. Each wait ends before the next (provider_recovered), so each
   draws its own transcript line. */
async function waitNamesItsProvider(js: Js, check: Check, agent: StandIns, w: BrowserWindow): Promise<void> {
  const sid = `${PREFIX}wait`;
  const turn = `${PREFIX}turn-wait`;
  agent.turns.push(turn);
  const pressed = await js<boolean>(`(() => { ${H} return newChat(); })()`);
  await js<boolean>(`(() => { ${H} return send('smoke t27: a message whose turn waits on a provider'); })()`);
  const ready = pressed && (await turnTaken(js, turn));
  named(w, turn, sid);
  const handled = ready && (await frameNamed(js, turn, sid));

  const old = await oneWait(js, w, turn, sid);
  check(
    "T29: a wait frame with no provider or cause (an older agent) reads exactly as before",
    handled && old.started && old.shown && old.ann === old.before && old.why === "no connection"
      && old.note === `The model isn’t answering (no connection)${TAIL}`,
    JSON.stringify(old),
  );

  const pick = await js<{ picked: string; name: string }>(PICK_CLOUD);
  try {
    const local = await oneWait(js, w, turn, sid, { provider_id: "local-llama", cause: { kind: "refused" } });
    const said = `${local.ann} ${local.why} ${local.note}`;
    check(
      "T29: a wait on the local server while a cloud provider is picked names Local models and says its server isn't running",
      pick.picked === "aimlapi" && local.started && local.shown
        && local.ann === "Waiting for Local models" && local.why === "the local model server isn’t running"
        && local.note === `No answer from Local models (the local model server isn’t running)${TAIL}`
        && !said.includes("no connection") && !said.includes(pick.name),
      `picked=${pick.picked} → ${JSON.stringify(local)}`,
    );

    const cloud = await oneWait(js, w, turn, sid, { provider_id: "aimlapi", cause: { kind: "unreachable" } });
    check(
      "T29: a connection failure to the provider the agent names reads \"no connection\", with that provider named in the strip and the transcript",
      cloud.started && cloud.shown && cloud.ann === `Waiting for ${pick.name}` && cloud.why === "no connection"
        && cloud.note === `No answer from ${pick.name} (no connection)${TAIL}`,
      JSON.stringify(cloud),
    );
  } finally {
    await js<boolean>(UNPICK);
  }
  frame(w, turn, "done");
  await frameEnded(js, turn);
  await settle(js);
}
