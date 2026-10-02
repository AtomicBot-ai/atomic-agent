/**
 * Release-fix checks for backlog item 41 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=41`.
 *
 * 41 — false "the agent failed" lines around a restart. A switch restarts
 * `atag serve`: stop() sent SIGTERM, gave the agent 4 s, sent SIGKILL and
 * returned without waiting for the exit, and start() cleared the one
 * `stopping` flag and spawned the next agent. The old agent's exit then
 * landed on the client as the new one's. The window read "The agent exited
 * (code null, signal SIGKILL)." for the client's own kill and, when that exit
 * came after the spawn, "The agent did not become healthy within 30s." a
 * second or two in; the new agent was taken out of the client's hands and its
 * serve.json cleared, so it served on untracked, and no stop or later launch
 * ever came back for it. A stop that ended a start on its way read as "did
 * not become healthy" too, and two starts at once spawned two agents.
 *
 * Its review added: a quit (close) during a restart must not bring an agent
 * up behind the app, and a start waiting behind a stop gives way to a stop
 * asked for while it waited; an agent still there after its SIGKILL is let go
 * of, the stop says so (false), and the next start waits for it without
 * blocking the main thread — no blocking reaper on a pid this client already
 * killed, no "orphaned agent left by a previous run". And (41b) the agent's
 * output reaches the log as whole lines, labelled by the level in them.
 *
 * Nothing here touches the app's own agent or its serve.json. The checks run
 * a second AgentClient against a stand-in agent: a small HTTP server that
 * answers /health and holds /api/events open as `atag serve` does, started
 * through a shell script whose command line reads like the agent's (the
 * reaper recognises it). What it does when it boots and when it is sent
 * SIGTERM is set per check: "linger" ignores SIGTERM, as an agent whose
 * scheduler waits on a task's turn does, so only the SIGKILL ends it. An agent
 * stuck in the kernel, which not even SIGKILL ends at once, is stood in by a
 * client whose SIGKILL does not take (AgentClientOptions.signal); the check
 * then ends it itself. Every stand-in writes its pid down; the checks count
 * them, and end any that is left — never with a signal to pid 0 or 1.
 */
import type { ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentClient, type AgentClientOptions, type AgentStatus } from "../agent-client.js";

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Said = { stream: string; line: string; level?: string };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
const threw = (err: unknown) => `threw: ${err instanceof Error ? err.message : String(err)}`;
const alive = (pid: number) => { if (pid <= 1) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
/** A signal to a stand-in — never to pid 0 or 1, which would reach this app's own process group, or launchd. */
const signal = (pid: number, sig: NodeJS.Signals) => { if (pid > 1) { try { process.kill(pid, sig); } catch { /* gone */ } } };
async function until(pred: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await wait(50);
  }
  return !!(await pred());
}
/** The longest the main thread went without a tick of its own while `run` ran: a blocking wait shows here. */
async function longestStall<T>(run: () => Promise<T>): Promise<{ value: T; stallMs: number }> {
  let last = Date.now();
  let stallMs = 0;
  const ticker = setInterval(() => {
    const now = Date.now();
    stallMs = Math.max(stallMs, now - last);
    last = now;
  }, 50);
  try {
    const value = await run();
    return { value, stallMs: Math.max(stallMs, Date.now() - last) };
  } finally {
    clearInterval(ticker);
  }
}

/* The grace a stand-in gets between SIGTERM and SIGKILL. The app's is 4 s;
   nothing here needs that long, and two lingering stops at 4 s each cost the
   run ~6 s more than they prove. */
const GRACE_MS = 1_000;
/* A SIGKILL that does not take: the agent stuck in the kernel. */
const killDoesNotTake = (child: ChildProcess, sig: NodeJS.Signals) => { if (sig !== "SIGKILL") child.kill(sig); };

