import { describe, expect, it, vi } from "vitest";

/**
 * The Windows failure both CLI paths have to survive, reproduced on any
 * host: Node hands EACCES/EAGAIN/EMFILE/ENFILE/ENOENT to the child's
 * `error` event and *throws* every other errno straight out of
 * `ChildProcess.prototype.spawn`. A `.cmd`/`.bat` target spawned without
 * a shell has failed with EINVAL since the CVE-2024-27980 fix, so the
 * throw is what production actually sees — and mocking `spawn` is the
 * only way to produce it off Windows.
 */
const SHIM = "C:\\npm\\claude.cmd";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (file: string, ...rest: unknown[]) => {
      if (file === SHIM) {
        throw Object.assign(new Error("spawn EINVAL"), {
          code: "EINVAL",
          errno: -22,
          syscall: "spawn",
          path: file,
        });
      }
      return (actual.spawn as (...a: unknown[]) => unknown)(file, ...rest);
    },
  };
});

const { runCliCommand } = await import("./run-cli-completion.js");
const { streamCliCommand } = await import("./stream-cli-completion.js");
const { SubscriptionCliSpawnError } = await import(
  "./subscription-cli-errors.js"
);

const options = {
  binary: SHIM,
  args: ["--print"],
  cwd: process.cwd(),
  timeoutMs: 5_000,
  maxOutputBytes: 4096,
  installHint: "Install Claude Code.",
  authHint: "Run `claude` and complete /login.",
};

describe("a spawn that throws EINVAL", () => {
  it("becomes a typed error on the buffered path", async () => {
    await expect(runCliCommand(options)).rejects.toBeInstanceOf(
      SubscriptionCliSpawnError,
    );
    await expect(runCliCommand(options)).rejects.toThrow(
      /could not be started[\s\S]*Install Claude Code\./,
    );
  });

  it("becomes a typed error on the streaming path", async () => {
    // `spawn` is the generator's first statement, so nothing catches
    // this unless the call itself is guarded.
    await expect(streamCliCommand(options).next()).rejects.toBeInstanceOf(
      SubscriptionCliSpawnError,
    );
  });

  it("still reports a genuinely missing binary as not installed", async () => {
    const missing = { ...options, binary: "definitely-not-a-real-binary-xyz" };
    await expect(runCliCommand(missing)).rejects.toThrow(/was not found on PATH/);
    await expect(streamCliCommand(missing).next()).rejects.toThrow(
      /was not found on PATH/,
    );
  });
});
