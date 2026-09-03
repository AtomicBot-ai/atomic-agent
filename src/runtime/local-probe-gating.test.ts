import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentRuntime } from "./bootstrap.js";
import {
  getUserConfigPath,
  resetConfigCache,
  USER_CONFIG_DEFAULTS,
  writeUserConfigFileSync,
} from "../config/index.js";
import type { UserConfigFile } from "../config/index.js";
import { GEMMA4_PROPS } from "../llm/model-profile.fixtures.js";
import { DEFAULT_EMBEDDING_MODEL_ID } from "../local-llm/index.js";
import { FakeBrowserBackend } from "../http/test-harness.js";
import type { LogRecord } from "../tracing/structured-logger.js";

/**
 * Issue #112 — a cloud-backed session must not probe the local
 * llama-server.
 *
 * The assertions are exact request COUNTS against the two local ports,
 * not "was it called": the bug was a fixed number of probes (`/health`
 * once, `/props` once) firing on a route that never uses them, and a
 * boolean would pass again the moment one of them came back.
 */

const TEXT_PORT = "127.0.0.1:8080";
const EMBED_PORT = "127.0.0.1:19092";

interface LocalTraffic {
  /** Every URL the process asked for, in order. */
  urls: string[];
  countTo(hostPort: string, path?: string): number;
  firstIndexOf(hostPort: string, path: string): number;
  reset(): void;
  /** Flip the fake cloud provider to rate-limiting, to force a fallover. */
  rateLimitCloud(): void;
}

/**
 * Count every outbound request. Answers the local endpoints with real
 * llama.cpp shapes so the *local* control cases probe successfully —
 * a stub that failed every probe would make "zero requests" and "all
 * requests failed" indistinguishable.
 */
