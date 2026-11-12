import { describe, expect, it } from "vitest";

import { CaptureResponse, SseDataParser, normaliseFinish, readErrorMessage, readUsage } from "./compat-bridge.js";

/** ATO-1080: the pieces the /v1/messages and /v1/responses routes stand on. */
describe("SseDataParser", () => {
  it("yields the data of each frame, across arbitrary split points", () => {
    const parser = new SseDataParser();
    expect(parser.push('data: {"a":1}\n\nda')).toEqual(['{"a":1}']);
    expect(parser.push("ta: [DONE]\n")).toEqual([]);
    expect(parser.push("\n")).toEqual(["[DONE]"]);
  });

  it("drops heartbeat comments and keeps only data lines of named frames", () => {
    const parser = new SseDataParser();
    expect(parser.push(': keepalive\n\nevent: x\ndata: {"b":2}\n\n')).toEqual(['{"b":2}']);
  });

  it("joins multi-line data and handles CRLF", () => {
    const parser = new SseDataParser();
    expect(parser.push("data: one\r\ndata: two\r\n\r\n")).toEqual(["one\ntwo"]);
  });

  it("flush returns an unterminated last frame", () => {
    const parser = new SseDataParser();
    parser.push("data: tail");
    expect(parser.flush()).toEqual(["tail"]);
    expect(parser.flush()).toEqual([]);
  });
});

function recordingSink() {
  const calls: Array<[string, ...unknown[]]> = [];
  return {
    calls,
    sink: {
      onJson: (status: number, headers: Record<string, string>, body: unknown) => calls.push(["json", status, headers, body]),
      onStreamStart: (headers: Record<string, string>) => calls.push(["start", headers]),
      onStreamData: (data: string) => calls.push(["data", data]),
      onStreamEnd: () => calls.push(["end"]),
    },
  };
}

describe("CaptureResponse", () => {
  it("hands a JSON answer to onJson with lower-cased headers", () => {
    const { calls, sink } = recordingSink();
    const res = new CaptureResponse(sink);
    res.writeHead(400, { "Content-Type": "application/json", "X-Atomic-Session-Id": "s1" });
    res.end('{"error":{"message":"bad"}}');
    expect(res.writableEnded).toBe(true);
    expect(calls).toEqual([
      ["json", 400, { "content-type": "application/json", "x-atomic-session-id": "s1" }, { error: { message: "bad" } }],
    ]);
  });

  it("streams SSE data frames as they are written, then ends", () => {
    const { calls, sink } = recordingSink();
    const res = new CaptureResponse(sink);
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.write('data: {"x":1}\n\n');
    res.write(": keepalive\n\n");
    res.write("data: [DONE]\n\n");
    res.end();
    expect(calls.map((c) => c[0])).toEqual(["start", "data", "data", "end"]);
    expect(calls[2]).toEqual(["data", "[DONE]"]);
  });

  it("abort() fires close before the end, as a client disconnect does", () => {
    const { sink } = recordingSink();
    const res = new CaptureResponse(sink);
    let closedBeforeEnd = false;
    res.once("close", () => {
      closedBeforeEnd = !res.writableEnded;
    });
    res.abort();
    expect(closedBeforeEnd).toBe(true);
    expect(res.destroyed).toBe(true);
    expect(res.write("ignored")).toBe(false);
  });

  it("a normal end does not look like a disconnect", () => {
    const { sink } = recordingSink();
    const res = new CaptureResponse(sink);
    let sawOpenClose = false;
    res.once("close", () => {
      sawOpenClose = !res.writableEnded;
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
    res.abort();
    expect(sawOpenClose).toBe(false);
  });
});

describe("helpers", () => {
  it("normaliseFinish keeps length and cancelled, else stop", () => {
    expect(normaliseFinish("length")).toBe("length");
    expect(normaliseFinish("cancelled")).toBe("cancelled");
    expect(normaliseFinish(null)).toBe("stop");
  });

  it("readUsage reads chat usage, zeros when absent", () => {
    expect(readUsage({ prompt_tokens: 5, completion_tokens: 3 })).toEqual({ input: 5, output: 3 });
    expect(readUsage(undefined)).toEqual({ input: 0, output: 0 });
  });

  it("readErrorMessage reads both error shapes", () => {
    expect(readErrorMessage({ error: { message: "boom" } })).toBe("boom");
    expect(readErrorMessage({ error: "flat" })).toBe("flat");
    expect(readErrorMessage(null)).toBe("Unknown error");
  });
});
