import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { probeLlamaHealth } from "../local-llm/server/daemon-lifecycle.js";
import { LlmHealthPoller } from "../tui/llm-health/llm-health-poller.js";
import type { TuiAction } from "../tui/tui-action.js";
import { buildGrammar } from "./grammar/build-grammar.js";
import {
  LlamaServerClient,
  LlamaServerError,
  PROBE_TIMEOUT_MS,
} from "./llama-server-client.js";
import { checkLlamaServer } from "./llama-server-health.js";
import { ModelProfileManager } from "./model-profile-manager.js";
import { QWEN3_PROPS } from "./model-profile.fixtures.js";
import { GEMMA4_THINK_PROFILE } from "./model-profile.js";
import { describeImageViaLlamaServer } from "./provider/llama-server/llama-server-vision.js";
import { ServerTemplateRenderer } from "./provider/llama-server/server-template-renderer.js";

/**
 * Every request the agent makes to llama-server outside the streamed
 * completion must end on its own clock. Each case below points the real
 * code at a real socket that accepts the request and then never answers
 * (the shape of a llama-server frozen with SIGSTOP, or any process that
 * only listens) and asserts the call settles within its deadline.
 */

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function startServer(handler: Handler) {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url ?? "");
    req.resume();
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, port, paths };
}

/** Accepts every request and never answers it. */
const silent: Handler = () => {};

