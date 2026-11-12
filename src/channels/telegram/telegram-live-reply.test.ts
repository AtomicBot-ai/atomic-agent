import { describe, expect, it, vi } from "vitest";

import type { AgentLoopEvent } from "../../agent/agent-contract.js";

import type { TelegramApi } from "./outbound-sender.js";
import { TelegramLiveReply, type LiveReplyOptions } from "./telegram-live-reply.js";

// ATO-634: the reply streams into one edited message, splits past the
// size limit, waits out 429s and ends as the formatted final text.

interface Call {
  kind: "send" | "edit" | "delete";
  id: number;
  text?: string;
  opts?: Record<string, unknown> | undefined;
}

/** A fake bot API; `failures` maps a call number (1-based) to the error it throws. */
function fakeApi(failures: Record<number, unknown> = {}): { api: TelegramApi; calls: Call[] } {
  const calls: Call[] = [];
  let n = 0;
  let nextId = 500;
  const maybeFail = () => {
    n += 1;
    if (failures[n] !== undefined) throw failures[n];
  };
  const api: TelegramApi = {
    sendMessage: vi.fn(async (_chat: number, text: string, opts?: Record<string, unknown>) => {
      maybeFail();
      const id = nextId++;
      calls.push({ kind: "send", id, text, opts });
      return { message_id: id };
    }),
    editMessageText: vi.fn(
      async (_chat: number, id: number, text: string, opts?: Record<string, unknown>) => {
        maybeFail();
        calls.push({ kind: "edit", id, text, opts });
        return true;
      },
    ),
    deleteMessage: vi.fn(async (_chat: number, id: number) => {
      calls.push({ kind: "delete", id });
      return true;
    }),
  };
  return { api, calls };
}

