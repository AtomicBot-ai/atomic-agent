import { BrowserWindow } from "electron";

/**
 * Release-fix checks for the 02.10 build's B01 and B06 (see
 * main/release-fixes-smoke.ts). Run alone with `--smoke --smoke-task=64`.
 *
 * B01 — Ask first, a turn waits on an approval for minutes and ends with
 * "The turn could not be completed after 7 min 33 s: terminated". The chat
 * then showed three (another time five) live Allow once / Deny / Abort run
 * cards for the same call, and the composer kept saying "Waiting for your
 * approval". The agent's events stream replays what it still lists on every
 * reconnect, and it kept listing requests whose turn had ended; the window
 * drew each of them as a live card, and the turn's end closed none.
 *
 * Now a call has one open card: a newer request of the chat for the same
 * call closes the older one (another call waiting at the same time keeps its
 * own); the end of the chat's turn here (an error, done, stopped) closes
 * every card of it and the composer stops waiting; a copy of a closed request
 * arriving later draws nothing.
 *
 * B06 — after that, ⌘N denied a stale card (`n`) instead of opening a new
 * chat. Now y / n / Esc answer only as bare keys, and only an open request:
 * Alt+N, Alt+Y, Ctrl+Y and ⌘Y with a card up answer nothing, and ⌘N opens a
 * new chat. A bare y still allows the open request.
 *
 * Nothing reaches the agent and the config is not touched. The requests go
 * through the real onApprovalEvent, the turn's end through the real
 * onChatEvent, the keys through the real keydown handler; the verdict and the
 * cancel are answered by stand-ins on the window's own IPC (a webContents
 * handler is asked before ipcMain's; a probe proves it first) and recorded,
 * never forwarded. What the check staged comes back out and the window is put
 * back as it was.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Handler = (event: unknown, arg: unknown) => unknown;

const PREFIX = "smoke-t64-";
const PROBE = `${PREFIX}probe`;
const A = `${PREFIX}chat-a`;
const TURN = `${PREFIX}turn-a`;
const ASK_1 = `${PREFIX}approval-1`;   // the turn's first request
const ASK_2 = `${PREFIX}approval-2`;   // the same call asked again
const ASK_3 = `${PREFIX}approval-3`;   // the next turn's request, for the keys
const ASK_R = `${PREFIX}approval-r`;   // another call of the same step, waiting at the same time
const QUIET = "smoke t64: not answered while the check runs";
const q = (v: unknown) => JSON.stringify(v);
const show = (x: unknown) => JSON.stringify(x);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The agent as this check needs it, on the window's own IPC. */
class StandIn {
  readonly approved: string[] = [];
  readonly cancelled: string[] = [];
  private readonly quiet: Handler = () => ({ ok: false, error: QUIET });
  private readonly noParked: Handler = () => ({ ok: true, data: { undelivered: [], discarded: 0 } });
  private readonly session: Handler = (_e, id) => {
    const sid = typeof id === "string" ? id : "";
    if (sid === PROBE) return { ok: true, data: { id: sid, turns: [], smokeT64: true } };
    return { ok: false, error: QUIET };
  };
  private readonly approve: Handler = (_e, payload) => {
    const p = (payload ?? {}) as { approvalId?: unknown; decision?: unknown };
    this.approved.push(`${String(p.approvalId)} ${String(p.decision)}`);
    return { ok: true, data: { resolved: true } };
  };
  private readonly cancel: Handler = (_e, turnId) => { this.cancelled.push(String(turnId)); return true; };

  private channels(): Array<[string, Handler]> {
    return [
      ["agent:session", this.session], ["agent:approve", this.approve], ["agent:cancel", this.cancel],
      ["agent:contextPreview", this.quiet], ["agent:undeliveredSteers", this.noParked], ["cli:traceTools", this.quiet],
      ["app:statPaths", this.quiet], ["cli:chatModelsList", this.quiet],
    ];
  }

  install(wins: BrowserWindow[]): void {
    for (const x of wins) for (const [ch, fn] of this.channels()) { x.webContents.ipc.removeHandler(ch); x.webContents.ipc.handle(ch, fn); }
  }

