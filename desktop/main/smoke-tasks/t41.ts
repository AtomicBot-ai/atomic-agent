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
 * Nothing here touches the app's own agent or its serve.json. The checks run
 * a second AgentClient against a stand-in agent: a small HTTP server that
 * answers /health and holds /api/events open as `atag serve` does, started
 * through a shell script whose command line reads like the agent's (the
 * reaper recognises it). What it does when it boots and when it is sent
 * SIGTERM is set per check: "linger" ignores SIGTERM, as an agent whose
 * scheduler waits on a task's turn does, so only the SIGKILL ends it. Every
 * stand-in writes its pid down; the checks count them, and end any that is
 * left — never with a signal to pid 0 or 1.
 */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentClient, type AgentStatus } from "../agent-client.js";

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

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

/* `atag serve`, as far as the AgentClient can tell. `boot`: ok (listens at
   once), slow (listens after 6 s), never, crash (exits with 3 shortly after it
   answers). `term`: quick (exits on SIGTERM), linger (ignores it). */
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
const srv = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200, {"content-type": "application/json"}); res.end(JSON.stringify({status: "ok", workingDir: dir})); return; }
  if (req.url === "/api/events") { res.writeHead(200, {"content-type": "text/event-stream"}); res.write(": open\\n\\n"); return; }
  res.writeHead(404); res.end();
});
const listen = () => srv.listen(port, "127.0.0.1");
if (boot === "slow") setTimeout(listen, 6000);
else if (boot !== "never") listen();
if (boot === "crash") setTimeout(() => process.exit(3), 1500);
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
  const mode = (boot: string, term: string) => {
    writeFileSync(join(dir, "boot"), boot);
    writeFileSync(join(dir, "term"), term);
  };
  const pids = (): number[] => {
    try { return readdirSync(join(dir, "pids")).map(Number).filter((p) => p > 1); } catch { return []; }
  };
  const living = () => pids().filter(alive);
  const recorded = (): number | null => {
    try { return (JSON.parse(readFileSync(record, "utf8")) as { pid?: number }).pid ?? null; } catch { return null; }
  };
  mkdirSync(join(dir, "pids"), { recursive: true });

  const clients: AgentClient[] = [];
  const client = (healthBudgetMs = 20_000) => {
    const c = new AgentClient(dir, { binary: () => bin, serveRecordPath: record, healthBudgetMs });
    clients.push(c);
    return c;
  };
  const watch = (c: AgentClient) => {
    const seen: Seen[] = [];
    c.on("status", (s: AgentStatus) => seen.push({ state: s.state, error: s.error }));
    return seen;
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
    mode("ok", "quick");
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
  } catch (err) {
    check("T41: the checks ran against a stand-in agent", false, threw(err));
  } finally {
    for (const c of clients) await c.stop().catch(() => undefined);
    for (const pid of living()) signal(pid, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
}
