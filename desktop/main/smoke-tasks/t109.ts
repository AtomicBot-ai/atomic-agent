import { BrowserWindow } from "electron";

/**
 * Release-fix check for ATO-197 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=109`.
 *
 * ATO-197 — a tool row ("Writing test2.txt", "Running cmd /c fsutil …") kept
 * its spinner until the whole turn was over, even when the call had already
 * finished, failed or been denied, and after Stop it spun for good: the
 * stream said a call started and nothing more, and the row learned its
 * outcome from the session store at the turn's end. The agent now says each
 * call's end (`event: tool_result`, matched to its `tool_progress` by
 * `call_id`), and the row settles at once: done, failed (its error line and
 * its time in words), denied, or not run. When a turn ends (Stop, a failure,
 * or a finished turn of an agent that said every outcome) a row nothing
 * answered reads "Not run", no spinner. An agent without the frame keeps the
 * old way, the store deciding after the turn, plus that cleanup.
 *
 * Nothing reaches the agent and the config is not touched. The frames go
 * through the real onChatEvent and Stop through the real abort(); the cancel,
 * the session store and the rest of what a turn's end asks for are answered
 * by stand-ins on the window's own IPC (a webContents handler is asked before
 * ipcMain's; a probe proves it first, as in t64) and recorded, never
 * forwarded. The rows are read through toolCard, drawn into a detached
 * element. What the check staged comes back out and the window is put back as
 * it was.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Handler = (event: unknown, arg: unknown) => unknown;

const PREFIX = "smoke-t109-";
const PROBE = `${PREFIX}probe`;
const A = `${PREFIX}chat-a`;
const QUIET = "smoke t109: not answered while the check runs";
const q = (v: unknown) => JSON.stringify(v);
const show = (x: unknown) => JSON.stringify(x);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A stored transcript row, as GET /api/sessions/{id} has it. */
type Turn = Record<string, unknown>;

/** The agent as this check needs it, on the window's own IPC. */
class StandIn {
  readonly cancelled: string[] = [];
  /** How often the session store was read (reconcileToolCards reads it at a turn's end). */
  sessionReads = 0;
  /** What the store holds for chat A. */
  store: Turn[] = [];
  private readonly quiet: Handler = () => ({ ok: false, error: QUIET });
  private readonly noParked: Handler = () => ({ ok: true, data: { undelivered: [], discarded: 0 } });
  private readonly session: Handler = (_e, id) => {
    const sid = typeof id === "string" ? id : "";
    if (sid === PROBE) return { ok: true, data: { id: sid, turns: [], smokeT109: true } };
    if (sid === A) { this.sessionReads++; return { ok: true, data: { id: sid, turns: this.store } }; }
    return { ok: false, error: QUIET };
  };
  private readonly cancel: Handler = (_e, turnId) => { this.cancelled.push(String(turnId)); return true; };

