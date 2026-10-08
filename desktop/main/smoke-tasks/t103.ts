/**
 * Release-fix check (see main/release-fixes-smoke.ts). Run alone with
 * `--smoke --smoke-task=103`.
 *
 * 103 — a message sent before the agent is up was thrown away. After a Force
 * Quit the app opens again at once and the agent it respawns takes seconds to
 * answer /health; the send button does not lock for that. Enter cleared the
 * box, drew the message as sent and answered it with "the agent is still
 * starting — send this again in a moment" — the words to send again were gone,
 * and nothing reached the agent (found by the e2e scenario 06, whose question
 * after the relaunch got no reply). Now nothing is sent, the message stays in
 * the box and a refusal toast says why, as for a chat that is still loading.
 *
 * Staged on the window's own state and put back: S.live is set to a starting
 * (then a stopped-with-an-error) agent, the box holds a message, and submit()
 * runs as Enter runs it. Nothing reaches the agent — the check is that no turn
 * starts.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

const show = (s: unknown) => JSON.stringify(s);

export async function checks103(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, unknown>>(`(() => {
    if (S.turnId || S.streamId || S.busy || S.pending || RUNNING.size > 0 || BSW.gating || openHoldsComposer() || swxWaitsForRoute()) {
      return {skipped: true};
    }
    const e = document.getElementById('entry');
    const keep = {live: S.live, log: S.log, draft: S.draft, entry: e ? e.value : null, toasts: S.toasts.slice()};
    const said = 'smoke t103: typed before the agent was up';
    const attempt = (live) => {
      S.live = Object.assign({}, keep.live, live);
      S.toasts = []; renderToasts();
      S.draft = said;
      render();
      const n = document.getElementById('entry');
      if (n) n.value = said;
      const rows = S.log.length;
      submit();
      const box = document.getElementById('entry');
      return {entry: box ? box.value : null, draft: S.draft, busy: S.busy, running: RUNNING.size,
        turnId: S.turnId, added: S.log.length - rows, toasts: S.toasts.map((t) => t.t + ' | ' + (t.s || ''))};
    };
    try {
      S.log = [];
      const starting = attempt({state: 'starting', error: null});
      const stopped = attempt({state: 'error', error: 'the agent exited (code 1)'});
      return {skipped: false, starting, stopped};
    } finally {
      S.live = keep.live; S.log = keep.log; S.draft = keep.draft;
      S.toasts = keep.toasts; renderToasts();
      ctxDraftChanged();
      render();
      const n = document.getElementById('entry');
      if (n && keep.entry !== null) n.value = keep.entry;
    }
  })()`);
  if (r["skipped"] === true) {
    check("T103: the probe ran (the window was idle)", false, "a turn, a switch or a chat opening was in the way, so nothing was staged");
    return;
  }
  type Try = { entry: string | null; draft: string; busy: boolean; running: number; turnId: string | null; added: number; toasts: string[] };
  const said = "smoke t103: typed before the agent was up";
  const starting = r["starting"] as Try;
  const stopped = r["stopped"] as Try;
  check(
    "T103: Enter while the agent is still starting sends nothing and starts no turn",
    !!starting && starting.busy === false && starting.running === 0 && !starting.turnId && starting.added === 0,
    show(starting),
  );
  check(
    "T103: the message stays in the box, word for word, and a toast says the agent is still starting",
    !!starting && starting.entry === said && starting.draft === said
      && starting.toasts.some((t) => t.startsWith("The agent is still starting")),
    show(starting),
  );
  check(
    "T103: with the agent stopped on an error, the message stays too and the toast carries the error",
    !!stopped && stopped.entry === said && stopped.added === 0 && stopped.busy === false
      && stopped.toasts.some((t) => t.startsWith("The agent is not running") && t.includes("the agent exited (code 1)")),
    show(stopped),
  );
}
