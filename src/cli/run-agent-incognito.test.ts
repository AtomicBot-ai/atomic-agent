import { describe, expect, it } from "vitest";

import { parseRunArgs } from "./run-agent.js";

/** ATO-586: `atomic-agent run --incognito`. */
describe("run --incognito", () => {
  it("is off unless asked for", () => {
    expect(parseRunArgs([])).toMatchObject({ incognito: false });
  });

  it("turns on with the flag, beside the other options", () => {
    expect(parseRunArgs(["--incognito", "--max-steps", "5"])).toMatchObject({
      incognito: true,
      maxSteps: 5,
    });
  });
});
