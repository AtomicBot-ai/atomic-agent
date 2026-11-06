// Stress set: inputs bigger than the model's window.
//
// n32k…n1m (T6–T10, ATO-787): one huge log, generated per run from a seed
// (never committed), with a single AUDIT needle and a count question. The
// agent can only pass by searching or reading in chunks; the checker also
// asks the trace for evidence of that (search tool, grep/head/tail, or a
// ranged read).
//
// l1 (ATO-895): a multi-turn session that reads more text than the window
// holds, so compaction must kick in at 32K and 64K, and the agent still has
// to finish the job afterwards.

import { usedChunkedAccess } from "../lib/trace.mjs";
import { fail, makeRng, pass, readText, writeFiles } from "../lib/util.mjs";

/** Rough chars-per-token for these synthetic logs (numbers, hex, paths). Documented as approximate. */
export const LOG_CHARS_PER_TOKEN = 3.5;
/** Rough chars-per-token for the English-like notes in l1. */
export const PROSE_CHARS_PER_TOKEN = 4;

const SERVICES = ["api", "auth", "billing", "cron", "gateway", "search", "worker"];
const PATHS = ["/api/orders", "/api/users", "/login", "/health", "/api/search", "/api/cart", "/static/app.js"];

/** Deterministic huge log. Returns { text, key, count, lines }. */
export function makeNeedleLog(tokens, seed = `needle:${tokens}`) {
  const rng = makeRng(seed);
  const targetBytes = Math.ceil(tokens * LOG_CHARS_PER_TOKEN);
  const lines = [];
  let bytes = 0;
  let sec = 0;
  while (bytes < targetBytes) {
    sec += rng.int(0, 3);
    const ts = new Date(Date.UTC(2026, 10, 2, 0, 0, sec)).toISOString().replace(".000", "");
    const svc = `${rng.pick(SERVICES)}-${String(rng.int(1, 12)).padStart(2, "0")}`;
    const line =
      rng.next() < 0.06
        ? `${ts} ERROR ${svc} code=E${rng.int(10, 39)} msg=upstream ${rng.pick(["timeout", "reset", "refused", "overloaded"])} req=${rng.hex(6)}`
        : `${ts} ${rng.pick(["INFO", "INFO", "INFO", "WARN"])} ${svc} req=${rng.hex(6)} path=${rng.pick(PATHS)} status=${rng.pick([200, 200, 200, 201, 304, 404])} latency=${rng.int(3, 900)}ms`;
    lines.push(line);
    bytes += line.length + 1;
  }
  const used = new Set();
  const freeIndex = (lo, hi) => {
    for (;;) {
      const i = rng.int(lo, hi);
      if (!used.has(i)) {
        used.add(i);
        return i;
      }
    }
  };
  const n = lines.length;
  const stamp = (i) => lines[i].slice(0, 20);
  const key = `${rng.code(4)}-${rng.code(4)}`;
  const ni = freeIndex(Math.floor(n * 0.2), Math.floor(n * 0.8));
  lines[ni] = `${stamp(ni)} AUDIT security-01 key=${key} owner=ops note=rotate-before-release`;
  const count = rng.int(5, 30);
  for (let c = 0; c < count; c += 1) {
    const i = freeIndex(0, n - 1);
    lines[i] = `${stamp(i)} ERROR ${rng.pick(SERVICES)}-01 code=E42 msg=checksum mismatch req=${rng.hex(6)}`;
  }
  const decoys = rng.int(3, 10);
  for (let c = 0; c < decoys; c += 1) {
    const i = freeIndex(0, n - 1);
    lines[i] = `${stamp(i)} ERROR ${rng.pick(SERVICES)}-02 code=E420 msg=quota warning req=${rng.hex(6)}`;
  }
  return { text: `${lines.join("\n")}\n`, key, count, lines: n };
}

function needleTask(id, tokens, label) {
  return {
    id,
    set: "stress",
    title: `needle in a ${label}-token log (search or read in chunks)`,
    timeoutSec: 1200,
    maxSteps: 40,
    turns: () => [
      `data/events.log is a very large log file, about ${label} tokens, which is more than you can read at once, so do not try to read it whole. ` +
        "Use search or read it in parts. Find the only line that contains the word AUDIT and copy the value after key= on that line. " +
        'Also count the lines that contain "code=E42 " (code E42 exactly; code=E420 does not count). ' +
        "Write answer.txt in the current folder with two lines: first the key, then the count.",
    ],
    fixture(dir) {
      const { text, key, count, lines } = makeNeedleLog(tokens);
      writeFiles(dir, { "data/events.log": text });
      return { key, count: String(count), lines, bytes: Buffer.byteLength(text) };
    },
    check(dir, meta, ctx = {}) {
      const a = readText(dir, "answer.txt");
      if (a === null) return fail("answer.txt missing");
      const lines = a.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
      const key = (lines[0] ?? "").replace(/^key=/, "");
      if (key !== meta.key) return fail(`key '${key.slice(0, 20)}' wrong`);
      const cnt = (lines[1] ?? "").replace(/\D+/g, "");
      if (cnt !== meta.count) return fail(`count '${lines[1] ?? ""}' want ${meta.count}`);
      const trace = ctx.trace;
      if (!trace?.found) return fail("no trace to verify chunked access");
      if (!usedChunkedAccess(trace.toolCalls)) return fail("right answer but no search or ranged read in the trace");
      return pass();
    },
    solve(dir, meta) {
      writeFiles(dir, { "answer.txt": `${meta.key}\n${meta.count}\n` });
    },
  };
}

