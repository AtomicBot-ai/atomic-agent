import { BrowserWindow } from "electron";

/**
 * Release-fix checks for backlog item 60 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=60`.
 *
 * 60 (QA items 20/21) — an approval belongs to the chat that asked. Two chats,
 * the same prompt in each ("Создай файл test.txt с текстом привет"), Ask first:
 * the request of chat 2 was drawn in chat 1 too, so chat 1 showed "Allow
 * Atomic Agent to write test.txt?" twice, and y/n there answered chat 2's.
 * onApprovalEvent drew every request into the transcript on screen and made it
 * the window's S.pending, whichever chat had raised it.
 *
 * Now a request for a chat that is not on screen is kept for that chat (its
 * sidebar dot says it waits) and drawn when that chat is opened; the chat on
 * screen keeps its own card and its own keys (05.10: ⌘↩ / ⌘.); one approvalId is one card, also
 * when the request comes twice; and answering answers the card on screen.
 *
 * Also covered: a request kept for a chat whose turn this window does not run
 * is forgotten once that chat's turn is over (it has no end frame here); a
 * request with no chat of its own to be found in is still drawn where the
 * person is, and its card's own buttons answer it; ⌘↩ and Abort run on a
 * chat's own card; a request that arrives while its chat is loading, or before a new
 * chat's first turn has said its session, waits and is drawn in that chat.
 *
 * Nothing reaches the agent and the config is not touched. The requests go
 * through the real onApprovalEvent, chats are opened with the real
 * openSession, and every call those make (the session fetch, the verdict, the
 * context preview, the trace, the parked steers) is answered by a stand-in on
 * the window's own IPC (a webContents handler is asked before ipcMain's; a
 * probe proves it first) and recorded, never forwarded. What the check staged
 * comes back out and the window is put back as it was.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Handler = (event: unknown, arg: unknown) => unknown;

const PREFIX = "smoke-t60-";
const PROBE = `${PREFIX}probe`;
const A = `${PREFIX}chat-a`;
const B = `${PREFIX}chat-b`;
const C = `${PREFIX}chat-c`;      // a chat on the list whose turn this window does not run; it has ended
const D = `${PREFIX}chat-d`;      // the same, its status read from the list
const E = `${PREFIX}chat-e`;      // a chat being opened
const N = `${PREFIX}chat-n`;      // a new chat's first turn, not yet named
const X = `${PREFIX}chat-x`;      // a session with no row anywhere (a one-shot task's)
const TURN_A = `${PREFIX}turn-a`;
const TURN_B = `${PREFIX}turn-b`;
const TURN_N = `${PREFIX}turn-n`;
const TURN_N2 = `${PREFIX}turn-n2`;
const ASK_A = `${PREFIX}approval-a`;
const ASK_A2 = `${PREFIX}approval-a2`;
const ASK_B = `${PREFIX}approval-b`;
const ASK_C = `${PREFIX}approval-c`;
const ASK_D = `${PREFIX}approval-d`;
const ASK_E = `${PREFIX}approval-e`;
const ASK_N = `${PREFIX}approval-n`;
const ASK_X = `${PREFIX}approval-x`;
const QUIET = "smoke t60: not answered while the check runs";
const q = (v: unknown) => JSON.stringify(v);
const show = (x: unknown) => JSON.stringify(x);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The agent as this check needs it, on the window's own IPC. */
class StandIn {
  readonly approved: string[] = [];
  readonly cancelled: string[] = [];
  private readonly status: Record<string, string> = { [A]: "running", [B]: "running", [C]: "cancelled" };
  private readonly quiet: Handler = () => ({ ok: false, error: QUIET });
  private readonly noParked: Handler = () => ({ ok: true, data: { undelivered: [], discarded: 0 } });
  private readonly session: Handler = (_e, id) => {
    const sid = typeof id === "string" ? id : "";
    if (sid === PROBE) return { ok: true, data: { id: sid, turns: [], smokeT60: true } };
    if (sid in this.status) {
      return { ok: true, data: { id: sid, status: this.status[sid], turns: [
        { kind: "user", text: "Создай файл test.txt с текстом привет" },
      ] } };
    }
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
  const mine = (x) => typeof x === 'string' && (x.indexOf('smoke-t60-') === 0 || x.indexOf('turn:smoke-t60-') === 0);
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  const ask = (approvalId, sessionId) => onApprovalEvent({approvalId, tool: 'os.fs.write', category: 'fs_write_workspace',
    reason: 'smoke t60', preview: 'test.txt', affectedResources: ['/tmp/smoke-t60/test.txt'], sessionId});
  // A key pressed with focus outside the editor, the transcript at its bottom (as t25's press).
  const press = (key) => {
    const a = document.activeElement;
    if (a && a !== document.body && a.blur) a.blur();
    const sc = document.getElementById('scroller');
    if (sc) sc.scrollTop = sc.scrollHeight;
    document.body.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true}));
  };
  // 05.10: the desktop's Allow once key for the card on screen, ⌘↩ (Ctrl+↩ off macOS).
  const allow = () => {
    const a = document.activeElement;
    if (a && a !== document.body && a.blur) a.blur();
    document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', metaKey: IS_MAC, ctrlKey: !IS_MAC, bubbles: true, cancelable: true}));
  };
  const row = (id) => {
    for (let i = SESSIONS.length - 1; i >= 0; i--) if (SESSIONS[i].id === id) SESSIONS.splice(i, 1);
    SESSIONS.unshift({id, t: 'smoke t60 ' + id, named: true, titled: true, updatedAt: Date.now(), status: 'running', turnCount: 1});
  };
  const view = () => {
    render();
    return {sessionId: S.sessionId, agentSession: S.agentSession,
      pending: S.pending ? String(S.pending.approvalId || '') : null,
      rows: S.log.filter((m) => m.k === 'approval').map((m) => String(m.approvalId || '') + (m.state ? ':' + m.state : '')),
      cards: [...document.querySelectorAll('#scroller .appr[data-appr-id]')].map((n) => n.getAttribute('data-appr-id') || ''),
      waiting: [...PENDING_APPROVALS].filter(([s]) => mine(s)).map(([s, a]) => s + '>' + a),
      kept: [...APPROVAL_CARDS].filter(([s, r]) => mine(s) && !r.state).map(([s, r]) => s + '>' + r.approvalId)};
  };