  uninstall(wins: BrowserWindow[]): void {
    for (const x of wins) if (!x.isDestroyed()) for (const [ch] of this.channels()) x.webContents.ipc.removeHandler(ch);
  }
}

/* Shared by the probes below. */
const H = String.raw`
  const mine = (x) => typeof x === 'string' && (x.indexOf('smoke-t64-') === 0 || x.indexOf('turn:smoke-t64-') === 0);
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  const ask = (approvalId) => onApprovalEvent({approvalId, tool: 'os.shell.run', category: 'shell',
    reason: 'smoke t64', preview: 'df -h /', sessionId: ${JSON.stringify(A)}});
  // A key pressed with focus outside the editor, the transcript at its bottom (as t25's press).
  const press = (key, mods) => {
    const a = document.activeElement;
    if (a && a !== document.body && a.blur) a.blur();
    const sc = document.getElementById('scroller');
    if (sc) sc.scrollTop = sc.scrollHeight;
    document.body.dispatchEvent(new KeyboardEvent('keydown', Object.assign({key, bubbles: true, cancelable: true}, mods || {})));
  };
  const view = () => {
    render();
    return {sessionId: S.sessionId, agentSession: S.agentSession,
      pending: S.pending ? String(S.pending.approvalId || '') : null,
      rows: S.log.filter((m) => m.k === 'approval').map((m) => String(m.approvalId || '') + (m.state ? ':' + m.state : '')),
      cards: [...document.querySelectorAll('#scroller .appr[data-appr-id]')].map((n) => n.getAttribute('data-appr-id') || ''),
      waiting: [...PENDING_APPROVALS].filter(([s]) => mine(s)).map(([s, a]) => s + '>' + a),
      kept: [...APPROVAL_CARDS].filter(([s, r]) => mine(s) && !r.state).map(([s, r]) => s + '>' + r.approvalId),
      gated: !!document.querySelector('#composer .statusstrip.gated'),
      busy: !!S.busy};
  };
`;
type View = {
  sessionId: string; agentSession: string | null; pending: string | null;
  rows: string[]; cards: string[]; waiting: string[]; kept: string[]; gated: boolean; busy: boolean;
};

const KEEP = `(() => {
  window.__t64keep = {log: S.log, sessionId: S.sessionId, agentSession: S.agentSession, busy: S.busy, pending: S.pending,
    focused: S.apprFocused, history: S.history, room: S.room, streamId: S.streamId, turnId: S.turnId, stick: S.stick,
    queued: S.queued.slice(), ahead: STEER.ahead, opening: OPENING, owed: typeof DRAIN_OWED !== 'undefined' ? DRAIN_OWED : null,
    stamp: CTX055.stamp, plan: {on: PLAN.on, itemId: PLAN.itemId, sessionId: PLAN.sessionId, startedMode: PLAN.startedMode}};
  return true;
})()`;

const FORGET = String.raw`
  for (const [turn, sid] of [...RUNNING]) if (mine(turn) || mine(sid)) RUNNING.delete(turn);
  for (const sid of [...PENDING_APPROVALS.keys()]) if (mine(sid)) PENDING_APPROVALS.delete(sid);
  for (const sid of [...APPROVAL_CARDS.keys()]) if (mine(sid)) APPROVAL_CARDS.delete(sid);
  for (const id of [...CLOSED_APPROVALS]) if (mine(id)) CLOSED_APPROVALS.delete(id);
  for (const sid of [...ATTN]) if (mine(sid)) ATTN.delete(sid);
  if (typeof QUEUES !== 'undefined') for (const key of [...QUEUES.keys()]) if (mine(key)) QUEUES.delete(key);
  for (let i = SESSIONS.length - 1; i >= 0; i--) if (mine(SESSIONS[i].id)) SESSIONS.splice(i, 1);
  const seen = Object.keys(PREFS.seen).filter(mine);
  seen.forEach((sid) => { delete PREFS.seen[sid]; });
  if (seen.length) savePrefs();
`;

