import { managedStart, servedWith } from "./managed-start.js";

/**
 * Release-fix checks for backlog item 39 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=39`.
 *
 * 39 — Going back from the cloud to the local model took about 20 s. The
 * cloud switch stops the model to give its memory back (kept that way), so
 * the way back is a fresh `models start`, and before the model even began
 * to load that start asked GitHub for a newer llama.cpp (the desktop runs
 * a new `models start` process every time, so the release cache never
 * survived), ran `llama-server --list-devices` twice, and after the load
 * held the model back another 3-5 s for a speed probe it had already made
 * on the previous start. (The 16 s in the backlog was llama-server's own
 * first start after a llama.cpp install, which did not recur.)
 *
 *   1 — Settings › Models: the worker count's notice "fusion: 1 worker —
 *       restart the local model …" stayed on the pane after Local models was
 *       picked. It is Fusion's notice, and goes when Fusion does; its restart
 *       half shows only while a local model that was up when the count
 *       changed still serves Fusion's workers.
 *   2 — The notice wraps inside a narrow pane instead of running past it.
 *   3 — The real `models start`, against a stand-in llama-server
 *       (managed-start.ts): one `--list-devices` per start; the speed probed
 *       on a model's first start, carried over on the next (the start still
 *       says "~22 tok/s"), and probed again after a llama.cpp update.
 *
 * The renderer checks put LIVE_CONFIG, the pane's message and the server
 * status back as they found them; the start checks run in a throwaway state
 * dir and leave nothing running.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

const FULL = "fusion: 1 worker — restart the local model (Settings › Models › Local) so it runs 1 at once";
const SHORT = "fusion: 1 worker";
const q = (v: unknown) => JSON.stringify(v);
const count = (calls: string[], what: string) => calls.filter((c) => c === what).length;

export async function checks39(js: Js, check: Check): Promise<void> {
  await noticeChecks(js, check);
  await startChecks(check);
}

async function noticeChecks(js: Js, check: Check): Promise<void> {
  type Seen = {
    fusionUp: string | null; workersInCloud: string | null; restarted: string | null; notUp: string | null;
    underLocal: string | null; dropped: boolean; staysGone: string | null;
    pane: { mode: string; hasNotice: boolean };
  };
  const seen = await js<Seen>(`(() => {
    const keep = {cfg: LIVE_CONFIG, msg: LLMP.msg, status: LLMP.status};
    const providers = [{id:'local-llama', kind:'llama-server'}, {id:'aimlapi', kind:'aimlapi', defaultChatModel:'m-o'},
      {id:'openrouter', kind:'openrouter', defaultChatModel:'m-w'}];
    const cfg = (active, runMode) => ({llm:{activeTextProvider:active, providers, runMode},
      localModels:{mode:'managed', managed:{modelId:'qwen-3.5-4b', parallel:1}}});
    const fusionLocal = cfg('aimlapi', {mode:'fusion', fusion:{orchestratorProvider:'aimlapi', workerProvider:'local-llama', workers:1}});
    const fusionCloud = cfg('aimlapi', {mode:'fusion', fusion:{orchestratorProvider:'aimlapi', workerProvider:'openrouter', workers:1}});
    const local = cfg('local-llama', {mode:'local', fusion:{orchestratorProvider:'aimlapi', workerProvider:'local-llama', workers:1}});
    const up = (pid) => ({daemonRunning:true, daemonPid:pid, health:'ok'});
    const shown = () => { const m = llmMsgNow(); return m ? m.text : null; };
    try {
      // The count set under Fusion, the local model up and serving the workers.
      LIVE_CONFIG = fusionLocal; LLMP.status = up(4242); LLMP.msg = fzWorkersMsg(1, ${q(FULL)});
      const fusionUp = shown();
      LIVE_CONFIG = fusionCloud;
      const workersInCloud = shown();
      LIVE_CONFIG = fusionLocal; LLMP.status = up(4343);
      const restarted = shown();
      LLMP.status = {daemonRunning:false, daemonPid:null, health:'down'}; LLMP.msg = fzWorkersMsg(1, ${q(FULL)});
      const notUp = shown();
      // Then Local models is picked.
      LLMP.status = up(4242); LLMP.msg = fzWorkersMsg(1, ${q(FULL)}); LIVE_CONFIG = local;
      const underLocal = shown();
      const dropped = LLMP.msg === null;
      LIVE_CONFIG = fusionLocal;
      const staysGone = shown();
      // The pane itself, drawn on a route that is not Fusion (the real one when it is not).
      LIVE_CONFIG = rmResolve(keep.cfg).effective === 'fusion' ? local : keep.cfg;
      LLMP.msg = fzWorkersMsg(1, ${q(FULL)});
      const html = llmPanelHTML();
      const pane = {mode: rmNow().effective, hasNotice: html.indexOf('restart the local model') >= 0 || html.indexOf(${q(SHORT)}) >= 0};
      return {fusionUp, workersInCloud, restarted, notUp, underLocal, dropped, staysGone, pane};
    } finally {
      LIVE_CONFIG = keep.cfg; LLMP.msg = keep.msg; LLMP.status = keep.status;
    }
  })()`);
  check(
    "T39: under Fusion with the local model serving the workers, the notice says to restart that model",
    seen.fusionUp === FULL,
    q(seen.fusionUp),
  );
  check(
    "T39: its restart half goes when the workers are in the cloud, the model has restarted, or it was not up",
    seen.workersInCloud === SHORT && seen.restarted === SHORT && seen.notUp === SHORT,
    q({ workersInCloud: seen.workersInCloud, restarted: seen.restarted, notUp: seen.notUp }),
  );
  check(
    "T39: once Local models is picked the Fusion workers notice is gone from Settings › Models, and does not come back with Fusion",
    seen.underLocal === null && seen.dropped && seen.staysGone === null && seen.pane.mode !== "fusion" && !seen.pane.hasNotice,
    q({ underLocal: seen.underLocal, dropped: seen.dropped, staysGone: seen.staysGone, pane: seen.pane }),
  );

  const wrap = await js<{ fits: boolean; lines: number; inside: boolean; width: number }>(`(() => {
    const host = document.createElement('div');
    host.className = 'llm-pane';
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:300px';
    host.innerHTML = llmMsgHTML(${q(FULL)});
    document.body.appendChild(host);
    try {
      const n = host.querySelector('.llm-msg');
      const text = n.querySelector('.grow');
      const lh = parseFloat(getComputedStyle(text).lineHeight) || 19;
      return {
        fits: n.scrollWidth <= n.clientWidth + 1 && text.scrollWidth <= text.clientWidth + 1,
        lines: Math.round(text.getBoundingClientRect().height / lh),
        inside: n.getBoundingClientRect().right <= host.getBoundingClientRect().right + 0.5,
        width: Math.round(n.getBoundingClientRect().width),
      };
    } finally {
      host.remove();
    }
  })()`);
  check(
    "T39: the notice wraps inside a narrow pane (300 px) instead of running past its edge",
    wrap.fits && wrap.inside && wrap.lines >= 2,
    q(wrap),
  );
}

async function startChecks(check: Check): Promise<void> {
  const h = await managedStart("qwen35");
  try {
    h.devices("MTL0: Apple M4 (10922 MiB, 10922 MiB free)");
    const first = await h.start();
    const c1 = h.calls();
    check(
      "T39: models start asks llama-server --list-devices once — the device pick and the context fit share the answer",
      first.ok && count(c1, "list-devices") === 1 && servedWith(c1)?.device === "MTL0",
      q({ ok: first.ok, calls: c1, error: first.error, stderr: first.stderr.slice(-400) }),
    );
    check(
      "T39: a model's first start measures its speed (one probe) and reports it",
      first.ok && count(c1, "probe") === 1 && /~22 tok\/s single stream/.test(first.stdout),
      q({ calls: c1, stdout: first.stdout.slice(-400) }),
    );
    await h.stop();

    h.clearCalls();
    const second = await h.start();
    const c2 = h.calls();
    check(
      "T39: the next start of that model on the same llama.cpp and device carries its speed over — no probe, still ~22 tok/s",
      second.ok && count(c2, "probe") === 0 && count(c2, "list-devices") === 1 && /~22 tok\/s single stream/.test(second.stdout),
      q({ ok: second.ok, calls: c2, stdout: second.stdout.slice(-400), error: second.error }),
    );
    await h.stop();

    h.build("turboquant-smoke-2");
    h.clearCalls();
    const third = await h.start();
    const c3 = h.calls();
    check(
      "T39: after a llama.cpp update the speed is measured again",
      third.ok && count(c3, "probe") === 1,
      q({ ok: third.ok, calls: c3, error: third.error }),
    );
    await h.stop();
  } finally {
    await h.dispose();
  }
}
