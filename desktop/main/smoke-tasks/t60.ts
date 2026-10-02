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
 * screen keeps its own card and its own y/n; one approvalId is one card, also
 * when the request comes twice; and answering answers the card on screen.
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
const TURN_B = `${PREFIX}turn-b`;
const ASK_A = `${PREFIX}approval-a`;
const ASK_B = `${PREFIX}approval-b`;
const QUIET = "smoke t60: not answered while the check runs";
const q = (v: unknown) => JSON.stringify(v);
const show = (x: unknown) => JSON.stringify(x);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The agent as this check needs it, on the window's own IPC. */
class StandIn {
  readonly approved: string[] = [];
  private readonly quiet: Handler = () => ({ ok: false, error: QUIET });
  private readonly noParked: Handler = () => ({ ok: true, data: { undelivered: [], discarded: 0 } });
  private readonly session: Handler = (_e, id) => {
    const sid = typeof id === "string" ? id : "";
    if (sid === PROBE) return { ok: true, data: { id: sid, turns: [], smokeT60: true } };
    if (sid === A || sid === B) {
      return { ok: true, data: { id: sid, turns: [
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

  private channels(): Array<[string, Handler]> {
    return [
      ["agent:session", this.session], ["agent:approve", this.approve], ["agent:contextPreview", this.quiet],
      ["agent:undeliveredSteers", this.noParked], ["cli:traceTools", this.quiet], ["app:statPaths", this.quiet],
      ["cli:chatModelsList", this.quiet],
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
  const mine = (x) => typeof x === 'string' && x.indexOf('smoke-t60-') === 0;
  const ask = (approvalId, sessionId) => onApprovalEvent({approvalId, tool: 'os.fs.write', category: 'fs_write_workspace',
    reason: 'smoke t60', preview: 'test.txt', affectedResources: ['/tmp/smoke-t60/test.txt'], sessionId});
  const view = () => {
    render();
    return {sessionId: S.sessionId, agentSession: S.agentSession,
      pending: S.pending ? String(S.pending.approvalId || '') : null,
      rows: S.log.filter((m) => m.k === 'approval').map((m) => String(m.approvalId || '')),
      cards: [...document.querySelectorAll('#scroller .appr[data-appr-id]')].map((n) => n.getAttribute('data-appr-id') || ''),
      waiting: [...PENDING_APPROVALS].filter(([s]) => mine(s)).map(([s, a]) => s + '>' + a),
      kept: [...APPROVAL_CARDS].filter(([s]) => mine(s)).map(([s, r]) => s + '>' + r.approvalId)};
  };
`;
type View = {
  sessionId: string; agentSession: string | null; pending: string | null;
  rows: string[]; cards: string[]; waiting: string[]; kept: string[];
};

const KEEP = `(() => {
  window.__t60keep = {log: S.log, sessionId: S.sessionId, agentSession: S.agentSession, busy: S.busy, pending: S.pending,
    focused: S.apprFocused, history: S.history, room: S.room, streamId: S.streamId, turnId: S.turnId, stick: S.stick,
    queued: S.queued.slice(), opening: OPENING, owed: typeof DRAIN_OWED !== 'undefined' ? DRAIN_OWED : null,
    stamp: CTX055.stamp, plan: {on: PLAN.on, itemId: PLAN.itemId, sessionId: PLAN.sessionId, startedMode: PLAN.startedMode}};
  return true;
})()`;

const FORGET = String.raw`
  for (const [turn, sid] of [...RUNNING]) if (mine(turn) || mine(sid)) RUNNING.delete(turn);
  for (const sid of [...PENDING_APPROVALS.keys()]) if (mine(sid)) PENDING_APPROVALS.delete(sid);
  for (const sid of [...APPROVAL_CARDS.keys()]) if (mine(sid)) APPROVAL_CARDS.delete(sid);
  if (typeof QUEUES !== 'undefined') for (const key of [...QUEUES.keys()]) if (mine(key)) QUEUES.delete(key);
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
    S.stick = k.stick; S.queued.length = 0; S.queued.push(...k.queued); OPENING = k.opening;
    if (typeof DRAIN_OWED !== 'undefined') DRAIN_OWED = k.owed;
    CTX055.stamp = k.stamp; Object.assign(PLAN, k.plan);
  }
  render();
  return true;
})()`;

/** Chat A on screen, as openSession leaves it, with nothing of this check's yet. */
const STAGE_A = `(() => { ${H}
  ${FORGET}
  OPENING = null; S.room = 'chat'; S.busy = false; S.pending = null; S.turnId = null; S.streamId = null;
  S.sessionId = ${q(A)}; S.agentSession = ${q(A)};
  S.log = [{id: nid(), k: 'user', text: 'Создай файл test.txt с текстом привет'}];
  // Chat B's turn runs (started here, its stream not on screen), as in the report.
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

    // (d) Back in chat A: its own card again, once, and its Allow once answers A's request only.
    const mark = agent.approved.length;
    const backA = await js<View>(`(async () => { ${H} await openSession(${q(A)}); return view(); })()`);
    const answered = await js<View>(`(async () => { ${H}
      const yes = document.querySelector('#scroller .appr[data-appr-id=' + JSON.stringify(${q(ASK_A)}) + '] [data-appr="y"]');
      if (yes) yes.click();
      await new Promise((r) => setTimeout(r, 150));
      return view();
    })()`);
    const sent = agent.approved.slice(mark);
    check(
      "T60: back in the first chat only its own card is there, once, and Allow once answers that request, leaving the other chat's open",
      backA.sessionId === A && backA.pending === ASK_A && show(backA.rows) === show([ASK_A]) && show(backA.cards) === show([ASK_A])
        && show(sent) === show([`${ASK_A} allow-once`]) && answered.pending === null
        && !answered.waiting.some((w) => w.startsWith(`${A}>`)) && answered.waiting.includes(`${B}>${ASK_B}`),
      `back=${show(backA)} sent=${show(sent)} answered=${show(answered)}`,
    );

    // (e) A new, empty chat on screen (no session yet, no turn of its own): B's request is not drawn there either.
    const fresh = await js<View>(`(() => { ${H}
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
