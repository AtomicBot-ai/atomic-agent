import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { BrowserWindow } from "electron";

import { certificateCode, modelListFailure, verifyProviderKey } from "../agent-cli.js";
import { ChatTurnTracker, type TurnSummary } from "../analytics/chat-turns.js";

/**
 * Release-fix checks for the 06.10 leftovers (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=108`.
 *
 * ATO-194 — choosing Local models waits on `models start`, and a first load
 * runs past the 45 s watchdog, which let go of the switch: the chips rolled
 * back to the cloud and the composer said "has not finished — the agent may
 * still be restarting" while the model was still loading. Now a local start
 * past 45 s keeps its lock and its paint and says it is loading; it is given
 * up on only at 180 s, with words about the model; landing clears the line.
 * A late answer of a switch given up on does not take the next one's lock.
 *
 * ATO-204 — "The model is answering again … The turn continues." stayed above
 * "turn failed"; it goes when the turn fails. The gate's refusal goes on every
 * config or catalogue read, not only refreshLiveConfig's.
 *
 * ATO-203 — a turn's end closed a card another surface raised in the chat
 * while it ran; it closes only cards of calls the turn made. An answer the
 * agent's gate no longer holds (its 404) closes the card calmly. A card closed
 * with no answer is an analytics event. A redelivered request counts once.
 *
 * ATO-202 — a model list from a server with a self-signed certificate read
 * "Start your local server"; 403 read as a rejected key; 5xx / 429 read as
 * "could not check this key"; our own deadline read as whatever its stderr
 * tail said. Each is said for what it is.
 *
 * Nothing reaches the agent or a provider, and the config is not touched:
 * the window's IPC is answered by stand-ins (a webContents handler is asked
 * before ipcMain's; a probe proves it first), analytics calls are recorded,
 * not sent, and the only network is a loopback server this check runs. What
 * the checks stage is put back.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Handler = (event: unknown, arg: unknown) => unknown;
type Failed = { err?: string; skipped?: boolean };

const PREFIX = "smoke-t108-";
const PROBE = `${PREFIX}probe`;
const show = (s: unknown) => JSON.stringify(s);
const q = (v: unknown) => JSON.stringify(v);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/* A renderer error is a failed check, never a thrown one (see t09). */
async function safe<T>(js: Js, code: string): Promise<T & Failed> {
  try {
    return (await js<T & Failed>(code)) ?? ({ err: "the renderer answered nothing" } as T & Failed);
  } catch (e) {
    return { err: `the renderer threw: ${message(e)}` } as T & Failed;
  }
}

/** The window's IPC as these checks need it. */
class StandIn {
  /** cli:providerModels' answer, by provider id; `other` for any other id. */
  lists: Record<string, unknown> = {};
  readonly calls: string[] = [];
  private readonly quiet: Handler = () => ({ ok: false, error: "smoke t108: not answered while the check runs" });
  private channels(): Array<[string, Handler]> {
    return [
      ["agent:session", (_e, id) => (id === PROBE ? { ok: true, data: { id: PROBE, turns: [], smokeT108: true } } : this.quiet(_e, id))],
      // The read swxWatchdog and the setup make: "could not read", so the staged config stands.
      ["cli:configGet", this.quiet],
      ["cli:providersReady", this.quiet],
      ["cli:chatModelsList", () => ({ ok: true, models: [{ id: `${PREFIX}model`, downloaded: true, active: true }] })],
      // The resolve route's 404, as main hands it over (its body as data).
      ["agent:approve", (_e, p) => {
        const id = String((p as { approvalId?: unknown } | null)?.approvalId ?? "");
        this.calls.push(`approve ${id}`);
        return { ok: true, data: { error: { message: `approvalId not pending: ${id}`, type: "invalid_request_error" } } };
      }],
      ["agent:cancel", () => false],
      ["cli:providerKeyPresent", () => ({ ok: true, present: true })],
      ["cli:upsertProvider", (_e, entry) => { this.calls.push(`upsert ${String((entry as { id?: unknown } | null)?.id)}`); return { ok: true, stdout: "", stderr: "" }; }],
      ["cli:providerModels", (_e, p) => {
        const id = String((p as { id?: unknown } | null)?.id ?? "");
        this.calls.push(`models ${id}`);
        return this.lists[id] ?? this.lists["other"] ?? { ok: true, models: [] };
      }],
      ["cli:removeProvider", (_e, id) => { this.calls.push(`remove ${String(id)}`); return { ok: true, stdout: "", stderr: "" }; }],
      ["cli:verifyProviderKey", () => { this.calls.push("verify"); return { ok: false, checked: false, error: "smoke t108: not checked" }; }],
      ["app:unverifiedSet", () => ({ ok: true })],
      ["cli:selectCloudModel", () => ({ ok: false, error: "smoke t108: nothing is switched" })],
      ["cli:activateProvider", () => ({ ok: false, error: "smoke t108: nothing is switched" })],
    ];
  }
  install(wins: BrowserWindow[]): void {
    for (const x of wins) for (const [ch, fn] of this.channels()) { x.webContents.ipc.removeHandler(ch); x.webContents.ipc.handle(ch, fn); }
  }
  uninstall(wins: BrowserWindow[]): void {
    for (const x of wins) if (!x.isDestroyed()) for (const [ch] of this.channels()) x.webContents.ipc.removeHandler(ch);
  }
}

