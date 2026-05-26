import { describe, expect, it } from "vitest";
import {
  createStreamParser,
  type StreamParseEvent,
} from "./stream-parser.js";

function feedAll(
  chunks: string[],
  options: Parameters<typeof createStreamParser>[0] = {},
): StreamParseEvent[] {
  const parser = createStreamParser(options);
  const events: StreamParseEvent[] = [];
  for (const chunk of chunks) {
    events.push(...parser.push(chunk));
  }
  events.push(...parser.end());
  return events;
}

function feedAllWithPreOpenedThink(chunks: string[]): StreamParseEvent[] {
  const parser = createStreamParser({ preOpenedThink: true });
  const events: StreamParseEvent[] = [];
  for (const chunk of chunks) {
    events.push(...parser.push(chunk));
  }
  events.push(...parser.end());
  return events;
}

function concatReply(events: StreamParseEvent[]): string {
  return events
    .filter((e): e is Extract<StreamParseEvent, { kind: "reply_text_delta" }> =>
      e.kind === "reply_text_delta",
    )
    .map((e) => e.text)
    .join("");
}

function concatReasoning(events: StreamParseEvent[]): string {
  return events
    .filter(
      (e): e is Extract<StreamParseEvent, { kind: "reasoning_delta" }> =>
        e.kind === "reasoning_delta",
    )
    .map((e) => e.text)
    .join("");
}

describe("createStreamParser", () => {
  it("emits reasoning deltas for a balanced think block", () => {
    const raw =
      '<think>planning the answer</think>{"tool":"reply","args":{"text":"hi"}}';
    const events = feedAll([raw]);
    expect(events[0]).toEqual({ kind: "reasoning_open" });
    expect(concatReasoning(events)).toBe("planning the answer");
    const closeIdx = events.findIndex((e) => e.kind === "reasoning_close");
    const replyOpenIdx = events.findIndex((e) => e.kind === "reply_text_open");
    expect(closeIdx).toBeGreaterThan(0);
    expect(replyOpenIdx).toBeGreaterThan(closeIdx);
    expect(concatReply(events)).toBe("hi");
    expect(events.at(-1)).toEqual({ kind: "reply_text_close" });
  });

  it("handles chunk boundary in the middle of the closing </think> tag", () => {
    const events = feedAll([
      "<think>abc</thi",
      "nk>{\"tool\":\"reply\",\"args\":{\"text\":\"ok\"}}",
    ]);
    expect(concatReasoning(events)).toBe("abc");
    expect(events.filter((e) => e.kind === "reasoning_close")).toHaveLength(1);
    expect(concatReply(events)).toBe("ok");
  });

  it("decodes JSON escape sequences inside reply text", () => {
    const raw =
      '{"tool":"reply","args":{"text":"line1\\nline2 \\"quoted\\" and \\u00e9"}}';
    const events = feedAll([raw]);
    expect(concatReply(events)).toBe('line1\nline2 "quoted" and é');
  });

  it("splits \\uXXXX across chunk boundaries correctly", () => {
    const raw = '{"tool":"reply","args":{"text":"x\\u00e9y"}}';
    const events = feedAll([
      raw.slice(0, raw.indexOf("\\u") + 2),
      raw.slice(raw.indexOf("\\u") + 2, raw.indexOf("\\u") + 4),
      raw.slice(raw.indexOf("\\u") + 4),
    ]);
    expect(concatReply(events)).toBe("xéy");
  });

  it("does not leak text deltas for non-reply tools", () => {
    const raw = '{"tool":"os.shell.run","args":{"command":"rm -rf /"}}';
    const events = feedAll([raw]);
    const replyDeltas = events.filter((e) => e.kind === "reply_text_delta");
    expect(replyDeltas).toHaveLength(0);
    expect(events.filter((e) => e.kind === "reply_text_open")).toHaveLength(0);
  });

  it("streams char by char when chunks split every single character", () => {
    const raw =
      '<think>hi</think>{"tool":"reply","args":{"text":"hello"}}';
    const chunks = raw.split("");
    const events = feedAll(chunks);
    expect(concatReasoning(events)).toBe("hi");
    expect(concatReply(events)).toBe("hello");
    expect(events.filter((e) => e.kind === "reply_text_close")).toHaveLength(1);
  });

  it("closes an unclosed think block on stream end", () => {
    const events = feedAll(["<think>cut off mid-thought"]);
    expect(concatReasoning(events)).toBe("cut off mid-thought");
    expect(events.at(-1)).toEqual({ kind: "reasoning_close" });
  });

  it("can start inside an already opened think block", () => {
    const events = feedAllWithPreOpenedThink([
      'planning</think>{"tool":"reply","args":{"text":"ok"}}',
    ]);
    expect(concatReasoning(events)).toBe("planning");
    expect(concatReply(events)).toBe("ok");
  });

  it("supports custom reasoning tags split across the closing sentinel", () => {
    const events = feedAll(
      [
        "alpha<chan",
        'nel|>{"tool":"reply","args":{"text":"ok"}}',
      ],
      {
        preOpenedThink: true,
        reasoningOpenTag: "<|channel>thought\n",
        reasoningCloseTag: "<channel|>",
      },
    );
    expect(concatReasoning(events)).toBe("alpha");
    expect(events.filter((e) => e.kind === "reasoning_close")).toHaveLength(1);
    expect(concatReply(events)).toBe("ok");
  });

  it("flushes remaining reply text on stream end if closing quote missing", () => {
    const events = feedAll(['{"tool":"reply","args":{"text":"partial']);
    expect(concatReply(events)).toBe("partial");
    expect(events.at(-1)).toEqual({ kind: "reply_text_close" });
  });

  it("supports multiple think blocks before JSON", () => {
    const raw =
      '<think>first</think> prose <think>second</think>{"tool":"reply","args":{"text":"ok"}}';
    const events = feedAll([raw]);
    const opens = events.filter((e) => e.kind === "reasoning_open").length;
    const closes = events.filter((e) => e.kind === "reasoning_close").length;
    expect(opens).toBe(2);
    expect(closes).toBe(2);
    expect(concatReasoning(events)).toBe("firstsecond");
    expect(concatReply(events)).toBe("ok");
  });

  it("streams array-only reply when think is pre-opened but close sentinel is missing", () => {
    const events = feedAll(
      ['[{"tool":"reply","args":{"text":"Привет!"}}]'],
      {
        preOpenedThink: true,
        reasoningOpenTag: "<|channel>thought\n",
        reasoningCloseTag: "<channel|>",
      },
    );
    expect(concatReasoning(events)).toBe("");
    expect(events.filter((e) => e.kind === "reasoning_close")).toHaveLength(1);
    expect(concatReply(events)).toBe("Привет!");
  });

  it("splits reply.args.text across chunks preserving backslash escapes", () => {
    const raw =
      '{"tool":"reply","args":{"text":"a\\\\b\\nc"}}';
    // Split right between `\` and `\\` sequence
    const events = feedAll([
      raw.slice(0, raw.indexOf("\\\\") + 1),
      raw.slice(raw.indexOf("\\\\") + 1),
    ]);
    expect(concatReply(events)).toBe("a\\b\nc");
  });
});