function installCountingFetch(): LocalTraffic {
  const urls: string[] = [];
  let cloudRateLimited = false;
  const impl: typeof fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    urls.push(url);
    if (url.includes(TEXT_PORT) || url.includes(EMBED_PORT)) {
      if (url.includes("/completion")) {
        // Answers with a 200 the client accepts as a completion (the
        // content parses to nothing useful, which is fine — the lazy
        // restore assertions are about the probes, not the reply).
        return new Response(JSON.stringify({ content: "", stop: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/props")) {
        return new Response(JSON.stringify(GEMMA4_PROPS), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/health")) {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    // A WORKING cloud provider, so a "cloud turn" is a turn the cloud
    // link actually SERVES. Answering it flatly would make the turn fail
    // before the fallback chain's local tail is ever consulted, which is
    // the one thing a zero-request assertion over cloud turns must not
    // do.
    if (url.includes("cloud.invalid") && url.includes("completions")) {
      if (cloudRateLimited) {
        // The shape that makes `runWithFallback` advance to the next
        // link rather than fail the turn.
        return new Response(JSON.stringify({ error: { message: "slow down" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          id: "c1",
          object: "chat.completion",
          created: 1,
          model: "cloudy-1",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: '{"tool":"finish","args":{"summary":"ok"}}',
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    // Everything else (analytics, update check, provider catalogues)
    // is answered flatly so no test ever reaches the network.
    return new Response("{}", {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };
  vi.stubGlobal("fetch", impl);
  return {
    urls,
    countTo: (hostPort, path) =>
      urls.filter((u) => u.includes(hostPort) && (!path || u.includes(path)))
        .length,
    firstIndexOf: (hostPort, path) =>
      urls.findIndex((u) => u.includes(hostPort) && u.includes(path)),
    reset: () => {
      urls.length = 0;
    },
    rateLimitCloud: () => {
      cloudRateLimited = true;
    },
  };
}

/** A cloud text provider that needs no network to construct. */
const CLOUD_PROVIDER = {
  id: "cloudy",
  kind: "openai-compatible" as const,
  baseUrl: "https://cloud.invalid",
  defaultChatModel: "cloudy-1",
  apiKey: "sk-test",
};

function writeConfig(stateDir: string, over: Partial<UserConfigFile>): void {
  writeUserConfigFileSync(getUserConfigPath(stateDir), {
    ...USER_CONFIG_DEFAULTS,
    // Keep the runtime off the network for everything unrelated.
    analytics: { enabled: false },
    ...over,
  });
  resetConfigCache();
}

/** The embedding half of the registry, left on the local default. */
const LOCAL_EMBED_PROVIDER = {
  id: "local-llama-embed",
  kind: "llama-server" as const,
  url: "http://127.0.0.1:19092",
};

const cloudLlm = {
  activeTextProvider: "cloudy",
  activeEmbeddingProvider: "local-llama-embed",
  providers: [CLOUD_PROVIDER, LOCAL_EMBED_PROVIDER],
  toolTransport: "auto" as const,
};

describe("issue #112 — local probe gating at CLI bootstrap", () => {
  let stateDir: string;
  let workingDir: string;
  let traffic: LocalTraffic;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-gate-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-gate-cwd-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    resetConfigCache();
    traffic = installCountingFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
    resetConfigCache();
  });

  const boot = async (logs: LogRecord[] = []) =>
    createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      handlers: { logSinks: [(record) => logs.push(record)] },
      overrides: {
        browserBackend: new FakeBrowserBackend(),
        // Unary seam only: the streaming path's SSE shape is beside the
        // point here, and the two share `prepareLink`.
        disableStreaming: true,
      },
    });

  it("makes zero local text requests with a cloud text provider", async () => {
    writeConfig(stateDir, { llm: cloudLlm });
    const logs: LogRecord[] = [];
    const runtime = await boot(logs);
    try {
      expect(traffic.countTo(TEXT_PORT)).toBe(0);
      expect(traffic.countTo(TEXT_PORT, "/health")).toBe(0);
      expect(traffic.countTo(TEXT_PORT, "/props")).toBe(0);
      // ...and says nothing alarming about the backend it skipped.
      const complaints = logs.filter(
        (r) =>
          (r.level === "warn" || r.level === "error") &&
          /llama|context window/i.test(r.message),
      );
      expect(complaints).toEqual([]);
    } finally {
      await runtime.shutdown();
    }
  });

  /**
   * Issue #112 review, F1. The gating is no longer a single latch: the
   * loop refreshes the profile again whenever a `llama-server` link
   * SERVED the previous turn, so that a sustained cloud->local fallover
   * does not freeze the profile. That arm must stay shut on a session
   * where the local link never serves — including turns 2 and 3, which a
   * boot-only assertion would never reach.
   *
   * The config is the default fallover shape: `appendLocal` defaults to
   * `true` and a `llama-server` text entry is configured, so the chain
   * really is `[cloudy, local-llama]`; the cloud link simply keeps
   * answering, and nothing behind it is touched.
   */
  it("makes zero local text requests across three cloud TURNS, not just at boot", async () => {
    writeConfig(stateDir, {
      llm: {
        ...cloudLlm,
        providers: [
          CLOUD_PROVIDER,
          { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:8080" },
          LOCAL_EMBED_PROVIDER,
        ],
      },
    });
    const runtime = await boot();
    try {
      expect(traffic.countTo(TEXT_PORT)).toBe(0);
      const session = runtime.createSession();
      for (let i = 0; i < 3; i += 1) {
        await runtime
          .executeTurn(session, `hello ${i}`, {
            maxSteps: 2,
            signal: new AbortController().signal,
          })
          .catch(() => undefined);
        // Reported with the turn index so a failure names the turn.
        expect({ turn: i, local: traffic.countTo(TEXT_PORT) }).toEqual({
          turn: i,
          local: 0,
        });
      }
      // ...and the turns really were served by the cloud link.
      expect(
        traffic.urls.filter(
          (u) => u.includes("cloud.invalid") && u.includes("completions"),
        ).length,
      ).toBe(3);
    } finally {
      await runtime.shutdown();
    }
  });

  it("still probes when the active text provider IS a llama-server link", async () => {
    // The control for the case above: same code path, local route.
    writeConfig(stateDir, {});
    const runtime = await boot();
    try {
      expect(traffic.countTo(TEXT_PORT, "/health")).toBe(1);
      expect(traffic.countTo(TEXT_PORT, "/props")).toBe(1);
    } finally {
      await runtime.shutdown();
    }
  });

  it("gates on provider KIND, not the `local-llama` id", async () => {
    // A llama-server entry under a custom id is still the local route.
    writeConfig(stateDir, {
      llm: {
        activeTextProvider: "my-box",
        activeEmbeddingProvider: "local-llama-embed",
        providers: [
          { id: "my-box", kind: "llama-server", url: "http://127.0.0.1:8080" },
          LOCAL_EMBED_PROVIDER,
        ],
        toolTransport: "auto",
      },
    });
    const runtime = await boot();
    try {
      expect(traffic.countTo(TEXT_PORT, "/health")).toBe(1);
      expect(traffic.countTo(TEXT_PORT, "/props")).toBe(1);
    } finally {
      await runtime.shutdown();
    }
  });

  it("lazily restores the local backend when the operator switches to it", async () => {
    // The whole point of deferring rather than deleting: the state boot
    // skipped has to come back before local inference, not at the next
    // process start.
    writeConfig(stateDir, {
      llm: {
        ...cloudLlm,
        providers: [
          CLOUD_PROVIDER,
          { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:8080" },
          LOCAL_EMBED_PROVIDER,
        ],
      },
    });
    const runtime = await boot();
    try {
      expect(traffic.countTo(TEXT_PORT)).toBe(0);

      // Exactly what the LLM tab does: registry first, then config.
      await runtime.providerRegistry.setActive("local-llama");
      writeConfig(stateDir, {
        llm: {
          ...cloudLlm,
          activeTextProvider: "local-llama",
          providers: [
            CLOUD_PROVIDER,
            { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:8080" },
            LOCAL_EMBED_PROVIDER,
          ],
        },
      });

      const session = runtime.createSession();
      await runtime
        .executeTurn(session, "hello", {
          maxSteps: 1,
          signal: new AbortController().signal,
        })
        .catch(() => undefined);

      // Health, profile/`/props` and the slot pool are warm before the
      // first local completion — none of which boot had done.
      expect(traffic.countTo(TEXT_PORT, "/health")).toBe(1);
      expect(traffic.countTo(TEXT_PORT, "/props")).toBe(1);
    } finally {
      await runtime.shutdown();
    }
  });

  /**
   * Issue #112 review, F1 + F7 — the fallover, end to end through a
   * booted runtime rather than at the seam.
   *
   * Boot is cloud, so the local link starts with no `/health`, no
   * `/props`, a `plain-instruct` profile and a one-slot pool. Then the
   * cloud primary starts returning 429 and `appendLocal` (default
   * `true`) routes every turn onto the llama-server link. Two things
   * have to hold, and neither was covered end-to-end before: the link is
   * warmed BEFORE its first completion, and it keeps being refreshed on
   * later turns even though the active provider never stops being cloud.
   */
  it("a cloud->local FALLOVER warms the link before it serves, turn after turn", async () => {
    writeConfig(stateDir, {
      llm: {
        ...cloudLlm,
        providers: [
          CLOUD_PROVIDER,
          { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:8080" },
          LOCAL_EMBED_PROVIDER,
        ],
      },
    });
    const runtime = await boot();
    try {
      expect(traffic.countTo(TEXT_PORT)).toBe(0);
      traffic.rateLimitCloud();
      const session = runtime.createSession();

      const turn = async (n: number) =>
        runtime
          .executeTurn(session, `hello ${n}`, {
            maxSteps: 1,
            signal: new AbortController().signal,
          })
          .catch(() => undefined);

      await turn(0);
      // The deferred boot probes were replayed by the seam...
      expect(traffic.countTo(TEXT_PORT, "/health")).toBe(1);
      expect(traffic.countTo(TEXT_PORT, "/props")).toBe(1);
      // ...and BEFORE the local link was asked to serve. Ordering is the
      // whole point: a `/props` that lands after the completion has
      // already been sent on a plain profile buys nothing.
      const props = traffic.firstIndexOf(TEXT_PORT, "/props");
      const completion = traffic.firstIndexOf(TEXT_PORT, "/completion");
      expect(completion).toBeGreaterThan(-1);
      expect(props).toBeLessThan(completion);

      // Turns 2 and 3: the profile keeps tracking the live server. The
      // active provider is still cloud, so before the F1 fix these were
      // both zero and the profile stayed frozen for the whole outage.
      await turn(1);
      expect(traffic.countTo(TEXT_PORT, "/props")).toBe(2);
      await turn(2);
      expect(traffic.countTo(TEXT_PORT, "/props")).toBe(3);
      // The restore stays one-shot: `/health` is not replayed per turn.
      expect(traffic.countTo(TEXT_PORT, "/health")).toBe(1);
    } finally {
      await runtime.shutdown();
    }
  });

  it("keeps probing local embeddings while the text route is cloud", async () => {
    writeConfig(stateDir, {
      llm: cloudLlm,
      localModels: {
        ...USER_CONFIG_DEFAULTS.localModels,
        embeddings: {
          ...USER_CONFIG_DEFAULTS.localModels.embeddings,
          enabled: true,
          modelId: DEFAULT_EMBEDDING_MODEL_ID,
        },
      },
      memory: {
        ...USER_CONFIG_DEFAULTS.memory,
        embeddings: { ...USER_CONFIG_DEFAULTS.memory.embeddings, enabled: true },
      },
    });
    const runtime = await boot();
    try {
      expect(traffic.countTo(EMBED_PORT, "/health")).toBe(1);
      expect(traffic.countTo(TEXT_PORT)).toBe(0);
    } finally {
      await runtime.shutdown();
    }
  });
});
