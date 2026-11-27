import { afterEach, describe, expect, it, vi } from "vitest";

import { resetConfigCache } from "../config/index.js";
import { effectiveReplyReserve } from "../prompt/token-budget.js";
import { startTestHarness, type Harness } from "./test-harness.js";

interface PreviewJson {
  basis: string;
  usage: {
    tokens: number;
    conversationTokens: number;
    conversationPairs: number;
    conversationPairsCap: number;
    sections: Array<{ label: string; tokens: number }>;
    replyReserve?: number;
  };
  contextWindow: number | null;
  reservedForReply: number;
  replyCap: number;
  pairsCap: number;
}

async function preview(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: PreviewJson }> {
  const res = await fetch(`${baseUrl}/api/context-preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as PreviewJson };
}

describe("POST /api/context-preview", () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (harness) await harness.cleanup();
    harness = null;
  });

  it("builds the next prompt for a fresh thread without persisting a session", async () => {
    harness = await startTestHarness();
    const before = harness.runtime.sessionStore.listRecent(100).length;

    const { status, json } = await preview(harness.baseUrl, {});
    expect(status).toBe(200);
    expect(json.basis).toBe("built");
    // The TUI's own section labels, in the TUI's order: the scaffold first.
    expect(json.usage.sections[0]?.label).toBe("prompt scaffold");
    expect(json.usage.tokens).toBeGreaterThan(0);
    // Not zero: an empty transcript still renders the conversation
    // section's "(no messages yet)" placeholder, so the section has a
    // small floor. The TUI's own panel shows the same figure on a fresh
    // thread. The floor is the placeholder and nothing else, so it stays
    // tiny — a fresh thread carrying real transcript tokens would break
    // the upper bound. What must be exactly zero is the pair count.
    expect(json.usage.conversationTokens).toBeGreaterThan(0);
    expect(json.usage.conversationTokens).toBeLessThan(20);
    expect(json.usage.conversationPairs).toBe(0);
    expect(json.pairsCap).toBe(harness.runtime.config.agent.conversationMaxPairs);
    expect(json.usage.conversationPairsCap).toBe(json.pairsCap);
    // The configured cap rides as `replyCap`; the reservation is the part
    // of it the budget really holds back on this window.
    expect(json.replyCap).toBe(
      harness.runtime.config.localModels.completionMaxTokens,
    );
    expect(json.reservedForReply).toBe(
      effectiveReplyReserve(json.replyCap, json.contextWindow),
    );
    // ATO-2495: the readout carries the same figure, so a client draws
    // the agent's reserve instead of recomputing it.
    expect(json.usage.replyReserve).toBe(json.reservedForReply);
    expect(json.contextWindow === null || json.contextWindow > 0).toBe(true);
    // A preview is not a session.
    expect(harness.runtime.sessionStore.listRecent(100).length).toBe(before);
  });

  /**
   * Desktop item 63: a 96k reply cap on a 32k model. The route used to
   * report the raw cap as reserved, which the popover drew as eating the
   * whole window; it reports the budget's reservation and the cap apart.
   */
  it("reports a cap past half the window as half the window, and the cap itself as replyCap", async () => {
    const before = process.env.ATOMIC_AGENT_LLAMA_MAX_TOKENS;
    process.env.ATOMIC_AGENT_LLAMA_MAX_TOKENS = "96000";
    resetConfigCache();
    try {
      harness = await startTestHarness({
        llamaProps: {
          model_alias: "small-32k",
          default_generation_settings: { n_ctx: 32_768 },
        },
      });
      const { status, json } = await preview(harness.baseUrl, {});
      expect(status).toBe(200);
      expect(json.contextWindow).toBe(32_768);
      expect(json.replyCap).toBe(96_000);
      expect(json.reservedForReply).toBe(16_384);
      expect(json.usage.replyReserve).toBe(16_384);
    } finally {
      if (before === undefined) delete process.env.ATOMIC_AGENT_LLAMA_MAX_TOKENS;
      else process.env.ATOMIC_AGENT_LLAMA_MAX_TOKENS = before;
      resetConfigCache();
    }
  });

  /**
   * ATO-2495 review: the route reports the budget's own reserve, not a
   * recomputation from the cap. A bounded think block (ATO-1295,
   * `localModels.reasoningBudgetTokens: 4000`) raises the reserve on a
   * 16k window from 4096 to 5024; the prompt carries 5024, so the route
   * must too. Recomputing from the cap alone gives 4096.
   */
  it("reports the reserve the prompt budget held back, raised for a bounded think block", async () => {
    harness = await startTestHarness({
      llamaProps: {
        model_alias: "small-16k",
        default_generation_settings: { n_ctx: 16_384 },
      },
    });
    const runtime = harness.runtime;
    const real = runtime.previewPrompt.bind(runtime);
    vi.spyOn(runtime, "previewPrompt").mockImplementation((input) => {
      const built = real(input);
      return {
        ...built,
        contextWindow: 16_384,
        replyReserve: effectiveReplyReserve(
          runtime.config.localModels.completionMaxTokens,
          16_384,
          4000,
        ),
      };
    });
    const { status, json } = await preview(harness.baseUrl, {});
    expect(status).toBe(200);
    expect(json.contextWindow).toBe(16_384);
    expect(json.replyCap).toBe(16_384);
    // The recomputation the route used to do: not the budget's figure.
    expect(effectiveReplyReserve(json.replyCap, json.contextWindow)).toBe(4096);
    expect(json.reservedForReply).toBe(5024);
    expect(json.usage.replyReserve).toBe(5024);
  });

  /**
   * ATO-2495 review: a cloud prompt carries no top-level `replyReserve`,
   * only `contextBudget.replyReserve`, the raw cap its budget subtracts.
   * The reply used to send that cap on `usage.replyReserve` and a
   * small-window recomputation on `reservedForReply`; it sends one figure.
   */
  it("sends one reserve on a cloud prompt: the cap the cloud budget subtracts", async () => {
    harness = await startTestHarness();
    const runtime = harness.runtime;
    const real = runtime.previewPrompt.bind(runtime);
    vi.spyOn(runtime, "previewPrompt").mockImplementation((input) => {
      const built = { ...real(input) };
      delete built.replyReserve;
      return {
        ...built,
        contextWindow: 32_768,
        contextBudget: { window: 32_768, replyReserve: 96_000 },
      };
    });
    const { status, json } = await preview(harness.baseUrl, {});
    expect(status).toBe(200);
    expect(json.usage.replyReserve).toBe(96_000);
    expect(json.reservedForReply).toBe(json.usage.replyReserve);
  });

  it("counts the draft as the user message", async () => {
    harness = await startTestHarness();
    const empty = (await preview(harness.baseUrl, {})).json;
    const drafted = (
      await preview(harness.baseUrl, {
        message: "hello there, please summarise this repository for me",
      })
    ).json;
    expect(drafted.usage.tokens).toBeGreaterThan(empty.usage.tokens);
    expect(drafted.usage.sections[0]?.tokens).toBe(empty.usage.sections[0]?.tokens);
  });

  it("previews an existing session with its transcript", async () => {
    harness = await startTestHarness();
    const session = harness.runtime.createSession();
    await harness.runtime.runTurn(session, "hello");

    const { status, json } = await preview(harness.baseUrl, { session_id: session.id });
    expect(status).toBe(200);
    expect(json.usage.conversationTokens).toBeGreaterThan(0);
    expect(json.usage.sections.some((s) => s.label === "conversation")).toBe(true);
  });

  it("answers 404 for an unknown session and 400 for a bad body", async () => {
    harness = await startTestHarness();
    const missing = await fetch(`${harness.baseUrl}/api/context-preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "missing" }),
    });
    expect(missing.status).toBe(404);
    const missingBody = (await missing.json()) as { error: { message: string } };
    expect(missingBody.error.message).toBe("session not found: missing");

    const bad = await fetch(`${harness.baseUrl}/api/context-preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(bad.status).toBe(400);
  });
});
