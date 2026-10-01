import { BrowserWindow } from "electron";

/**
 * Release-fix checks for backlog item 28 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=28`.
 *
 * 28 — "A session on local, then a new one on cloud, and both stall; the
 * other way round too." Every switch of the route (Local, Cloud, a
 * provider, a model, Fusion) ends in main restarting `atag serve`
 * (applySwitch), and the restart aborts every turn the window streams, in
 * every chat. A switch to the cloud first stops the local model server too.
 * The renderer refused a switch only while the chat on screen was busy
 * (S.busy). New chat puts S.busy down while the chat just left is still
 * answering, so Cloud or Local picked in the new chat restarted the agent
 * under that reply. It never arrived and nothing said why. A model whose
 * download landed then did the same.
 *
 * No turn reaches the agent and nothing is switched. The turns are
 * startLiveTurn's own sends, answered by a stand-in for `agent:chat` on the
 * window's own IPC. A webContents handler is asked before ipcMain's, which a
 * read-only probe proves before anything relies on it. Their frames go out
 * on the real agent:chat channel. `cli:switchBackend` and
 * `cli:selectLocalModel` are stand-ins too. They count the calls and write
 * nothing, so whether a switch was refused is read off the count, at the
 * IPC the restart would come from. The chats have ids nothing else uses,
 * and the window is put back as it was.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Sent = { sessionId?: unknown };
type Toast = { t: string; s: string };

const PREFIX = "smoke-t28-";
const CHAT_A = `${PREFIX}a`;
const CHAT_B = `${PREFIX}b`;
const TURN_A = `${PREFIX}turn-a`;
const TURN_B = `${PREFIX}turn-b`;
const MODEL = `${PREFIX}model`;
const TITLE_A = "smoke t28: the chat left answering";
const q = (v: unknown) => JSON.stringify(v);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Shared by the probes below. */
const H = String.raw`
  const tick = (ms) => new Promise((res) => setTimeout(res, ms));
  const mine = (x) => typeof x === 'string' && x.indexOf('smoke-t28-') === 0;
  const newChat = () => {
    const b = document.querySelector('#sidebar .sb-new[data-act="session:new"]');
    if (b) b.click();
    return !!b;
  };
  const words = (needle) => S.log.some((m) => String(m.text || '').indexOf(needle) >= 0);
  const working = () => !!document.querySelector('#scroller .tk-working');
  const lastToast = () => { const t = S.toasts[S.toasts.length - 1]; return t ? {t: String(t.t || ''), s: String(t.s || '')} : null; };
`;

/* The window as the check found it; RESTORE puts it back. */
const KEEP = `(() => {
  window.__t28keep = {log: S.log, sessionId: S.sessionId, agentSession: S.agentSession, busy: S.busy, pending: S.pending,
    history: S.history, room: S.room, streamId: S.streamId, turnId: S.turnId, reasonId: S.reasonId, stick: S.stick,
    settings: S.settings, overlay: S.overlay, toasts: S.toasts.slice(), had: 'turnStartedAt' in S, started: S.turnStartedAt,
    queued: S.queued.slice(), steerAhead: STEER.ahead, steerMine: STEER.mine.slice(),
    fz: FZ.live, stamp: CTX055.stamp, unverified: UNVERIFIED,
    plan: {on: PLAN.on, itemId: PLAN.itemId, sessionId: PLAN.sessionId, startedMode: PLAN.startedMode},
    dl: {deferred: DL.deferred, error: DL.error},
    swx: {err: SWX.err, times: Object.assign({}, SWX.times), lastMs: SWX.lastMs},
    sel: {err: SEL.err, busy: SEL.busy, open: SEL.open}, bswLine: BSW.line};
  // A finished turn's 'done' would mark the active provider's key as working; no provider is marked here.
  UNVERIFIED = [];
  return true;
})()`;
const RESTORE = `(async () => { ${H}
  await tick(150);   // whatever the last frames started settles first
  const k = window.__t28keep; delete window.__t28keep;
  if (k) {
    S.log = k.log; S.sessionId = k.sessionId; S.agentSession = k.agentSession; S.busy = k.busy; S.pending = k.pending;
    S.history = k.history; S.room = k.room; S.streamId = k.streamId; S.turnId = k.turnId; S.reasonId = k.reasonId;
    S.stick = k.stick; S.settings = k.settings; S.overlay = k.overlay; S.toasts = k.toasts;
    if (k.had) S.turnStartedAt = k.started; else delete S.turnStartedAt;
    S.queued.length = 0; S.queued.push.apply(S.queued, k.queued);
    STEER.ahead = k.steerAhead; STEER.mine.length = 0; STEER.mine.push.apply(STEER.mine, k.steerMine);
    FZ.live = k.fz; CTX055.stamp = k.stamp; UNVERIFIED = k.unverified; Object.assign(PLAN, k.plan);
    DL.deferred = k.dl.deferred; DL.error = k.dl.error;
    SWX.err = k.swx.err; SWX.times = k.swx.times; SWX.lastMs = k.swx.lastMs;
    SEL.err = k.sel.err; SEL.busy = k.sel.busy; SEL.open = k.sel.open; BSW.line = k.bswLine;
  }
  if (DL.deferTimer) { clearTimeout(DL.deferTimer); DL.deferTimer = 0; }
  for (const [turn, sid] of [...RUNNING]) if (mine(turn) || mine(sid)) RUNNING.delete(turn);
  for (const sid of [...PENDING_APPROVALS.keys()]) if (mine(sid)) PENDING_APPROVALS.delete(sid);
  for (const sid of [...ATTN]) if (mine(sid)) ATTN.delete(sid);
  for (let i = SESSIONS.length - 1; i >= 0; i--) if (mine(SESSIONS[i].id)) SESSIONS.splice(i, 1);
  const seen = Object.keys(PREFS.seen).filter(mine);
  seen.forEach((sid) => { delete PREFS.seen[sid]; });
  if (seen.length) savePrefs();
  renderToasts(); render();
  await refreshSessions();
  refreshContext();
  return true;
})()`;