export async function checks108(js: Js, check: Check): Promise<void> {
  await inMain(check);
  const wins = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed());
  const agent = new StandIn();
  try {
    agent.install(wins);
    const probe = await js<{ data?: { smokeT108?: boolean } } | null>(`BR.session(${q(PROBE)})`).catch((e: unknown) => String(e));
    if (typeof probe !== "object" || probe?.data?.smokeT108 !== true) {
      check("T108: a stand-in on the window's IPC answers first", false, `${show(probe)}; nothing was staged`);
      return;
    }
    await localStart(js, check);
    await recoveredLine(js, check);
    await gateNotices(js, check);
    await approvalCards(js, check, agent);
    await listFailures(js, check, agent);
  } finally {
    /* The stand-ins come off before anything else is awaited (see t25). */
    agent.uninstall(wins);
  }
}

/* ---- main's side: ATO-202 and ATO-203 (d) ---- */
async function inMain(check: Check): Promise<void> {
  const cases: Array<[string, string | undefined, ReturnType<typeof modelListFailure>]> = [
    ['could not list models from "lan": fetch failed', "lan", { unreachable: true }],
    ['could not list models from "lan": request to https://localhost:8443 failed, reason: SELF_SIGNED_CERT_IN_CHAIN', "lan", { certificate: "SELF_SIGNED_CERT_IN_CHAIN" }],
    ['could not list models from "groq": http 403: Access denied in your region', "groq", { status: 403 }],
    ['could not list models from "groq": http 503', "groq", { status: 503 }],
    // Another line of stderr names a 401; the list's own line is what counts.
    ['warn: a background request answered http 401\ncould not list models from "groq": fetch failed', "groq", { unreachable: true }],
    ["the agent did not answer `atag models search` within 90s — it may be busy or starting up. Try again. (http 401)", "groq", { timedOut: true }],
  ];
  const wrong = cases.filter(([text, id, want]) => show(modelListFailure(text, id)) !== show(want));
  check(
    "T108 (ATO-202): a failed model list is read as a certificate problem, the provider's own status, unreachable or our timeout — from its own line",
    wrong.length === 0,
    show(wrong.map(([text, id, want]) => ({ text, want, got: modelListFailure(text, id) }))),
  );
  const codes = [
    certificateCode(Object.assign(new TypeError("fetch failed"), { cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } })),
    certificateCode(Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }) })),
    certificateCode(Object.assign(new TypeError("fetch failed"), { cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } })),
    certificateCode(Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } })),
    certificateCode(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })),
  ];
  check(
    "T108 (ATO-202): undici's cause codes for a certificate not trusted are read; a refused connection is not one",
    show(codes) === show(["SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED", null]),
    show(codes),
  );

  // The key check's own deadline, against a loopback server that never answers.
  const server = createServer(() => { /* never answers */ });
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const res = await verifyProviderKey(
      { id: `${PREFIX}silent`, kind: "openai-compatible", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "smoke-t108-not-a-key" },
      "smoke-t108-model",
      300,
    );
    check(
      "T108 (ATO-202): a key check that runs out of time says it timed out — not \"could not reach\", not a verdict on the key",
      res.ok === false && res.checked === false && res.timedOut === true && /did not answer within/.test(res.error ?? ""),
      show(res),
    );
  } catch (e) {
    check("T108 (ATO-202): the key check's deadline", false, message(e));
  } finally {
    server.closeAllConnections?.();
    server.close();
  }

  const out: TurnSummary[] = [];
  const t = new ChatTurnTracker((s) => out.push(s));
  t.begin(`${PREFIX}turn`);
  t.observe({ turnId: `${PREFIX}turn`, kind: "session_id", payload: { session_id: `${PREFIX}chat` } });
  t.approval({ sessionId: `${PREFIX}chat`, approvalId: "a1" });
  t.approval({ sessionId: `${PREFIX}chat`, approvalId: "a1" });   // the events stream reconnected and replayed it
  t.approval({ sessionId: `${PREFIX}chat`, approvalId: "a2" });
  t.observe({ turnId: `${PREFIX}turn`, kind: "done" });
  check(
    "T108 (ATO-203): chat_turn_ui counts a redelivered approval request once",
    out.length === 1 && out[0]!.approvals_asked === 2,
    show(out),
  );
}