`;
type View = {
  sessionId: string; agentSession: string | null; pending: string | null;
  rows: string[]; cards: string[]; waiting: string[]; kept: string[];
};

const KEEP = `(() => {
  window.__t60keep = {log: S.log, sessionId: S.sessionId, agentSession: S.agentSession, busy: S.busy, pending: S.pending,
    focused: S.apprFocused, history: S.history, room: S.room, streamId: S.streamId, turnId: S.turnId, stick: S.stick,
    queued: S.queued.slice(), ahead: STEER.ahead, opening: OPENING, owed: typeof DRAIN_OWED !== 'undefined' ? DRAIN_OWED : null,
    stamp: CTX055.stamp, plan: {on: PLAN.on, itemId: PLAN.itemId, sessionId: PLAN.sessionId, startedMode: PLAN.startedMode}};
  return true;
})()`;

const FORGET = String.raw`
  for (const [turn, sid] of [...RUNNING]) if (mine(turn) || mine(sid)) RUNNING.delete(turn);
  for (const sid of [...PENDING_APPROVALS.keys()]) if (mine(sid)) PENDING_APPROVALS.delete(sid);
  for (const sid of [...APPROVAL_CARDS.keys()]) if (mine(sid)) APPROVAL_CARDS.delete(sid);
  if (typeof QUEUES !== 'undefined') for (const key of [...QUEUES.keys()]) if (mine(key)) QUEUES.delete(key);
  for (let i = SESSIONS.length - 1; i >= 0; i--) if (mine(SESSIONS[i].id)) SESSIONS.splice(i, 1);
  const seen = Object.keys(PREFS.seen).filter(mine);
  seen.forEach((sid) => { delete PREFS.seen[sid]; });
  if (seen.length) savePrefs();