/** Headers and one byte of body, then nothing: `fetch` has resolved. */
const headersThenStall: Handler = (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.write(" ");
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Settles with "hung" when `promise` has not settled within `ms`. */
async function within(promise: Promise<unknown>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => "settled" as const,
        () => "settled" as const,
      ),
      new Promise<"hung">((resolve) => {
        timer = setTimeout(() => resolve("hung"), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("GET /props (LlamaServerClient.fetchProps)", () => {
  it("gives up on a silent server within PROBE_TIMEOUT_MS, not the generation budget", async () => {
    const server = await startServer(silent);
    // A generation budget far past the test's life: the probe must not
    // inherit it.
    const client = new LlamaServerClient({
      baseUrl: server.url,
      requestTimeoutMs: 600_000,
    });
    const started = Date.now();
    const call = client.fetchProps();
    expect(await within(call, 7_000)).toBe("settled");
    expect(PROBE_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    const err = await call.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlamaServerError);
    expect((err as LlamaServerError).timedOut).toBe(true);
    expect((err as LlamaServerError).message).toContain("/props");
    expect(Date.now() - started).toBeGreaterThanOrEqual(PROBE_TIMEOUT_MS - 50);
  });

  it("gives up on a body that never finishes", async () => {
    const server = await startServer(headersThenStall);
    const client = new LlamaServerClient({
      baseUrl: server.url,
      requestTimeoutMs: 600_000,
      probeTimeoutMs: 300,
    });
    const call = client.fetchProps();
    expect(await within(call, 3_000)).toBe("settled");
    await expect(call).rejects.toBeInstanceOf(LlamaServerError);
  });
});

describe("POST /apply-template (LlamaServerClient.applyTemplate)", () => {
  it("gives up on a silent server, and the renderer falls back to the raw prompt", async () => {
    const server = await startServer(silent);
    const client = new LlamaServerClient({
      baseUrl: server.url,
      requestTimeoutMs: 600_000,
      probeTimeoutMs: 300,
    });
    const warn = vi.fn();
    const renderer = new ServerTemplateRenderer({
      applyTemplate: (messages, kwargs) =>
        client.applyTemplate(messages, kwargs),
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as never,
    });
    const render = renderer.render(
      {
        system: "sys",
        user: "hello",
        prefixHash: "h1",
        enableThinking: undefined,
      } as never,
      "m",
    );
    expect(await within(render, 3_000)).toBe("settled");
    await expect(render).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "chat template render failed; sending the raw prompt for this step",
      expect.objectContaining({
        error: expect.stringContaining("/apply-template"),
      }),
    );
  });
});

describe("GET /slots (LlamaServerClient.fetchSlots)", () => {
  it("gives up on a silent server within its poll deadline", async () => {
    const server = await startServer(silent);
    const client = new LlamaServerClient({
      baseUrl: server.url,
      slotsPollTimeoutMs: 300,
    });
    const call = client.fetchSlots();
    expect(await within(call, 3_000)).toBe("settled");
    await expect(call).rejects.toBeDefined();
  });
});

describe("ModelProfileManager.refresh against a silent server", () => {
  it("returns within the probe deadline, keeps the prior profile, warns once, and recovers", async () => {
    let answering = false;
    const server = await startServer((req, res) => {
      if (!answering) return;
      if (req.url === "/props") json(res, 200, QWEN3_PROPS);
      else json(res, 404, {});
    });
    const client = new LlamaServerClient({
      baseUrl: server.url,
      requestTimeoutMs: 600_000,
      probeTimeoutMs: 300,
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const manager = new ModelProfileManager({
      llama: client,
      initialProfile: GEMMA4_THINK_PROFILE,
      initialGrammar: await buildGrammar(GEMMA4_THINK_PROFILE),
      initialModelId: "gemma-4-it",
      readPrefixReuse: async () => null,
      logger: logger as never,
    });

    const first = manager.refresh();
    expect(await within(first, 3_000)).toBe("settled");
    await expect(first).resolves.toMatchObject({
      profileChanged: false,
      profileId: "gemma4-think",
      modelId: "gemma-4-it",
    });
    const second = manager.refresh();
    expect(await within(second, 3_000)).toBe("settled");

    // Two failures, one warning: a server that stays down must not
    // repeat it at every turn start.
    const warned = logger.warn.mock.calls.filter(
      ([message]) =>
        message === "model profile refresh failed; keeping prior profile",
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]![1]).toMatchObject({
      error: expect.stringContaining("/props"),
      profile: "gemma4-think",
    });

    answering = true;
    const third = await manager.refresh();
    expect(third.profileChanged).toBe(true);
    expect(third.profileId).toBe(manager.getProfile().id);
    expect(logger.info).toHaveBeenCalledWith(
      "model profile refresh recovered",
      expect.anything(),
    );
  });
});

describe("GET /health, /v1/models and the guarded /props (checkLlamaServer)", () => {
  it("reports a silent server unreachable within its timeout", async () => {
    const server = await startServer(silent);
    const call = checkLlamaServer({
      url: server.url,
      retries: 0,
      timeoutMs: 300,
    });
    expect(await within(call, 3_000)).toBe("settled");
    await expect(call).resolves.toMatchObject({ reachable: false });
  });

  it("keeps a passing /health when the guarded /props never answers", async () => {
    const server = await startServer((req, res) => {
      if (req.url === "/health") json(res, 200, { status: "ok" });
      // /props: silent
    });
    const call = checkLlamaServer({
      url: server.url,
      retries: 0,
      timeoutMs: 300,
      verifyAuth: true,
    });
    expect(await within(call, 3_000)).toBe("settled");
    await expect(call).resolves.toMatchObject({
      reachable: true,
      kind: "llama-server",
    });
  });

  it("gives up on /v1/models when /health 404s and the follow-up is silent", async () => {
    const server = await startServer((req, res) => {
      if (req.url === "/health") json(res, 404, {});
      // /v1/models: silent
    });
    const call = checkLlamaServer({
      url: server.url,
      retries: 0,
      timeoutMs: 300,
    });
    expect(await within(call, 3_000)).toBe("settled");
    await expect(call).resolves.toMatchObject({ reachable: false });
    expect(server.paths).toContain("/v1/models");
  });
});

describe("managed daemon /health (probeLlamaHealth)", () => {
  it("reads a silent daemon as down", async () => {
    const server = await startServer(silent);
    const call = probeLlamaHealth(server.port);
    expect(await within(call, 4_000)).toBe("settled");
    await expect(call).resolves.toBe("down");
  });
});

describe("TUI footer poller (/health + /props label)", () => {
  it("keeps polling when /props never answers", async () => {
    const server = await startServer((req, res) => {
      if (req.url === "/health") json(res, 200, { status: "ok" });
      // /props: silent
    });
    const actions: TuiAction[] = [];
    const poller = new LlmHealthPoller(
      { emit: (action) => actions.push(action) },
      server.url,
      100,
    );
    poller.start();
    try {
      const deadline = Date.now() + 6_000;
      while (
        server.paths.filter((p) => p === "/health").length < 2 &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(
        server.paths.filter((p) => p === "/health").length,
      ).toBeGreaterThanOrEqual(2);
      expect(
        actions.some(
          (a) =>
            a.type === "llm_health_updated" &&
            (a as { status?: string }).status === "healthy",
        ),
      ).toBe(true);
    } finally {
      poller.stop();
    }
  });
});

describe("vision.describe (POST /v1/chat/completions)", () => {
  it("gives up on a body that never finishes", async () => {
    const server = await startServer(headersThenStall);
    const call = describeImageViaLlamaServer({
      request: {
        prompt: "what is this",
        images: [{ id: "1", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }],
      } as never,
      baseUrl: server.url,
      maxImageBytes: 1_000,
      maxImagesPerCall: 1,
      requestTimeoutMs: 300,
      fetchImpl: fetch,
    });
    expect(await within(call, 3_000)).toBe("settled");
    await expect(call).rejects.toThrow(/vision request failed/);
  });
});
