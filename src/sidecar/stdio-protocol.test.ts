import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { StdioProtocol } from "./stdio-protocol.js";
import type { HostRequest } from "./sidecar-events.js";

function createProtocol() {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  const parseErrors: Error[] = [];
  const protocol = new StdioProtocol({
    input,
    output,
    onParseError: (err) => parseErrors.push(err),
  });
  return { input, output, protocol, parseErrors };
}

async function readLines(stream: PassThrough, count: number, timeoutMs = 1000) {
  return new Promise<string[]>((resolve, reject) => {
    const lines: string[] = [];
    let buffer = "";
    const timer = setTimeout(() => {
      reject(new Error(`timeout waiting for ${count} lines, got ${lines.length}`));
    }, timeoutMs);
    const onData = (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        lines.push(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
        if (lines.length >= count) {
          clearTimeout(timer);
          stream.off("data", onData);
          resolve(lines);
          return;
        }
        idx = buffer.indexOf("\n");
      }
    };
    stream.on("data", onData);
  });
}

describe("StdioProtocol", () => {
  it("parses a single NDJSON request line and invokes the handler", async () => {
    const { input, protocol } = createProtocol();
    const received: HostRequest[] = [];
    protocol.onRequest((req) => received.push(req));
    const request: HostRequest = {
      kind: "request",
      id: "r1",
      type: "ping",
      payload: {},
    };
    input.write(`${JSON.stringify(request)}\n`);
    await new Promise((r) => setImmediate(r));
    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe("r1");
    expect(received[0]?.type).toBe("ping");
  });

  it("handles multiple concatenated frames in one chunk", async () => {
    const { input, protocol } = createProtocol();
    const received: HostRequest[] = [];
    protocol.onRequest((req) => received.push(req));
    const a: HostRequest = { kind: "request", id: "a", type: "ping", payload: {} };
    const b: HostRequest = { kind: "request", id: "b", type: "cancel", payload: { sessionId: "s1" } };
    input.write(`${JSON.stringify(a)}\n${JSON.stringify(b)}\n`);
    await new Promise((r) => setImmediate(r));
    expect(received.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("handles partial frames split across chunks", async () => {
    const { input, protocol } = createProtocol();
    const received: HostRequest[] = [];
    protocol.onRequest((req) => received.push(req));
    const msg: HostRequest = { kind: "request", id: "split", type: "ping", payload: {} };
    const raw = JSON.stringify(msg);
    const half = Math.floor(raw.length / 2);
    input.write(raw.slice(0, half));
    await new Promise((r) => setImmediate(r));
    expect(received).toHaveLength(0);
    input.write(`${raw.slice(half)}\n`);
    await new Promise((r) => setImmediate(r));
    expect(received).toHaveLength(1);
  });

  it("reports parse errors for malformed lines without crashing", async () => {
    const { input, protocol, parseErrors } = createProtocol();
    const received: HostRequest[] = [];
    protocol.onRequest((req) => received.push(req));
    input.write("{not json\n");
    const good: HostRequest = { kind: "request", id: "ok", type: "ping", payload: {} };
    input.write(`${JSON.stringify(good)}\n`);
    await new Promise((r) => setImmediate(r));
    expect(parseErrors).toHaveLength(1);
    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe("ok");
  });

  it("emitEvent writes a single newline-terminated JSON line", async () => {
    const { output, protocol } = createProtocol();
    const linesPromise = readLines(output, 1);
    protocol.emitEvent("pong", { at: 42 });
    const [line] = await linesPromise;
    const parsed = JSON.parse(line!) as { kind: string; type: string; payload: { at: number } };
    expect(parsed.kind).toBe("event");
    expect(parsed.type).toBe("pong");
    expect(parsed.payload.at).toBe(42);
  });

  it("respond returns the correct correlationId and ok flag", async () => {
    const { output, protocol } = createProtocol();
    const linesPromise = readLines(output, 1);
    protocol.respond("req-123", { echoed: true });
    const [line] = await linesPromise;
    const parsed = JSON.parse(line!) as {
      kind: string;
      correlationId: string;
      ok: boolean;
      payload: { echoed: boolean };
    };
    expect(parsed.kind).toBe("response");
    expect(parsed.correlationId).toBe("req-123");
    expect(parsed.ok).toBe(true);
    expect(parsed.payload.echoed).toBe(true);
  });

  it("ignores blank lines between frames", async () => {
    const { input, protocol } = createProtocol();
    const received: HostRequest[] = [];
    protocol.onRequest((req) => received.push(req));
    const msg: HostRequest = { kind: "request", id: "x", type: "ping", payload: {} };
    input.write(`\n\n${JSON.stringify(msg)}\n\n`);
    await new Promise((r) => setImmediate(r));
    expect(received).toHaveLength(1);
  });
});
