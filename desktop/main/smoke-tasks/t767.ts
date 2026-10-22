/**
 * Release-fix checks for ATO-767 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=767`. Not part of a plain `--smoke`:
 * it kills the app's own agent four times and leaves it stopped until it
 * restarts it by hand, which every check after it would trip over.
 *
 * An agent that exited on its own left the window on "The agent exited"
 * until the person found Restart Agent Runtime. main.ts now starts it again
 * (agent-auto-restart.ts): three attempts within five minutes, after 1 s,
 * 5 s and 20 s, then the window offers a Restart agent button.
 *
 *   A — the app's restarter is armed (a smoke run leaves it off). The agent
 *       is killed from outside (SIGKILL on the pid serve.json names); with no
 *       action from the check it is connected again, on a new pid, and the
 *       chat has the line about the restart.
 *   B — killed three more times, each once it is back: the third automatic
 *       restart is the last; after the fourth kill the status stays `error`
 *       and the chat has the Restart agent button.
 *   C — that button's restart (the menu's) brings it back, and the restarter
 *       is left off again as the smoke found it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { hostedAutoRestart, AGENT_RESTARTED_LINE } from "../agent-auto-restart.js";
import { DESKTOP_STATE_DIR } from "../state-dir.js";

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Status = { state?: string; port?: number | null; error?: string | null } | null;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The pid of the agent this app runs, from the record it keeps for the next launch. */
function servePid(): number | null {
  try {
    const rec = JSON.parse(readFileSync(join(DESKTOP_STATE_DIR, "serve.json"), "utf8")) as { pid?: unknown };
    return typeof rec.pid === "number" && rec.pid > 1 ? rec.pid : null;
  } catch {
    return null;
  }
}

async function until<T>(look: () => Promise<T>, ok: (v: T) => boolean, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  let v = await look();
  while (!ok(v) && Date.now() < deadline) {
    await wait(250);
    v = await look();
  }
  return v;
}

export async function checks767(js: Js, check: Check): Promise<void> {
  const restarter = hostedAutoRestart();
  check("T767: main hosts the automatic restarter, off in a smoke run", !!restarter && !restarter.isArmed());
  if (!restarter) return;
  const status = () => js<Status>("window.atomic.status()").catch(() => null);
  const restartLines = () =>
    js<number>(`window.__systemLines().filter((t) => t === ${JSON.stringify(AGENT_RESTARTED_LINE)}).length`).catch(() => -1);

  restarter.arm(true);
  try {
    const up = await until(status, (s) => s?.state === "connected", 120_000);
    check("T767: the agent is connected before the kill", up?.state === "connected", JSON.stringify(up));
    const linesBefore = await restartLines();

    // A — one kill, and it comes back by itself.
    const first = servePid();
    check("T767: serve.json names the running agent", first !== null);
    if (first === null) return;
    process.kill(first, "SIGKILL");
    await until(status, (s) => s?.state === "error", 10_000);
    const back = await until(status, (s) => s?.state === "connected", 60_000);
    const second = servePid();
    check(
      "T767: killed from outside, the agent is connected again with no action, on a new pid",
      back?.state === "connected" && second !== null && second !== first,
      JSON.stringify({ state: back?.state, first, second }),
    );
    const lines = await until(restartLines, (n) => n > linesBefore, 5_000);
    check("T767: the chat says the agent stopped unexpectedly and was restarted", lines === linesBefore + 1, JSON.stringify({ linesBefore, lines }));

    // B — three more kills: two more restarts (after 5 s and 20 s), then it gives up.
    for (let i = 2; i <= 4; i++) {
      const pid = servePid();
      if (pid === null) break;
      process.kill(pid, "SIGKILL");
      await until(status, (s) => s?.state === "error", 10_000);
      if (i < 4) {
        const again = await until(status, (s) => s?.state === "connected", 90_000);
        check(`T767: kill ${i} is restarted automatically too`, again?.state === "connected", JSON.stringify(again));
      }
    }
    await wait(3_000);   // the fourth exit gives up at once: nothing is scheduled
    const after = await status();
    const button = await js<{ row: boolean; html: boolean }>(
      "(() => { const m = S.log.slice().reverse().find((x) => x.act === 'restart-agent'); return {row: !!m, html: !!m && sysRowHTML(m, 1).includes('data-act=\"agent:restart\">Restart agent</button>')}; })()",
    ).catch(() => null);
    check(
      "T767: after the third automatic restart the fourth kill leaves the status at error and offers Restart agent",
      after?.state === "error" && !restarter.pending() && !!button?.row && !!button?.html,
      JSON.stringify({ state: after?.state, pending: restarter.pending(), button }),
    );

    // C — the button's restart (the menu's) brings it back and starts the count again.
    const manual = await js<Status>("window.atomic.restart()").catch(() => null);
    const final = manual?.state === "connected" ? manual : await until(status, (s) => s?.state === "connected", 120_000);
    check("T767: Restart agent brings the agent back and forgets the count", final?.state === "connected" && restarter.attemptsMade() === 0, JSON.stringify({ state: final?.state, attempts: restarter.attemptsMade() }));
  } finally {
    restarter.arm(false);
  }
}