/* ---- ATO-194: a local model start past 45 s ---- */
async function localStart(js: Js, check: Check): Promise<void> {
  type R = {
    started: { pending: number; tick: boolean; shown: boolean };
    slow: { pending: number; slow: boolean; err: string | null; backend: string; timer: boolean; held: boolean; line: string; strip: string | null; composer: boolean };
    gaveUp: { pending: number; err: string | null; wantKept: boolean; tick: boolean };
    afterRead: { want: unknown };
    landed: { err: string | null; pending: number; want: unknown };
    mid: { pending: number; timer: boolean; want: string | null; err: string | null };
    end: { pending: number; timer: boolean; err: string | null };
  };
  const r = await safe<R>(js, `(async () => {
    if (S.busy || S.pending || RUNNING.size > 0 || SWX.pending || OPENING) return {skipped: true};
    const tick = (ms) => new Promise((res) => setTimeout(res, ms));
    // ATO-134: a switch asks the agent whether anything is running before its \`run\`; this waits for the run to have begun.
    const begun = async (get) => { for (let i = 0; i < 300 && !get(); i++) await tick(10); return get(); };
    const keep = {err: SWX.err, times: Object.assign({}, SWX.times), lastMs: SWX.lastMs, cfg: LIVE_CONFIG, owed: DRAIN_OWED};
    DRAIN_OWED = false;
    try {
      const label = 'starting ${PREFIX}model…';
      let land = null;
      const p = swxRun(label, {backend: 'local', model: '${PREFIX}model'}, () => new Promise((res) => { land = res; }));
      await tick(30);
      const seq = SWX.seq;
      const started = {pending: SWX.pending, tick: !!SWX.tick, shown: swxStartingShown()};
      SWX.since = Date.now() - 50000;   // as if 50 s had run
      clearTimeout(SWX.timer); swxWatchdog(label, seq);   // what the 45 s timer calls
      render();
      const strip = document.querySelector('.statusstrip.swxstart');
      const slow = {pending: SWX.pending, slow: SWX.slow, err: SWX.err, backend: selBackend(), timer: !!SWX.timer,
        held: swxHoldsComposer(), line: swxStartLine(), strip: strip ? strip.textContent : null, composer: !!document.getElementById('composer')};
      clearTimeout(SWX.timer); swxWatchdog(label, seq);   // what the 180 s timer calls
      const gaveUp = {pending: SWX.pending, err: SWX.err, wantKept: !!SWX.want, tick: !!SWX.tick};
      await tick(150);   // the config read (a stand-in: could not read) lets go of the paint
      const afterRead = {want: SWX.want};
      (await begun(() => land))({ok: true});
      await p;
      const landed = {err: SWX.err, pending: SWX.pending, want: SWX.want};

      // A switch given up on, then another: the first one's late answer leaves the second's lock alone.
      let landA = null, landB = null;
      const pA = swxRun('smoke t108 A…', {providerId: '${PREFIX}a'}, () => new Promise((res) => { landA = res; }));
      await tick(20);
      clearTimeout(SWX.timer); swxWatchdog('smoke t108 A…', SWX.seq);
      const pB = swxRun('smoke t108 B…', {providerId: '${PREFIX}b'}, () => new Promise((res) => { landB = res; }));
      await tick(20);
      (await begun(() => landA))({ok: false, error: 'smoke t108: A failed late'});
      await pA;
      const mid = {pending: SWX.pending, timer: !!SWX.timer, want: SWX.want ? SWX.want.providerId || null : null, err: SWX.err};
      (await begun(() => landB))({ok: true});
      await pB;
      const end = {pending: SWX.pending, timer: !!SWX.timer, err: SWX.err};
      return {started, slow, gaveUp, afterRead, landed, mid, end};
    } finally {
      SWX.err = keep.err; SWX.times = keep.times; SWX.lastMs = keep.lastMs; LIVE_CONFIG = keep.cfg; DRAIN_OWED = keep.owed;
      render();
    }
  })()`);
  if (r.skipped || r.err) { check("T108 (ATO-194): the switch probe ran (the window was idle)", false, show(r)); return; }
  check(
    "T108 (ATO-194): a local model start shows no line in its first seconds, and counts them while it runs",
    r.started.pending === 1 && r.started.tick && !r.started.shown,
    show(r.started),
  );
  check(
    "T108 (ATO-194): past 45 s a local start keeps its lock and the Local route on the chips, with no \"has not finished\" — the composer says the model is still loading",
    r.slow.pending === 1 && r.slow.slow && r.slow.err === null && r.slow.backend === "local" && r.slow.timer && r.slow.held
      && r.slow.line === `Starting ${PREFIX}model — still loading it into memory; a first start can take a few minutes`
      && (!r.slow.composer || (r.slow.strip ?? "").includes("still loading it into memory")),
    show(r.slow),
  );
  check(
    "T108 (ATO-194): given up on at 180 s, the line names the model loading, not an agent restart; the paint waits for the config read",
    r.gaveUp.pending === 0 && r.gaveUp.wantKept && !r.gaveUp.tick
      && r.gaveUp.err === `starting ${PREFIX}model… has not finished — the model may still be loading; Settings › Models says when it is ready`
      && !/restarting/.test(r.gaveUp.err ?? "") && r.afterRead.want === null,
    show({ gaveUp: r.gaveUp, afterRead: r.afterRead }),
  );
  check(
    "T108 (ATO-194): when the start lands, the line goes",
    r.landed.err === null && r.landed.pending === 0 && r.landed.want === null,
    show(r.landed),
  );
  check(
    "T108 (ATO-194): a late answer of a switch given up on leaves the next switch's lock, timer, paint and line alone",
    r.mid.pending === 1 && r.mid.timer && r.mid.want === `${PREFIX}b` && r.mid.err === null
      && r.end.pending === 0 && !r.end.timer && r.end.err === null,
    show({ mid: r.mid, end: r.end }),
  );
}

