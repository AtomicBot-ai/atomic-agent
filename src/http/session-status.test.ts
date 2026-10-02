import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";

import type { CompletionResult } from "../llm/llama-server-client.js";
import { SessionStore } from "../session/index.js";

import { COMPLETION_ID_HEADER } from "./openai-chat-completions.js";
import { startTestHarness, type Harness } from "./test-harness.js";

/**
 * The status a chat's session row holds over `serve`, for each way the
 * desktop ends a turn: its Stop (`POST .../cancel`), a client that drops
 * the stream, and the app quitting mid-turn — the last being the one
 * that used to lose the turn's end: the store closed before the aborted
 * turn could write it, and a first message in a new chat read back as
 * `pending` with nothing in it.
 */

function reply(text: string): CompletionResult {
  return {
    content: JSON.stringify({ tool: "reply", args: { text } }),
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 0, predictedMs: 0, promptTokens: 1, predictedTokens: 1 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: null,
  };
}

/**
 * The turn's own model call holds until its signal aborts and then
 * rejects `unwindMs` later, as an aborted request takes a moment to come
 * back. Side calls (naming, reflection) on other ids answer at once.
 */
function hangingModel(unwindMs = 0) {
  const state = { target: "", entered: 0, aborted: 0 };
  const llamaComplete = async (params: {
    sessionId: string;
    signal?: AbortSignal;
  }): Promise<CompletionResult> => {
    if (params.sessionId !== state.target) return reply("ok");
    state.entered += 1;
    const signal = params.signal;
    await new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    state.aborted += 1;
    if (unwindMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, unwindMs));
    }
    throw signal?.reason ?? new DOMException("aborted", "AbortError");
  };
  return { state, llamaComplete };
}

async function waitFor(check: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

function chatInit(sessionId: string, signal: AbortSignal): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      stream: true,
      session_id: sessionId,
      messages: [{ role: "user", content: "write a long story" }],
    }),
    signal,
  };
}

async function storedStatus(baseUrl: string, id: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/sessions/${id}`);
  const body = (await res.json()) as { status?: string };
  return body.status ?? `<${res.status}>`;
}

/** Poll until the row stops saying `running`, then hand back what it says. */
async function settledStatus(baseUrl: string, id: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  let status = await storedStatus(baseUrl, id);
  while (status === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    status = await storedStatus(baseUrl, id);
  }
  return status;
}

describe("a chat's session status over serve", () => {
  let harness: Harness;
  let model: ReturnType<typeof hangingModel>;

  beforeEach(async () => {
    model = hangingModel(20);
    harness = await startTestHarness({ llamaComplete: model.llamaComplete });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("is running while the turn runs, and cancelled once the desktop's Stop cancels it", async () => {
    model.state.target = "status-stop";
    const res = await fetch(
      `${harness.baseUrl}/v1/chat/completions`,
      chatInit("status-stop", new AbortController().signal),
    );
    expect(res.status).toBe(200);
    const completionId = res.headers.get(COMPLETION_ID_HEADER)!;
    const body = res.text().catch(() => "");
    expect(await waitFor(() => model.state.entered === 1)).toBe(true);
    expect(await storedStatus(harness.baseUrl, "status-stop")).toBe("running");

    const cancel = await fetch(
      `${harness.baseUrl}/v1/chat/completions/${completionId}/cancel`,
      { method: "POST" },
    );
    expect(cancel.status).toBe(200);
    await cancel.body?.cancel();
    // The stream closes once the turn has ended and written its end.
    await body;
    expect(await storedStatus(harness.baseUrl, "status-stop")).toBe(
      "cancelled",
    );
  });

  it("is cancelled once a client that dropped the stream has ended the turn", async () => {
    model.state.target = "status-drop";
    const client = new AbortController();
    const res = await fetch(
      `${harness.baseUrl}/v1/chat/completions`,
      chatInit("status-drop", client.signal),
    );
    expect(res.status).toBe(200);
    expect(await waitFor(() => model.state.entered === 1)).toBe(true);
    client.abort();
    expect(await waitFor(() => model.state.aborted === 1, 2_000)).toBe(true);
    expect(await settledStatus(harness.baseUrl, "status-drop")).toBe(
      "cancelled",
    );
  });
});

describe("a chat's session when serve shuts down mid-turn", () => {
  it("is stored cancelled, with the message that started the turn", async () => {
    // The app quitting: `serve` drops every connection (which stops the
    // turn) and shuts the runtime down. The aborted model call comes
    // back 50 ms later — after the store used to be closed.
    const model = hangingModel(50);
    model.state.target = "status-quit";
    const harness = await startTestHarness({
      llamaComplete: model.llamaComplete,
    });
    try {
      const res = await fetch(
        `${harness.baseUrl}/v1/chat/completions`,
        chatInit("status-quit", new AbortController().signal),
      );
      expect(res.status).toBe(200);
      const drained = res.text().catch(() => "");
      expect(await waitFor(() => model.state.entered === 1)).toBe(true);

      await harness.handle.close();
      await harness.runtime.shutdown();
      await drained;

      const store = new SessionStore({
        dbFile: join(harness.stateDir, "sessions.sqlite"),
      });
      try {
        const stored = store.load("status-quit");
        expect(stored?.status).toBe("cancelled");
        expect(
          stored?.turns.flatMap((turn) =>
            turn.kind === "user" ? [turn.text] : [],
          ),
        ).toEqual(["write a long story"]);
        // The turn's own end, not shutdown's stand-in for it.
        expect(stored?.lastError).toBeNull();
      } finally {
        store.close();
      }
    } finally {
      await harness.cleanup();
    }
  });
});
