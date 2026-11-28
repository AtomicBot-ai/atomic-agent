import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PET_PRIORITY, PET_STATES, PetMachine, type PetActivity, type PetEnding, type PetState } from "./pet-machine.js";

/**
 * The table both pet machines replay (ATO-2513): this one and the desktop's
 * (`desktop/test/pet-fixture.test.mjs`). A rule changed in one machine and
 * not the other fails one of the two suites.
 */
interface FixtureStep {
  at: number;
  activity?: PetActivity | null;
  waiting?: boolean;
  ended?: PetEnding;
  dnd?: boolean;
  state: PetState;
  nextAt?: number | null;
}
interface Fixture {
  timing: { minShowMs: number; doneMs: number; errorMs: number; sleepAfterMs: number };
  scenarios: Array<{ name: string; steps: FixtureStep[] }>;
}

const fixture = JSON.parse(
  readFileSync(new URL("./pet-machine.fixture.json", import.meta.url), "utf8"),
) as Fixture;

describe("terminal pet machine (ATO-2513)", () => {
  it("ranks the states as the desktop pet does", () => {
    for (let i = 1; i < PET_STATES.length; i++) {
      const higher = PET_STATES[i - 1] as PetState;
      const lower = PET_STATES[i] as PetState;
      expect(PET_PRIORITY[higher]).toBeGreaterThan(PET_PRIORITY[lower]);
    }
  });

  for (const scenario of fixture.scenarios) {
    it(`shared case: ${scenario.name}`, () => {
      const machine = new PetMachine(0, fixture.timing);
      for (const step of scenario.steps) {
        if (step.dnd !== undefined) machine.setDoNotDisturb(step.dnd);
        if (step.ended) machine.ended(step.ended, step.at);
        const out = machine.step({ activity: step.activity ?? null, waiting: step.waiting ?? false }, step.at);
        expect(out.state, `${scenario.name} at ${step.at}`).toBe(step.state);
        if ("nextAt" in step) expect(out.nextAt, `${scenario.name} next at ${step.at}`).toBe(step.nextAt);
      }
    });
  }

  it("has cases for every state the bar can show", () => {
    const seen = new Set(fixture.scenarios.flatMap((s) => s.steps.map((st) => st.state)));
    for (const state of PET_STATES) expect(seen.has(state), state).toBe(true);
  });
});
