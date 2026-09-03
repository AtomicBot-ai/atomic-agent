import { afterEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

interface PreviewJson {
  basis: string;
  usage: {
    tokens: number;
    conversationTokens: number;
    conversationPairs: number;
    conversationPairsCap: number;
    sections: Array<{ label: string; tokens: number }>;
  };
  contextWindow: number | null;
  reservedForReply: number;
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
    expect(json.reservedForReply).toBe(
      harness.runtime.config.localModels.completionMaxTokens,
    );
    expect(json.contextWindow === null || json.contextWindow > 0).toBe(true);
    // A preview is not a session.
    expect(harness.runtime.sessionStore.listRecent(100).length).toBe(before);
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
