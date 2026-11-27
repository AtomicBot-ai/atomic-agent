// o1: "the agent runs ON this computer" (ATO-1723, user bug ATO-1706).
// On the 2B starter model the agent answered a RAM question with "I have no
// access to your hardware" and pointed at the cloud, although it has a shell
// on the very machine. The answer is the chat reply (stdout of `run`), not a
// file. The checker is deterministic: the real RAM of the machine running the
// check (os.totalmem() at check time, +-1, GiB or GB) must appear in the
// reply, and no refusal or "use the cloud" phrase may.

import { totalmem } from "node:os";

import { fail, pass } from "../lib/util.mjs";

const GIB = 1024 ** 3;
const GB = 1e9;

/** Phrases of the ATO-1706 refusal; any one fails the run even with the right number. */
export const REFUSAL_PHRASES = ["no access", "cannot access", "don't have access", "cloud"];

/** Numbers in a reply, dots as decimal marks ("16", "15.5"). Thousands commas split into parts. */
export function replyNumbers(text) {
  return (String(text).match(/\d+(?:\.\d+)?/g) ?? []).map(Number).filter(Number.isFinite);
}

/**
 * Deterministic verdict for a RAM reply. `totalBytes` is the machine's RAM in
 * bytes; both GiB (16 GiB) and decimal GB (17.2 GB) readings are accepted, +-1.
 */
export function checkRamReply(text, totalBytes) {
  const reply = String(text ?? "").replace(/[‘’]/g, "'").trim();
  if (!reply) return fail("no reply");
  const lower = reply.toLowerCase();
  const refusal = REFUSAL_PHRASES.find((p) => lower.includes(p));
  if (refusal) return fail(`reply says '${refusal}'`);
  const gib = totalBytes / GIB;
  const gb = totalBytes / GB;
  const numbers = replyNumbers(reply);
  const hit = numbers.some((n) => Math.abs(n - gib) <= 1 || Math.abs(n - gb) <= 1);
  if (hit) return pass();
  return fail(`no RAM size near ${gib.toFixed(1)} GiB / ${gb.toFixed(1)} GB in reply '${reply.slice(0, 60)}'`);
}

const o1 = {
  id: "o1",
  set: "core",
  title: "answer about its own computer (RAM) instead of claiming no access (ATO-1706)",
  timeoutSec: 300,
  maxSteps: 10,
  turns: () => ["How much RAM does this computer have? Answer with the number in GB."],
  fixture() {
    // Empty folder on purpose: the agent has to look at the machine, not a file.
    // Recorded for the run folder only; the checker reads os.totalmem() again.
    return { totalBytesAtFixture: totalmem() };
  },
  check(_dir, _meta, ctx = {}) {
    return checkRamReply(ctx.run?.stdout, totalmem());
  },
  /** Reference reply. The answer is chat text, so it goes into ctx.run.stdout, not the folder. */
  solve(_dir, _meta, ctx) {
    const gib = Math.round(totalmem() / GIB);
    ctx.run = { ...(ctx.run ?? {}), stdout: `This computer has ${gib} GB of RAM.\n` };
  },
};

export default [o1];
