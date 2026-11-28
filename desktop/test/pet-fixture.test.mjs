// ATO-2513: the desktop pet's machine (main/pet-state.ts) replays the same
// table of cases as the terminal pet's (src/tui/pet/pet-machine.ts). The
// desktop build cannot import src/, so the rules are kept twice; a rule
// changed in one and not the other fails this suite or the terminal's.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PetMachine, PET_STATES } = require("../out/main/pet-state.js");

const fixture = JSON.parse(readFileSync(new URL("../../src/tui/pet/pet-machine.fixture.json", import.meta.url), "utf8"));

for (const scenario of fixture.scenarios) {
  test(`shared case: ${scenario.name}`, () => {
    const m = new PetMachine(0, fixture.timing);
    for (const step of scenario.steps) {
      if (step.dnd !== undefined) m.setDoNotDisturb(step.dnd);
      if (step.ended) m.ended(step.ended, step.at);
      const out = m.step({ activity: step.activity ?? null, waiting: step.waiting ?? false }, step.at);
      assert.equal(out.state, step.state, `${scenario.name} at ${step.at}`);
      if ("nextAt" in step) assert.equal(out.nextAt, step.nextAt, `${scenario.name} next at ${step.at}`);
    }
  });
}

test("the table names every state the desktop pet has", () => {
  const seen = new Set(fixture.scenarios.flatMap((s) => s.steps.map((st) => st.state)));
  for (const st of PET_STATES) assert.ok(seen.has(st), st);
});