/** The renderer answers `expr` truthy within `ms`, polled. */
async function until(js: Js, expr: string, ms = 3000): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    if (await js<boolean>(`!!(${expr})`).catch(() => false)) return true;
    if (Date.now() - t0 >= ms) return false;
    await wait(25);
  }
}

export async function checks28(js: Js, check: Check): Promise<void> {
  const wins = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed());
  const w = wins[0] ?? null;
  // The probe: a stand-in on a read-only channel must answer before ipcMain's handler.
  for (const x of wins) x.webContents.ipc.handle("app:hostRam", () => "smoke-t28");
  const probe = await js<unknown>("BR.hostRam()").catch((e: unknown) => String(e)).finally(() => {
    for (const x of wins) if (!x.isDestroyed()) x.webContents.ipc.removeHandler("app:hostRam");
  });
  if (!w || probe !== "smoke-t28") {
    check("T28: a stand-in on the window's IPC answers first", false, `${JSON.stringify(probe)}; nothing was staged`);
    return;
  }

  const turns = [TURN_A, TURN_B];
  const sent: Sent[] = [];
  const switched: unknown[] = [];
  const started: unknown[] = [];
  const frame = (f: Record<string, unknown>) => { if (!w.isDestroyed()) w.webContents.send("agent:chat", f); };
  let kept = false;
  try {
    for (const x of wins) {
      x.webContents.ipc.handle("agent:chat", (_e, payload: unknown) => {
        sent.push((payload ?? {}) as Sent);
        const turnId = turns.shift();
        return turnId ? { ok: true, turnId } : { ok: false, error: "smoke t28: no third turn" };
      });
      // Nothing is written and nothing restarts: a call is the switch going through.
      x.webContents.ipc.handle("cli:switchBackend", (_e, kind: unknown) => {
        switched.push(kind);
        return { ok: true, restart: false };
      });
      // The answer obActivateLocal re-parks on, so the download card and setup are left alone.
      x.webContents.ipc.handle("cli:selectLocalModel", (_e, id: unknown) => {
        started.push(id);
        return { ok: false, error: "a turn is running" };
      });
    }
    kept = await js<boolean>(KEEP);
    await scenario(js, check, frame, sent, switched, started);
  } finally {
    for (const x of wins) {
      if (x.isDestroyed()) continue;
      for (const ch of ["agent:chat", "cli:switchBackend", "cli:selectLocalModel"]) x.webContents.ipc.removeHandler(ch);
    }
    if (kept) await js<unknown>(RESTORE);
  }
}