/* ---- ATO-204 (b): "the turn continues" under a turn that then failed ---- */
async function recoveredLine(js: Js, check: Check): Promise<void> {
  const r = await safe<{ recovered: string[]; failed: string[]; failure: boolean; kept: string[] }>(js, `(() => {
    if (S.turnId || S.streamId || S.busy || RUNNING.size > 0 || WAIT || S.queued.length) return {skipped: true};
    const keep = {room: S.room, log: S.log, text: APPSTATUS.text, tone: APPSTATUS.tone, logs: LOGS.length, toasts: S.toasts.slice(),
      unverified: UNVERIFIED, history: S.history.length, planMode: PLAN.startedMode, reasonId: S.reasonId};
    const turnId = '${PREFIX}turn-recovered';
    const stream = {id: '${PREFIX}stream', k: 'assistant', text: ''};
    const asked = {id: nid(), k: 'user', text: 'smoke t108: a turn that comes back, then fails'};
    const ours = () => S.log.filter((m) => m.k === 'system' && m.waitFor === stream.id).map((m) => String(m.text || ''));
    try {
      S.log = keep.log.concat([asked, stream]);
      S.turnId = turnId; S.streamId = stream.id; S.room = 'chat';
      UNVERIFIED = []; PLAN.startedMode = null;
      onChatEvent({turnId, kind: 'provider_recovered', payload: {object: 'atomic.provider_recovered', waited_ms: 23000}});
      const recovered = ours();
      onChatEvent({turnId, kind: 'error', error: 'smoke t108: a late failure', payload: {}});
      const failed = ours();
      const failure = S.log.some((m) => m.k === 'system' && m.sev === 'err');
      // The rows kept for a chat lose it too (liveTurnEnded hands them to tpDropRecoveredNote).
      const rows = [{id: nid(), k: 'system', note: true, recovered: true, waitFor: 'x', text: 'answering again'},
        {id: nid(), k: 'system', sev: 'pause', note: true, waitFor: 'x', text: 'a wait line'}];
      tpDropRecoveredNote('x', rows);
      return {recovered, failed, failure, kept: rows.map((m) => m.text)};
    } finally {
      WAIT = null;
      if (WAIT_TICK) { clearInterval(WAIT_TICK); WAIT_TICK = 0; }
      S.turnId = null; S.streamId = null; S.busy = false; S.reasonId = keep.reasonId;
      S.log = keep.log; S.room = keep.room; S.history.length = keep.history;
      UNVERIFIED = keep.unverified; PLAN.startedMode = keep.planMode;
      APPSTATUS.text = keep.text; APPSTATUS.tone = keep.tone; LOGS.length = keep.logs;
      S.toasts = keep.toasts; renderToasts();
      render();
    }
  })()`);
  if (r.skipped || r.err) { check("T108 (ATO-204): the recovered-line probe ran (the window was idle)", false, show(r)); return; }
  check(
    "T108 (ATO-204): \"The model is answering again … The turn continues.\" goes when the turn then fails; the failure line is drawn",
    r.recovered.length === 1 && /answering again/.test(r.recovered[0] ?? "") && r.failed.length === 0 && r.failure,
    show(r),
  );
  check(
    "T108 (ATO-204): in a turn's kept rows only the recovered line goes; a wait line stays",
    show(r.kept) === show(["a wait line"]),
    show(r.kept),
  );
}

