// Unit tests for renderer/context-compaction.js (ATO-259, ATO-295).
// Run: npm run test:unit
// The chat's compaction lines and when `/compact` / "Compact now" can run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const C = createRequire(import.meta.url)("../renderer/context-compaction.js");

test("a finished compaction says how far the context shrank", () => {
  assert.deepEqual(C.compactionResultLine({ status: "compacted", tokens_before: 30000, tokens_after: 9500 }),
    { sev: "", text: "Conversation compacted: ~30k → ~9.5k tokens" });
  assert.equal(C.compactionResultLine({ status: "compacted" }).text, "Conversation compacted");
});

test("noop, busy and cancelled are plain lines; a failure warns and keeps the agent's reason", () => {
  assert.match(C.compactionResultLine({ status: "noop" }).text, /^Nothing to compact/);
  assert.match(C.compactionResultLine({ status: "busy" }).text, /already being compacted/);
  assert.match(C.compactionResultLine({ status: "cancelled" }).text, /^Compaction cancelled/);
  const failed = C.compactionResultLine({ status: "failed", message: "summary was empty." });
  assert.equal(failed.sev, "warn");
  assert.equal(failed.text, "Couldn't compact the conversation: summary was empty. The full history is kept");
});

test("no line uses an em dash", () => {
  const lines = [C.COMPACTING_LINE, C.HISTORY_TRIMMED_LINE,
    ...["compacted", "noop", "busy", "cancelled", "failed"].map((status) => C.compactionResultLine({ status, tokens_before: 2, tokens_after: 1 }).text)];
  for (const line of lines) assert.ok(!line.includes("—"), line);
});

test("progress names the part only when the summary is written in pieces", () => {
  assert.equal(C.compactionProgressLine({ chunk: 1, chunks: 1 }), C.COMPACTING_LINE);
  assert.equal(C.compactionProgressLine({ chunk: 2, chunks: 3 }), C.COMPACTING_LINE + " part 2 of 3");
});

test("the manual command is off while a turn runs, while compacting, and before the chat is saved", () => {
  const ready = { supported: true, compacting: false, busy: false, sessionId: "s1" };
  assert.equal(C.compactBlockedReason(ready), "");
  assert.notEqual(C.compactBlockedReason({ ...ready, busy: true }), "");
  assert.notEqual(C.compactBlockedReason({ ...ready, compacting: true }), "");
  assert.notEqual(C.compactBlockedReason({ ...ready, sessionId: null }), "");
  assert.notEqual(C.compactBlockedReason({ ...ready, sessionId: "waiting-123" }), "");
  assert.notEqual(C.compactBlockedReason({ ...ready, supported: false }), "");
});

// ATO-661: `/compact <what to keep>`, as Claude Code's `/compact [instructions]`.
test("the words after /compact are what to keep; none is a plain compaction", () => {
  assert.deepEqual(C.compactInstructionsFrom(["keep", "the", "API", "design"]), { ok: true, text: "keep the API design" });
  assert.deepEqual(C.compactInstructionsFrom([]), { ok: true, text: "" });
  assert.deepEqual(C.compactInstructionsFrom(["", " "]), { ok: true, text: "" });
});

test("a keep text over the agent's 2000-character limit is refused with the usage", () => {
  const r = C.compactInstructionsFrom(["x".repeat(C.COMPACT_INSTRUCTIONS_MAX + 1)]);
  assert.equal(r.ok, false);
  assert.match(r.error, /too long/);
  assert.ok(r.error.includes(C.COMPACT_USAGE));
  assert.equal(C.compactInstructionsFrom(["x".repeat(C.COMPACT_INSTRUCTIONS_MAX)]).ok, true);
});

test("the running row says what is kept, clipped", () => {
  assert.equal(C.compactingLineFor(""), C.COMPACTING_LINE);
  assert.equal(C.compactingLineFor("keep  the\nAPI"), C.COMPACTING_LINE + " Keeping: keep the API");
  const long = C.compactingLineFor("y".repeat(500));
  assert.ok(long.length < C.COMPACTING_LINE.length + 140);
  assert.ok(long.endsWith("…"));
});

test("a compacted line carries the agent's note, such as instructions not applied", () => {
  const r = C.compactionResultLine({ status: "compacted", tokens_before: 30000, tokens_after: 9500,
    message: "Your compaction instructions were not applied: the checkpoint was extracted without a model call." });
  assert.equal(r.sev, "");
  assert.equal(r.text, "Conversation compacted: ~30k → ~9.5k tokens. Your compaction instructions were not applied: the checkpoint was extracted without a model call");
  assert.ok(!C.COMPACT_USAGE.includes("—"));
});
