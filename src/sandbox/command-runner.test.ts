import { describe, expect, it } from "vitest";

import { isBrokenPipe, runCommand } from "./command-runner.js";

/**
 * These run real children rather than a mocked `child_process`: the
 * behaviour under test is what the kernel does when a pipe's reader
 * disappears mid-write, which a mock cannot reproduce.
 */
function node(script: string) {
  return { command: process.execPath, args: ["-e", script] };
}

/** Exits without reading stdin — the shape of a CLI that rejects the request. */
const REJECTS_INPUT = `
  process.stderr.write("Please run /login to authenticate", () => process.exit(1));
`;

/** Reads stdin to the end and reports how many bytes arrived. */
const COUNTS_INPUT = `
  let n = 0;
  process.stdin.on("data", (c) => { n += c.length; });
  process.stdin.on("end", () => process.stdout.write(String(n)));
`;

const KIB = 1024;

describe("runCommand stdin", () => {
  it("survives a child that exits before draining a 1 MiB payload", async () => {
    // Without an `error` listener on `child.stdin` the EPIPE raised here
    // is an uncaught exception, which `installGlobalErrorHandlers` keeps
    // fatal: the whole agent exits(1) instead of reporting the child's
    // own failure. Measured boundary: 16 and 64 KiB flush into the pipe
    // buffer and never fault, 128 KiB and up always do.
    const { command, args } = node(REJECTS_INPUT);
    const result = await runCommand(command, args, {
      cwd: process.cwd(),
      input: "x".repeat(1024 * KIB),
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("/login");
    expect(result.inputTruncated).toBe(true);
  });

  it("reports the child's own exit code, not the broken pipe", async () => {
    const { command, args } = node(`
      process.stderr.write("weekly limit reached", () => process.exit(7));
    `);
    const result = await runCommand(command, args, {
      cwd: process.cwd(),
      input: "x".repeat(256 * KIB),
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(7);
    expect(result.stderr).toBe("weekly limit reached");
  });

  it("leaves inputTruncated false when the payload fits the pipe buffer", async () => {
    // 64 KiB lands in the buffer before the child is gone, so nothing
    // faults even though the child never reads it. The flag has to track
    // the actual write, not the mere fact that the child ignored stdin.
    const { command, args } = node(REJECTS_INPUT);
    const result = await runCommand(command, args, {
      cwd: process.cwd(),
      input: "x".repeat(64 * KIB),
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.inputTruncated).toBe(false);
  });

  it("delivers the whole payload to a child that reads it", async () => {
    const { command, args } = node(COUNTS_INPUT);
    const result = await runCommand(command, args, {
      cwd: process.cwd(),
      input: "x".repeat(1024 * KIB),
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(String(1024 * KIB));
    expect(result.inputTruncated).toBe(false);
  });
});

describe("isBrokenPipe", () => {
  it("matches the codes a vanished reader produces", () => {
    for (const code of [
      "EPIPE",
      "ECONNRESET",
      "EOF",
      "ERR_STREAM_DESTROYED",
      "ERR_STREAM_WRITE_AFTER_END",
    ]) {
      expect(isBrokenPipe(Object.assign(new Error("x"), { code }))).toBe(true);
    }
  });

  it("does not swallow errors that mean something else", () => {
    // These have to keep travelling as errors — absorbing everything on
    // the stream would turn a real local fault into a silent success.
    expect(isBrokenPipe(Object.assign(new Error("x"), { code: "EACCES" }))).toBe(
      false,
    );
    expect(isBrokenPipe(new Error("no code at all"))).toBe(false);
    expect(isBrokenPipe(null)).toBe(false);
  });
});