/* ---- ATO-204 (c): every config or catalogue read retires the gate's refusal ---- */
async function gateNotices(js: Js, check: Check): Promise<void> {
  const r = await safe<{ before: string; after: number; reads: Record<string, boolean> }>(js, `(async () => {
    if (S.turnId || S.streamId || S.busy || RUNNING.size > 0 || BSW.gating) return {skipped: true};
    const keep = {cfg: LIVE_CONFIG, log: S.log, local: SEL.local, loaded: BSW.localLoaded};
    try {
      const local = {id: 'local-llama', kind: 'llama-server'};
      LIVE_CONFIG = {llm: {activeTextProvider: 'local-llama', providers: [local], fallback: {appendLocal: true}},
        localModels: {mode: 'managed', managed: {modelId: '${PREFIX}model'}}};
      SEL.local = [{id: '${PREFIX}model', downloaded: false}]; BSW.localLoaded = true;
      S.log = [{id: nid(), k: 'user', text: 'an earlier question'},
        {id: nid(), k: 'system', gateNotice: true, text: 'local model ${PREFIX}model is not downloaded (message returned to the editor)'}];
      const before = localTurnGate().kind;
      await bswSnapshot();   // the catalogue read: the model is on disk now (a stand-in)
      const after = S.log.filter((m) => m.gateNotice).length;
      const reads = {};
      for (const [name, fn] of [['loadResources', loadResources], ['mcpRefreshRun', mcpRefreshRun], ['llmRefreshRun', llmRefreshRun],
        ['tgRefreshOnce', tgRefreshOnce], ['bswSnapshot', bswSnapshot], ['refreshLiveConfig', refreshLiveConfig]]) {
        reads[name] = /dropGateNoticesIfCleared\\(\\)/.test(String(fn));
      }
      return {before, after, reads};
    } finally {
      LIVE_CONFIG = keep.cfg; S.log = keep.log; SEL.local = keep.local; BSW.localLoaded = keep.loaded;
      render();
    }
  })()`);
  if (r.skipped || r.err) { check("T108 (ATO-204): the gate probe ran (the window was idle)", false, show(r)); return; }
  check(
    "T108 (ATO-204): the catalogue read that finds the model on disk takes the gate's refusal away",
    r.before === "block" && r.after === 0,
    show(r),
  );
  check(
    "T108 (ATO-204): every config read — the start's, Settings › LLM, MCP and Telegram, the catalogue snapshot — asks whether the refusal still holds",
    Object.values(r.reads).length === 6 && Object.values(r.reads).every(Boolean),
    show(r.reads),
  );
}

