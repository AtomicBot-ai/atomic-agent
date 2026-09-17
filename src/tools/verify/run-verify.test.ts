import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AtomicAgentConfig } from "../../config/index.js";
import { defaultBrowserLauncher, type BrowserLauncher } from "./run-page-kind.js";
import { runChecks, runVerify, type VerifyRunContext } from "./run-verify.js";
import { createVerifyWorkspace } from "./verify-workspace-copy.js";

const NODE = process.execPath;

const CONFIG: Pick<AtomicAgentConfig, "browser"> = {
  browser: {
    enabled: true,
    channel: "chrome",
    headless: true,
    cdpUrl: null,
    executablePath: null,
    noSandbox: false,
    launchTimeoutMs: 20_000,
  },
};

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "atag-verify-run-"));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

function ctx(over: Partial<VerifyRunContext> = {}): VerifyRunContext {
  return { workingDir: work, config: CONFIG, ...over };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

describe("runVerify — command", () => {
  it("runs in an isolated copy, reports the exit code and output tails, and evaluates checks", async () => {
    await writeFile(join(work, "data.txt"), "hello from the workspace");
    const copies: string[] = [];
    const out = await runVerify(
      {
        kind: "command",
        cmd: NODE,
        args: ["-e", "const fs=require('fs'); process.stdout.write(fs.readFileSync('data.txt','utf8')); fs.writeFileSync('evidence.txt','x'); console.error('warned'); process.exit(3)"],
        checks: ["exit 3", 'stdout contains "workspace"', 'stderr not contains "warned"', "exit 0", "whatever"],
      },
      ctx({
        workspace: async (dir) => {
          const ws = await createVerifyWorkspace(dir);
          copies.push(ws.dir);
          return ws;
        },
      }),
    );
    expect(out.kind).toBe("command");
    expect(out.isolated).toBe(true);
    expect(out.exitCode).toBe(3);
    expect(out.ok).toBe(false);
    expect(out.stdoutTail).toBe("hello from the workspace");
    expect(out.stderrTail).toContain("warned");
    expect(out.checks?.map((c) => c.ok)).toEqual([true, true, false, false, false]);
    expect(out.checks?.[4]?.detail).toBe("unknown check");
    // Failing checks come first in the summary, after the head line.
    const lines = out.summary.split("\n");
    expect(lines[0]).toBe("verify.run command: FAILED");
    expect(lines[1]).toMatch(/^FAIL check `stderr not contains "warned"`/);
    expect(lines[2]).toMatch(/^FAIL check `exit 0`/);
    expect(lines[3]).toBe("FAIL check `whatever` — unknown check");
    expect(out.summary.length).toBeLessThanOrEqual(4_000);
    // The copy took the write; the workspace is untouched and the copy is gone.
    expect(await readdir(work)).toEqual(["data.txt"]);
    expect(copies).toHaveLength(1);
    expect(copies[0]).not.toBe(work);
    expect(existsSync(copies[0]!)).toBe(false);
  });

  it("is ok on exit 0 with every check passing, and runs a command line through the shell", async () => {
    const out = await runVerify(
      { kind: "command", cmd: `${JSON.stringify(NODE)} -e "console.log('a b')" && echo done`, checks: ["exit 0", 'stdout contains "done"'] },
      ctx(),
    );
    expect(out.ok).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.summary.split("\n")[0]).toBe("verify.run command: ok");
  });

  it("kills the process group on timeout and says so", async () => {
    const out = await runVerify(
      { kind: "command", cmd: NODE, args: ["-e", "setInterval(() => {}, 1000)"], timeoutMs: 500, checks: ["exit 0"] },
      ctx(),
    );
    expect(out.ok).toBe(false);
    expect(out.timedOut).toBe(true);
    expect(out.exitCode).toBeNull();
    expect(out.checks?.[0]?.detail).toBe("killed (timed out)");
    expect(out.summary).toContain("killed: timed out");
  });

  it("reports a command that cannot start instead of throwing", async () => {
    const out = await runVerify({ kind: "command", cmd: "atag-no-such-binary-xyz", args: ["--x"] }, ctx());
    expect(out.ok).toBe(false);
    expect(out.error).toContain("could not start");
  });

  it("refuses a cwd outside the copy and names the field", async () => {
    const out = await runVerify({ kind: "command", cmd: NODE, args: ["-v"], cwd: "../.." }, ctx());
    expect(out.ok).toBe(false);
    expect(out.error).toContain("`cwd`");
  });

  it("names the invalid argument", async () => {
    await expect(runVerify({ kind: "command" }, ctx())).rejects.toThrow("`cmd` must be a non-empty string");
    await expect(runVerify({ kind: "dance" }, ctx())).rejects.toThrow("`kind`");
    await expect(runVerify({ kind: "page" }, ctx())).rejects.toThrow("exactly one of `path` or `url`");
  });
});