  private channels(): Array<[string, Handler]> {
    return [
      ["agent:session", this.session], ["agent:cancel", this.cancel], ["agent:approve", this.quiet],
      ["agent:steer", this.quiet], ["agent:chat", this.quiet], ["agent:contextPreview", this.quiet],
      ["agent:undeliveredSteers", this.noParked], ["agent:ackSteers", this.quiet], ["cli:traceTools", this.quiet],
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

/* Shared by the probes below: a turn's frames, and its rows as toolCard draws them. */
const H = String.raw`
  const frame = (turnId, kind, payload) => onChatEvent(Object.assign({turnId, kind}, payload === undefined ? {} : {payload}));
  const started = (turnId, tool, label, callId) => frame(turnId, 'tool_progress',
    Object.assign({object: 'chat.completion.tool_progress', tool, label}, callId ? {call_id: callId} : {}));
  const ended = (turnId, callId, tool, status, ms, summary) => frame(turnId, 'tool_result',
    {object: 'chat.completion.tool_result', call_id: callId, tool, status, duration_ms: ms, summary});
  const rows = (turnId) => S.log.filter((c) => c.k === 'tool' && c.turn === turnId).map((c) => {
    const box = document.createElement('div');
    box.innerHTML = toolCard(c);
    const st = box.querySelector('.tl-st');
    const text = (sel) => { const n = box.querySelector(sel); return n ? n.textContent : null; };
    return {name: c.name, callId: c.callId || null, state: toolState(c), startedAt: c.startedAt || 0,
      glyph: st ? [...st.classList].filter((x) => x !== 'tl-st').join(' ') : null,
      spin: !!box.querySelector('.tk-spin'), du: text('.du') || '', head: text('.nm') || '', sum: text('.cardsum')};
  });
`;
type Row = { name: string; callId: string | null; state: string; startedAt: number; glyph: string | null; spin: boolean; du: string; head: string; sum: string | null };

const KEEP = `(() => {
  window.__t109keep = {log: S.log, sessionId: S.sessionId, agentSession: S.agentSession, busy: S.busy, pending: S.pending,
    room: S.room, streamId: S.streamId, turnId: S.turnId, reasonId: S.reasonId, stick: S.stick,
    queued: S.queued.slice(), ahead: STEER.ahead, opening: OPENING, owed: typeof DRAIN_OWED !== 'undefined' ? DRAIN_OWED : null,
    plan: {on: PLAN.on, itemId: PLAN.itemId, sessionId: PLAN.sessionId, startedMode: PLAN.startedMode}};
  return true;
})()`;

const FORGET = String.raw`
  const mine = (x) => typeof x === 'string' && (x.indexOf('smoke-t109-') === 0 || x.indexOf('turn:smoke-t109-') === 0);
  for (const [turn, sid] of [...RUNNING]) if (mine(turn) || mine(sid)) RUNNING.delete(turn);
  for (const turn of [...TOOL_RESULT_TURNS]) if (mine(turn)) TOOL_RESULT_TURNS.delete(turn);
  for (const sid of [...PENDING_APPROVALS.keys()]) if (mine(sid)) PENDING_APPROVALS.delete(sid);
  for (const sid of [...APPROVAL_CARDS.keys()]) if (mine(sid)) APPROVAL_CARDS.delete(sid);
  for (const id of [...LIVE_TURNS.keys()]) if (mine(id)) LIVE_TURNS.delete(id);
  for (const id of [...FIRST_TURNS.keys()]) if (mine(id)) FIRST_TURNS.delete(id);
  for (const id of [...PENDING_CHATS.keys()]) if (mine(id)) PENDING_CHATS.delete(id);
  for (const id of [...STREAM_ERR.keys()]) if (mine(id)) STREAM_ERR.delete(id);
  for (const sid of [...ATTN]) if (mine(sid)) ATTN.delete(sid);
  if (typeof QUEUES !== 'undefined') for (const key of [...QUEUES.keys()]) if (mine(key)) QUEUES.delete(key);
  const seen = Object.keys(PREFS.seen).filter(mine);
  seen.forEach((sid) => { delete PREFS.seen[sid]; });
  if (seen.length) savePrefs();
`;

const RESTORE = `(() => {
  const k = window.__t109keep; delete window.__t109keep;
  ${FORGET}
  if (k) {
    S.log = k.log; S.sessionId = k.sessionId; S.agentSession = k.agentSession; S.busy = k.busy; S.pending = k.pending;
    S.room = k.room; S.streamId = k.streamId; S.turnId = k.turnId; S.reasonId = k.reasonId; S.stick = k.stick;
    S.queued.length = 0; S.queued.push(...k.queued); STEER.ahead = k.ahead; OPENING = k.opening;
    if (typeof DRAIN_OWED !== 'undefined') DRAIN_OWED = k.owed;
    Object.assign(PLAN, k.plan);
  }
  render();
  return true;
})()`;

/* Chat A on screen, turn \`turn\` running in it (its reply row on screen).
   Nothing the person queued can be sent by anything below: the queue on
   screen is emptied (RESTORE gives it back). */
const stage = (turn: string) => `(() => {
  ${FORGET}
  S.queued.length = 0; STEER.ahead = 0;
  if (typeof DRAIN_OWED !== 'undefined') DRAIN_OWED = false;
  OPENING = null; S.room = 'chat'; S.busy = true; S.pending = null; S.turnId = ${q(turn)}; S.reasonId = null;
  PLAN.on = false; PLAN.startedMode = null;
  S.sessionId = ${q(A)}; S.agentSession = ${q(A)};
  const item = {id: nid(), k: 'assistant', text: '', turn: ${q(turn)}};
  S.log = [{id: nid(), k: 'user', text: 'smoke t109: write test2.txt and check the drives'}, item];
  S.streamId = item.id;
  RUNNING.set(${q(turn)}, ${q(A)});
  render();
  return true;
})()`;

/** Until the session store has been read `n` times and the read has been acted on. */
async function storeRead(agent: StandIn, n: number): Promise<boolean> {
  for (let i = 0; i < 40 && agent.sessionReads < n; i++) await wait(50);
  await wait(250);
  return agent.sessionReads >= n;
}

export async function checks109(js: Js, check: Check): Promise<void> {
  const wins = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed());
  const agent = new StandIn();
  let kept = false;
  try {
    agent.install(wins);
    const probe = await js<{ data?: { smokeT109?: boolean } } | null>(`BR.session(${q(PROBE)})`).catch((e: unknown) => String(e));
    if (typeof probe !== "object" || probe?.data?.smokeT109 !== true) {
      check("T109: a stand-in on the window's IPC answers the session fetch first", false, `${show(probe)}; nothing was staged`);
      return;
    }
    kept = await js<boolean>(KEEP);

    /* (a) An agent with the frame: three calls of one step start; the
       command fails, then the write ends. Each row says so the moment its
       frame comes, and the others still run. */
    const TURN = `${PREFIX}turn-a`;
    await js<boolean>(stage(TURN));
    const live = await js<{ running: Row[]; failed: Row[]; written: Row[] }>(`(() => { ${H}
      started(${q(TURN)}, 'os.fs.write', '{"path":"test2.txt"}', '0:0');
      started(${q(TURN)}, 'os.shell.run', '{"cmd":"cmd /c fsutil fsinfo drives"}', '0:1');
      started(${q(TURN)}, 'os.fs.read', '{"path":"notes.txt"}', '0:2');
      const running = rows(${q(TURN)});
      ended(${q(TURN)}, '0:1', 'os.shell.run', 'error', 1234,
        '$ cmd /c fsutil fsinfo drives\\nThe FSUTIL utility requires administrative privileges.\\nexit: 1');
      const failed = rows(${q(TURN)});
      ended(${q(TURN)}, '0:0', 'os.fs.write', 'ok', 850, 'wrote test2.txt (12 bytes)');
      return {running, failed, written: rows(${q(TURN)})};
    })()`);
    const [w0, s0, r0] = live.written;
    check(
      "T109 (ATO-197): every started call spins until its own result comes",
      live.running.length === 3 && live.running.every((r) => r.state === "run" && r.spin && r.du === "")
        && show(live.running.map((r) => r.callId)) === show(["0:0", "0:1", "0:2"]),
      show(live.running),
    );
    check(
      "T109 (ATO-197): a failed call stops spinning at once: red mark, its error line, its time in words; the calls still running keep spinning",
      live.failed[1]?.state === "err" && live.failed[1]?.glyph === "err" && !live.failed[1]?.spin
        && live.failed[1]?.sum === "The FSUTIL utility requires administrative privileges." && live.failed[1]?.du === "1.2 s"
        && live.failed[0]?.spin === true && live.failed[2]?.spin === true,
      show(live.failed),
    );
    check(
      "T109 (ATO-197): a finished call is done at once, in the past tense, with the agent's time (850 ms)",
      w0?.state === "ok" && w0?.glyph === "ok" && !w0?.spin && (w0?.head ?? "").startsWith("Wrote") && w0?.du === "850 ms"
        && s0?.state === "err" && r0?.state === "run" && r0?.spin === true,
      show(live.written),
    );

    // (b) The person denies the next call: the row says denied, not failed, and charges no time.
    const denied = await js<Row[]>(`(() => { ${H}
      started(${q(TURN)}, 'os.shell.run', '{"cmd":"rm -rf build"}', '1:0');
      ended(${q(TURN)}, '1:0', 'os.shell.run', 'denied', 8000, 'approval denied for os.shell.run');
      return rows(${q(TURN)});
    })()`);
    const d0 = denied[3];
    check(
      "T109 (ATO-197): a denied call reads \"Denied: …\" with its own mark, no spinner, no red error line and no time",
      d0?.state === "deny" && d0?.glyph === "deny" && !d0?.spin && (d0?.head ?? "").startsWith("Denied: ") && d0?.du === "" && d0?.sum === null,
      show(d0),
    );

    /* (c) A fifth call starts, then Stop (the real abort()) and the agent's
       `aborted`. The calls nothing answered are not run, nothing spins, the
       answered ones keep their outcome; the store, which never got the
       stopped step (the newest call it has is older than every row), takes
       nothing from them. */
    const born = await js<number>(`(() => { ${H}
      started(${q(TURN)}, 'os.fs.write', '{"path":"b.txt"}', '2:0');
      return Math.min(...rows(${q(TURN)}).map((r) => r.startedAt));
    })()`);
    agent.store = [
      { kind: "user", text: "smoke t109: an earlier message", at: born - 4000 },
      { kind: "assistant_tool_call", tool: "os.fs.write", args: { path: "old.txt" }, at: born - 3000 },
      { kind: "tool_result", tool: "os.fs.write", status: "ok", summary: "wrote old.txt", at: born - 3000 },
    ];
    const reads = agent.sessionReads;
    const stopped = await js<{ rows: Row[]; told: boolean }>(`(() => { ${H}
      abort();
      frame(${q(TURN)}, 'aborted');
      return {rows: rows(${q(TURN)}), told: TOOL_RESULT_TURNS.has(${q(TURN)})};
    })()`);
    const settled = (await storeRead(agent, reads + 1)) ? await js<Row[]>(`(() => { ${H} return rows(${q(TURN)}); })()`) : null;
    const states = (list: Row[] | null) => (list ?? []).map((r) => r.state);
    check(
      "T109 (ATO-197): Stop: the calls nothing answered read \"Not run: …\" at once, nothing spins, the turn is cancelled once",
      show(agent.cancelled) === show([TURN]) && show(states(stopped.rows)) === show(["ok", "err", "skip", "deny", "skip"])
        && stopped.rows.every((r) => !r.spin) && (stopped.rows[2]?.head ?? "").startsWith("Not run: ")
        && stopped.rows[2]?.glyph === "skip" && stopped.rows[4]?.du === "" && !stopped.told,
      show({ cancelled: agent.cancelled, stopped }),
    );
    check(
      "T109 (ATO-197): after Stop the store, which never got the stopped step, does not overwrite what the stream said",
      settled !== null && show(states(settled)) === show(["ok", "err", "skip", "deny", "skip"]) && settled.every((r) => !r.spin)
        && settled[0]?.du === "850 ms",
      show({ reads: agent.sessionReads, settled }),
    );

    /* (d) An agent without the frame (no call_id, no tool_result), a turn that
       finishes: as before, the row waits for the store, which then says. */
    const OLD = `${PREFIX}turn-old`;
    await js<boolean>(stage(OLD));
    agent.store = [];
    const before = await js<Row[]>(`(() => { ${H}
      started(${q(OLD)}, 'os.fs.write', '{"path":"a.txt"}');
      return rows(${q(OLD)});
    })()`);
    const now = Date.now();
    agent.store = [
      { kind: "user", text: "smoke t109: write a.txt", at: now },
      { kind: "assistant_tool_call", tool: "os.fs.write", args: { path: "a.txt", content: "x" }, at: now },
      { kind: "tool_result", tool: "os.fs.write", status: "ok", summary: "wrote a.txt (1 bytes)", at: now },
    ];
    const readsOld = agent.sessionReads;
    const atDone = await js<Row[]>(`(() => { ${H}
      frame(${q(OLD)}, 'done');
      return rows(${q(OLD)});
    })()`);
    const afterStore = (await storeRead(agent, readsOld + 1)) ? await js<Row[]>(`(() => { ${H} return rows(${q(OLD)}); })()`) : null;
    check(
      "T109 (ATO-197): an agent without the frame: the row has no call_id and keeps running to the turn's end, then takes its outcome from the store",
      before.length === 1 && before[0]?.callId === null && before[0]?.state === "run"
        && atDone[0]?.state === "run" && afterStore?.[0]?.state === "ok" && afterStore?.[0]?.spin === false,
      show({ before, atDone, afterStore }),
    );

    /* (e) The same agent, stopped: the row is "Not run" at once; the store
       has nothing newer than the row, so it stays that. */
    const OLD_STOP = `${PREFIX}turn-old-stop`;
    await js<boolean>(stage(OLD_STOP));
    const bornOld = await js<number>(`(() => { ${H}
      started(${q(OLD_STOP)}, 'os.shell.run', '{"cmd":"sleep 100"}');
      return rows(${q(OLD_STOP)})[0].startedAt;
    })()`);
    agent.store = [
      { kind: "assistant_tool_call", tool: "os.shell.run", args: { cmd: "ls" }, at: bornOld - 3000 },
      { kind: "tool_result", tool: "os.shell.run", status: "ok", summary: "$ ls\nexit: 0", at: bornOld - 3000 },
    ];
    const readsStop = agent.sessionReads;
    const oldStopped = await js<Row[]>(`(() => { ${H}
      frame(${q(OLD_STOP)}, 'aborted');
      return rows(${q(OLD_STOP)});
    })()`);
    const oldSettled = (await storeRead(agent, readsStop + 1)) ? await js<Row[]>(`(() => { ${H} return rows(${q(OLD_STOP)}); })()`) : null;
    check(
      "T109 (ATO-197): an agent without the frame, stopped: the running row reads \"Not run: …\" at once, no spinner, and the older stored call does not take it",
      oldStopped[0]?.state === "skip" && !oldStopped[0]?.spin && (oldStopped[0]?.head ?? "").startsWith("Not run: ")
        && oldSettled?.[0]?.state === "skip",
      show({ oldStopped, oldSettled }),
    );
  } finally {
    /* The stand-ins come off before anything else is awaited (see t25). */
    agent.uninstall(wins);
    if (kept) await js<unknown>(RESTORE).catch(() => undefined);
    await wait(50);
  }
}
