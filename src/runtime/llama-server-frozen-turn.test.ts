import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAgentRuntime } from "./bootstrap.js";
import {
  getUserConfigPath,
  resetConfigCache,
  USER_CONFIG_DEFAULTS,
  writeUserConfigFileSync,
} from "../config/index.js";
import { FakeBrowserBackend } from "../http/test-harness.js";
import { LLAMA3_PROPS } from "../llm/model-profile.fixtures.js";
import type { LogRecord } from "../tracing/structured-logger.js";

/**
 * A llama-server that accepts connections and never answers — frozen
 * with SIGSTOP, wedged, or any socket that only listens — used to hold
 * `run` at boot and a turn between `turn_started` and `step_started`
 * with no event and no log line: the `/props` probe on both paths
 * inherited the five-minute generation budget.
 *
 * Real sockets, real client, real agent loop. The fake server has three
 * phases, the way a supervised daemon goes through them: `hang` (accepts,
 * never answers), `down` (the supervisor killed it: every hung socket is
 * reset and the port refuses), and `up` (restarted, answers).
 */

type Phase = "hang" | "down" | "up";

interface FakeLlama {
  url: string;
  setPhase(next: Phase): Promise<void>;
  paths: string[];
}

const REPLY = JSON.stringify({ tool: "reply", args: { text: "back" } });

async function startFakeLlama(initial: Phase): Promise<{
  fake: FakeLlama;
  close: () => Promise<void>;
}> {
  let phase: Phase = initial;
  const paths: string[] = [];
  const hung = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    paths.push(req.url ?? "");
    req.resume();
    if (phase === "hang") {
      hung.add(req.socket);
      req.socket.once("close", () => hung.delete(req.socket));
      return;
    }
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const path = (req.url ?? "").split("?")[0];
    if (path === "/health") return send(200, { status: "ok" });
    if (path === "/props") return send(200, LLAMA3_PROPS);
    if (path === "/completion") {
      return send(200, {
        content: REPLY,
        stop: true,
        model: "llama-3.1-8b-instruct",
        timings: { prompt_n: 10, predicted_n: 5, predicted_per_second: 50 },
      });
    }
    // /apply-template, /slots, anything else: not built into this server.
    return send(404, { error: { code: 404, message: "File Not Found" } });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as { port: number };
  const listening = () => server.listening;
  return {
    fake: {
      url: `http://127.0.0.1:${port}`,
      paths,
      async setPhase(next) {
        if (next === "down") {
          // The supervisor's kill: every open socket is reset and the
          // port stops accepting.
          for (const socket of hung) socket.destroy();
          hung.clear();
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        } else if (!listening()) {
          await new Promise<void>((resolve) =>
            server.listen(port, "127.0.0.1", () => resolve()),
          );
        }
        phase = next;
      },
    },
    close: async () => {
      for (const socket of hung) socket.destroy();
      if (!listening()) return;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Real fetch for the fake server, a flat 404 for everything else. */
function routeFetchTo(base: string): void {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (async (input: Parameters<typeof fetch>[0], init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    if (url.startsWith(base)) return real(input, init);
    return new Response("{}", {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
}

describe("a llama-server that accepts and never answers", () => {
  let stateDir: string;
  let workingDir: string;
  let closeFake: (() => Promise<void>) | null = null;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-frozen-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-frozen-cwd-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    resetConfigCache();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeFake?.();
    closeFake = null;
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
    resetConfigCache();
  });

  async function setup(initial: Phase) {
    const { fake, close } = await startFakeLlama(initial);
    closeFake = close;
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      analytics: { enabled: false },
      // The query rewriter's own budget (10 s by default) also waits on
      // this server for a referential follow-up; it runs beside the
      // `/props` sync, so a short one leaves the probe as the long pole.
      memory: {
        ...USER_CONFIG_DEFAULTS.memory,
        retrieve: {
          ...USER_CONFIG_DEFAULTS.memory.retrieve,
          rewriter: {
            ...USER_CONFIG_DEFAULTS.memory.retrieve.rewriter,
            timeoutMs: 2_000,
          },
        },
      },
      localModels: {
        ...USER_CONFIG_DEFAULTS.localModels,
        mode: "external",
        url: fake.url,
      },
      llm: {
        activeTextProvider: "local-llama",
        activeEmbeddingProvider: "local-llama-embed",
        providers: [
          { id: "local-llama", kind: "llama-server", url: fake.url },
          {
            id: "local-llama-embed",
            kind: "llama-server",
            url: "http://127.0.0.1:19092",
          },
        ],
        toolTransport: "auto",
      },
    });
    resetConfigCache();
    routeFetchTo(fake.url);
    return fake;
  }

  function boot(
    logs: LogRecord[],
    events: Array<{ type: string; at: number }>,
  ) {
    return createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      handlers: {
        logSinks: [(record) => logs.push(record)],
        onAgentEvent: (event) => events.push({ type: event.type, at: Date.now() }),
      },
      overrides: {
        browserBackend: new FakeBrowserBackend(),
        disableStreaming: true,
      },
    });
  }

  it("does not hold boot: it continues on the plain profile with a warning", async () => {
    const fake = await setup("hang");
    const logs: LogRecord[] = [];
    const started = Date.now();
    const runtime = await boot(logs, []);
    const bootMs = Date.now() - started;
    try {
      // /health (3 s) + /props (5 s), plus construction.
      expect(bootMs).toBeLessThan(12_000);
      expect(fake.paths).toContain("/props");
      expect(logs.map((r) => r.message)).toContain(
        "model profile probe failed; using plain fallback",
      );
    } finally {
      await runtime.shutdown();
    }
  }, 30_000);

  it("reaches the step within seconds, parks while the server is gone, and finishes once it is back", async () => {
    const fake = await setup("up");
    const logs: LogRecord[] = [];
    const events: Array<{ type: string; at: number }> = [];
    const runtime = await boot(logs, events);
    try {
      const session = runtime.createSession();
      const warm = await runtime.runTurn(session, "say hi", { maxSteps: 3 });
      expect(warm.reason).toBe("reply");

      // Freeze it.
      await fake.setPhase("hang");
      events.length = 0;
      const turnStarted = Date.now();
      const turn = runtime.runTurn(warm.session, "say hi again", {
        maxSteps: 3,
      });

      // The turn-start /props refresh gives up on its own clock (5 s) and
      // the step starts; its completion then waits on the frozen server.
      const deadline = Date.now() + 8_000;
      while (
        !events.some((e) => e.type === "step_started") &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const stepStarted = events.find((e) => e.type === "step_started");
      expect(stepStarted, "step_started while the server is frozen").toBeDefined();
      expect(stepStarted!.at - turnStarted).toBeLessThan(7_000);

      // The supervisor kills it (sockets reset, port refuses) and brings
      // it back a few seconds later.
      await fake.setPhase("down");
      const killedAt = Date.now();
      const waitDeadline = Date.now() + 5_000;
      while (
        !events.some((e) => e.type === "provider_waiting") &&
        Date.now() < waitDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const waiting = events.find((e) => e.type === "provider_waiting");
      expect(waiting, "provider_waiting after the reset").toBeDefined();
      expect(waiting!.at - killedAt).toBeLessThan(5_000);

      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await fake.setPhase("up");

      const result = await turn;
      expect(result.reason).toBe("reply");
      const types = events.map((e) => e.type);
      expect(types.indexOf("step_started")).toBeLessThan(
        types.indexOf("provider_waiting"),
      );
      expect(types).toContain("provider_recovered");
    } finally {
      await runtime.shutdown();
    }
  }, 45_000);
});
