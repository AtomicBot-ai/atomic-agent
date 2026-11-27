import { describe, expect, it } from "vitest";

import { LAUNCH_INTEGRATIONS } from "./launch-integrations.js";
import { formatLaunchChoices, launchChoices, readLaunchPick } from "./launch-picker.js";

describe("launch picker (ATO-2737)", () => {
  const choices = launchChoices((b) => (b === "codex" ? "/bin/codex" : null));
  const byId = (id: string) => LAUNCH_INTEGRATIONS.find((i) => i.id === id);

  it("marks each CLI installed or not, with the install command for the missing ones", () => {
    expect(choices.map((c) => [c.integration.id, c.installed])).toEqual(
      LAUNCH_INTEGRATIONS.map((i) => [i.id, i.id === "codex"]),
    );
    const text = formatLaunchChoices(choices);
    expect(text).toContain("not installed (npm install -g @anthropic-ai/claude-code)");
    expect(text).toMatch(/codex\s+Codex\s+installed\n/);
  });

  it("reads a number, an id or an alias; empty is no pick; anything else is invalid", () => {
    expect(readLaunchPick("1", choices)).toBe(LAUNCH_INTEGRATIONS[0]);
    expect(readLaunchPick(" Codex ", choices)).toBe(byId("codex"));
    expect(readLaunchPick("claude-code", choices)).toBe(byId("claude"));
    expect(readLaunchPick("", choices)).toBeNull();
    expect(readLaunchPick("0", choices)).toBe("invalid");
    expect(readLaunchPick(String(choices.length + 1), choices)).toBe("invalid");
    expect(readLaunchPick("vim", choices)).toBe("invalid");
  });
});
