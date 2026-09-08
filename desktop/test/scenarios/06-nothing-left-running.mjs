/**
 * 06 — the app does not leave an agent running behind it.
 *
 * The person: uses the app, then the app dies the way apps die — Force Quit
 * from the Dock, an Activity Monitor kill, a crash in the window process, the
 * machine running out of memory. Later they open it again.
 *
 * The human result they care about, and would only ever notice as "why is
 * this Mac so slow": after reopening, there is exactly ONE agent process for
 * this app, not two. Nothing it started before is still sitting there.
 *
 * This is the scenario that came out of a real morning. Driving found 108
 * orphaned `atag serve` processes on the operator's Mac, the oldest four days
 * old, holding about 3.4 GB between them — enough that the wizard's own
 * `atag config get` blew its 30-second timeout and first-run died with
 * "Command failed", which reads as anything but "an app you closed last
 * Thursday is still running". `before-quit` stopped the child; nothing else
 * ever did, and `npm run smoke` cannot see the damage because the damage is
 * what is left over after the app is gone.
 *
 * Everything here is observation of the OS — `ps`, the same thing a person
 * types into Activity Monitor's search box. The kill is done to the app from
 * outside, exactly as Force Quit does it; nothing inside the app is called.
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { launch } from '../drive.mjs';
import {
  scenario, main, ask, waitTurn, check, sleep, CDP_PORT, SCENARIO_NAME,
} from '../harness.mjs';

/** Every process on this Mac, as {pid, ppid, command}. Plain `ps`. */
function processes() {
  const out = execFileSync('/bin/ps', ['-eo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 8 << 20 });
  return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return m ? { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] } : null;
  }).filter(Boolean);
}

/** True when `pid` is `root` or one of its descendants. */
function descendsFrom(all, pid, root) {
  const by = new Map(all.map((p) => [p.pid, p]));
  for (let cur = by.get(pid), hops = 0; cur && hops < 40; hops++) {
    if (cur.pid === root) return true;
    cur = by.get(cur.ppid);
  }
  return false;
}

/** The `atag serve` processes, with the port each one is listening on. */
function agentsRunning() {
  return processes()
    .filter((p) => /\bserve\b/.test(p.command) && /(atag|atomic-agent|cli\/index\.js)/.test(p.command))
    .map((p) => ({ ...p, port: Number((p.command.match(/--port (\d+)/) || [])[1] || 0) }));
}

/** The Electron main process of the app we launched — what Force Quit kills. */
function electronMainOf(shimPid) {
  const all = processes();
  return all.find((p) => /Electron\.app\/Contents\/MacOS\/Electron\b/.test(p.command)
    && !/Helper/.test(p.command)
    && descendsFrom(all, p.pid, shimPid)) || null;
}

const alive = (pid) => processes().some((p) => p.pid === pid);

export const run = () => scenario(SCENARIO_NAME(import.meta.url), async ({ app, stateDir, workspace }) => {
  // ---- use the app normally, so there is definitely an agent running -------
  await ask(app, 'In one short sentence, what is a lighthouse for?');
  await waitTurn(app, { timeout: 240000 });

  const beforeKill = agentsRunning();
  const shim = app.proc.pid;
  const mine = beforeKill.filter((a) => descendsFrom(processes(), a.pid, shim));
  check(mine.length === 1, 'the app I opened is running exactly one agent',
    `found ${mine.length}: ${JSON.stringify(mine.map((m) => `${m.pid}:${m.port}`))}`);
  const agent = mine[0];
  app.log(`this window's agent is pid ${agent.pid} on port ${agent.port}`);

  // ---- now the app dies the way apps die ----------------------------------
  const main_proc = electronMainOf(shim);
  check(!!main_proc, 'found the app process a person would Force Quit');
  /* Force Quit takes the whole app: the main process AND its helpers (GPU,
     network, renderer). Killing only the main process leaves the helpers
     holding the Chromium profile's lock, and the NEXT launch on that profile
     dies with "Cannot destructure property 'preloadScripts'" — a wound this
     scenario would have inflicted on itself and then blamed on the app. What
     is deliberately NOT killed is the agent: that is the whole point. */
  const all = processes();
  const appProcs = all
    .filter((p) => descendsFrom(all, p.pid, shim) || p.pid === shim)
    .filter((p) => /Electron/i.test(p.command))
    .map((p) => p.pid);
  app.log(`Force Quit: kill -9 on the app and its helpers (${appProcs.length} processes, main ${main_proc.pid})`);
  try { app.ws.close(); } catch { /* the socket goes with the window */ }
  for (const pid of appProcs) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  for (let i = 0; i < 60 && appProcs.some(alive); i++) await sleep(200);
  check(!alive(main_proc.pid), 'the app is gone');
  await sleep(1500);

  /* This is the leak, stated out loud rather than asserted: on macOS a killed
     parent does not take its children, so the agent is still there. The fix is
     not "it dies with the app" — nothing can promise that — it is that the
     next launch comes back for it. */
  const stranded = alive(agent.pid);
  app.log(stranded
    ? `the agent (pid ${agent.pid}) outlived the app, as an orphan always does`
    : `the agent went with the app on this run`);

  // ---- the person opens the app again -------------------------------------
  for (let i = 0; i < 40; i++) { // let the debugging port go
    try { await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); await sleep(250); } catch { break; }
  }
  const again = await launch({ port: CDP_PORT, stateDir, workspace });
  try {
    await again.waitFor(`!!document.querySelector('#entry')`, 'the window, reopened', { timeout: 90000 });
    await again.waitFor(`!document.querySelector('.sendbtn[disabled]')`, 'the agent up again', { timeout: 90000 });

    // ---- and this is what they would have found in Activity Monitor -------
    if (stranded) {
      check(!alive(agent.pid),
        `reopening the app cleaned up the agent it stranded last time (pid ${agent.pid})`,
        `pid ${agent.pid} is STILL running — every launch leaves one behind, for ever`);
    }
    const now = agentsRunning().filter((a) => a.port === agent.port || descendsFrom(processes(), a.pid, again.proc.pid));
    check(now.length <= 1, 'there is one agent for this app, not two',
      `running: ${JSON.stringify(now.map((a) => `${a.pid}:${a.port}`))}`);

    // The app said so, out loud, rather than doing it silently.
    if (stranded) {
      const said = again.output().includes('reaped an orphaned agent');
      app.log(said ? 'the app logged the clean-up' : 'the app cleaned up without saying so');
    }

    // ---- and it still works ------------------------------------------------
    await ask(again, 'Say READY and nothing else.');
    const reply = (await waitTurn(again, { timeout: 240000 })).reply;
    check(reply.trim().length > 0, 'the reopened app still talks to its agent',
      `the reply was empty; the reopened window may be pointing at a dead port`);
    again.log(`the reopened app answered: ${JSON.stringify(reply.slice(0, 80))}`);

    // Nothing this scenario started is left over once it closes.
    const record = join(stateDir, 'serve.json');
    app.log(`the app's own note of its child lives at ${record}`);
  } finally {
    await again.close();
  }
});

if (import.meta.url === `file://${process.argv[1]}`) main(run());
