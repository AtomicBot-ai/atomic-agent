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
 * call closes the older one for good (a copy of it draws nothing). Another
 * call waiting at the same time keeps its own card, and that card's buttons
 * answer it. The end of the chat's turn here (an error, done, stopped)
 * closes every card of it and the composer stops waiting; a request the
 * agent replays after that (it replays only what its gate still holds: one
 * another surface raised in the chat) opens its card again.
 *
 * B06 — after that, ⌘N denied a stale card (`n`) instead of opening a new
 * chat. Now y / n / Esc answer only as bare keys, and only an open request:
 * Alt+N, Alt+Y and ⌘Y with a card up answer nothing, Ctrl+Esc and Alt+Esc
 * open nothing over it, and ⌘N opens a new chat. Ctrl+Y (the TUI's chord)
 * and the bare y still allow the open request.
 *
 * A window that loads again (reopened from the Dock, reloaded) gets the
 * agent's replay of what is pending before it has read the chat list. A
 * request then stays kept for its chat (its dot) instead of being drawn over
 * the empty start view; the chat shows it, with its transcript, when it is
 * opened. Only a request whose chat has no row once the list is in is drawn
 * where the person is. Simulated here by marking the list unread.
 *
 * ATO-198: such a page also takes over the turns main is streaming before it
 * asks for that replay (agent:liveTurns, adoptLiveTurns, then
 * agent:replayApprovals). A new chat's first turn waiting on an approval is
 * not on the chat list yet: its row stands in, the request is kept for it,
 * its frames are kept, and opening it shows the message, the card and what
 * streamed since. Fed here through adoptLiveTurns; main's side (the turns it
 * lists, the replay on request) needs a real agent and a reload, and is not
 * covered.
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
const ASK_4 = `${PREFIX}approval-4`;   // the same call asked again, for the bare y
const ASK_R = `${PREFIX}approval-r`;   // another call of the same step, waiting at the same time
const B = `${PREFIX}chat-b`;           // a chat with a row whose request is replayed into a page that just loaded
const C = `${PREFIX}chat-c`;           // a session with no row anywhere (a one-shot task's)
const ASK_B = `${PREFIX}approval-b`;
const ASK_C = `${PREFIX}approval-c`;
const ASKED_B = "smoke t64: Создай файл test2.txt с текстом привет";
const N = `${PREFIX}chat-n`;           // a new chat whose first turn runs, started by the page before this one
const TURN_N = `${PREFIX}turn-n`;
const ASK_N = `${PREFIX}approval-n`;
const ASKED_N = "smoke t64: Создай файл test5.txt с текстом привет";
const N2 = `${PREFIX}chat-n2`;         // a second new chat, its first turn waiting too (ATO-208)
const TURN_N2 = `${PREFIX}turn-n2`;
const ASK_N2 = `${PREFIX}approval-n2`;
const ASKED_N2 = "smoke t64: Создай файл test67.txt с текстом привет";
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
    if (sid === N || sid === N2) return { ok: true, data: { id: sid, status: "running", turns: [] } };
    if (sid === B) return { ok: true, data: { id: sid, status: "running", turns: [{ kind: "user", text: ASKED_B }] } };
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
  // Another call of the same step: a read outside the working folder.
  const askRead = () => onApprovalEvent({approvalId: ${JSON.stringify(`${PREFIX}approval-r`)}, tool: 'os.fs.read',
    category: 'fs_read_outside', reason: 'smoke t64', preview: '/etc/hosts', affectedResources: ['/etc'],
    sessionId: ${JSON.stringify(A)}});
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
      // The strip sits above the composer in .composerwrap, not inside #composer (as t25 reads it).
      gated: [...document.querySelectorAll('.statusstrip')].some((n) => /Waiting for your approval/.test(n.textContent || '')),
      busy: !!S.busy, settings: !!S.settings || !!S.overlay};
  };
