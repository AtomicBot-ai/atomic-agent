import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

// ATO-1086: the tripwire that proves "zero requests leave the machine" in
// the offline smoke (scripts/smoke-e2e.mjs). Each case runs a real Node
// child with the preload and checks the log, and that loopback still works.
// Nothing reaches the network: every remote attempt fails inside the child.

const PRELOAD = join(import.meta.dirname, "net-intercept-preload.mjs");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Attempt {
  kind: string;
  host: string;
  port: number | null;
}

function runChild(code: string, viaNodeOptions = false): Promise<{ stdout: string; attempts: Attempt[] }> {
  const dir = mkdtempSync(join(tmpdir(), "aa-egress-"));
  dirs.push(dir);
  const log = join(dir, "egress.ndjson");
  const flag = `--import=${pathToFileURL(PRELOAD).href}`;
  const env = { PATH: process.env.PATH ?? "", ATOMIC_AGENT_NET_INTERCEPT_LOG: log, ...(viaNodeOptions ? { NODE_OPTIONS: flag } : {}) };
  const args = viaNodeOptions ? ["-e", code] : [flag, "-e", code];
  return new Promise((resolveRun, rejectRun) => {
    execFile(process.execPath, args, { env, timeout: 20_000 }, (err, stdout, stderr) => {
      if (err) {
        rejectRun(new Error(`${err.message}\n${stderr}`));
        return;
      }
      const attempts = existsSync(log)
        ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Attempt)
        : [];
      resolveRun({ stdout, attempts });
    });
  });
}

const LOCAL_SERVER = `
const http = require("node:http");
const srv = http.createServer((q, r) => r.end("local-ok")).listen(0, "127.0.0.1");
const ready = new Promise((r) => srv.once("listening", r));
`;

describe("network tripwire preload", () => {
  it("blocks and logs fetch, https, raw TCP, DNS and UDP to remote hosts", async () => {
    const { stdout, attempts } = await runChild(`
      const https = require("node:https"), net = require("node:net"), dns = require("node:dns"), dgram = require("node:dgram");
      (async () => {
        const out = [];
        try { await fetch("https://example.com/"); out.push("fetch:passed"); } catch (e) { out.push("fetch:" + (e.cause?.code ?? e.message)); }
        await new Promise((r) => https.get("https://api.openai.com/v1/models", () => { out.push("https:passed"); r(); }).on("error", (e) => { out.push("https:" + e.code); r(); }));
        await new Promise((r) => net.connect(443, "1.1.1.1").on("connect", () => { out.push("tcp:passed"); r(); }).on("error", (e) => { out.push("tcp:" + e.code); r(); }));
        await new Promise((r) => dns.lookup("us.i.posthog.com", (e) => { out.push("dns:" + (e?.code ?? "passed")); r(); }));
        try { await dns.promises.resolve4("o1.ingest.sentry.io"); out.push("dnsp:passed"); } catch (e) { out.push("dnsp:" + e.code); }
        const s = dgram.createSocket("udp4");
        await new Promise((r) => s.send("x", 53, "8.8.8.8", (e) => { out.push("udp:" + (e?.code ?? "passed")); r(); }));
        s.close();
        console.log(out.join(","));
      })();
    `);
    expect(stdout.trim().split(",")).toEqual(["fetch:ECONNREFUSED", expect.stringMatching(/^https:E(CONNREFUSED|NOTFOUND)$/), "tcp:ECONNREFUSED", "dns:ENOTFOUND", "dnsp:ENOTFOUND", "udp:ECONNREFUSED"]);
    const hosts = attempts.map((a) => a.host);
    for (const host of ["example.com", "api.openai.com", "1.1.1.1", "us.i.posthog.com", "o1.ingest.sentry.io", "8.8.8.8"]) {
      expect(hosts, host).toContain(host);
    }
    expect(attempts.find((a) => a.host === "8.8.8.8")).toMatchObject({ kind: "udp", port: 53 });
  });

  it("lets loopback through: 127.0.0.1, localhost and ::1-mapped", async () => {
    const { stdout, attempts } = await runChild(`${LOCAL_SERVER}
      (async () => {
        await ready;
        const port = srv.address().port;
        const a = await (await fetch("http://127.0.0.1:" + port + "/")).text();
        const b = await (await fetch("http://localhost:" + port + "/")).text();
        console.log(a + "," + b);
        srv.close();
      })();
    `);
    expect(stdout.trim()).toBe("local-ok,local-ok");
    expect(attempts).toEqual([]);
  });

  it("reaches Node grandchildren when passed through NODE_OPTIONS", async () => {
    const { stdout, attempts } = await runChild(`
      const { execFileSync } = require("node:child_process");
      const out = execFileSync(process.execPath, ["-e", "fetch('https://example.net/').then(() => console.log('passed'), (e) => console.log(e.cause?.code ?? e.message))"], { encoding: "utf8" });
      console.log(out.trim());
    `, true);
    expect(stdout.trim()).toBe("ECONNREFUSED");
    expect(attempts.map((a) => a.host)).toContain("example.net");
  });
});