/* `atag serve`, as far as the AgentClient can tell. `boot`: ok (listens at
   once), slow (listens after 6 s), never, crash (exits with 3 shortly after it
   first answers /health — not after boot, which a loaded machine can take
   longer than that to reach). `term`: quick (exits on SIGTERM), linger
   (ignores it). `say`: 1 writes the lines check 5 reads to stderr — a
   structured INFO and WARN, a plain line, a line longer than any pipe chunk,
   and a character cut across two writes. */
const STAND_IN = `const http = require("http");
const fs = require("fs");
const path = require("path");
const dir = __dirname;
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const read = (f) => { try { return fs.readFileSync(path.join(dir, f), "utf8").trim(); } catch { return ""; } };
fs.mkdirSync(path.join(dir, "pids"), { recursive: true });
fs.writeFileSync(path.join(dir, "pids", String(process.pid)), String(port));
const boot = read("boot");
const term = read("term");
if (read("say") === "1") {
  const at = () => new Date().toISOString();
  process.stderr.write("[" + at() + "] INFO stand-in booted {\\"port\\":" + port + "}\\n");
  process.stderr.write("[" + at() + "] WARN stand-in warned\\n");
  process.stderr.write("plain stderr line\\n");
  process.stderr.write("long:" + "y".repeat(200000) + "\\n");
  process.stderr.write(Buffer.from([0xf0, 0x9f]));
  setTimeout(() => process.stderr.write(Buffer.concat([Buffer.from([0x93, 0x84]), Buffer.from("done\\n")])), 200);
}
let crashArmed = false;
const srv = http.createServer((req, res) => {
  if (req.url === "/health") {
    if (boot === "crash" && !crashArmed) { crashArmed = true; setTimeout(() => process.exit(3), 1500); }
    res.writeHead(200, {"content-type": "application/json"}); res.end(JSON.stringify({status: "ok", workingDir: dir})); return;
  }
  if (req.url === "/api/events") { res.writeHead(200, {"content-type": "text/event-stream"}); res.write(": open\\n\\n"); return; }
  res.writeHead(404); res.end();
});
const listen = () => srv.listen(port, "127.0.0.1");
if (boot === "slow") setTimeout(listen, 6000);
else if (boot !== "never") listen();
process.on("SIGTERM", () => { if (term !== "linger") process.exit(0); });
setInterval(() => {}, 1 << 30);
`;

type Seen = { state: string; error: string | null };