/* ---- ATO-203: approval cards ---- */
async function approvalCards(js: Js, check: Check, agent: StandIn): Promise<void> {
  type R = {
    ended: string[]; pending: string | null; waiting: string | null; noRecord: string[]; replaced: string[];
    handed: { cards: string[]; pending: string | null; waiting: string | null; kept: string | null };
    late: { state: string | null; closedForGood: boolean; note: boolean; pending: string | null; again: number };
    seen: string[]; answered: number;
  };
  const sid = `${PREFIX}chat`;
  const r = await safe<R>(js, `(async () => {
    if (S.turnId || S.streamId || S.busy || S.pending || RUNNING.size > 0 || OPENING) return {skipped: true};
    const tick = (ms) => new Promise((res) => setTimeout(res, ms));
    const sid = ${q(sid)};
    const keep = {log: S.log, sessionId: S.sessionId, agentSession: S.agentSession, room: S.room, focused: S.apprFocused,
      closed: ANX.apprClosed, answered: ANX.apprAnswered, logs: LOGS.length, busy: S.busy};
    const seen = [];
    let answered = 0;
    ANX.apprClosed = (req, how) => { seen.push(req.approvalId + ':' + how); };
    ANX.apprAnswered = () => { answered += 1; };
    const ask = (approvalId, tool, category, preview) => onApprovalEvent({approvalId, tool, category, reason: 'smoke t108', preview, sessionId: sid});
    const cards = () => S.log.filter((m) => m.k === 'approval').map((m) => m.approvalId.replace('${PREFIX}', '') + ':' + (m.state || 'open'));
    try {
      S.sessionId = sid; S.agentSession = sid; S.room = 'chat';
      const tool = {id: nid(), k: 'tool', name: 'os.shell.run', ok: null, args: 'df -h'};
      const item = {id: nid(), k: 'assistant', text: ''};
      S.log = [{id: nid(), k: 'user', text: 'smoke t108: check free disk space'}, tool, item];
      const rec = {text: 'smoke t108: check free disk space', asked: S.log[0], item, log: S.log, startedAt: Date.now() - 1000};
      // Our turn's call, and a call Telegram's turn in the same chat asks for while ours runs.
      ask('${PREFIX}ours', 'os.shell.run', 'shell', 'df -h /');
      ask('${PREFIX}tg', 'os.fs.write', 'fs_write_workspace', 'notes.txt');
      closeChatApprovals(sid, 'stopped', rec.startedAt, turnToolNames(rec));
      const ended = cards();
      const pending = S.pending ? S.pending.approvalId.replace('${PREFIX}', '') : null;
      const waiting = PENDING_APPROVALS.has(sid) ? String(PENDING_APPROVALS.get(sid)).replace('${PREFIX}', '') : null;
      // With no record of the turn's rows, every card in its window closes, as before.
      closeChatApprovals(sid, 'expired', rec.startedAt, null);
      const noRecord = cards();
      // Telegram's request came first and ours after it: ours closes, and the chat waits on Telegram's again.
      S.log = [{id: nid(), k: 'user', text: 'smoke t108'}, tool, item];
      ask('${PREFIX}tg2', 'os.fs.write', 'fs_write_workspace', 'todo.txt');
      ask('${PREFIX}ours2', 'os.shell.run', 'shell', 'du -sh .');
      closeChatApprovals(sid, 'stopped', rec.startedAt, turnToolNames(rec));
      const strip = (x) => (x ? String(x).replace('${PREFIX}', '') : null);
      const handed = {cards: cards(), pending: strip(S.pending && S.pending.approvalId), waiting: strip(PENDING_APPROVALS.get(sid)),
        kept: strip(APPROVAL_CARDS.get(sid) && APPROVAL_CARDS.get(sid).approvalId)};
      closeChatApprovals(sid, 'expired', rec.startedAt, null);
      // A newer request for the same call replaces the older one.
      S.log = [{id: nid(), k: 'user', text: 'smoke t108'}, item];
      ask('${PREFIX}r1', 'os.shell.run', 'shell', 'ls');
      ask('${PREFIX}r2', 'os.shell.run', 'shell', 'ls');
      const replaced = cards();
      // A request whose turn had already stopped is answered: the gate's 404.
      S.log = [{id: nid(), k: 'user', text: 'smoke t108'}, item];
      ask('${PREFIX}late', 'os.shell.run', 'shell', 'rm -rf build');
      const req = S.pending;
      answerLive(req, 'n');
      await tick(200);
      const note = S.log.some((m) => m.k === 'system' && m.apprNote && /no longer waiting/.test(String(m.text || '')));
      ask('${PREFIX}late', 'os.shell.run', 'shell', 'rm -rf build');   // the stream replays it: nothing opens
      const late = {state: req ? req.state || null : null, closedForGood: CLOSED_APPROVALS.has('${PREFIX}late'), note,
        pending: S.pending ? S.pending.approvalId : null, again: S.log.filter((m) => m.k === 'approval' && !m.state).length};
      // Stop marks a card stopped (abort → stoppedCard): that is an unanswered card too.
      stoppedCard({k: 'approval', approvalId: '${PREFIX}stop', drawn: true});
      return {ended, pending, waiting, noRecord, handed, replaced, late, seen, answered};
    } finally {
      ANX.apprClosed = keep.closed; ANX.apprAnswered = keep.answered;
      PENDING_APPROVALS.delete(sid); APPROVAL_CARDS.delete(sid); ATTN.delete(sid);
      for (const id of [...CLOSED_APPROVALS]) if (String(id).indexOf('${PREFIX}') === 0) CLOSED_APPROVALS.delete(id);
      S.log = keep.log; S.sessionId = keep.sessionId; S.agentSession = keep.agentSession; S.room = keep.room;
      S.apprFocused = keep.focused; S.pending = null; S.busy = keep.busy; LOGS.length = keep.logs;
      render();
    }
  })()`);
  if (r.skipped || r.err) { check("T108 (ATO-203): the approval probe ran (the window was idle)", false, show(r)); return; }
  check(
    "T108 (ATO-203): our turn's end closes the card of a call it made and leaves the one Telegram's turn raised meanwhile open and waiting",
    show(r.ended) === show(["ours:stopped", "tg:open"]) && r.pending === "tg" && r.waiting === "tg",
    show({ ended: r.ended, pending: r.pending, waiting: r.waiting }),
  );
  check(
    "T108 (ATO-203): with no record of the turn's rows, its end closes every card in its window, as before",
    show(r.noRecord) === show(["ours:stopped", "tg:expired"]),
    show(r.noRecord),
  );
  check(
    "T108 (ATO-203): when Telegram's request came first, our turn's end closes ours and hands the chat's waiting (dot, kept card, composer) back to Telegram's",
    show(r.handed.cards) === show(["tg2:open", "ours2:stopped"]) && r.handed.pending === "tg2" && r.handed.waiting === "tg2" && r.handed.kept === "tg2",
    show(r.handed),
  );
  check(
    "T108 (ATO-203): an answer the agent no longer waits for (its 404) closes the card calmly, for good, and says nothing was decided",
    agent.calls.includes(`approve ${PREFIX}late`) && r.late.state === "expired" && r.late.closedForGood && r.late.note
      && r.late.pending === null && r.late.again === 0,
    show(r.late),
  );
  check(
    "T108 (ATO-203): each card closed with no answer is one analytics event — stopped (the turn's end, and Stop), expired, replaced, not_waiting",
    show(r.seen) === show([`${PREFIX}ours:stopped`, `${PREFIX}tg:expired`, `${PREFIX}ours2:stopped`, `${PREFIX}tg2:expired`,
      `${PREFIX}r1:replaced`, `${PREFIX}late:not_waiting`, `${PREFIX}stop:stopped`])
      && show(r.replaced) === show(["r1:expired", "r2:open"]) && r.answered === 1,
    show({ seen: r.seen, replaced: r.replaced, answered: r.answered }),
  );
}

