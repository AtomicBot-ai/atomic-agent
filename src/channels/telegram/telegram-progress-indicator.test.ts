import { describe, expect, it, vi } from "vitest";

import type { AgentLoopEvent } from "../../agent/agent-loop.js";

import type { TelegramApi } from "./outbound-sender.js";
import {
  progressLabel,
  TelegramProgressIndicator,
} from "./telegram-progress-indicator.js";

interface Recorded {
  sends: Array<{ text: string; opts: Record<string, unknown> | undefined }>;
  edits: Array<{ messageId: number; text: string }>;
  deletes: number[];
}

function makeApi(overrides: Partial<TelegramApi> = {}): {
  api: TelegramApi;
  recorded: Recorded;
} {
  const recorded: Recorded = { sends: [], edits: [], deletes: [] };
  let nextId = 100;
  const api: TelegramApi = {
    sendMessage: vi.fn(async (_chatId, text, opts) => {
      recorded.sends.push({ text, opts });
      return { message_id: nextId++ };
    }),
    editMessageText: vi.fn(async (_chatId, messageId, text) => {
      recorded.edits.push({ messageId, text });
      return true;
    }),
    deleteMessage: vi.fn(async (_chatId, messageId) => {
      recorded.deletes.push(messageId);
      return true;
    }),
    ...overrides,
  };
  return { api, recorded };
}

/** Settle the indicator's internal promise chain. */
async function settle(): Promise<void> {
  // Two macrotask hops cover chain links queued from within chain links.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("TelegramProgressIndicator", () => {
  it("start → update → remove drives send, edit and delete in order", async () => {
    const { api, recorded } = makeApi();
    const progress = new TelegramProgressIndicator(api, 7, undefined, 0);

    progress.start("🤔 Thinking…");
    await settle();
    progress.update("🔧 os.fs.read");
    await settle();
    await progress.remove();

    expect(recorded.sends).toHaveLength(1);
    expect(recorded.edits).toEqual([{ messageId: 100, text: "🔧 os.fs.read" }]);
    expect(recorded.deletes).toEqual([100]);
  });

  it("sends the bubble silently (disable_notification)", async () => {
    const { api, recorded } = makeApi();
    const progress = new TelegramProgressIndicator(api, 7, undefined, 0);

    progress.start("🤔 Thinking…");
    await settle();

    expect(recorded.sends[0]?.opts).toMatchObject({
      disable_notification: true,
    });
    await progress.remove();
  });

  it("fast-turn race: remove before the send resolves still deletes the bubble", async () => {
    const { api, recorded } = makeApi();
    let release: (v: { message_id: number }) => void = () => undefined;
    api.sendMessage = vi.fn(
      () =>
        new Promise<{ message_id: number }>((resolve) => {
          release = resolve;
        }),
    );
    const progress = new TelegramProgressIndicator(api, 7, undefined, 0);

    progress.start("🤔 Thinking…");
    // Let the chain invoke sendMessage (which stays pending) before racing
    // the removal against it.
    await settle();
    const removed = progress.remove();
    release({ message_id: 42 });
    await removed;
    await settle();

    expect(recorded.deletes).toEqual([42]);
  });

  it("dedupes identical text and throttles inside the edit window", async () => {
    const { api, recorded } = makeApi();
    // Large interval: only the first post-start edit may pass, and only
    // when enough virtual time elapsed — with real clocks nothing passes.
    const progress = new TelegramProgressIndicator(api, 7, undefined, 60_000);

    progress.start("🤔 Thinking…");
    await settle();
    progress.update("🤔 Thinking…"); // identical → dropped
    progress.update("🔧 os.fs.read"); // inside window → dropped
    await settle();

    expect(recorded.edits).toHaveLength(0);
    await progress.remove();
  });

  it("mutes edits for retry_after seconds on a 429", async () => {
    const { api, recorded } = makeApi();
    api.editMessageText = vi.fn(async (_chatId, messageId, text) => {
      recorded.edits.push({ messageId, text });
      if (recorded.edits.length === 1) {
        throw Object.assign(new Error("Too Many Requests"), {
          error_code: 429,
          parameters: { retry_after: 60 },
        });
      }
      return true;
    });
    const progress = new TelegramProgressIndicator(api, 7, undefined, 0);

    progress.start("🤔 Thinking…");
    await settle();
    progress.update("step 1");
    await settle();
    // The flood-wait from the first edit must suppress this one entirely.
    progress.update("step 2");
    await settle();

    expect(recorded.edits).toHaveLength(1);
    await progress.remove();
  });

  it("failure to send never throws and remove stays safe", async () => {
    const { api } = makeApi({
      sendMessage: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    const warn = vi.fn();
    const progress = new TelegramProgressIndicator(api, 7, { warn }, 0);

    progress.start("🤔 Thinking…");
    await settle();
    await expect(progress.remove()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("progressLabel", () => {
  it("does not echo step_finished summaries (raw tool output)", () => {
    const event = {
      type: "step_finished",
      stepIndex: 2,
      summary: "SECRET_KEY=abcdef massive raw tool output tail",
      durationMs: 10,
    } as AgentLoopEvent;
    expect(progressLabel(event)).toBe("✅ Step 3 done");
  });

  it("keeps the tool-name and step labels", () => {
    expect(
      progressLabel({ type: "step_started", stepIndex: 0 } as AgentLoopEvent),
    ).toBe("⚙️ Working… (step 1)");
    expect(
      progressLabel({
        type: "llm_event",
        event: { type: "tool_call_parsed", call: { tool: "browser.navigate" } },
      } as unknown as AgentLoopEvent),
    ).toBe("🔧 browser.navigate");
  });
});
