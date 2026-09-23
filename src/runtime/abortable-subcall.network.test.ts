import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { LlmStreamParams } from "../agent/step-executor.js";
import { ProviderFallbackChain } from "../llm/fallback/index.js";
import { DEFAULT_FALLBACK_TIMING } from "../llm/fallback/fallback-config.js";
import { LlamaServerClient } from "../llm/llama-server-client.js";
import { QWEN_THINK_PROFILE } from "../llm/model-profile.js";
import {
  fakeAnswer,
  fakeProvider,
} from "../llm/provider/fake-provider.fixture.js";
import { LlamaServerProvider } from "../llm/provider/llama-server/llama-server-provider.js";
import type { LlmProvider } from "../llm/provider/llm-provider.js";
import { OpenAiProvider } from "../llm/provider/openai/openai-provider.js";
import {
  createLinkGeneratorRunner,
  type LinkGeneratorInput,
  type LinkGeneratorLlmComplete,
  type LinkGeneratorRunnerDeps,
} from "../memory/links/link-generator-runner.js";
import { abortableSubcall } from "./abortable-subcall.js";
import { createFallbackCompleter } from "./llm-fallback-seam.js";

/**
 * End to end over a real socket: a memory sub-call runner whose timeout
 * fires must close the HTTP request it started — not merely stop waiting
 * for it — and the abandoned request must not advance the fallback chain.
 *
 * Wiring mirrors bootstrap: link-generator runner → `abortableSubcall`
 * (bootstrap's link-gen request shape) → `createFallbackCompleter` → a
 * real provider pointed at a local server that never finishes answering.
 */

type Mode = "silent" | "headers-then-stall";
type Kind = "openai" | "llama-server";

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

/** A server that accepts the request and never completes the response. */
async function startStallingServer(mode: Mode) {
  let requests = 0;
  let closedSockets = 0;
  const server = createServer((req, res) => {
    requests += 1;
    req.socket.once("close", () => {
      closedSockets += 1;
    });
    req.resume();
    if (mode === "headers-then-stall") {
      // Headers plus a byte of body, then nothing: `fetch` has resolved,
      // so only a cancelled body read can let go of this socket.
      res.writeHead(200, { "content-type": "application/json" });
      res.write(" ");
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => requests,
    closedSockets: () => closedSockets,
  };
}

function providerFor(kind: Kind, url: string): LlmProvider {
  if (kind === "openai") {
    return new OpenAiProvider({
      id: "primary",
      baseUrl: url,
      apiKey: "test-key",
      defaultChatModel: "test-model",
    });
  }
  return new LlamaServerProvider(
    new LlamaServerClient({ baseUrl: url, completionRetries: 1 }),
    {
      id: "primary",
      getProfile: () => QWEN_THINK_PROFILE,
      visionEnabledByConfig: false,
      visionAutoDetect: false,
      maxImageBytes: 1,
      maxImagesPerCall: 1,
      baseUrlOverride: url,
    },
  );
}

/** Polls `predicate` until it holds or `ms` elapses. */
async function eventually(predicate: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

/** Settles with "hung" when `promise` has not settled within `ms`. */
function within(promise: Promise<unknown>, ms: number) {
  return Promise.race([
    promise.then(() => "settled" as const),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), ms)),
  ]);
}

const INPUT: LinkGeneratorInput = {
  sessionId: "s1",
  userMessage: "where did we put the deploy notes?",
  assistantReply: "In the ops wiki, next to the runbook.",
  candidates: [
    { id: "1", body: "deploy notes live in the ops wiki" },
    { id: "2", body: "the runbook covers rollbacks" },
  ] as unknown as LinkGeneratorInput["candidates"],
};

const CASES: ReadonlyArray<{ kind: Kind; mode: Mode }> = [
  { kind: "openai", mode: "silent" },
  { kind: "openai", mode: "headers-then-stall" },
  { kind: "llama-server", mode: "silent" },
  { kind: "llama-server", mode: "headers-then-stall" },
];

describe("a timed-out memory sub-call", () => {
  for (const { kind, mode } of CASES) {
    it(`closes its ${kind} request (${mode}) and leaves the fallback chain alone`, async () => {
      const server = await startStallingServer(mode);
      const chain = new ProviderFallbackChain({
        resolve: () => ({
          chain: ["primary", "backup"],
          timing: DEFAULT_FALLBACK_TIMING,
        }),
      });
      let backupCalls = 0;
      const providers = new Map<string, LlmProvider>([
        ["primary", providerFor(kind, server.url)],
        [
          "backup",
          fakeProvider("backup", "grammar", async () => {
            backupCalls += 1;
            return fakeAnswer("backup");
          }),
        ],
      ]);
      const complete = createFallbackCompleter({
        fallbackChain: chain,
        resolveSlice: (providerId) => {
          const provider = providers.get(providerId)!;
          return { provider, transport: provider.capabilities.toolTransport };
        },
        recordUnaryUsage: () => {},
        recordStreamUsage: () => {},
      });
      // The whole chain run — including any fallover an orphaned failure
      // would trigger — is this promise; the runner stops watching it.
      let chainRun: Promise<unknown> | undefined;
      const tracked = (params: LlmStreamParams) => {
        const run = complete(params);
        chainRun = run.catch(() => undefined);
        return run;
      };
      const llmComplete: LinkGeneratorLlmComplete = abortableSubcall(
        tracked,
        (params: Parameters<LinkGeneratorLlmComplete>[0]) => ({
          prompt: params.prompt,
          grammar: params.grammar,
          slotId: params.slotId,
          sessionId: params.sessionId,
          ...(params.responseFormat
            ? { responseFormat: params.responseFormat }
            : {}),
        }),
      );
      const outcomes: string[] = [];
      const runner = createLinkGeneratorRunner({
        llmComplete,
        linkStore: {} as LinkGeneratorRunnerDeps["linkStore"],
        reflectionSlotId: -1,
        timeoutMs: 150,
        emitTrace: (event) => outcomes.push(event.outcome),
      });

      await expect(runner.generate(INPUT)).resolves.toBe(0);

      expect(outcomes).toEqual(["timeout"]);
      expect(server.requests()).toBe(1);
      // The load-bearing assertion: the server sees the socket go away.
      // Without the signal reaching the request it stays open until the
      // provider's own request timeout, minutes later.
      expect(await eventually(() => server.closedSockets() > 0, 3_000)).toBe(
        true,
      );
      expect(chainRun).toBeDefined();
      expect(await within(chainRun!, 3_000)).toBe("settled");
      expect(backupCalls).toBe(0);
      expect(chain.activeOverrideFor("link-gen:s1")).toBeNull();
    });
  }
});