/** Manual clock and timers. */
function clock() {
  let now = 0;
  const timers: { at: number; cb: () => void; live: boolean }[] = [];
  return {
    now: () => now,
    schedule: (cb: () => void, ms: number) => {
      const t = { at: now + ms, cb, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    /** Move time forward, firing due timers in order. */
    advance(to: number) {
      now = to;
      for (const t of timers.filter((x) => x.live && x.at <= to)) {
        t.live = false;
        t.cb();
      }
    },
    pending: () => timers.filter((t) => t.live).length,
  };
}

const delta = (text: string): AgentLoopEvent =>
  ({ type: "llm_event", event: { type: "assistant_delta", text } }) as AgentLoopEvent;

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
}

function make(api: TelegramApi, c: ReturnType<typeof clock>, extra: Partial<LiveReplyOptions> = {}) {
  return new TelegramLiveReply({
    api,
    chatId: 7,
    now: c.now,
    schedule: c.schedule,
    minEditIntervalMs: 1000,
    minGrowthChars: 10,
    sleep: async () => undefined,
    ...extra,
  });
}

const flood = (after: number) => ({ error_code: 429, parameters: { retry_after: after } });

describe("TelegramLiveReply", () => {
  it("posts once, then edits at most once a second with the latest text", async () => {
    const { api, calls } = fakeApi();
    const c = clock();
    const live = make(api, c);
    live.onEvent(delta("Hello there, "));
    await settle();
    c.advance(200);
    live.onEvent(delta("this is streaming "));
    c.advance(500);
    live.onEvent(delta("in pieces."));
    await settle();
    expect(calls).toEqual([{ kind: "send", id: 500, text: "Hello there, ", opts: undefined }]);
    c.advance(1000);
    await settle();
    expect(calls.slice(1)).toEqual([
      { kind: "edit", id: 500, text: "Hello there, this is streaming in pieces.", opts: undefined },
    ]);
    // Nothing new: no edit.
    c.advance(5000);
    await settle();
    expect(calls).toHaveLength(2);
  });

  it("holds a tiny growth until the trailing flush shows it", async () => {
    const { api, calls } = fakeApi();
    const c = clock();
    const live = make(api, c);
    live.onEvent(delta("Short"));
    await settle();
    expect(calls).toEqual([]);
    expect(c.pending()).toBe(1);
    c.advance(1000);
    await settle();
    expect(calls.map((x) => x.text)).toEqual(["Short"]);
  });

  it("finishes a full bubble and starts a new one past the size limit", async () => {
    const { api, calls } = fakeApi();
    const c = clock();
    const live = make(api, c, { bubbleChars: 20, minEditIntervalMs: 0, minGrowthChars: 1 });
    live.onEvent(delta("a".repeat(15)));
    await settle();
    live.onEvent(delta("b".repeat(15)));
    await settle();
    expect(calls).toEqual([
      { kind: "send", id: 500, text: "a".repeat(15), opts: undefined },
      { kind: "edit", id: 500, text: `${"a".repeat(15)}${"b".repeat(5)}`, opts: undefined },
      { kind: "send", id: 501, text: "b".repeat(10), opts: undefined },
    ]);
    expect(live.messageIds()).toEqual([500, 501]);
  });

  it("replaces the bubbles with the formatted reply and deletes the ones not needed", async () => {
    const { api, calls } = fakeApi();
    const c = clock();
    const live = make(api, c, { bubbleChars: 20, minEditIntervalMs: 0, minGrowthChars: 1 });
    live.onEvent(delta("**bold** and some more text"));
    await settle();
    expect(live.messageIds()).toEqual([500, 501]);
    calls.length = 0;
    const final = await live.finalize("**bold** and some more text", "html");
    expect(final).toEqual({ delivered: true, messages: 1 });
    expect(calls).toEqual([
      {
        kind: "edit",
        id: 500,
        text: "<b>bold</b> and some more text",
        opts: { parse_mode: "HTML", disable_web_page_preview: true },
      },
      { kind: "delete", id: 501 },
    ]);
  });

  it("falls back to the plain chunk when Telegram rejects the formatting on the final edit", async () => {
    const parseErr = { error_code: 400, description: "Bad Request: can't parse entities" };
    const { api, calls } = fakeApi({ 2: parseErr });
    const c = clock();
    const live = make(api, c);
    live.onEvent(delta("**bold** streamed text"));
    await settle();
    const final = await live.finalize("**bold** streamed text", "html");
    expect(final.delivered).toBe(true);
    expect(calls.at(-1)).toEqual({
      kind: "edit",
      id: 500,
      text: "**bold** streamed text",
      opts: undefined,
    });
  });

  it("pauses edits on a 429 while streaming and shows all text once allowed", async () => {
    // Call 1 posts, call 2 (the first edit) hits a 2 s flood-wait.
    const { api, calls } = fakeApi({ 2: flood(2) });
    const c = clock();
    const live = make(api, c);
    live.onEvent(delta("First part of it. "));
    await settle();
    c.advance(1000);
    live.onEvent(delta("Second part here. "));
    await settle();
    c.advance(1500);
    live.onEvent(delta("Third part too."));
    c.advance(2500);
    await settle();
    expect(calls.filter((x) => x.kind === "edit")).toEqual([]);
    c.advance(3000);
    await settle();
    expect(calls.filter((x) => x.kind === "edit")).toEqual([
      { kind: "edit", id: 500, text: "First part of it. Second part here. Third part too.", opts: undefined },
    ]);
  });

  it("waits out repeated 429s on the final edit instead of dropping the reply", async () => {
    const { api, calls } = fakeApi({ 2: flood(1), 3: flood(4) });
    const c = clock();
    const slept: number[] = [];
    const live = make(api, c, { sleep: async (ms) => void slept.push(ms) });
    live.onEvent(delta("A streamed answer."));
    await settle();
    const final = await live.finalize("A streamed answer, final.", "plain");
    expect(final).toEqual({ delivered: true, messages: 1 });
    expect(slept).toEqual([1000, 4000]);
    expect(calls.at(-1)).toEqual({
      kind: "edit",
      id: 500,
      text: "A streamed answer, final.",
      opts: undefined,
    });
  });

  it("sends the rest as new messages, in the topic, when a final edit fails", async () => {
    const gone = { error_code: 400, description: "Bad Request: message to edit not found" };
    const { api, calls } = fakeApi({ 2: gone });
    const c = clock();
    const live = make(api, c, { threadId: 33 });
    live.onEvent(delta("Streamed into a topic."));
    await settle();
    expect(calls[0]!.opts).toEqual({ message_thread_id: 33 });
    const final = await live.finalize("Streamed into a topic, final.", "plain");
    expect(final).toEqual({ delivered: true, messages: 1 });
    expect(calls.slice(1)).toEqual([
      { kind: "delete", id: 500 },
      { kind: "send", id: 501, text: "Streamed into a topic, final.", opts: { message_thread_id: 33 } },
    ]);
  });

  it("posts the chunks the bubbles cannot hold after the edited ones", async () => {
    const { api, calls } = fakeApi();
    const c = clock();
    const live = make(api, c);
    live.onEvent(delta("Start of a long answer."));
    await settle();
    const reply = `${"x".repeat(3999)}\n${"y".repeat(50)}`;
    const final = await live.finalize(reply, "plain");
    expect(final).toEqual({ delivered: true, messages: 2 });
    expect(calls.slice(1).map((x) => [x.kind, x.id])).toEqual([
      ["edit", 500],
      ["send", 501],
    ]);
    expect(calls.at(-1)!.text).toBe("y".repeat(50));
  });

  it("restarts the text on a new step, so a note is overwritten, not appended to", async () => {
    const { api, calls } = fakeApi();
    const c = clock();
    const live = make(api, c, { minEditIntervalMs: 0, minGrowthChars: 1 });
    live.onEvent(delta("Checking the files first."));
    await settle();
    live.onEvent({ type: "step_started", stepIndex: 1 } as AgentLoopEvent);
    live.onEvent(delta("Here is the answer."));
    await settle();
    expect(calls.at(-1)).toEqual({ kind: "edit", id: 500, text: "Here is the answer.", opts: undefined });
  });

  it("says nothing was delivered when no text streamed", async () => {
    const { api, calls } = fakeApi();
    const live = make(api, clock());
    expect(await live.finalize("reply", "html")).toEqual({ delivered: false, messages: 0 });
    expect(calls).toEqual([]);
  });

  it("close() keeps what was streamed and stops further edits", async () => {
    const { api, calls } = fakeApi();
    const c = clock();
    const live = make(api, c);
    live.onEvent(delta("Partial answer before cancel."));
    await settle();
    await live.close();
    live.onEvent(delta(" more"));
    c.advance(5000);
    await settle();
    expect(calls).toEqual([
      { kind: "send", id: 500, text: "Partial answer before cancel.", opts: undefined },
    ]);
  });
});
