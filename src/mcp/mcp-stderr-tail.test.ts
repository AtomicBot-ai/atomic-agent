import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { attachStderrTail, formatStderrTail } from "./mcp-stderr-tail.js";

describe("attachStderrTail", () => {
  it("captures output and settles when the stream ends", async () => {
    const stream = new PassThrough();
    const tail = attachStderrTail(stream);

    stream.write("first\n");
    stream.end("second\n");
    await tail.settle(1000);

    expect(tail.read()).toBe("first\nsecond\n");
  });

  it("settles on the timeout when the server stays alive", async () => {
    const tail = attachStderrTail(new PassThrough());
    const started = Date.now();
    await tail.settle(30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });

  it("keeps only the last 4000 chars so a chatty server cannot grow it", async () => {
    const stream = new PassThrough();
    const tail = attachStderrTail(stream);
    stream.write("x".repeat(5000));
    stream.end("TAIL");
    await tail.settle(1000);

    expect(tail.read()).toHaveLength(4000);
    expect(tail.read().endsWith("TAIL")).toBe(true);
  });

  it("tolerates a missing stream and a stream error", async () => {
    expect(attachStderrTail(null).read()).toBe("");
    await expect(attachStderrTail(undefined).settle(5)).resolves.toBeUndefined();

    const stream = new PassThrough();
    const tail = attachStderrTail(stream);
    stream.emit("error", new Error("EPIPE"));
    expect(tail.read()).toBe("");
  });
});

describe("formatStderrTail", () => {
  it("picks the cause out of a Node crash dump, not the trailing noise", () => {
    const dump = [
      "node:internal/modules/cjs/loader:1433",
      "  throw err;",
      "  ^",
      "",
      "Error [ERR_REQUIRE_ESM]: require() of ES Module /srv/tool.js not supported.",
      "    at Module._compile (node:internal/modules/cjs/loader:1234:14)",
      "  code: 'ERR_REQUIRE_ESM'",
      "}",
      "",
      "Node.js v22.23.1",
    ].join("\n");

    const out = formatStderrTail(dump);
    expect(out).toContain("ERR_REQUIRE_ESM");
    expect(out).toContain("require() of ES Module");
    expect(out).not.toContain("Node.js v22");
    expect(out).not.toContain("at Module._compile");
  });

  it("falls back to the last lines when nothing looks like a cause", () => {
    expect(formatStderrTail("usage: my-server [opts]\nsee --help\n")).toBe(
      "usage: my-server [opts] / see --help",
    );
  });

  it("strips ANSI colour and clips long output", () => {
    const coloured = "\u001B[31mENOENT: no such file\u001B[0m";
    expect(formatStderrTail(coloured)).toBe("ENOENT: no such file");
    expect(formatStderrTail(`Error: ${"y".repeat(400)}`, 3, 50)).toHaveLength(50);
  });

  it("returns empty for a silent server", () => {
    expect(formatStderrTail("")).toBe("");
    expect(formatStderrTail("\n  \n")).toBe("");
  });
});
