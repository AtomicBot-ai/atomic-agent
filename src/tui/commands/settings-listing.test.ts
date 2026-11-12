import { describe, expect, it } from "vitest";

import { buildSettingsReference } from "../../config/settings-reference.js";
import { renderSettingsOverview, renderSettingsSearch, SETTINGS_SEARCH_LIMIT } from "./settings-listing.js";

const entries = buildSettingsReference(
  [
    { key: "agent.maxSteps", defaultValue: 25, isArray: false },
    { key: "agent.toolTimeoutMs", defaultValue: 60_000, isArray: false },
    { key: "memory.links.enabled", defaultValue: true, isArray: false },
  ],
  { "agent.maxSteps": { type: "number", description: "Steps in one leg of a task." } },
  [],
);

describe("/settings", () => {
  it("lists the blocks and how to search when given no words", () => {
    const text = renderSettingsOverview(entries);
    expect(text).toContain("3 settings in config.json: agent (2), memory (1).");
    expect(text).toContain("/settings <words>");
  });

  it("shows matching keys with default, type, description and a changed value", () => {
    const text = renderSettingsSearch("steps", entries, new Map([["agent.maxSteps", "40"]]));
    expect(text).toContain("agent.maxSteps = 40  (default 25)  [number]");
    expect(text).toContain("Steps in one leg of a task.");
    expect(text).not.toContain("memory.links.enabled");
  });

  it("says when nothing matches", () => {
    expect(renderSettingsSearch("nothing-like-this", entries, new Map())).toContain('no setting matches "nothing-like-this"');
  });

  it("caps a broad search and says how many are left", () => {
    const many = buildSettingsReference(
      Array.from({ length: SETTINGS_SEARCH_LIMIT + 3 }, (_, i) => ({ key: `memory.k${i}`, defaultValue: i, isArray: false })),
      {},
      [],
    );
    const text = renderSettingsSearch("memory", many, new Map());
    expect(text).toContain("… 3 more");
  });

  it("searches the real reference by default", () => {
    expect(renderSettingsSearch("stopOnExit", undefined, new Map())).toContain("localModels.managed.stopOnExit");
  });
});
