import { describe, expect, it, vi } from "vitest";
import { ModelProfileManager } from "./model-profile-manager.js";
import {
  GEMMA4_THINK_PROFILE,
  PLAIN_INSTRUCT_PROFILE,
  QWEN_THINK_PROFILE,
} from "./model-profile.js";
import { buildGrammar } from "./grammar/build-grammar.js";
import {
  GEMMA4_PROPS,
  QWEN3_PROPS,
  LLAMA3_PROPS,
} from "./model-profile.fixtures.js";
import type { LlamaServerClient } from "./llama-server-client.js";

function makeLlamaStub(
  responses: Record<string, unknown>[],
): { client: Pick<LlamaServerClient, "fetchProps">; calls: number } {
  let calls = 0;
  const queue = [...responses];
  const client = {
    async fetchProps() {
      calls += 1;
      const next = queue.shift() ?? queue[queue.length - 1];
      if (!next) throw new Error("no fake props configured");
      return next;
    },
  } as Pick<LlamaServerClient, "fetchProps">;
  return {
    client,
    get calls() {
      return calls;
    },
  } as { client: Pick<LlamaServerClient, "fetchProps">; calls: number };
}

describe("ModelProfileManager", () => {
  it("reports the initial profile/grammar until a mismatch is observed", async () => {
    const grammar = await buildGrammar(GEMMA4_THINK_PROFILE);
    const stub = makeLlamaStub([QWEN3_PROPS]);
    const manager = new ModelProfileManager({
      llama: stub.client as LlamaServerClient,
      initialProfile: GEMMA4_THINK_PROFILE,
      initialGrammar: grammar,
      initialModelId: "gemma-4-it",
    });

    expect(manager.getProfile().id).toBe("gemma4-think");
    expect(manager.getGrammar()).toBe(grammar);
    expect(manager.isStale()).toBe(false);

    manager.observeCompletionModelId("gemma-4-it");
    expect(manager.isStale()).toBe(false);
    expect(stub.calls).toBe(0);

    const result = await manager.refreshIfStale();
    expect(result.profileChanged).toBe(false);
    expect(stub.calls).toBe(0);
  });

  it("flags itself stale when a completion returns a different modelId", async () => {
    const grammar = await buildGrammar(GEMMA4_THINK_PROFILE);
    const stub = makeLlamaStub([QWEN3_PROPS]);
    const manager = new ModelProfileManager({
      llama: stub.client as LlamaServerClient,
      initialProfile: GEMMA4_THINK_PROFILE,
      initialGrammar: grammar,
      initialModelId: "gemma-4-it",
    });

    manager.observeCompletionModelId("qwen3-30b-a3b-instruct-2507");
    expect(manager.isStale()).toBe(true);
  });

  it("refreshIfStale re-probes /props and swaps grammar when profile id changes", async () => {
    const grammar = await buildGrammar(GEMMA4_THINK_PROFILE);
    const stub = makeLlamaStub([QWEN3_PROPS]);
    const manager = new ModelProfileManager({
      llama: stub.client as LlamaServerClient,
      initialProfile: GEMMA4_THINK_PROFILE,
      initialGrammar: grammar,
      initialModelId: "gemma-4-it",
    });

    manager.observeCompletionModelId("qwen3-30b-a3b-instruct-2507");
    const result = await manager.refreshIfStale();

    expect(stub.calls).toBe(1);
    expect(result.profileChanged).toBe(true);
    expect(result.profileId).toBe("qwen-think");
    expect(manager.getProfile().id).toBe("qwen-think");
    expect(manager.getProfile().reasoningStyle).toBe(
      QWEN_THINK_PROFILE.reasoningStyle,
    );
    expect(manager.getGrammar()).toContain("think-prelude");
    expect(manager.getModelId()).toBe("qwen3-30b-a3b-instruct-2507");
    expect(manager.isStale()).toBe(false);
  });

  it("does not rebuild the grammar when the profile id stays the same", async () => {
    const grammar = await buildGrammar(QWEN_THINK_PROFILE);
    const stub = makeLlamaStub([QWEN3_PROPS]);
    const manager = new ModelProfileManager({
      llama: stub.client as LlamaServerClient,
      initialProfile: QWEN_THINK_PROFILE,
      initialGrammar: grammar,
      initialModelId: "qwen3-30b-a3b-instruct-2507",
    });

    manager.observeCompletionModelId("qwen3-30b-a3b-instruct-2507-alt");
    const result = await manager.refreshIfStale();
    expect(result.profileChanged).toBe(false);
    expect(manager.getGrammar()).toBe(grammar);
  });

  it("falls back to keeping the prior profile when /props probe throws", async () => {
    const grammar = await buildGrammar(GEMMA4_THINK_PROFILE);
    const warn = vi.fn();
    const stub = {
      async fetchProps() {
        throw new Error("boom");
      },
    } as unknown as LlamaServerClient;
    const manager = new ModelProfileManager({
      llama: stub,
      initialProfile: GEMMA4_THINK_PROFILE,
      initialGrammar: grammar,
      initialModelId: "gemma-4-it",
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as never,
    });

    manager.observeCompletionModelId("qwen3-30b-a3b-instruct-2507");
    const result = await manager.refreshIfStale();
    expect(result.profileChanged).toBe(false);
    expect(result.profileId).toBe("gemma4-think");
    expect(manager.isStale()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "model profile refresh failed; keeping prior profile",
      expect.objectContaining({ error: "boom", profile: "gemma4-think" }),
    );
  });

  it("bootstrap-from-plain: first non-empty modelId is adopted without marking stale", async () => {
    const stub = makeLlamaStub([QWEN3_PROPS]);
    const manager = new ModelProfileManager({
      llama: stub.client as LlamaServerClient,
      initialProfile: PLAIN_INSTRUCT_PROFILE,
      initialGrammar: 'root ::= "ok"',
      initialModelId: null,
    });

    manager.observeCompletionModelId("qwen3-30b-a3b-instruct-2507");
    expect(manager.isStale()).toBe(false);
    expect(manager.getModelId()).toBe("qwen3-30b-a3b-instruct-2507");
    expect(stub.calls).toBe(0);
  });

  it("refresh() can collapse to plain-instruct when /props no longer looks reasoning-capable", async () => {
    const grammar = await buildGrammar(QWEN_THINK_PROFILE);
    const stub = makeLlamaStub([LLAMA3_PROPS]);
    const manager = new ModelProfileManager({
      llama: stub.client as LlamaServerClient,
      initialProfile: QWEN_THINK_PROFILE,
      initialGrammar: grammar,
      initialModelId: "qwen3-30b-a3b-instruct-2507",
    });

    manager.observeCompletionModelId("llama-3.1-8b-instruct");
    const result = await manager.refreshIfStale();
    expect(result.profileChanged).toBe(true);
    expect(result.profileId).toBe("plain-instruct");
    expect(manager.getProfile()).toBe(PLAIN_INSTRUCT_PROFILE);
    expect(manager.getGrammar()).not.toContain("think-prelude");
  });
});