`;

const RESTORE = `(() => { ${H}
  const k = window.__t60keep; delete window.__t60keep;
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

/* Chat A on screen, as openSession leaves it, with nothing of this check's yet.
   No queued message of the person's can be sent by anything below: the queue
   on screen is emptied (RESTORE gives it back). */
const STAGE_A = `(() => { ${H}
  ${FORGET}
  S.queued.length = 0; STEER.ahead = 0;
  if (typeof DRAIN_OWED !== 'undefined') DRAIN_OWED = false;
  OPENING = null; S.room = 'chat'; S.busy = false; S.pending = null; S.turnId = null; S.streamId = null;
  S.sessionId = ${q(A)}; S.agentSession = ${q(A)};
  S.log = [{id: nid(), k: 'user', text: 'Создай файл test.txt с текстом привет'}];
  // Both chats' turns run (started here, their streams not on screen), as in the report.
  RUNNING.set(${q(TURN_A)}, ${q(A)});
  RUNNING.set(${q(TURN_B)}, ${q(B)});
  render();
  return true;
})()`;

export async function checks60(js: Js, check: Check): Promise<void> {
  const wins = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed());
  const agent = new StandIn();
  let kept = false;
  try {
    agent.install(wins);
    const probe = await js<{ data?: { smokeT60?: boolean } } | null>(`BR.session(${q(PROBE)})`).catch((e: unknown) => String(e));
    if (typeof probe !== "object" || probe?.data?.smokeT60 !== true) {
      check("T60: a stand-in on the window's IPC answers the session fetch first", false, `${show(probe)}; nothing was staged`);
      return;
    }
    kept = await js<boolean>(KEEP);
    await js<boolean>(STAGE_A);

    // (a) Chat B's request arrives while chat A is on screen.
    const afterB = await js<View>(`(() => { ${H} ask(${q(ASK_B)}, ${q(B)}); return view(); })()`);
    check(
      "T60: another chat's approval is not drawn in the chat on screen and is not its pending request; it is kept for its own chat, whose dot says it waits",
      afterB.sessionId === A && afterB.pending === null && afterB.rows.length === 0 && afterB.cards.length === 0
        && afterB.waiting.includes(`${B}>${ASK_B}`) && afterB.kept.includes(`${B}>${ASK_B}`),
      show(afterB),
    );

    // (b) Chat A's own request, then the same request again (a replayed event).
    const afterA = await js<View>(`(() => { ${H} ask(${q(ASK_A)}, ${q(A)}); ask(${q(ASK_A)}, ${q(A)}); return view(); })()`);
    check(
      "T60: the chat on screen draws its own request once, also when it arrives twice, and only that one",
      afterA.pending === ASK_A && show(afterA.rows) === show([ASK_A]) && show(afterA.cards) === show([ASK_A]),
      show(afterA),
    );

    // (c) Opening chat B shows B's request, once; a copy of it arriving then changes nothing.
    const onB = await js<View>(`(async () => { ${H} await openSession(${q(B)}); ask(${q(ASK_B)}, ${q(B)}); return view(); })()`);
    check(
      "T60: opening the other chat shows its own request once, as its pending one, and not the first chat's",
      onB.sessionId === B && onB.agentSession === B && onB.pending === ASK_B
        && show(onB.rows) === show([ASK_B]) && show(onB.cards) === show([ASK_B]),
      show(onB),
    );

    // (d) Back in chat A: its own card again, once, and ⌘↩ answers A's request only.
    const mark = agent.approved.length;
    const backA = await js<View>(`(async () => { ${H} await openSession(${q(A)}); return view(); })()`);
    const answered = await js<View>(`(async () => { ${H} allow(); await tick(150); return view(); })()`);
    const sent = agent.approved.slice(mark);
    check(
      "T60: back in the first chat only its own card is there, once, and ⌘↩ answers that request, leaving the other chat's open",
      backA.sessionId === A && backA.pending === ASK_A && show(backA.rows) === show([ASK_A]) && show(backA.cards) === show([ASK_A])
        && show(sent) === show([`${ASK_A} allow-once`]) && answered.pending === null
        && !answered.waiting.some((w) => w.startsWith(`${A}>`)) && answered.waiting.includes(`${B}>${ASK_B}`),
      `back=${show(backA)} sent=${show(sent)} answered=${show(answered)}`,
    );

    // (e) A request whose session has no row anywhere is drawn here, as before; the chat's own next one
    // comes after it. The older card's own Allow once answers that card; the chat's own card's Abort run
    // denies its request and stops the turn that asked, A's (05.10: Esc no longer answers a card).
    const mark2 = agent.approved.length;
    const markC = agent.cancelled.length;
    const two = await js<View>(`(() => { ${H} ask(${q(ASK_X)}, ${q(X)}); ask(${q(ASK_A2)}, ${q(A)}); return view(); })()`);
    const clicked = await js<View>(`(async () => { ${H}
      const yes = document.querySelector('#scroller .appr[data-appr-id=' + JSON.stringify(${q(ASK_X)}) + '] [data-appr="y"]');
      if (yes) yes.click();
      await tick(150);
      return view();
    })()`);
    const escaped = await js<View>(`(async () => { ${H}
      const abort = document.querySelector('#scroller .appr[data-appr-id=' + JSON.stringify(${q(ASK_A2)}) + '] [data-appr="esc"]');
      if (abort) abort.click();
      await tick(150);
      return view();
    })()`);
    const sent2 = agent.approved.slice(mark2);
    const stops = agent.cancelled.slice(markC);
    check(
      "T60: a request with no chat to be found in is still drawn in the chat on screen, and its own card's Allow once answers it, not the chat's newer request",
      show(two.cards) === show([ASK_X, ASK_A2]) && two.pending === ASK_A2
        && sent2[0] === `${ASK_X} allow-once` && clicked.pending === ASK_A2 && clicked.waiting.includes(`${A}>${ASK_A2}`),
      `two=${show(two)} clicked=${show(clicked)} sent=${show(sent2)}`,
    );
    check(
      "T60: Abort run on the chat's own card denies that request and stops the turn that asked, the chat's own",
      show(sent2) === show([`${ASK_X} allow-once`, `${ASK_A2} deny`]) && show(stops) === show([TURN_A])
        && escaped.pending === null && !escaped.waiting.some((w) => w.startsWith(`${A}>`)) && escaped.waiting.includes(`${B}>${ASK_B}`),
      `sent=${show(sent2)} stops=${show(stops)} escaped=${show(escaped)}`,
    );

    // (f) A chat on the list whose turn this window does not run asks while A is on screen: kept for it.
    // Its turn has ended by the time it is opened (status "cancelled"): the request is forgotten, no card.
    // Another such chat's request goes when the list says its turn is over, and not on a list read before it came.
    const pruned = await js<{ kept: View; opened: View; early: boolean; late: boolean; running: boolean }>(`(async () => { ${H}
      row(${q(C)}); row(${q(D)});
      ask(${q(ASK_C)}, ${q(C)}); ask(${q(ASK_D)}, ${q(D)});
      const keptView = view();
      await tick(30);
      await openSession(${q(C)});
      const opened = view();
      const before = Date.now() - 1000;
      const early = !approvalOver(${q(D)}, 'ok', before) && PENDING_APPROVALS.get(${q(D)}) === ${q(ASK_D)};
      const running = !approvalOver(${q(D)}, 'running', Date.now() + 1) && PENDING_APPROVALS.get(${q(D)}) === ${q(ASK_D)};
      await tick(30);
      const late = approvalOver(${q(D)}, 'ok', Date.now()) && !PENDING_APPROVALS.has(${q(D)}) && !APPROVAL_CARDS.has(${q(D)});
      return {kept: keptView, opened, early, late, running};
    })()`);
    check(
      "T60: a request of a chat whose turn this window does not run is kept for it, and forgotten, not drawn, once that chat's turn is over",
      pruned.kept.waiting.includes(`${C}>${ASK_C}`) && pruned.kept.cards.length === 0
        && pruned.opened.sessionId === C && pruned.opened.pending === null && pruned.opened.rows.length === 0
        && !pruned.opened.waiting.some((w) => w.startsWith(`${C}>`)) && !pruned.opened.kept.some((w) => w.startsWith(`${C}>`))
        && pruned.early && pruned.running && pruned.late,
      show(pruned),
    );

    // (g) The chat on screen is still loading when its request comes: nothing is drawn under "loading…",
    // and it is kept for that chat.
    const loading = await js<View>(`(() => { ${H}
      S.sessionId = ${q(E)}; S.agentSession = ${q(A)}; S.pending = null; S.turnId = null; S.streamId = null;
      S.log = [{id: nid(), k: 'system', text: 'loading session…'}];
      OPENING = {id: ${q(E)}, failed: false};
      ask(${q(ASK_E)}, ${q(E)});
      const v = view();
      OPENING = null;
      return v;
    })()`);
    check(
      "T60: a request for the chat that is still loading is not drawn under its loading line; it is kept for it",
      loading.pending === null && loading.rows.length === 0 && loading.cards.length === 0 && loading.waiting.includes(`${E}>${ASK_E}`),
      show(loading),
    );

    // (h) A new chat on screen, its first turn not named yet, and another new chat's first turn running
    // too: a request that comes before either is named is drawn in neither, and is drawn in the chat
    // on screen when its turn says the session is its own.
    const named = await js<{ before: View; after: View }>(`(() => { ${H}
      const item = {id: nid(), k: 'assistant', text: '', turn: ${q(TURN_N)}};
      S.sessionId = ''; S.agentSession = null; S.pending = null;
      S.log = [{id: nid(), k: 'user', text: 'smoke t60: a new chat'}, item];
      S.streamId = item.id; S.turnId = ${q(TURN_N)};
      RUNNING.set(${q(TURN_N)}, null); RUNNING.set(${q(TURN_N2)}, null);
      ask(${q(ASK_N)}, ${q(N)});
      const before = view();
      onChatEvent({turnId: ${q(TURN_N)}, kind: 'session_id', payload: {sessionId: ${q(N)}}});
      return {before, after: view()};
    })()`);
    check(
      "T60: with two new chats' first turns unnamed, a request is drawn in neither until its turn names its session, then in that chat, once",
      named.before.pending === null && named.before.rows.length === 0 && named.before.waiting.includes(`${N}>${ASK_N}`)
        && named.after.sessionId === N && named.after.pending === ASK_N && show(named.after.rows) === show([ASK_N])
        && show(named.after.cards) === show([ASK_N]),
      show(named),
    );

    // (i) A new, empty chat on screen (no session yet, no turn of its own): B's request is not drawn there either.
    const fresh = await js<View>(`(() => { ${H}
      RUNNING.delete(${q(TURN_N)}); RUNNING.delete(${q(TURN_N2)});
      S.sessionId = ''; S.agentSession = null; S.pending = null; S.turnId = null; S.streamId = null;
      S.log = [];
      ask(${q(ASK_B)}, ${q(B)});
      return view();
    })()`);
    check(
      "T60: a new chat that has not started yet does not take another chat's request either",
      fresh.pending === null && fresh.rows.length === 0 && fresh.cards.length === 0 && fresh.waiting.includes(`${B}>${ASK_B}`),
      show(fresh),
    );
    // What openSession set off after it landed (the context gauge, the trace) is answered before the stand-ins go.
    await wait(300);
  } finally {
    /* The stand-ins come off before anything else is awaited (see t25). */
    agent.uninstall(wins);
    if (kept) await js<unknown>(RESTORE).catch(() => undefined);
    await wait(50);
  }
}
