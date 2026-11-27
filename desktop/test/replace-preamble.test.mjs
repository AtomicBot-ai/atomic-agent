// ATO-2738: the model's lead-in, fence and quotes taken off an answer before
// it goes back in place of the selection (main/replace-preamble.ts, built output).
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { stripModelPreamble: strip } = require("../out/main/replace-preamble.js");

test("a lead-in line that announces the text goes", () => {
  assert.equal(strip("Here is the rewritten text:\n\nBetter words."), "Better words.");
  assert.equal(strip("Here's the translation:\nBonjour."), "Bonjour.");
  assert.equal(strip("Here’s a shorter version:\n\nShort."), "Short.");
  assert.equal(strip("Sure! Here is the improved paragraph:\n\nA better paragraph."), "A better paragraph.");
  assert.equal(strip("Certainly, here is the corrected text:\nFixed."), "Fixed.");
  assert.equal(strip("Below is the edited email:\n\nHi Sam,\nSee you."), "Hi Sam,\nSee you.");
});

test("a bare Sure! counts only right before such a lead-in", () => {
  assert.equal(strip("Sure!\n\nHere is the rewritten text:\n\nBetter."), "Better.");
  assert.equal(strip("Certainly.\nHere's the revised text:\nRevised."), "Revised.");
});

test("one fence or one pair of quotes around the whole answer goes, also after a lead-in", () => {
  assert.equal(strip("```\nconst x = 1;\n```"), "const x = 1;");
  assert.equal(strip("```js\nconst x = 1;\n```"), "const x = 1;");
  assert.equal(strip("Here is the updated text:\n\n```\nNew text\n```"), "New text");
  assert.equal(strip('"Better words."'), "Better words.");
  assert.equal(strip("“Better words.”"), "Better words.");
  assert.equal(strip("«Mieux.»"), "Mieux.");
  assert.equal(strip('Here is the rewritten sentence:\n"Better words."'), "Better words.");
});

test("the person's own text stays: a real opening, a real closing, quotes inside, two fences", () => {
  const kept = [
    "Sure! I'd be happy to join on Friday.",
    "Sure!\n\nI'll be there at 5.",
    "Here is the agenda:\n1. Budget\n2. Hiring",
    "Thanks for the notes. Let me know if you have questions.",
    '"Yes," she said, "tomorrow."',
    "```\na\n```\nand\n```\nb\n```",
    "Here is the rewritten text:",
    "It's 'fine'",
  ];
  for (const t of kept) assert.equal(strip(t), t, t);
});

test("a lead-in that is the selection's own first line stays; a model's own one still goes", () => {
  const opts = (selection) => ({ selection });
  for (const first of ["Here is the updated schedule:", "Here's the draft of the contract:", "Here are the corrected figures:"]) {
    const answer = first + "\nMon 9am";
    assert.equal(strip(answer, opts("  " + first + "\r\nMon 9 am")), answer, first);
    assert.equal(strip(answer), "Mon 9am", "no selection: " + first);
  }
  assert.equal(strip("Sure!\nHere is the rewritten text:\nBetter.", opts("Old words.")), "Better.");
  assert.equal(strip("Here is the updated schedule:\nMon 9am", opts("Mon 9 am")), "Mon 9am");
  assert.equal(strip("Here is the updated schedule:\nMon 9am", opts(null)), "Mon 9am");
});

test("line ends made \\n, ends trimmed, nothing for nothing", () => {
  assert.equal(strip("  Here is the text:\r\n\r\nLine one\r\nLine two  "), "Line one\nLine two");
  assert.equal(strip("   "), "");
  assert.equal(strip('""'), '""', "empty quotes are not unwrapped to nothing");
});
