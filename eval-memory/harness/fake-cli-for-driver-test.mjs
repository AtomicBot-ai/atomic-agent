#!/usr/bin/env node
/**
 * Tiny stand-in for `atomic-agent run` used by
 * `multi-turn-driver.test.ts`. Reads stdin line-by-line via Node's
 * `readline` (identical to the real CLI), echoes a deterministic
 * reply to stdout for each prompt, writes a small bookkeeping line
 * to stderr. Exits cleanly on EOF.
 *
 * Configurable via env vars (the driver always forwards
 * `ATOMIC_AGENT_STATE_DIR`; tests pass others through `opts.env`):
 *
 *   FAKE_CLI_REPLY_PREFIX   — prefix for each reply (default `reply-`)
 *   FAKE_CLI_PER_REPLY_MS   — sleep this many ms before each reply
 *                             (default 0). Lets the test simulate
 *                             realistic per-turn latency without an LLM.
 *   FAKE_CLI_NOISE_MULTILINE — when "1", emits a multi-line stderr blob
 *                              after every reply (the real CLI's
 *                              JSON.stringify summary is multi-line, so
 *                              the driver must tolerate stderr blobs
 *                              interleaved with reply lines).
 *   FAKE_CLI_MAX_REPLIES    — when set, exit cleanly after N replies
 *                              without waiting for EOF. Lets the test
 *                              simulate a CLI that goes `status:
 *                              completed` mid-stream.
 *   FAKE_CLI_FAIL_AT        — when set, throw after N replies to
 *                              simulate a CLI crash.
 *   FAKE_CLI_MULTILINE_AT   — when set to a CSV of integers, the reply
 *                              for those reply-indexes (1-based) is
 *                              emitted as a 4-line markdown bullet
 *                              block instead of a single line. Used
 *                              to reproduce the prompt↔reply pairing
 *                              slide caused by line-based stdout
 *                              splitting in the multi-turn driver
 *                              (see `multi-turn-driver.ts`
 *                              `stdoutBuffer.split(/\r?\n/)`).
 */

import { createInterface } from "node:readline";

const replyPrefix = process.env.FAKE_CLI_REPLY_PREFIX ?? "reply-";
const perReplyMs = parseInt(process.env.FAKE_CLI_PER_REPLY_MS ?? "0", 10);
const multilineNoise = process.env.FAKE_CLI_NOISE_MULTILINE === "1";
const maxReplies = process.env.FAKE_CLI_MAX_REPLIES
  ? parseInt(process.env.FAKE_CLI_MAX_REPLIES, 10)
  : null;
const failAt = process.env.FAKE_CLI_FAIL_AT
  ? parseInt(process.env.FAKE_CLI_FAIL_AT, 10)
  : null;
const multilineAt = new Set(
  (process.env.FAKE_CLI_MULTILINE_AT ?? "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0),
);

let counter = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rl = createInterface({ input: process.stdin, output: process.stderr });

process.stderr.write(`[fake-cli] start (pid=${process.pid})\n`);

// Use a serial async queue so per-reply sleep does not let the next
// line jump the queue.
let chain = Promise.resolve();
rl.on("line", (line) => {
  chain = chain.then(async () => {
    if (perReplyMs > 0) await sleep(perReplyMs);
    counter += 1;
    process.stderr.write(`[fake-cli] turn ${counter} echoed (received ${line.length} bytes)\n`);
    if (failAt !== null && counter === failAt) {
      throw new Error(`[fake-cli] simulated crash at reply #${counter}`);
    }
    if (multilineAt.has(counter)) {
      // Mimic the real CLI without the fix: a markdown bullet list
      // reply emitted as a single `stdout.write(reply + "\n")` —
      // which is 4 embedded newlines + 1 trailing newline = 5 lines
      // arriving in the driver in one chunk. The pre-fix driver
      // takes line 1 as the reply and pushes the other 4 into
      // `stdoutBacklog`, sliding every subsequent pairing by 4.
      process.stdout.write(
        `${replyPrefix}${counter}\n\n* bullet a\n* bullet b\n* bullet c\n`,
      );
    } else {
      process.stdout.write(`${replyPrefix}${counter}\n`);
    }
    if (multilineNoise) {
      process.stderr.write(
        `[fake-cli] {\n  "sessionId": "fake",\n  "turnCount": ${counter}\n}\n`,
      );
    }
    if (maxReplies !== null && counter >= maxReplies) {
      process.stderr.write(`[fake-cli] reached FAKE_CLI_MAX_REPLIES=${maxReplies}, exiting\n`);
      process.exit(0);
    }
  });
});

rl.on("close", () => {
  // Drain the queue then exit.
  chain.then(
    () => {
      process.stderr.write(`[fake-cli] stdin closed, exiting cleanly after ${counter} replies\n`);
      process.exit(0);
    },
    (err) => {
      process.stderr.write(`[fake-cli] queue failed: ${err.message}\n`);
      process.exit(1);
    },
  );
});
