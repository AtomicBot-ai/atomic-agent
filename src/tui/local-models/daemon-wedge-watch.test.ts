import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { DaemonSupervisor } from "./daemon-supervisor.js";
import {
  probeEndpoint,
  processingFingerprint,
  WEDGE_SILENCE_MS,
  WEDGE_STALL_MS,
  WedgeWatch,
  type ProbeAnswer,
} from "./daemon-wedge-watch.js";

const silent: ProbeAnswer = { answered: false };
const ok: ProbeAnswer = { answered: true };
const slot = (task: number, processed: number, decoded: number, processing = true) => ({
  answered: true as const,
  slots: [
    {
      id: 0,
      id_task: task,
      is_processing: processing,
      n_prompt_tokens_processed: processed,
      next_token: [{ n_decoded: decoded }],
    },
  ],
});

describe("WedgeWatch — silent", () => {
  it("a SIGSTOPped server (nothing answers) is wedged after the silence budget, not before", () => {
    const w = new WedgeWatch();
    expect(w.observe({ at: 0, health: ok, slots: ok })).toBeNull();
    expect(w.observe({ at: WEDGE_SILENCE_MS - 1, health: silent, slots: silent })).toBeNull();
    expect(w.observe({ at: WEDGE_SILENCE_MS, health: silent, slots: silent })).toBe(
      "the model server stopped answering (90 s without a reply to /health or /slots)",
    );
  });

  it("a busy server — /slots hanging through a long decode, /health answering — is never wedged", () => {
    const w = new WedgeWatch();
    for (let t = 0; t <= 30 * 60_000; t += 3_000) {
      expect(w.observe({ at: t, health: ok, slots: silent })).toBeNull();
    }
  });

  it("any answer resets the silence", () => {
    const w = new WedgeWatch();
    w.observe({ at: 0, health: silent, slots: silent });
    w.observe({ at: 80_000, health: silent, slots: ok });
    expect(w.observe({ at: 160_000, health: silent, slots: silent })).toBeNull();
    expect(w.observe({ at: 170_000, health: silent, slots: silent })).not.toBeNull();
  });

  it("reset() forgets the record, so a fresh daemon gets a whole budget", () => {
    const w = new WedgeWatch();
    w.observe({ at: 0, health: silent, slots: silent });
    w.reset();
    expect(w.observe({ at: WEDGE_SILENCE_MS + 5, health: silent, slots: silent })).toBeNull();
  });
});

describe("WedgeWatch — stalled", () => {
  it("a processing slot with frozen counters is stuck after the stall budget", () => {
    const w = new WedgeWatch();
    expect(w.observe({ at: 0, health: ok, slots: slot(3181, 1774, 0) })).toBeNull();
    expect(w.observe({ at: WEDGE_STALL_MS - 1, health: ok, slots: slot(3181, 1774, 0) })).toBeNull();
    expect(w.observe({ at: WEDGE_STALL_MS, health: ok, slots: slot(3181, 1774, 0) })).toBe(
      "the model server is stuck — a slot has shown the same progress for 120 s",
    );
  });

  it("a slow prompt eval whose counters move between answers is never stuck", () => {
    const w = new WedgeWatch();
    // One answer per 200 s ubatch (CPU, big model), /slots silent in between.
    for (let i = 0; i < 20; i += 1) {
      expect(w.observe({ at: i * 200_000, health: ok, slots: slot(7, 1024 * i, 0) })).toBeNull();
      expect(w.observe({ at: i * 200_000 + 100_000, health: ok, slots: silent })).toBeNull();
    }
  });

  it("an idle server, or a new task, is not a stall", () => {
    const w = new WedgeWatch();
    w.observe({ at: 0, health: ok, slots: slot(1, 10, 5, false) });
    expect(w.observe({ at: 10 * WEDGE_STALL_MS, health: ok, slots: slot(1, 10, 5, false) })).toBeNull();
    w.observe({ at: 0, health: ok, slots: slot(1, 10, 5) });
    expect(w.observe({ at: WEDGE_STALL_MS, health: ok, slots: slot(2, 10, 5) })).toBeNull();
  });

  it("a build without the counters is never judged", () => {
    expect(processingFingerprint([{ id: 0, id_task: 1, is_processing: true }])).toBeNull();
    expect(processingFingerprint("nope")).toBeNull();
    expect(processingFingerprint([{ id: 0, id_task: 1, is_processing: true, n_decoded: 3 }])).toBe("0:1:undefined:3");
  });
});

describe("probeEndpoint", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) {
      s.closeAllConnections();
      await new Promise((r) => s.close(() => r(null)));
    }
  });

  async function serve(handler: Parameters<typeof createServer>[1]): Promise<number> {
    const s = createServer(handler);
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return (s.address() as AddressInfo).port;
  }

  it("a 404 is an answer; a server that never replies is not", async () => {
    const notFound = await serve((_q, res) => {
      res.writeHead(404);
      res.end();
    });
    expect(await probeEndpoint(`http://127.0.0.1:${notFound}/slots`, 500)).toEqual({ answered: true, slots: undefined });
    const hung = await serve(() => {});
    expect(await probeEndpoint(`http://127.0.0.1:${hung}/health`, 200)).toEqual({ answered: false });
  });

  it("reads the slots body", async () => {
    const port = await serve((_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ id: 0, is_processing: false }]));
    });
    expect(await probeEndpoint(`http://127.0.0.1:${port}/slots`, 500)).toEqual({
      answered: true,
      slots: [{ id: 0, is_processing: false }],
    });
  });
});

describe("DaemonSupervisor + wedge", () => {
  it("recovers a live but wedged daemon, and resets the watch after a start", async () => {
    let now = 10_000_000;
    let restarts = 0;
    let resets = 0;
    let wedged: string | null = null;
    const lines: string[] = [];
    const sup = new DaemonSupervisor(
      {
        enabled: () => true,
        owns: () => true,
        pidAlive: async () => true,
        restart: async () => {
          restarts += 1;
          return true;
        },
        say: (l) => lines.push(l),
        describeFault: () => null,
        checkWedge: async () => wedged,
        resetWedge: () => {
          resets += 1;
        },
        now: () => now,
      },
      1_000_000,
    );
    now += 10 * 60_000;
    await sup.tick();
    expect(restarts).toBe(0);
    wedged = "the model server stopped answering (91 s without a reply to /health or /slots)";
    await sup.tick();
    expect(restarts).toBe(1);
    expect(resets).toBeGreaterThanOrEqual(1);
    expect(lines).toEqual([
      "local-llm: the model server stopped answering (91 s without a reply to /health or /slots) — restarting it (auto-restart)",
    ]);
  });
});
