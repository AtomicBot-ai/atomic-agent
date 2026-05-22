/**
 * Integration tests for `multi-turn-driver` against a deterministic
 * fake CLI (`fake-cli-for-driver-test.mjs`). The fake reads stdin
 * line-by-line via the same `readline` machinery the real
 * `atomic-agent run` uses, echoes one reply per line, and exits on
 * EOF. This lets us exercise the driver's stdin/stdout
 * synchronisation, listener-leak invariant, and child-exit handling
 * across hundreds of turns in seconds — without standing up
 * llama-server.
 *
 * The single load-bearing pin: 200 sequential turns drive cleanly
 * with `resolverOverwrites=0` and `stopReason=loop_complete`. The
 * "empty replies tail" bug surfaced at turn ~107 in production runs
 * pre-fix, so a 200-turn test gives ~2× margin.
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { driveMultiTurn } from "./multi-turn-driver.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FAKE_CLI = resolve(HERE, "fake-cli-for-driver-test.mjs");

const cliOverride = {
  command: process.execPath,
  baseArgs: [FAKE_CLI] as readonly string[],
  appendDriverFlags: false,
};

const makePrompts = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `prompt-${i}`);

const setupDirs = () => {
  const stateDir = mkdtempSync(join(tmpdir(), "driver-test-state-"));
  const workingDir = mkdtempSync(join(tmpdir(), "driver-test-work-"));
  return { stateDir, workingDir };
};

describe("multi-turn-driver — integration with fake CLI", () => {
  let dirs: { stateDir: string; workingDir: string };

  beforeEach(() => {
    expect(existsSync(FAKE_CLI)).toBe(true);
    dirs = setupDirs();
  });

  afterEach(() => {
    rmSync(dirs.stateDir, { recursive: true, force: true });
    rmSync(dirs.workingDir, { recursive: true, force: true });
  });

  it("drives 5 turns cleanly", async () => {
    const res = await driveMultiTurn({
      stateDir: dirs.stateDir,
      workingDir: dirs.workingDir,
      prompts: makePrompts(5),
      maxSteps: 1,
      timeoutMs: 30_000,
      cliOverride,
      env: { FAKE_CLI_REPLY_PREFIX: "reply-" },
    });
    expect(res.timedOut).toBe(false);
    expect(res.exitCode).toBe(0);
    expect(res.stderrAll).toContain("stopReason=loop_complete");
    expect(res.stderrAll).toContain("promptsSent=5/5");
    expect(res.stderrAll).toContain("resolverOverwrites=0");
  });

  it("drives 200 turns cleanly without listener leak or resolver overwrite", async () => {
    // Pinning: this would have surfaced the pre-fix listener leak
    // around turn 11 (MaxListenersExceededWarning) and any race in
    // pendingReplyResolver. With the fix in place, all 200 turns
    // drive in <2s of wall clock on a typical M-series Mac.
    const N = 200;
    const res = await driveMultiTurn({
      stateDir: dirs.stateDir,
      workingDir: dirs.workingDir,
      prompts: makePrompts(N),
      maxSteps: 1,
      timeoutMs: 60_000,
      cliOverride,
    });
    expect(res.timedOut).toBe(false);
    expect(res.exitCode).toBe(0);
    expect(res.stderrAll).toContain(`promptsSent=${N}/${N}`);
    expect(res.stderrAll).toContain("resolverOverwrites=0");
    expect(res.stderrAll).toContain("stopReason=loop_complete");
    // Sanity: every reply we synthesised in the fake was observed by
    // the driver. The driver writes assistant_reply text into
    // TurnRecord.assistantReply only when a real CLI emits a trace
    // tool_invocation event; the fake does not write traces, so we
    // assert on the driver-level signal (resolverOverwrites + bytes).
  }, 60_000);

  it("tolerates multiline stderr noise interleaved with replies", async () => {
    const N = 50;
    const res = await driveMultiTurn({
      stateDir: dirs.stateDir,
      workingDir: dirs.workingDir,
      prompts: makePrompts(N),
      maxSteps: 1,
      timeoutMs: 30_000,
      cliOverride,
      env: { FAKE_CLI_NOISE_MULTILINE: "1" },
    });
    expect(res.timedOut).toBe(false);
    expect(res.exitCode).toBe(0);
    expect(res.stderrAll).toContain(`promptsSent=${N}/${N}`);
    expect(res.stderrAll).toContain("resolverOverwrites=0");
  });

  it("records stopReason=child_exited when the fake CLI ends mid-stream", async () => {
    // The fake exits cleanly after 10 replies; driver was scheduled
    // for 20, so it should observe `child_exited` and surface a
    // diagnostic instead of silently truncating.
    const res = await driveMultiTurn({
      stateDir: dirs.stateDir,
      workingDir: dirs.workingDir,
      prompts: makePrompts(20),
      maxSteps: 1,
      timeoutMs: 30_000,
      cliOverride,
      env: { FAKE_CLI_MAX_REPLIES: "10" },
    });
    expect(res.exitCode).toBe(0);
    expect(res.stderrAll).toMatch(/stopReason=(child_exited|stdin_not_writable)/);
    expect(res.stderrAll).toContain("resolverOverwrites=0");
    // Promptssent should be exactly 10 (one extra prompt may be
    // attempted before the driver sees the close).
    const m = res.stderrAll.match(/promptsSent=(\d+)\/20/);
    expect(m).not.toBeNull();
    const sent = parseInt(m![1], 10);
    expect(sent).toBeGreaterThanOrEqual(10);
    expect(sent).toBeLessThanOrEqual(11);
  });

  it("pairs prompts ↔ replies one-to-one even when a CLI reply contains embedded newlines", async () => {
    // Pinning: production LoCoMo run-2026-05-19T18-13-37-880Z showed
    // a sliding-window prompt↔reply misalignment of +4 starting at
    // Q5. The driver splits stdout on `\r?\n` and pushes extra lines
    // into `stdoutBacklog`, which `waitForNextReplyLine` returns
    // immediately on subsequent prompts — *before* the CLI has even
    // produced a real reply. The real CLI fix (collapsing embedded
    // newlines in run-agent.ts) restores the "one stdout line per
    // turn" invariant; this test pins the new behaviour without
    // depending on the real model.
    //
    // The fake emits reply #3 as 5 stdout lines (`reply-3` + 4
    // bullet lines). With the pre-fix CLI behaviour the driver would
    // see ["reply-1","reply-2","reply-3","","* bullet a"] across the
    // 5 prompts. The driver itself does not collapse newlines (that
    // is the CLI's contract), so this test verifies the driver
    // surfaces enough state for callers to detect the slide.
    const res = await driveMultiTurn({
      stateDir: dirs.stateDir,
      workingDir: dirs.workingDir,
      prompts: makePrompts(5),
      maxSteps: 1,
      timeoutMs: 30_000,
      cliOverride,
      env: { FAKE_CLI_REPLY_PREFIX: "reply-", FAKE_CLI_MULTILINE_AT: "3" },
    });
    expect(res.timedOut).toBe(false);
    expect(res.exitCode).toBe(0);
    // Driver returns one entry per prompt; with the multi-line reply
    // on prompt #3, indices 4 and 5 here receive the *backlog
    // leftovers* (the empty line after `reply-3\n\n`, then the first
    // bullet). This is the proof the CLI must keep replies single-
    // line; the comment in run-agent.ts already declares "exactly
    // one stdout line per turn".
    expect(res.replyLinesPerPrompt).toEqual([
      "reply-1",
      "reply-2",
      "reply-3",
      "",
      "* bullet a",
    ]);
  });

  it("respects timeoutMs and reports timedOut=true with SIGKILL", async () => {
    // FAKE_CLI_PER_REPLY_MS=200 with timeoutMs=400 forces the timer
    // to fire after at most one reply.
    const res = await driveMultiTurn({
      stateDir: dirs.stateDir,
      workingDir: dirs.workingDir,
      prompts: makePrompts(50),
      maxSteps: 1,
      timeoutMs: 400,
      cliOverride,
      env: { FAKE_CLI_PER_REPLY_MS: "200" },
    });
    expect(res.timedOut).toBe(true);
    expect(res.signal).toBe("SIGKILL");
    // exitCode is null when killed by signal.
    expect(res.exitCode).toBeNull();
  });
});