describe("runVerify — service", () => {
  it("starts a server, waits for the port, sends the requests, and kills the group", async () => {
    const port = await freePort();
    const server = "const http=require('http'); http.createServer((q,s)=>{ if(q.url==='/health'){ s.end('ok') } else if (q.method==='POST'){ let b=''; q.on('data',c=>b+=c); q.on('end',()=>s.end('got '+b)) } else { s.statusCode=404; s.end('nope') } }).listen(" + port + ")";
    const out = await runVerify(
      {
        kind: "service",
        start: { cmd: NODE, args: ["-e", server] },
        ready: { port },
        requests: [
          { path: "/health", expectBody: "ok" },
          { method: "POST", path: "/echo", body: '{"a":1}', expectBody: '{"a":1}' },
          { path: "/missing", expectStatus: 404 },
          { path: "/missing" },
        ],
        checks: ["status 200"],
      },
      ctx(),
    );
    expect(out.ready).toBe(true);
    expect(out.readyMs).not.toBeNull();
    expect(out.requests?.map((r) => [r.status, r.ok])).toEqual([[200, true], [200, true], [404, true], [404, false]]);
    expect(out.requests?.[1]?.bodyHead).toBe('got {"a":1}');
    expect(out.ok).toBe(false);
    expect(out.checks?.[0]).toMatchObject({ ok: false, detail: "statuses: 200, 200, 404, 404" });
    expect(out.summary).toContain("failed requests (1)");
    // The server is gone: the port is free again.
    await expect(
      new Promise<void>((resolve, reject) => {
        const s = net.createServer();
        s.once("error", reject);
        s.listen(port, "127.0.0.1", () => s.close(() => resolve()));
      }),
    ).resolves.toBeUndefined();
  }, 30_000);

  it("reports a server that exits before it is ready", async () => {
    const port = await freePort();
    const out = await runVerify(
      { kind: "service", start: { cmd: NODE, args: ["-e", "console.error('boom'); process.exit(2)"] }, ready: { port, timeoutMs: 5_000 } },
      ctx(),
    );
    expect(out.ready).toBe(false);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("exited before it was ready");
    expect(out.stderrTail).toContain("boom");
  });
});

describe("runVerify — page", () => {
  it("fails with `no browser available` when nothing can launch — never a pass", async () => {
    await writeFile(join(work, "index.html"), "<html><body>hi</body></html>");
    const launch: BrowserLauncher = async () => {
      throw new Error("no browser available: none found");
    };
    const out = await runVerify(
      { kind: "page", path: "index.html", checks: ["no errors"] },
      ctx({ launchBrowser: launch }),
    );
    expect(out.ok).toBe(false);
    expect(out.error).toBe("no browser available: none found");
    // `no errors` over a page that never opened must not pass.
    expect(out.checks?.[0]).toMatchObject({ ok: false, detail: "not evaluated: no browser available: none found" });
    expect(out.summary).toContain("no browser available");
  });

  it("fails on a missing file before launching anything", async () => {
    let launched = false;
    const out = await runVerify(
      { kind: "page", path: "nope.html" },
      ctx({
        launchBrowser: async () => {
          launched = true;
          throw new Error("unreachable");
        },
      }),
    );
    expect(launched).toBe(false);
    expect(out.error).toBe("no such file: nope.html");
  });
});

describe("runVerify — page, real browser", () => {
  let launchable = false;
  beforeAll(async () => {
    try {
      const browser = await defaultBrowserLauncher(CONFIG)();
      await browser.close();
      launchable = true;
    } catch {
      launchable = false;
    }
  }, 60_000);

  it.runIf(process.env.ATAG_VERIFY_PAGE_TEST !== "0")("drives a local page: script, probes, errors, missing selectors", async (test) => {
    if (!launchable) {
      test.skip();
      return;
    }
    await writeFile(
      join(work, "index.html"),
      `<html><body><button id="launch">go</button>
<script>
  window.game = { score: 0, launched: false };
  document.getElementById("launch").addEventListener("click", () => { window.game.launched = true; });
  document.getElementById("does-not-exist");
  document.querySelector(".nope");
  setInterval(() => { window.game.score += 1; }, 50);
  console.warn("just a warning");
</script>
<script>throw new Error("boom on load");</script>
</body></html>`,
    );
    const out = await runVerify(
      {
        kind: "page",
        path: "index.html",
        script: [{ action: "click", selector: "#launch" }, { action: "wait", ms: 100 }],
        seconds: 1,
        probes: [{ name: "score", expr: "window.game.score" }, { name: "launched", expr: "window.game.launched" }],
        checks: ["no errors", "missing selectors 2", "probe score increases", "probe launched stays true"],
      },
      ctx(),
    );
    expect(out.errors).toEqual(["Error: boom on load"]);
    expect(out.consoleWarnings).toEqual(["just a warning"]);
    expect(out.missingSelectors).toEqual(["# does-not-exist", "querySelector .nope"]);
    expect(out.ok).toBe(false);
    expect(out.checks?.map((c) => c.ok)).toEqual([false, true, true, true]);
    const score = out.probes?.score ?? [];
    expect(score.length).toBeGreaterThan(1);
    expect(score.length).toBeLessThanOrEqual(40);
    expect(out.summary).toContain("uncaught errors (1)");
  }, 60_000);
});

describe("runChecks", () => {
  it("runs every spec in order and is ok only when all are", async () => {
    const out = await runChecks(
      [
        { kind: "command", cmd: NODE, args: ["-e", "process.exit(0)"], checks: ["exit 0"] },
        { kind: "command", cmd: NODE, args: ["-e", "process.exit(1)"], checks: ["exit 0"] },
        { kind: "nonsense" },
      ],
      ctx(),
    );
    expect(out.ok).toBe(false);
    expect(out.results.map((r) => r.ok)).toEqual([true, false, false]);
    expect(out.results[2]?.error).toContain("`kind`");
    const good = await runChecks([{ kind: "command", cmd: NODE, args: ["-v"], checks: ["exit 0"] }], ctx());
    expect(good.ok).toBe(true);
  });
});