const RESTORE = `(() => { ${H}
  const k = window.__t64keep; delete window.__t64keep;
  ${FORGET}
  if (k) {
    S.log = k.log; S.sessionId = k.sessionId; S.agentSession = k.agentSession; S.busy = k.busy; S.pending = k.pending;
    S.apprFocused = k.focused; S.history = k.history; S.room = k.room; S.streamId = k.streamId; S.turnId = k.turnId;
    S.stick = k.stick; S.queued.length = 0; S.queued.push(...k.queued); STEER.ahead = k.ahead; OPENING = k.opening;
    if (typeof DRAIN_OWED !== 'undefined') DRAIN_OWED = k.owed;
    CTX055.stamp = k.stamp; Object.assign(PLAN, k.plan);
  }
  render();
  return true;
})()`;

/* Chat A on screen, its turn running (started here, its reply row on screen,
   not the window's last turn, so the end draws no failure line here). No
   queued message of the person's can be sent by anything below: the queue
   on screen is emptied (RESTORE gives it back). */
const STAGE = `(() => { ${H}
  ${FORGET}
  S.queued.length = 0; STEER.ahead = 0;
  if (typeof DRAIN_OWED !== 'undefined') DRAIN_OWED = false;
  OPENING = null; S.room = 'chat'; S.busy = true; S.pending = null; S.turnId = null; PLAN.on = false;
  S.sessionId = ${q(A)}; S.agentSession = ${q(A)};
  const item = {id: nid(), k: 'assistant', text: '', turn: ${q(TURN)}};
  S.log = [{id: nid(), k: 'user', text: 'smoke t64: check free disk space'}, item];
  S.streamId = item.id;
  RUNNING.set(${q(TURN)}, ${q(A)});
  render();
  return true;
})()`;

