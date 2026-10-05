/**
 * Release-fix checks for QA item B02 (build 02.10) and ATO-185 (see
 * main/release-fixes-smoke.ts). Run alone with `--smoke --smoke-task=102`.
 *
 * B02 — "Skip the model setup, send a message: 'no local model is selected —
 * open Models (/local) … (message returned to the editor)'. Add OpenRouter,
 * send again: the reply comes, under the old error, which stays." The gate's
 * refusal is a pre-send notice (nothing ran, the message went back to the
 * editor). It is marked `gateNotice` now and goes once the route can run a
 * turn: the config read after a provider or model change
 * (refreshLiveConfig → dropGateNoticesIfCleared), or a turn that got past the
 * gate (startLiveTurn → dropStaleGateNotices). A second refusal replaces the
 * first instead of stacking. A real turn's failure line is not touched.
 *
 * ATO-185 — "After the app starts, the first reply comes under 'No answer from
 * Local models (the local model server isn't running) … Start it in Settings ›
 * Models.' and those lines stay until the chat is opened again." The wait's
 * lines carry `waitFor` (the reply row they held up): they go when the model
 * answers again (provider_recovered), and the "answering again" line goes when
 * the turn completes (done). A line of another turn stays.
 *
 * Both are driven through the window's own functions with LIVE_CONFIG and the
 * transcript staged on copies and put back, as t40's wait probe does. Nothing
 * is sent to the agent: the gate is checked to refuse before bswGatedTurn is
 * called, and the wait frames go to a stand-in turn that RUNNING never had.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

const show = (s: unknown) => JSON.stringify(s);

const GATE_LINE = "no local model is selected — open Models (/local) to pick and download one (message returned to the editor)";

export async function checks102(js: Js, check: Check): Promise<void> {
  /* ---- B02: the gate's refusal goes once a provider is set ---- */
  const g = await js<Record<string, unknown>>(`(() => {
    if (S.turnId || S.streamId || S.busy || RUNNING.size > 0 || BSW.gating) return {skipped: true};
    const e = document.getElementById('entry');
    const keep = {cfg: LIVE_CONFIG, log: S.log, draft: S.draft, entry: e ? e.value : null};
    const local = {id: 'local-llama', kind: 'llama-server'};
    const noModel = {llm: {activeTextProvider: 'local-llama', providers: [local], fallback: {appendLocal: true}},
      localModels: {mode: 'managed', managed: {modelId: null}}};
    const cloud = {llm: {activeTextProvider: 'openrouter', providers: [{id: 'openrouter', kind: 'openrouter'}, local], fallback: {appendLocal: true}},
      localModels: {mode: 'managed', managed: {modelId: null}}};
    const failed = {id: nid(), k: 'system', sev: 'err', text: 'turn failed [provider]: an earlier turn that really failed'};
    const decode = (t) => { const x = document.createElement('textarea'); x.innerHTML = t || ''; return x.value; };
    const gateLines = () => S.log.filter((m) => m.k === 'system' && m.gateNotice).map((m) => decode(m.text));
    try {
      S.log = [{id: nid(), k: 'user', text: 'an earlier question'}, failed];
      const log = S.log;
      LIVE_CONFIG = noModel;
      const verdict = localTurnGate().kind;
      if (verdict !== 'block') return {skipped: false, verdict};
      bswGatedTurn('What can you do?');
      const first = gateLines();
      const draft = S.draft;
      bswGatedTurn('What can you do?');
      const second = gateLines();
      // Still no model: a config read that changes nothing keeps the line.
      const keptWhileBlocked = !dropGateNoticesIfCleared() && gateLines().length === 1;
      // OpenRouter added and picked: the read refreshLiveConfig makes.
      LIVE_CONFIG = cloud;
      const afterCloud = localTurnGate().kind;
      const dropped = dropGateNoticesIfCleared();
      const after = gateLines();
      return {skipped: false, verdict, first, second, draft, keptWhileBlocked, afterCloud, dropped, after,
        sameArray: S.log === log, failedKept: S.log.includes(failed),
        users: S.log.filter((m) => m.k === 'user').length,
        // A turn that got past the gate retires them too (it runs the agent, so it is read, not run).
        startDrops: /dropStaleGateNotices\\(\\)/.test(String(startLiveTurn)),
        refreshDrops: /dropGateNoticesIfCleared\\(\\)/.test(String(refreshLiveConfig))};
    } finally {
      LIVE_CONFIG = keep.cfg; S.log = keep.log; S.draft = keep.draft;
      ctxDraftChanged();
      render();
      const n = document.getElementById('entry');
      if (n && keep.entry !== null) n.value = keep.entry;
    }
  })()`);
  if (g["skipped"] === true) {
    check("T102: B02 the gate probe ran (the window was idle)", false, "a turn was running, so nothing was staged");
  } else {
    const first = (g["first"] as string[] | undefined) ?? [];
    const second = (g["second"] as string[] | undefined) ?? [];
    check(
      "T102: B02 with no local model the gate refuses with the TUI's text, marked as a pre-send notice",
      g["verdict"] === "block" && first.length === 1 && first[0] === GATE_LINE && g["draft"] === "What can you do?",
      show({ verdict: g["verdict"], first, draft: g["draft"] }),
    );
    check(
      "T102: B02 a second refusal replaces the first instead of stacking, and stays while still no model",
      second.length === 1 && second[0] === GATE_LINE && g["keptWhileBlocked"] === true,
      show({ second, keptWhileBlocked: g["keptWhileBlocked"] }),
    );
    check(
      "T102: B02 once OpenRouter is the provider the stale refusal is gone; a real failed turn's line and the earlier question stay",
      g["afterCloud"] === "run" && g["dropped"] === true && Array.isArray(g["after"]) && (g["after"] as string[]).length === 0
        && g["failedKept"] === true && g["users"] === 1 && g["sameArray"] === true,
      show({ afterCloud: g["afterCloud"], dropped: g["dropped"], after: g["after"], failedKept: g["failedKept"], users: g["users"], sameArray: g["sameArray"] }),
    );
    check(
      "T102: B02 a turn that starts (startLiveTurn) and a config re-read (refreshLiveConfig) both retire the refusal",
      g["startDrops"] === true && g["refreshDrops"] === true,
      show({ startDrops: g["startDrops"], refreshDrops: g["refreshDrops"] }),
    );
  }

  /* ---- ATO-185: a wait's lines go once the turn moves on ---- */
  const w = await js<Record<string, unknown>>(`(() => {
    if (S.turnId || S.streamId || S.busy || RUNNING.size > 0 || WAIT || S.queued.length) return {skipped: true};
    const keep = {room: S.room, log: S.log, text: APPSTATUS.text, tone: APPSTATUS.tone, logs: LOGS.length,
      unverified: UNVERIFIED, history: S.history.length, planMode: PLAN.startedMode, reasonId: S.reasonId};
    const turnId = 'smoke-t102-wait';
    const stream = {id: 'smoke-t102-stream', k: 'assistant', text: 'OPENROUTER_OK'};
    // An earlier turn's wait that ended in a failure: its lines are the reason it failed, and stay.
    const otherWait = {id: nid(), k: 'system', sev: 'pause', note: true, waitFor: 'smoke-t102-earlier', text: 'an earlier turn waited and gave up'};
    const asked = {id: nid(), k: 'user', text: 'smoke t102: first message after the app starts'};
    const ours = () => S.log.filter((m) => m.k === 'system' && m.waitFor === stream.id).map((m) => ({sev: m.sev || '', text: String(m.text || '')}));
    let out = {skipped: false};
    try {
      S.log = keep.log.concat([otherWait, asked, stream]);
      S.turnId = turnId; S.streamId = stream.id; S.room = 'chat';
      UNVERIFIED = []; PLAN.startedMode = null;
      onChatEvent({turnId, kind: 'provider_waiting', payload: {object: 'atomic.provider_waiting', session_id: 'smoke-t102',
        attempt: 1, waited_ms: 0, max_wait_ms: 300000, next_retry_ms: 30000, reason: 'fetch failed',
        provider_id: 'local-llama', cause: {kind: 'refused'}}});
      const waiting = ours();
      onChatEvent({turnId, kind: 'provider_recovered', payload: {object: 'atomic.provider_recovered', session_id: 'smoke-t102', waited_ms: 4000}});
      const recovered = ours();
      const waitAfterRecovered = !!WAIT;
      onChatEvent({turnId, kind: 'done'});
      const done = ours();
      out = {skipped: false, waiting, recovered, waitAfterRecovered, done,
        otherKept: S.log.includes(otherWait), replyKept: S.log.includes(stream) && stream.text === 'OPENROUTER_OK'};
    } finally {
      WAIT = null;
      if (WAIT_TICK) { clearInterval(WAIT_TICK); WAIT_TICK = 0; }
      S.turnId = null; S.streamId = null; S.busy = false; S.reasonId = keep.reasonId;
      S.log = keep.log; S.room = keep.room; S.history.length = keep.history;
      UNVERIFIED = keep.unverified; PLAN.startedMode = keep.planMode;
      APPSTATUS.text = keep.text; APPSTATUS.tone = keep.tone; LOGS.length = keep.logs;
      render();
    }
    return out;
  })()`);
  if (w["skipped"] === true) {
    check("T102: ATO-185 the wait probe ran (the window was idle)", false, "a turn was running, so nothing was staged");
    return;
  }
  type Line = { sev: string; text: string };
  const waiting = (w["waiting"] as Line[] | undefined) ?? [];
  const recovered = (w["recovered"] as Line[] | undefined) ?? [];
  const done = (w["done"] as Line[] | undefined) ?? [];
  check(
    "T102: ATO-185 a wait on the local server puts its line in the turn, tied to that turn's reply",
    waiting.length >= 1 && waiting.some((l) => l.sev === "pause" && l.text.includes("No answer from")),
    show(waiting),
  );
  check(
    "T102: ATO-185 when the model answers again the wait's lines go; only the \"answering again\" line is left",
    recovered.length === 1 && recovered[0]!.sev === "" && /answering again/.test(recovered[0]!.text)
      && w["waitAfterRecovered"] === false,
    show({ recovered, waitAfterRecovered: w["waitAfterRecovered"] }),
  );
  check(
    "T102: ATO-185 when the turn completes no service line of its wait is left; the reply and an earlier turn's line stay",
    done.length === 0 && w["replyKept"] === true && w["otherKept"] === true,
    show({ done, replyKept: w["replyKept"], otherKept: w["otherKept"] }),
  );
}