export async function checks41(_js: Js, check: Check): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "aa-t41-"));
  const script = join(dir, "atag-standin.cjs");
  writeFileSync(script, STAND_IN);
  const bin = join(dir, "atag");
  writeFileSync(bin, [
    "#!/bin/sh",
    "export ELECTRON_RUN_AS_NODE=1",
    `exec ${q(process.execPath)} ${q(script)} "$@"`,
    "",
  ].join("\n"));
  chmodSync(bin, 0o755);
  const record = join(dir, "serve.json");
  const mode = (boot: string, term: string, say = false) => {
    writeFileSync(join(dir, "boot"), boot);
    writeFileSync(join(dir, "term"), term);
    writeFileSync(join(dir, "say"), say ? "1" : "0");
  };
  const pids = (): number[] => {
    try { return readdirSync(join(dir, "pids")).map(Number).filter((p) => p > 1); } catch { return []; }
  };
  const living = () => pids().filter(alive);
  const recorded = (path = record): number | null => {
    try { return (JSON.parse(readFileSync(path, "utf8")) as { pid?: number }).pid ?? null; } catch { return null; }
  };
  mkdirSync(join(dir, "pids"), { recursive: true });

  const clients: AgentClient[] = [];
  const client = (healthBudgetMs = 20_000, extra: AgentClientOptions = {}) => {
    const c = new AgentClient(dir, { binary: () => bin, serveRecordPath: record, healthBudgetMs, stopGraceMs: GRACE_MS, ...extra });
    clients.push(c);
    return c;
  };
  const watch = (c: AgentClient) => {
    const seen: Seen[] = [];
    c.on("status", (s: AgentStatus) => seen.push({ state: s.state, error: s.error }));
    return seen;
  };
  const heard = (c: AgentClient) => {
    const said: Said[] = [];
    c.on("log", (e: Said) => said.push(e));
    return said;
  };
  const errors = (seen: Seen[]) => seen.filter((s) => s.state === "error").map((s) => s.error);

  try {
    // 1. A restart whose agent has to be killed: SIGTERM ignored, SIGKILL after the grace.
    mode("ok", "linger");
    const a = client();
    const seenA = watch(a);
    const up = await a.start();
    const first = a.pid;
    const t1 = Date.now();
    await a.stop();
    await a.start();
    const restartMs = Date.now() - t1;
    const second = a.pid;
    // The old agent's exit lands around now; give a late one time to land before anything is read.
    await wait(1_500);
    check(
      "T41: a restart whose agent has to be killed (it ignored SIGTERM) is a restart, not a failure — no \"exited … SIGKILL\", no \"did not become healthy\"",
      up.state === "connected" && errors(seenA).length === 0 && a.status.state === "connected"
        && first !== null && !alive(first) && second !== null && second !== first,
      `restart took ${restartMs} ms; errors ${JSON.stringify(errors(seenA))}; states ${JSON.stringify(seenA.map((s) => s.state))}; old pid ${first} ${first && alive(first) ? "alive" : "gone"}; new pid ${second}`,
    );
    check(
      "T41: after that restart the client still holds the new agent, and its serve.json still names it",
      second !== null && a.pid === second && alive(second) && recorded() === second,
      `client pid ${a.pid}; new pid ${second} ${second && alive(second) ? "alive" : "gone"}; serve.json names ${recorded()}`,
    );
    // The second agent lingers too (a stand-in reads its mode once, at boot): this stop is a SIGKILL after the grace.
    await a.stop();
    check(
      "T41: a stop after it ends that agent — none is left running untracked",
      living().length === 0 && a.status.state === "stopped" && recorded() === null,
      `still running: ${JSON.stringify(living())}; state ${a.status.state}; serve.json names ${recorded()}`,
    );

    // 2. A stop that ends a start while the agent is still booting.
    mode("slow", "quick");
    const b = client();
    const seenB = watch(b);
    const before = pids().length;
    const starting = b.start();
    await until(() => pids().length > before && b.pid !== null, 10_000);
    await wait(600);   // a few health looks have gone unanswered
    const t2 = Date.now();
    await b.stop();
    const settled = await Promise.race([starting.then((s) => ({ s, ms: Date.now() - t2 })), wait(10_000).then(() => null)]);
    check(
      "T41: a start that a stop ends while the agent boots says nothing — not \"did not become healthy\" — and settles at once",
      settled !== null && settled.ms < 3_000 && errors(seenB).length === 0 && b.status.state === "stopped" && living().length === 0,
      settled
        ? `settled ${settled.ms} ms after the stop as ${settled.s.state}; errors ${JSON.stringify(errors(seenB))}; still running ${JSON.stringify(living())}`
        : `the start had not settled 10 s after the stop; errors ${JSON.stringify(errors(seenB))}`,
    );
    check(
      "T41: that start answers \"stopped\" — not a status an earlier agent left, which the window would report again",
      settled !== null && settled.s.state === "stopped" && settled.s.error === null,
      settled ? JSON.stringify({ state: settled.s.state, error: settled.s.error }) : "never settled",
    );

    // 3. Two starts at once.
    mode("ok", "quick");
    const c = client();
    const count = pids().length;
    const [s1, s2] = await Promise.all([c.start(), c.start()]);
    const spawned = pids().length - count;
    await c.stop();
    check(
      "T41: two starts at once run one agent, and a stop leaves none behind",
      spawned === 1 && s1.state === "connected" && s2.state === "connected" && living().length === 0,
      `spawned ${spawned}; answers ${s1.state}/${s2.state}; still running ${JSON.stringify(living())}`,
    );

    // 4. What is still said: an agent that dies by itself, and a health wait that really runs out.
    mode("crash", "quick");
    const d = client();
    const seenD = watch(d);
    const crashedUp = await d.start();
    await until(() => d.status.state !== "connected", 5_000);
    mode("never", "quick");
    const e = client(3_000);
    const late = await e.start();
    await e.stop();
    check(
      "T41: an agent that exits by itself is still reported, and so is a health wait that really ran out",
      crashedUp.state === "connected" && d.status.state === "error" && /exited \(code 3, signal none\)/.test(d.status.error ?? "")
        && late.state === "error" && /did not become healthy within 3s/.test(late.error ?? "") && errors(seenD).length === 1,
      `crash: ${d.status.state} ${JSON.stringify(d.status.error)}; timeout: ${late.state} ${JSON.stringify(late.error)}`,
    );

    // 5. (41b) What the agent writes reaches the log as whole lines, each with its own level.
    mode("ok", "quick", true);
    const f = client();
    const said = heard(f);
    await f.start();
    await until(() => said.some((l) => l.line.endsWith("done")), 3_000);
    await f.stop();
    const line = (pred: (l: Said) => boolean) => said.find(pred);
    const info = line((l) => / INFO stand-in booted /.test(l.line));
    const warn = line((l) => / WARN stand-in warned$/.test(l.line));
    const plain = line((l) => l.line === "plain stderr line");
    const longs = said.filter((l) => /^long:|^y+$/.test(l.line));
    const cut = line((l) => l.line.endsWith("done"));
    check(
      "T41 (41b): the agent's output comes as whole lines — one past every pipe chunk stays one, a character cut between writes stays whole",
      longs.length === 1 && longs[0]!.line.length === 200_005 && cut?.line === "\u{1F4C4}done",
      `long line(s): ${JSON.stringify(longs.map((l) => l.line.length))}; cut character line: ${JSON.stringify(cut?.line ?? null)}`,
    );
    check(
      "T41 (41b): a structured line carries its level (INFO, WARN); a plain stderr line carries none and stays ERR",
      info?.level === "info" && warn?.level === "warn" && plain !== undefined && plain.level === undefined && plain.stream === "stderr",
      JSON.stringify({ info: info?.level ?? null, warn: warn?.level ?? null, plain: plain ? plain.level ?? "none" : "missing" }),
    );

    // 6. A quit during a restart: the restart's start, queued behind the stop the quit joins, brings nothing up.
    mode("ok", "linger");
    const g = client();
    await g.start();
    const beforeQuit = pids().length;
    const restart = (async () => { await g.stop(); return g.start(); })();   // agent:restart
    await wait(200);   // its stop is waiting out the grace (the agent ignores SIGTERM)
    const quit = g.close();   // Cmd+Q: joins that stop
    const [restarted, goneOnQuit] = await Promise.all([restart, quit]);
    const later = await g.start();
    check(
      "T41: a quit during a restart leaves no agent behind the app — not the restart's start, nor one asked for after",
      goneOnQuit === true && restarted.state === "stopped" && later.state === "stopped" && g.pid === null
        && pids().length === beforeQuit && living().length === 0,
      `stop answered ${goneOnQuit}; restart answered ${restarted.state}, a later start ${later.state}; spawned ${pids().length - beforeQuit}; still running ${JSON.stringify(living())}`,
    );

    // 7. A start waiting behind a stop gives way to a stop asked for while it waited.
    mode("ok", "linger");
    const h = client();
    await h.start();
    const beforeQueued = pids().length;
    const firstStop = h.stop();      // waits out the grace: the agent ignores SIGTERM
    const queued = h.start();        // waits behind it
    await wait(200);
    const secondStop = h.stop();     // asked while the start waits: joins the first
    const [r1, r2, q1] = await Promise.all([firstStop, secondStop, queued]);
    mode("ok", "quick");
    const again = await h.start();   // and the start after it runs as ever
    await h.stop();
    check(
      "T41: a start queued behind a stop gives way to a stop asked for while it waited, and spawns nothing; the next start runs",
      r1 && r2 && q1.state === "stopped" && pids().length === beforeQueued + 1 && again.state === "connected" && living().length === 0,
      `stops answered ${r1}/${r2}; the queued start ${q1.state}; spawned ${pids().length - beforeQueued} (1 is the start after); still running ${JSON.stringify(living())}`,
    );

    // 8. An agent still there after its SIGKILL: let go of, and waited for — without blocking — by the next start.
    mode("ok", "linger");
    const recordK = join(dir, "serve-k.json");
    const k = client(20_000, { serveRecordPath: recordK, stopGraceMs: 300, killWaitMs: 300, lingerWaitMs: 10_000, signal: killDoesNotTake });
    const saidK = heard(k);
    await k.start();
    const stuck = k.pid;
    const gone = await k.stop();
    const keptRecord = recorded(recordK);
    mode("ok", "quick");
    // The kernel lets it go at last, 0.8 s in: the stand-in is ended from outside, as SIGKILL would end it.
    setTimeout(() => { if (stuck) signal(stuck, "SIGKILL"); }, 800);
    const { value: next, stallMs } = await longestStall(() => k.start());
    const fresh = k.pid;
    check(
      "T41: a stop that lets go of an agent still there after SIGKILL says it is not gone (false) and keeps its record",
      gone === false && stuck !== null && keptRecord === stuck,
      `stop answered ${gone}; pid ${stuck}; its record ${keptRecord}`,
    );
    check(
      "T41: the next start waits for it without blocking the window, reaps nothing and calls nothing an orphan of a previous run, then starts the next agent",
      next.state === "connected" && fresh !== null && fresh !== stuck && stuck !== null && !alive(stuck) && stallMs < 1_000
        && recorded(recordK) === fresh && !saidK.some((l) => /reaped an orphaned agent/.test(l.line)),
      `start ${next.state}; old pid ${stuck} ${stuck && alive(stuck) ? "alive" : "gone"}, new ${fresh}; main thread stalled ${stallMs} ms at most; record names ${recorded(recordK)}; said ${JSON.stringify(saidK.filter((l) => l.line.startsWith("[desktop]")).map((l) => l.line))}`,
    );
    check(
      "T41: with it gone, a stop says the agent is gone (true)",
      (await k.stop()) === true && living().length === 0,
      `still running ${JSON.stringify(living())}`,
    );

    // 9. One that outlasts the wait: the next start goes on beside it, and says so.
    mode("ok", "linger");
    const recordL = join(dir, "serve-l.json");
    const l = client(20_000, { serveRecordPath: recordL, stopGraceMs: 300, killWaitMs: 300, lingerWaitMs: 1_000, signal: killDoesNotTake });
    const saidL = heard(l);
    await l.start();
    const outlasting = l.pid;
    await l.stop();
    mode("ok", "quick");
    const t9 = Date.now();
    const beside = await l.start();
    const waitedMs = Date.now() - t9;
    const besidePid = l.pid;
    check(
      "T41: an agent that outlasts the wait is said, and the next one starts beside it after the wait",
      beside.state === "connected" && waitedMs >= 900 && outlasting !== null && alive(outlasting) && besidePid !== null && besidePid !== outlasting
        && saidL.some((s) => /has still not exited — starting the next one beside it/.test(s.line)),
      `start ${beside.state} after ${waitedMs} ms; old ${outlasting} ${outlasting && alive(outlasting) ? "alive" : "gone"}, new ${besidePid}`,
    );
    if (outlasting) signal(outlasting, "SIGKILL");
    await l.stop();
  } catch (err) {
    check("T41: the checks ran against a stand-in agent", false, threw(err));
  } finally {
    // Stand-ins first, so no stop below waits out a grace or a SIGKILL that does not take.
    for (const pid of living()) signal(pid, "SIGKILL");
    for (const c of clients) await c.stop().catch(() => undefined);
    for (const pid of living()) signal(pid, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
}