`;
type View = {
  sessionId: string; agentSession: string | null; pending: string | null;
  rows: string[]; cards: string[]; waiting: string[]; kept: string[]; gated: boolean; busy: boolean; settings: boolean;
};

const KEEP = `(() => {
  window.__t64keep = {log: S.log, sessionId: S.sessionId, agentSession: S.agentSession, busy: S.busy, pending: S.pending,
    focused: S.apprFocused, history: S.history, room: S.room, streamId: S.streamId, turnId: S.turnId, stick: S.stick,
    queued: S.queued.slice(), ahead: STEER.ahead, opening: OPENING, owed: typeof DRAIN_OWED !== 'undefined' ? DRAIN_OWED : null,
    sessionsRead: SESSIONS_READ, stamp: CTX055.stamp, plan: {on: PLAN.on, itemId: PLAN.itemId, sessionId: PLAN.sessionId, startedMode: PLAN.startedMode}};
  return true;
})()`;

const FORGET = String.raw`
  for (const [turn, sid] of [...RUNNING]) if (mine(turn) || mine(sid)) RUNNING.delete(turn);
  for (const sid of [...PENDING_APPROVALS.keys()]) if (mine(sid)) PENDING_APPROVALS.delete(sid);
  for (const sid of [...APPROVAL_CARDS.keys()]) if (mine(sid)) APPROVAL_CARDS.delete(sid);
  for (const id of [...CLOSED_APPROVALS]) if (mine(id)) CLOSED_APPROVALS.delete(id);
  for (const id of [...LIVE_TURNS.keys()]) if (mine(id)) LIVE_TURNS.delete(id);
  for (const id of [...FIRST_TURNS.keys()]) if (mine(id)) FIRST_TURNS.delete(id);
  for (const id of [...PENDING_CHATS.keys()]) if (mine(id)) PENDING_CHATS.delete(id);
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
    CTX055.stamp = k.stamp; Object.assign(PLAN, k.plan); SESSIONS_READ = k.sessionsRead;
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
    const other = await js<View>(`(() => { ${H} askRead(); return view(); })()`);
    check(
      "T64 (B01): a request for another call of the same chat does not close the open one",
      other.pending === ASK_R && show(other.cards) === show([ASK_2, ASK_R])
        && show(other.rows) === show([`${ASK_1}:expired`, ASK_2, ASK_R]),
      show(other),
    );

    // (a3) The older of the two open cards is answered with its own button; the newer one still waits.
    const markOld = agent.approved.length;
    const older = await js<View>(`(async () => { ${H}
      const yes = document.querySelector('#scroller .appr[data-appr-id=' + JSON.stringify(${q(ASK_2)}) + '] [data-appr="y"]');
      if (yes) yes.click();
      await tick(150);
      return view();
    })()`);
    const sentOld = agent.approved.slice(markOld);
    check(
      "T64 (B01): with two calls of a chat waiting, the older card's own Allow once answers it, and the chat still waits on the other",
      show(sentOld) === show([`${ASK_2} allow-once`]) && older.pending === ASK_R && show(older.cards) === show([ASK_R])
        && show(older.waiting) === show([`${A}>${ASK_R}`]) && older.gated,
      `older=${show(older)} sent=${show(sentOld)}`,
    );

    // (b) The turn ends with a card unanswered ("terminated").
    const end = await js<View>(`(() => { ${H}
      onChatEvent({turnId: ${q(TURN)}, kind: 'error', error: 'terminated'});
      return view();
    })()`);
    check(
      "T64 (B01): when the chat's turn ends with a request open, its cards close, nothing waits for an approval and the composer stops saying so",
      end.pending === null && end.cards.length === 0
        && show(end.rows) === show([`${ASK_1}:expired`, `${ASK_2}:approved`, `${ASK_R}:expired`])
        && end.waiting.length === 0 && end.kept.length === 0 && !end.gated && !end.busy,
      show(end),
    );

    // (b2) The agent replays what its gate still holds. The request a newer one replaced and the answered
    // one draw nothing; one it still waits on (another surface's, in the same chat) opens again, and answers.
    const markR = agent.approved.length;
    const replay = await js<{ replay: View; denied: View }>(`(async () => { ${H}
      ask(${q(ASK_1)}); ask(${q(ASK_2)}); askRead();
      await tick(50);
      const replay = view();
      const no = document.querySelector('#scroller .appr[data-appr-id=' + JSON.stringify(${q(ASK_R)}) + '] [data-appr="n"]');
      if (no) no.click();
      await tick(150);
      return {replay, denied: view()};
    })()`);
    const sentR = agent.approved.slice(markR);
    check(
      "T64 (B01): after the turn's end, a replay of a replaced or answered request opens nothing; a request the agent still waits on opens its card again",
      replay.replay.pending === ASK_R && show(replay.replay.cards) === show([ASK_R])
        && show(replay.replay.rows) === show([`${ASK_1}:expired`, `${ASK_2}:approved`, ASK_R])
        && show(replay.replay.waiting) === show([`${A}>${ASK_R}`]) && replay.replay.gated,
      show(replay.replay),
    );
    check(
      "T64 (B01): the card opened again answers its request",
      show(sentR) === show([`${ASK_R} deny`]) && replay.denied.pending === null && replay.denied.waiting.length === 0,
      `denied=${show(replay.denied)} sent=${show(sentR)}`,
    );

    // (c) The next turn of the chat asks. Chords with n and y (bar Ctrl+Y) answer nothing, Esc with a
    // modifier opens nothing over the card, and ⌘N opens a new chat.
    const mark = agent.approved.length;
    const keys = await js<{ asked: View; chords: View; fresh: View }>(`(async () => { ${H}
      RUNNING.set(${q(`${TURN}-2`)}, ${q(A)});
      ask(${q(ASK_3)});
      const asked = view();
      press('n', {altKey: true}); press('y', {altKey: true}); press('y', {metaKey: true});
      press('Escape', {ctrlKey: true}); press('Escape', {altKey: true});
      await tick(50);
      const chords = view();
      press('n', {metaKey: true});
      await tick(150);
      return {asked, chords, fresh: view()};
    })()`);
    const chordAnswers = agent.approved.slice(mark);
    check(
      "T64 (B06): with an approval card up, chords with n and y and Esc with a modifier answer nothing, open nothing, and the card stays open",
      keys.asked.pending === ASK_3 && show(keys.asked.cards) === show([ASK_3])
        && keys.chords.pending === ASK_3 && show(keys.chords.cards) === show([ASK_3]) && !keys.chords.settings
        && chordAnswers.length === 0,
      `asked=${show(keys.asked)} chords=${show(keys.chords)} sent=${show(chordAnswers)}`,
    );
    check(
      "T64 (B06): ⌘N with an approval card up opens a new chat and leaves the request open for its chat",
      keys.fresh.sessionId === "" && keys.fresh.agentSession === null && keys.fresh.pending === null && keys.fresh.cards.length === 0
        && keys.fresh.waiting.includes(`${A}>${ASK_3}`) && chordAnswers.length === 0,
      `fresh=${show(keys.fresh)} sent=${show(chordAnswers)}`,
    );

    // (d) Back in the chat, Ctrl+Y (the TUI's chord) allows its open request; then the bare y allows the next one.
    const mark2 = agent.approved.length;
    const yes = await js<{ ctrl: View; bare: View }>(`(async () => { ${H}
      S.sessionId = ${q(A)}; S.agentSession = ${q(A)};
      const req = APPROVAL_CARDS.get(${q(A)});
      S.log = [{id: nid(), k: 'user', text: 'smoke t64: check free disk space'}, req];
      S.pending = req; S.apprFocused = true;
      press('y', {ctrlKey: true});
      await tick(150);
      const ctrl = view();
      ask(${q(ASK_4)});
      press('y');
      await tick(150);
      return {ctrl, bare: view()};
    })()`);
    const sent = agent.approved.slice(mark2);
    check(
      "T64 (B06): Ctrl+Y and the bare y still allow the chat's open request, once each",
      show(sent) === show([`${ASK_3} allow-once`, `${ASK_4} allow-once`]) && yes.ctrl.pending === null
        && yes.bare.pending === null && !yes.bare.waiting.some((w) => w.startsWith(`${A}>`)),
      `yes=${show(yes)} sent=${show(sent)}`,
    );
    // (e) A page that just loaded, its chat list not read yet, gets the replay of chat B's request (B has a
    // row) and of one with no chat anywhere. Neither is drawn over the empty view; once the list is in, the
    // one with no chat is drawn where the person is, B's stays kept, and opening B shows it with B's transcript.
    const loaded = await js<{ early: View; read: View; opened: View; asked: boolean }>(`(async () => { ${H}
      for (const [t, s] of [...RUNNING]) if (mine(t) || mine(s)) RUNNING.delete(t);
      OPENING = null; S.sessionId = ''; S.agentSession = null; S.pending = null; S.turnId = null; S.streamId = null;
      S.busy = false; S.log = [];
      SESSIONS_READ = false;
      onApprovalEvent({approvalId: ${q(ASK_B)}, tool: 'os.fs.write', category: 'fs_write_workspace', reason: 'smoke t64',
        preview: 'test2.txt', affectedResources: ['/tmp/smoke-t64/test2.txt'], sessionId: ${q(B)}});
      onApprovalEvent({approvalId: ${q(ASK_C)}, tool: 'os.shell.run', category: 'shell', reason: 'smoke t64',
        preview: 'echo smoke t64', sessionId: ${q(C)}});
      const early = view();
      for (let i = SESSIONS.length - 1; i >= 0; i--) if (SESSIONS[i].id === ${q(B)}) SESSIONS.splice(i, 1);
      SESSIONS.unshift({id: ${q(B)}, t: 'smoke t64 chat b', named: true, titled: true, updatedAt: Date.now(), status: 'running', turnCount: 1});
      sessionsRead();
      const read = view();
      const no = document.querySelector('#scroller .appr[data-appr-id=' + JSON.stringify(${q(ASK_C)}) + '] [data-appr="n"]');
      if (no) no.click();
      await tick(150);
      await openSession(${q(B)});
      return {early, read, opened: view(), asked: S.log.some((m) => m.k === 'user' && m.text === ${q(ASKED_B)})};
    })()`);
    check(
      "T64 (B01 QA): an approval replayed before the page has read the chat list is not drawn over the empty view; it is kept for its chat",
      loaded.early.pending === null && loaded.early.cards.length === 0 && loaded.early.rows.length === 0 && !loaded.early.gated
        && loaded.early.waiting.includes(`${B}>${ASK_B}`) && loaded.early.kept.includes(`${B}>${ASK_B}`),
      show(loaded.early),
    );
    check(
      "T64 (B01 QA): once the list is in, a request whose chat has a row stays kept for it; one with no chat anywhere is drawn where the person is",
      loaded.read.sessionId === "" && loaded.read.pending === ASK_C && show(loaded.read.cards) === show([ASK_C])
        && loaded.read.waiting.includes(`${B}>${ASK_B}`) && loaded.read.kept.includes(`${B}>${ASK_B}`),
      show(loaded.read),
    );
    check(
      "T64 (B01 QA): opening that chat shows its transcript and its card, once",
      loaded.opened.sessionId === B && loaded.asked && loaded.opened.pending === ASK_B
        && show(loaded.opened.cards) === show([ASK_B]) && loaded.opened.gated,
      `opened=${show(loaded.opened)} asked=${loaded.asked}`,
    );

    // (f) ATO-198: the page before this one started a new chat's first turn, which waits on an approval.
    // This page takes the turn over, then the request is replayed: kept for that chat, whose row stands in
    // on the list; a frame of the turn is kept; opening the chat shows the message, the card and the frame.
    const taken = await js<{ took: number; early: View; row: boolean; row2: boolean; opened: View; asked: boolean; reply: string; turn: boolean;
      opened2: View; asked2: boolean; other: boolean }>(`(async () => { ${H}
      for (const [t, s] of [...RUNNING]) if (mine(t) || mine(s)) RUNNING.delete(t);
      OPENING = null; S.sessionId = ''; S.agentSession = null; S.pending = null; S.turnId = null; S.streamId = null;
      S.busy = false; S.log = [];
      SESSIONS_READ = true;
      const took = adoptLiveTurns([
        {turnId: ${q(TURN_N)}, sessionId: ${q(N)}, text: ${q(ASKED_N)}, startedAt: Date.now() - 60000, firstTurn: true},
        {turnId: ${q(TURN_N2)}, sessionId: ${q(N2)}, text: ${q(ASKED_N2)}, startedAt: Date.now() - 30000, firstTurn: true}]);
      onApprovalEvent({approvalId: ${q(ASK_N)}, tool: 'os.fs.write', category: 'fs_write_workspace', reason: 'smoke t64',
        preview: 'test5.txt', affectedResources: ['/tmp/smoke-t64/test5.txt'], sessionId: ${q(N)}});
      onApprovalEvent({approvalId: ${q(ASK_N2)}, tool: 'os.fs.write', category: 'fs_write_workspace', reason: 'smoke t64',
        preview: 'test67.txt', affectedResources: ['/tmp/smoke-t64/test67.txt'], sessionId: ${q(N2)}});
      onChatEvent({turnId: ${q(TURN_N)}, kind: 'delta', text: 'smoke t64 reply'});
      const early = view();
      const row = !!chatById(${q(N)});
      const row2 = !!chatById(${q(N2)});
      await openSession(${q(N)});
      const item = S.log.find((m) => m.k === 'assistant' && m.turn === ${q(TURN_N)});
      const opened = view();
      const asked = S.log.some((m) => m.k === 'user' && m.text === ${q(ASKED_N)});
      const reply = item ? String(item.text || '') : '';
      const turn = S.turnId === ${q(TURN_N)};
      await openSession(${q(N2)});
      return {took, early, row, row2, opened, asked, reply, turn, opened2: view(),
        asked2: S.log.some((m) => m.k === 'user' && m.text === ${q(ASKED_N2)}),
        other: S.log.some((m) => m.k === 'user' && m.text === ${q(ASKED_N)})};
    })()`);
    check(
      "T64 (ATO-198/208): a page that loads while two new chats' first turns wait on approvals takes both turns over; each request is kept for its own chat, whose row stands in on the list, and none is drawn over the empty view",
      taken.took === 2 && taken.row && taken.row2 && taken.early.pending === null && taken.early.cards.length === 0
        && taken.early.rows.length === 0 && taken.early.waiting.includes(`${N}>${ASK_N}`)
        && taken.early.waiting.includes(`${N2}>${ASK_N2}`) && !taken.early.gated,
      show(taken),
    );
    check(
      "T64 (ATO-198): opening that chat shows its message, its card once, and what the turn streamed since, and the turn streams on there",
      taken.opened.sessionId === N && taken.asked && taken.opened.pending === ASK_N && show(taken.opened.cards) === show([ASK_N])
        && taken.reply.includes("smoke t64 reply") && taken.turn && taken.opened.gated,
      show(taken),
    );
    check(
      "T64 (ATO-208): the second chat shows only its own message and its own card",
      taken.opened2.sessionId === N2 && taken.asked2 && !taken.other && taken.opened2.pending === ASK_N2
        && show(taken.opened2.cards) === show([ASK_N2]),
      show(taken.opened2),
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