/* ---- ATO-202: what the setup and the model lists say ---- */
async function listFailures(js: Js, check: Check, agent: StandIn): Promise<void> {
  const lines = await safe<Record<string, string>>(js, `(() => ({
    cert: modelListFailLine({ok: false, certificate: 'SELF_SIGNED_CERT_IN_CHAIN'}, 'LAN box'),
    timedOut: modelListFailLine({ok: false, timedOut: true, error: 'the agent did not answer … (http 401)'}, 'Groq'),
    refused: modelListFailLine({ok: false, status: 403}, 'Groq'),
    busy: modelListFailLine({ok: false, status: 429}, 'Groq'),
    down: modelListFailLine({ok: false, status: 502}, 'Groq'),
    key: modelListFailLine({ok: false, status: 401}, 'Groq'),
  }))()`);
  check(
    "T108 (ATO-202): Settings' and the selector's model lists say certificate, timeout, refused access, rate limit and server trouble in words",
    /certificate this app does not trust \(SELF_SIGNED_CERT_IN_CHAIN\)/.test(lines["cert"] ?? "")
      && /did not come back within 90 s/.test(lines["timedOut"] ?? "") && !/key/.test(lines["timedOut"] ?? "")
      && /refused access \(403\)/.test(lines["refused"] ?? "") && /\(429\)/.test(lines["busy"] ?? "")
      && /problem answering \(HTTP 502\)/.test(lines["down"] ?? "") && /did not accept the saved key \(401\)/.test(lines["key"] ?? ""),
    show(lines),
  );

  const staged = await safe<{ ok: boolean }>(js, `(() => {
    window.__t108Keep = {wiz: Object.assign({}, WIZ), open: SEL.open, err: SEL.err, kind: SEL.kind, addOpen: SEL.addOpen,
      cfg: LIVE_CONFIG, ids: BSW.readyIds, loaded: BSW.readyLoaded, want: SWX.want, failed: ANX.providerFailed};
    window.__t108Failed = [];
    ANX.providerFailed = (reason) => { window.__t108Failed.push(reason); };
    window.__t108Settle = async () => { for (let i = 0; i < 100 && (WIZ.stepping || WIZ.phase === 'verifying'); i++) await new Promise((r) => setTimeout(r, 50)); };
    window.__t108Try = async (rowId, apiKey, baseUrl) => {
      WIZ.phase = null; WIZ.unfinishedId = null;
      const cfg = JSON.parse(JSON.stringify(window.__t108Keep.cfg || {}));
      cfg.llm = cfg.llm || {}; cfg.llm.providers = [];
      LIVE_CONFIG = cfg; SWX.want = null; BSW.readyIds = []; BSW.readyLoaded = true;
      SEL.open = true; SEL.err = null; SEL.kind = 'provider';
      const row = rowId === 'custom' ? KIND_ROWS.find((k) => k.custom) : KIND_ROWS.find((k) => k.id === rowId);
      Object.assign(WIZ, {row, phase: 'configure', apiKey, baseUrl, error: null, softError: null, errorDetail: null, errorKind: null,
        uncheckedFor: null, acceptUnchecked: false, modelChosen: false, forId: null, unfinishedId: null});
      render();
      act('wiz:next'); await window.__t108Settle();
      const pop = document.querySelector('#overlays .selpop');
      return {phase: WIZ.phase, error: WIZ.error, keyUnlit: wizErrUnreachable(),
        redField: !!(pop && pop.querySelector('.tk-inpwrap.is-error, .tk-inpwrap.is-warn')), failed: window.__t108Failed.slice(-1)[0] || null};
    };
    return {ok: true};
  })()`);
  if (!staged.ok) { check("T108 (ATO-202): the setup was staged", false, show(staged)); return; }
  type Seen = { phase: string | null; error: string | null; keyUnlit: boolean; redField: boolean; failed: string | null };
  const run = async (rowId: string, apiKey: string, baseUrl: string, list: unknown): Promise<Seen & Failed> => {
    agent.lists = { groq: list, other: list };
    return safe<Seen>(js, `window.__t108Try(${q(rowId)}, ${q(apiKey)}, ${q(baseUrl)})`);
  };
  try {
    const cert = await run("custom", "", "https://localhost:8443/v1",
      { ok: false, error: 'could not list models from "custom": fetch failed', certificate: "SELF_SIGNED_CERT_IN_CHAIN" });
    check(
      "T108 (ATO-202): a local https server with a self-signed certificate reads as a certificate problem, not \"Start your local server\"; key field unlit; analytics `certificate`",
      cert.phase === "configure"
        && cert.error === "Your local server at https://localhost:8443/v1 answered with a certificate this app does not trust (SELF_SIGNED_CERT_IN_CHAIN). Give the server a trusted certificate, or use http:// for a server on this machine, then try again."
        && cert.keyUnlit && !cert.redField && cert.failed === "certificate",
      show(cert),
    );
    const refused = await run("groq", "smoke-t108-some-key-0123", "",
      { ok: false, error: 'could not list models from "groq": http 403: Access denied in your region', status: 403 });
    check(
      "T108 (ATO-202): 403 on the model list says the provider refused access — region, organisation, credit — not that it didn't accept the key",
      refused.error === "Groq refused access (403). The key may be fine: check the account’s region, organisation and credit, then try again."
        && refused.keyUnlit && !refused.redField,
      show(refused),
    );
    const down = await run("groq", "smoke-t108-some-key-0123", "", { ok: false, error: 'could not list models from "groq": http 503', status: 503 });
    const busy = await run("groq", "smoke-t108-some-key-0123", "", { ok: false, error: 'could not list models from "groq": http 429', status: 429 });
    check(
      "T108 (ATO-202): 5xx and 429 say the server had a problem / is rate limiting, try again — not \"Could not check this key\"",
      down.error === "Groq had a problem answering (HTTP 503). Try again in a moment."
        && busy.error === "Groq is limiting requests right now (429). Wait a moment, then try again." && down.keyUnlit && busy.keyUnlit,
      show({ down, busy }),
    );
    const late = await run("groq", "smoke-t108-some-key-0123", "", {
      ok: false, timedOut: true,
      error: "the agent did not answer `atag models search` within 90s — it may be busy or starting up. Try again. (http 401)",
    });
    check(
      "T108 (ATO-202): our own 90 s deadline says the list timed out; a stale `http 401` in the stderr tail is not read as a rejected key",
      late.error === "The model list from Groq did not come back within 90 s. Try again; if it keeps happening, check the address."
        && late.keyUnlit && late.failed === "timed_out",
      show(late),
    );
    const key = await run("groq", "smoke-t108-bad-key-0123", "", { ok: false, error: 'could not list models from "groq": http 401: Invalid API Key', status: 401 });
    const gone = await run("groq", "smoke-t108-some-key-0123", "", { ok: false, error: 'could not list models from "groq": fetch failed', unreachable: true });
    check(
      "T108 (ATO-202): 401 is still the key, lit; a host that does not answer is analytics `server_unreachable`, not `catalog_empty`",
      /^Groq didn’t accept this key/.test(key.error ?? "") && !key.keyUnlit && gone.failed === "server_unreachable",
      show({ key, gone }),
    );
  } finally {
    await js<unknown>(`(() => { const k = window.__t108Keep || {};
      WIZ.unfinishedId = null; act('close');
      Object.assign(WIZ, k.wiz || {}, {unfinishedId: null, stepping: false});
      LIVE_CONFIG = k.cfg; BSW.readyIds = k.ids || []; BSW.readyLoaded = !!k.loaded; SWX.want = k.want;
      if (k.failed) ANX.providerFailed = k.failed;
      SEL.open = !!k.open; SEL.err = k.err || null; if (k.kind) SEL.kind = k.kind; SEL.addOpen = !!k.addOpen;
      ['__t108Keep', '__t108Settle', '__t108Try', '__t108Failed'].forEach((n) => { delete window[n]; });
      render(); })()`).catch(() => undefined);
  }
}