export async function checks64(js: Js, check: Check): Promise<void> {
  const wins = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed());
  const agent = new StandIn();
  let kept = false;
  try {
    agent.install(wins);
    const probe = await js<{ data?: { smokeT64?: boolean } } | null>(`BR.session(${q(PROBE)})`).catch((e: unknown) => String(e));
    if (typeof probe !== "object" || probe?.data?.smokeT64 !== true) {
      check("T64: a stand-in on the window's IPC answers the session fetch first", false, `${show(probe)}; nothing was staged`);
      return;
    }
    kept = await js<boolean>(KEEP);
    await js<boolean>(STAGE);

    // (a) The turn asks, the same call is asked again, and the first request comes back (an events reconnect).
    const again = await js<View>(`(() => { ${H} ask(${q(ASK_1)}); ask(${q(ASK_2)}); ask(${q(ASK_1)}); return view(); })()`);
    check(
      "T64 (B01): a call has one open approval card: a newer request for the same call closes the older one, and a copy of the older one does not open it again",
      again.pending === ASK_2 && show(again.cards) === show([ASK_2])
        && show(again.rows) === show([`${ASK_1}:expired`, ASK_2]) && show(again.waiting) === show([`${A}>${ASK_2}`]) && again.gated,
      show(again),
    );

    // (a2) Another call of the same step asks while that one waits (a read outside the folder): both stay open.
    const other = await js<View>(`(() => { ${H}
      onApprovalEvent({approvalId: ${q(ASK_R)}, tool: 'os.fs.read', category: 'fs_read_outside', reason: 'smoke t64',
        preview: '/etc/hosts', affectedResources: ['/etc'], sessionId: ${q(A)}});
      return view();
    })()`);
    check(
      "T64 (B01): a request for another call of the same chat does not close the open one",
      other.pending === ASK_R && show(other.cards) === show([ASK_2, ASK_R])
        && show(other.rows) === show([`${ASK_1}:expired`, ASK_2, ASK_R]),
      show(other),
    );

    // (b) The turn ends with the card unanswered ("terminated"), then the events stream replays both requests.
    const ended = await js<{ end: View; replay: View }>(`(async () => { ${H}
      onChatEvent({turnId: ${q(TURN)}, kind: 'error', error: 'terminated'});
      const end = view();
      ask(${q(ASK_1)}); ask(${q(ASK_2)});
      onApprovalEvent({approvalId: ${q(ASK_R)}, tool: 'os.fs.read', category: 'fs_read_outside', reason: 'smoke t64',
        preview: '/etc/hosts', affectedResources: ['/etc'], sessionId: ${q(A)}});
      await tick(50);
      return {end, replay: view()};
    })()`);
    const closedRows = show([`${ASK_1}:expired`, `${ASK_2}:expired`, `${ASK_R}:expired`]);
    check(
      "T64 (B01): when the chat's turn ends with a request open, its cards close, nothing waits for an approval and the composer stops saying so",
      ended.end.pending === null && ended.end.cards.length === 0 && show(ended.end.rows) === closedRows
        && ended.end.waiting.length === 0 && ended.end.kept.length === 0 && !ended.end.gated && !ended.end.busy,
      show(ended.end),
    );
    check(
      "T64 (B01): a request of a turn that ended here, replayed afterwards, draws no card and opens nothing again",
      ended.replay.pending === null && ended.replay.cards.length === 0 && show(ended.replay.rows) === closedRows
        && ended.replay.waiting.length === 0 && !ended.replay.gated,
      show(ended.replay),
    );

    // (c) The next turn of the chat asks. Chords with n and y answer nothing; ⌘N opens a new chat.
    const mark = agent.approved.length;
    const keys = await js<{ asked: View; chords: View; fresh: View }>(`(async () => { ${H}
      RUNNING.set(${q(`${TURN}-2`)}, ${q(A)});
      ask(${q(ASK_3)});
      const asked = view();
      press('n', {altKey: true}); press('y', {altKey: true}); press('y', {ctrlKey: true}); press('y', {metaKey: true});
      await tick(50);
      const chords = view();
      press('n', {metaKey: true});
      await tick(150);
      return {asked, chords, fresh: view()};
    })()`);
    const chordAnswers = agent.approved.slice(mark);
    check(
      "T64 (B06): with an approval card up, chords with n and y answer nothing, and the card stays open",
      keys.asked.pending === ASK_3 && show(keys.asked.cards) === show([ASK_3])
        && keys.chords.pending === ASK_3 && show(keys.chords.cards) === show([ASK_3]) && chordAnswers.length === 0,
      `asked=${show(keys.asked)} chords=${show(keys.chords)} sent=${show(chordAnswers)}`,
    );
    check(
      "T64 (B06): ⌘N with an approval card up opens a new chat and leaves the request open for its chat",
      keys.fresh.sessionId === "" && keys.fresh.agentSession === null && keys.fresh.pending === null && keys.fresh.cards.length === 0
        && keys.fresh.waiting.includes(`${A}>${ASK_3}`) && chordAnswers.length === 0,
      `fresh=${show(keys.fresh)} sent=${show(chordAnswers)}`,
    );

    // (d) Back in the chat, the bare y still allows its open request.
    const mark2 = agent.approved.length;
    const yes = await js<View>(`(async () => { ${H}
      S.sessionId = ${q(A)}; S.agentSession = ${q(A)};
      const req = APPROVAL_CARDS.get(${q(A)});
      S.log = [{id: nid(), k: 'user', text: 'smoke t64: check free disk space'}, req];
      S.pending = req; S.apprFocused = true;
      press('y');
      await tick(150);
      return view();
    })()`);
    const sent = agent.approved.slice(mark2);
    check(
      "T64 (B06): the bare y still allows the chat's open request, once",
      show(sent) === show([`${ASK_3} allow-once`]) && yes.pending === null && !yes.waiting.some((w) => w.startsWith(`${A}>`)),
      `yes=${show(yes)} sent=${show(sent)}`,
    );
    // What the turn's end set off (the session list re-read) is answered before the stand-ins go.
    await wait(300);
  } finally {
    /* The stand-ins come off before anything else is awaited (see t25). */
    agent.uninstall(wins);
    if (kept) await js<unknown>(RESTORE).catch(() => undefined);
    await wait(50);
  }
}