const WORDS = (
  "river stone lamp orbit garden signal copper window harbor meadow engine pocket ladder candle forest " +
  "market planet violin ribbon thunder marble feather canyon silver lantern compass blanket island tunnel"
).split(" ");
const VERBS = "carries holds follows shapes guards crosses measures warms lifts gathers".split(" ");

/** Parts needed so the reading alone is ~1.5x the window (forces at least one compaction). */
export function longSessionParts(window) {
  return Math.max(8, Math.ceil((window * 1.5) / 3500));
}

/** Deterministic notes: `count` parts of ~3.5K tokens, one CODE line each. */
export function makeNotes(count, seed = "l1") {
  const rng = makeRng(seed);
  const files = {};
  const codes = [];
  const targetChars = 3500 * PROSE_CHARS_PER_TOKEN;
  for (let p = 1; p <= count; p += 1) {
    const nn = String(p).padStart(2, "0");
    const topic = `${rng.pick(WORDS)} and ${rng.pick(WORDS)}`;
    const code = `${rng.pick(WORDS)}-${rng.int(100, 999)}`;
    codes.push(code);
    const paras = [`# Part ${nn}: ${topic}`, ""];
    let size = 0;
    const codeAt = rng.int(3, 12);
    let para = 0;
    while (size < targetChars) {
      const sentences = [];
      for (let s = 0; s < 6; s += 1) {
        sentences.push(`The ${rng.pick(WORDS)} ${rng.pick(VERBS)} the ${rng.pick(WORDS)} near the ${rng.pick(WORDS)} while the ${rng.pick(WORDS)} ${rng.pick(VERBS)} ${rng.int(2, 99)} ${rng.pick(WORDS)}s.`);
      }
      const text = sentences.join(" ");
      paras.push(text, "");
      size += text.length + 1;
      para += 1;
      if (para === codeAt) paras.push(`CODE part-${nn}: ${code}`, "");
    }
    if (para < codeAt) paras.push(`CODE part-${nn}: ${code}`, "");
    files[`notes/part-${nn}.md`] = paras.join("\n");
  }
  return { files, codes };
}

export function longSessionTurns(count) {
  const turns = [];
  const nn = (i) => String(i).padStart(2, "0");
  for (let p = 1; p <= count; p += 2) {
    const pair = p + 1 <= count ? `notes/part-${nn(p)}.md and notes/part-${nn(p + 1)}.md` : `notes/part-${nn(p)}.md`;
    turns.push(
      `Read ${pair} in full (open the files and read all of the text, do not just search them). ` +
        "Reply with one short sentence about what each part talks about, and copy its CODE line.",
    );
  }
  turns.push(
    `Now write codes.txt in the current folder: the CODE values of all ${count} parts (only the value after the colon, like amber-417), ` +
      `in order from part 01 to part ${nn(count)}, one per line. If you no longer remember a value, open that file again.`,
  );
  return turns;
}

const l1 = {
  id: "l1",
  set: "stress",
  title: "long multi-turn session that must survive compaction (ATO-895)",
  timeoutSec: 2700,
  maxSteps: 30,
  turns: (ctx) => longSessionTurns(longSessionParts(ctx.window)),
  fixture(dir, ctx) {
    const count = longSessionParts(ctx.window);
    const { files, codes } = makeNotes(count);
    writeFiles(dir, files);
    return { codes, parts: count, approxTokens: count * 3500 };
  },
  check(dir, meta, ctx = {}) {
    const run = ctx.run;
    if (run && run.turnsSent < run.totalTurns) return fail(`agent stopped after turn ${run.turnsSent} of ${run.totalTurns}`);
    const trace = ctx.trace;
    if (trace?.found && trace.compactionFailures > 0 && trace.compactions === 0) return fail("compaction failed and never succeeded");
    const t = readText(dir, "codes.txt");
    if (t === null) return fail("codes.txt missing");
    const got = t.replace(/\r/g, "").split("\n").map((l) => l.trim().replace(/^CODE part-\d+:\s*/, "")).filter(Boolean);
    const wrong = meta.codes.findIndex((c, i) => got[i] !== c);
    if (got.length !== meta.codes.length || wrong >= 0) {
      return fail(`codes.txt: ${got.length}/${meta.codes.length} lines, first wrong at part ${wrong + 1}`);
    }
    return { pass: true, reason: "", details: { compactions: trace?.compactions ?? null, exercised: (trace?.compactions ?? 0) > 0 } };
  },
  solve(dir, meta) {
    writeFiles(dir, { "codes.txt": `${meta.codes.join("\n")}\n` });
  },
};

export default [
  needleTask("n32k", 32_000, "32K"),
  needleTask("n64k", 64_000, "64K"),
  needleTask("n128k", 128_000, "128K"),
  needleTask("n512k", 512_000, "512K"),
  needleTask("n1m", 1_000_000, "1M"),
  l1,
];