async function scenario(
  js: Js,
  check: Check,
  frame: (f: Record<string, unknown>) => void,
  sent: Sent[],
  switched: unknown[],
  started: unknown[],
): Promise<void> {
  /* Chat A: a new chat whose turn is running and has said something. */
  const fresh = await js<boolean>(`(() => { ${H} return newChat(); })()`);
  await js<unknown>(`(() => { ${H}
    const text = 'smoke t28: chat A question';
    S.log.push({id: nid(), k: 'user', text});   // as submit() pushes it
    startLiveTurn(text);
    return true;
  })()`);
  const aRuns = await until(js, `RUNNING.has(${q(TURN_A)})`);
  frame({ turnId: TURN_A, kind: "session_id", payload: { session_id: CHAT_A } });
  frame({ turnId: TURN_A, kind: "delta", text: "smoke t28: A words 1" });
  const aShown = await until(js, `S.sessionId === ${q(CHAT_A)} && S.log.some((m) => String(m.text || '').indexOf('smoke t28: A words 1') >= 0)`);
  // Its row, as the sidebar lists it, so a refusal can name it.
  await js<unknown>(`(() => {
    for (let i = SESSIONS.length - 1; i >= 0; i--) if (SESSIONS[i].id === ${q(CHAT_A)}) SESSIONS.splice(i, 1);
    SESSIONS.unshift({id: ${q(CHAT_A)}, t: ${q(TITLE_A)}, named: true, titled: true, updatedAt: Date.now(), status: '', turnCount: 1});
    render();
    return true;
  })()`);

  /* New chat, then Cloud and Local from it, while A is still answering. */
  const left = await js<{ pressed: boolean; busy: boolean; running: boolean; sessionId: string }>(`(() => { ${H}
    const pressed = newChat();
    return {pressed, busy: !!S.busy, running: RUNNING.has(${q(TURN_A)}), sessionId: S.sessionId};
  })()`);
  const refused = await js<{ cloud: unknown; local: unknown; toast: Toast | null; running: boolean; error?: string }>(`(async () => { ${H}
    try {
      const cloud = await selChooseBackend('cloud');
      const toast = lastToast();
      const local = await selChooseBackend('local');
      return {cloud, local, toast, running: RUNNING.has(${q(TURN_A)})};
    } catch (e) { return {cloud: null, local: null, toast: null, running: false, error: String((e && e.stack) || e)}; }
  })()`);
  const named = refused.toast;
  check(
    "T28: from a new chat, Cloud and Local are refused while the chat just left is still answering, and nothing is switched",
    fresh && aRuns && aShown && left.pressed && !left.busy && left.running && left.sessionId === ""
      && !refused.error && switched.length === 0 && refused.running
      && (refused.cloud as { ok?: boolean } | null)?.ok === false && (refused.local as { ok?: boolean } | null)?.ok === false,
    refused.error ?? `fresh=${fresh} aRuns=${aRuns} aShown=${aShown} left=${q(left)} switched=${q(switched)} cloud=${q(refused.cloud)} local=${q(refused.local)}`,
  );
  check(
    "T28: the refusal names the chat that is answering",
    !!named && named.t === "Not while a turn is running"
      && named.s === `\u201c${TITLE_A}\u201d is still answering. Wait for it to finish or stop it, then switch.`,
    q(named),
  );

  /* The funnel itself: any switch that restarts the agent is refused the same
     way; the coding mode restarts nothing and still goes. */
  const funnel = await js<{ provider: number; providerRes: unknown; mode: number; modeRes: unknown; error?: string }>(`(async () => {
    const out = {provider: 0, providerRes: null, mode: 0, modeRes: null};
    try {
      out.providerRes = await swxRun('smoke t28: a provider switch', {providerId: 'smoke-t28-provider'}, () => {
        out.provider++;
        return Promise.resolve({ok: false, error: 'smoke t28: stand-in, nothing was switched'});
      });
      out.modeRes = await swxRun('smoke t28: a coding mode', {mode: currentMode(), route: false}, () => {
        out.mode++;
        return Promise.resolve({ok: true});
      });
    } catch (e) { out.error = String((e && e.stack) || e); }
    return out;
  })()`);
  check(
    "T28: every switch through the funnel that restarts the agent waits for the other chat's turn; the coding mode still goes",
    !funnel.error && funnel.provider === 0 && (funnel.providerRes as { error?: string } | null)?.error === "a turn is running"
      && funnel.mode === 1,
    funnel.error ?? q(funnel),
  );

  /* A model whose download lands now is not started under A's turn. */
  const parked = await js<{ deferred: unknown; error?: string }>(`(async () => {
    try { await obActivateLocal(${q(MODEL)}); return {deferred: DL.deferred}; }
    catch (e) { return {deferred: null, error: String((e && e.stack) || e)}; }
  })()`);
  const parkedOk = !parked.error && parked.deferred === MODEL && started.length === 0;

  /* Chat B: its own turn runs beside A's. Its frames land in it, A's do not. */
  await js<unknown>(`(() => { ${H}
    const text = 'smoke t28: chat B question';
    S.log.push({id: nid(), k: 'user', text});
    startLiveTurn(text);
    return true;
  })()`);
  const bRuns = await until(js, `RUNNING.has(${q(TURN_B)})`);
  const bWorking = await until(js, `!!document.querySelector('#scroller .tk-working')`, 1500);
  frame({ turnId: TURN_B, kind: "session_id", payload: { session_id: CHAT_B } });
  frame({ turnId: TURN_A, kind: "delta", text: "smoke t28: A words 2" });
  frame({ turnId: TURN_B, kind: "delta", text: "smoke t28: B words 1" });
  const bShown = await until(js, `S.log.some((m) => String(m.text || '').indexOf('smoke t28: B words 1') >= 0)`);
  const workingGone = await until(js, `!document.querySelector('#scroller .tk-working')`, 2000);
  const both = await js<{ sessionId: string; agentSession: string | null; busy: boolean; a: boolean; running: number }>(`(() => { ${H}
    return {sessionId: S.sessionId, agentSession: S.agentSession, busy: !!S.busy, a: words('smoke t28: A words'),
      running: [...RUNNING.keys()].filter(mine).length};
  })()`);
  check(
    "T28: the new chat's own turn runs beside the other one: its frames land in it, the other chat's do not, and Working… goes at its first words",
    bRuns && bWorking && bShown && workingGone && both.sessionId === CHAT_B && both.agentSession === CHAT_B
      && both.busy && !both.a && both.running === 2 && sent.length === 2 && !sent[1]!.sessionId,
    `bRuns=${bRuns} working=${bWorking}→gone=${workingGone} shown=${bShown} view=${q(both)} sent=${q(sent.map((p) => p.sessionId ?? null))}`,
  );

  /* B ends first; A is still answering, so nothing may switch or start yet. */
  frame({ turnId: TURN_B, kind: "delta", text: " and B words 2" });
  frame({ turnId: TURN_B, kind: "done" });
  const bDone = await until(js, `!S.busy && !RUNNING.has(${q(TURN_B)})`);
  await wait(300);   // a flush that runs too early does so on the paint after the frame
  const stillParked = await js<{ deferred: unknown }>(`({deferred: DL.deferred})`);
  const again = await js<{ ok?: boolean } | null>(`selChooseBackend('cloud')`).catch(() => null);
  check(
    "T28: a model whose download landed while another chat answered is not started under that turn, nor when this chat's own turn ends",
    parkedOk && bDone && stillParked.deferred === MODEL && started.length === 0 && again?.ok === false && switched.length === 0,
    parked.error ?? `parked=${q(parked)} bDone=${bDone} after B=${q(stillParked)} started=${q(started)} switch=${q(again)} switched=${q(switched)}`,
  );

  /* A ends: the download's model starts, once, and a switch goes through. */
  frame({ turnId: TURN_A, kind: "done" });
  const aDone = await until(js, `!RUNNING.has(${q(TURN_A)})`);
  const startedOnce = aDone && (await (async () => {
    const t0 = Date.now();
    while (started.length < 1 && Date.now() - t0 < 4000) await wait(25);
    await wait(300);
    return started.length === 1 && started[0] === MODEL;
  })());
  const after = await js<{ ok?: boolean } | null>(`selChooseBackend('cloud')`).catch(() => null);
  check(
    "T28: once the other chat's turn ends, the parked model starts once and a switch goes through as before",
    aDone && startedOnce && !!after && after.ok === true && switched.length === 1 && switched[0] === "cloud",
    `aDone=${aDone} started=${q(started)} switch=${q(after)} switched=${q(switched)}`,
  );
}
