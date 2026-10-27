import { describe, expect, it, vi } from "vitest";

import { buildGrammar } from "./grammar/build-grammar.js";
import type { LlamaServerClient } from "./llama-server-client.js";
import { ModelProfileManager } from "./model-profile-manager.js";
import { PLAIN_INSTRUCT_PROFILE } from "./model-profile.js";
import { QWEN3_PROPS } from "./model-profile.fixtures.js";

/**
 * `buildGrammar` is gated so the test decides when a hot-swap's rebuild
 * finishes: the MCP catalog changes while the rebuild is awaited.
 */
const gate = vi.hoisted(() => {
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const state = {
    held: false,
    entered: new Promise<void>((resolve) => { entered = resolve; }),
    released: new Promise<void>((resolve) => { release = resolve; }),
    enter: () => entered(),
    release: () => release(),
  };
  return state;
});

vi.mock("./grammar/build-grammar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./grammar/build-grammar.js")>();
  return {
    ...actual,
    buildGrammar: async (...args: Parameters<typeof actual.buildGrammar>) => {
      const built = await actual.buildGrammar(...args);
      if (gate.held) {
        gate.enter();
        await gate.released;
      }
      return built;
    },
  };
});

describe("ModelProfileManager: an MCP change during a hot-swap rebuild", () => {
  it("is not lost when the rebuilt grammar lands", async () => {
    const llama = { fetchProps: async () => QWEN3_PROPS } as Pick<LlamaServerClient, "fetchProps">;
    const mgr = new ModelProfileManager({
      llama: llama as LlamaServerClient,
      initialProfile: PLAIN_INSTRUCT_PROFILE,
      initialGrammar: await buildGrammar(PLAIN_INSTRUCT_PROFILE),
      initialModelId: null,
    });
    gate.held = true;
    const refreshing = mgr.refresh();
    await gate.entered;
    // The rebuild read "no MCP tools"; a server connects meanwhile.
    const rule = 'mcp-server-tool ::= "\\"mcp.docs.search\\""';
    mgr.setMcpToolNameRule(rule, true);
    gate.release();
    await refreshing;
    expect(mgr.getProfile().id).toBe("qwen-think");
    expect(mgr.getGrammar()).toContain(rule);
    expect(mgr.getGrammar()).toMatch(/^tool-name ::= .*\| mcp-server-tool \|/m);
  });
});
