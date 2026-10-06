import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  describeReclaim,
  isPortOpen,
  reclaimManagedPort,
  type ReclaimDeps,
  type ReclaimRequest,
} from "./port-reclaim.js";
import type { PortHolder } from "./port-holder.js";

const OWN = "/home/op/.atomic-agent/models";
const QA = "/tmp/aa-qa-before/models";

const req: ReclaimRequest = {
  port: 19091,
  role: "chat",
  ownDataDir: OWN,
  alias: "qwen-3.8-27b-uncensored",
  avoidPorts: [19092],
};

function deps(over: Partial<ReclaimDeps> & { holder?: PortHolder | null; open?: Set<number> }): ReclaimDeps & {
  stopped: number[];
  pidFiles: Array<[string, string, number]>;
} {
  const open = over.open ?? new Set([19091]);
  const stopped: number[] = [];
  const pidFiles: Array<[string, string, number]> = [];
  return {
    findHolder: async () => (over.holder === undefined ? null : over.holder),
    servedModels: async () => null,
    stateDirInUse: async () => false,
    liveSessions: () => false,
    stopProcess: async (pid) => {
      stopped.push(pid);
      open.delete(req.port);
    },
    portOpen: async (p) => open.has(p),
    writePidFile: (d, role, pid) => pidFiles.push([d, role, pid]),
    samePath: (a, b) => a === b,
    waitMs: 50,
    ...over,
    stopped,
    pidFiles,
  };
}

const holder = (dir: string | null, pid = 46051): PortHolder => ({
  pid,
  executable: dir ? `${dir}/backend/llama-server` : "/Applications/Other.app/llama-server",
  atagDataDir: dir,
});

describe("reclaimManagedPort", () => {
  it("does nothing on a free port", async () => {
    const d = deps({ open: new Set() });
    expect(await reclaimManagedPort(req, d)).toEqual({ kind: "free" });
    expect(d.stopped).toEqual([]);
  });

  it("stops another state dir's leftover that nothing of that dir is using (the /tmp/aa-qa-before case)", async () => {
    const d = deps({ holder: holder(QA) });
    const out = await reclaimManagedPort(req, d);
    expect(out).toMatchObject({ kind: "stopped", pid: 46051 });
    expect(d.stopped).toEqual([46051]);
    expect(describeReclaim(out, "chat server", 19091)).toBe(
      `local-llm: chat server — stopped a leftover llama-server pid 46051 (llama-server) — nothing of ${QA} is running`,
    );
  });

  it("never stops another state dir's server while that dir is in use — by a session marker or an open sessions.sqlite", async () => {
    for (const over of [{ liveSessions: () => true }, { stateDirInUse: async () => true }]) {
      const d = deps({ holder: holder(QA), ...over });
      const out = await reclaimManagedPort(req, d);
      expect(out).toMatchObject({ kind: "moved", port: 19093 });
      expect(d.stopped).toEqual([]);
    }
  });

  it("never stops a server that is not atomic-agent's; moves past the embedding port", async () => {
    const d = deps({ holder: holder(null) });
    const out = await reclaimManagedPort(req, d);
    expect(out).toEqual({
      kind: "moved",
      port: 19093,
      why: "port 19091 is held by pid 46051 (llama-server), which is not an atomic-agent server",
    });
    expect(d.stopped).toEqual([]);
    expect(describeReclaim(out, "chat server", 19091)).toBe(
      "local-llm: chat server on port 19093 (saved to config) — port 19091 is held by pid 46051 (llama-server), which is not an atomic-agent server",
    );
  });

  it("never stops a holder it cannot identify", async () => {
    const d = deps({ holder: null });
    expect(await reclaimManagedPort(req, d)).toMatchObject({ kind: "moved", port: 19093 });
    expect(d.stopped).toEqual([]);
  });

  it("adopts our own server when it already serves the model, writing its pid", async () => {
    const d = deps({ holder: holder(OWN, 61655), servedModels: async () => ["qwen-3.8-27b-uncensored"] });
    expect(await reclaimManagedPort(req, d)).toEqual({ kind: "adopted", pid: 61655 });
    expect(d.pidFiles).toEqual([[OWN, "chat", 61655]]);
    expect(d.stopped).toEqual([]);
  });

  it("stops our own server when it serves another model", async () => {
    const d = deps({ holder: holder(OWN, 61655), servedModels: async () => ["gemma-4-12b"] });
    const out = await reclaimManagedPort(req, d);
    expect(out).toMatchObject({ kind: "stopped", pid: 61655 });
    expect((out as { why: string }).why).toContain("it served gemma-4-12b, not qwen-3.8-27b-uncensored");
  });

  it("moves when a stopped holder does not let go of the port", async () => {
    const d = deps({ holder: holder(QA), stopProcess: async () => {} });
    const out = await reclaimManagedPort(req, d);
    expect(out).toMatchObject({ kind: "moved", port: 19093 });
    expect((out as { why: string }).why).toContain("but it did not release the port");
  });

  it("skips ports that are also taken", async () => {
    const d = deps({ holder: holder(null), open: new Set([19091, 19093, 19094]) });
    expect(await reclaimManagedPort(req, d)).toMatchObject({ kind: "moved", port: 19095 });
  });

  it("the embedding role writes the embedding pid file", async () => {
    const d = deps({ holder: holder(OWN, 5), servedModels: async () => ["nomic-embed-text-v1.5"] });
    await reclaimManagedPort({ ...req, role: "embedding", port: 19091, alias: "nomic-embed-text-v1.5" }, d);
    expect(d.pidFiles).toEqual([[OWN, "embedding", 5]]);
  });
});

describe("isPortOpen", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
    vi.unstubAllGlobals();
  });

  it("a bare TCP listener (no HTTP at all) is open; a closed port is not", async () => {
    // Accepts and hangs up: speaks no HTTP, but holds the port.
    const s = createServer((sock) => sock.destroy());
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const port = (s.address() as AddressInfo).port;
    expect(await isPortOpen(port)).toBe(true);
    await new Promise((r) => s.close(() => r(null)));
    servers.length = 0;
    expect(await isPortOpen(port)).toBe(false);
  });
});
