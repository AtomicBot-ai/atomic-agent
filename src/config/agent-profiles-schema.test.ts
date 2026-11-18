import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_PROFILE_DESCRIPTION_CHARS,
  MAX_PROFILE_PROMPT_CHARS,
  MAX_PROFILE_TOOLS,
} from "../agent-profiles/agent-profile.js";
import { parseAgentProfilesConfig } from "./agent-profiles-schema.js";
import { setConfigNoticeSink } from "./config-primitives.js";
import { ConfigValidationError } from "./config-validation-error.js";

const FIELD = "llm.runMode.agentProfiles";

// Notices are said once per process, so each case uses its own keys.
let notices: string[] = [];
beforeEach(() => {
  notices = [];
  setConfigNoticeSink((line) => notices.push(line));
});
afterEach(() => {
  setConfigNoticeSink(null);
});

/** Parse `{ [key]: entry, ok: valid }`: the broken entry is dropped, `ok` stays. */
function expectSkipped(key: string, entry: unknown, reason: string): void {
  expect(
    parseAgentProfilesConfig({ [key]: entry, ok: { prompt: "Still here." } }, FIELD),
  ).toEqual({ ok: { prompt: "Still here." } });
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain(`${FIELD}.${key}`);
  expect(notices[0]).toContain(reason);
  expect(notices[0]).toContain("this profile is skipped");
}

describe("parseAgentProfilesConfig (ATO-1667)", () => {
  it("parses a valid map, trimming text and dropping unknown fields", () => {
    expect(
      parseAgentProfilesConfig(
        {
          reviewer: {
            description: "  Reads a change and reports problems ",
            prompt: "\n  Find bugs. Report file and line.\n",
            model: " review ",
            tools: ["os.fs.read", " Grep ", "os.fs.read", ""],
            color: "red",
          },
          "Code_Explorer-2": { prompt: "Find code." },
        },
        FIELD,
      ),
    ).toEqual({
      reviewer: {
        description: "Reads a change and reports problems",
        prompt: "Find bugs. Report file and line.",
        model: "review",
        tools: ["os.fs.read", "Grep"],
      },
      "code_explorer-2": { prompt: "Find code." },
    });
    expect(notices).toEqual([]);
  });

  it("reads an empty map as no profiles, and absent or null as unset", () => {
    expect(parseAgentProfilesConfig({}, FIELD)).toEqual({});
    expect(parseAgentProfilesConfig(undefined, FIELD)).toBeUndefined();
    expect(parseAgentProfilesConfig(null, FIELD)).toBeUndefined();
  });

  it("treats an empty tools list as no allowlist, as a profile file does", () => {
    expect(parseAgentProfilesConfig({ a: { prompt: "x", tools: [] } }, FIELD)).toEqual({
      a: { prompt: "x" },
    });
  });

  it("splits a comma-separated tools string like profile frontmatter", () => {
    expect(
      parseAgentProfilesConfig({ split: { prompt: "x", tools: "Read, Grep,,os.fs.read , Read" } }, FIELD),
    ).toEqual({ split: { prompt: "x", tools: ["Read", "Grep", "os.fs.read"] } });
    expect(parseAgentProfilesConfig({ blank: { prompt: "x", tools: " , " } }, FIELD)).toEqual({
      blank: { prompt: "x" },
    });
  });

  it.each([["has space"], ["-leading-dash"], ["plugin:agent"], [""], ["a".repeat(65)]])(
    "skips the profile name %j with a notice and keeps the others",
    (name) => {
      expectSkipped(name, { prompt: "x" }, "profile name must be");
    },
  );

  it("skips the second key that lower-cases to a taken name", () => {
    expect(
      parseAgentProfilesConfig({ dup: { prompt: "first" }, DUP: { prompt: "second" } }, FIELD),
    ).toEqual({ dup: { prompt: "first" } });
    expect(notices).toEqual([
      `[atomic-agent] ${FIELD}.DUP: duplicate profile name: dup; this profile is skipped`,
    ]);
  });

  it("skips an over-long description at the file's limit", () => {
    const ok = "d".repeat(MAX_PROFILE_DESCRIPTION_CHARS);
    expect(parseAgentProfilesConfig({ desc: { prompt: "x", description: ok } }, FIELD)).toEqual({
      desc: { prompt: "x", description: ok },
    });
    expectSkipped(
      "desc-long",
      { prompt: "x", description: `${ok}d` },
      `${FIELD}.desc-long.description: longer than ${MAX_PROFILE_DESCRIPTION_CHARS} chars`,
    );
  });

  it("skips a missing prompt", () => {
    expectSkipped("no-prompt", {}, `${FIELD}.no-prompt.prompt: expected a non-empty string`);
  });

  it("skips a blank prompt", () => {
    expectSkipped("blank-prompt", { prompt: "   " }, `${FIELD}.blank-prompt.prompt`);
  });

  it("skips a prompt over the file's body limit", () => {
    expectSkipped(
      "long-prompt",
      { prompt: "p".repeat(MAX_PROFILE_PROMPT_CHARS + 1) },
      `at most ${MAX_PROFILE_PROMPT_CHARS}`,
    );
  });

  it.each([
    ["type-desc", { prompt: "x", description: 3 }, "type-desc.description"],
    ["type-model", { prompt: "x", model: "  " }, "type-model.model"],
    ["type-tools", { prompt: "x", tools: [1] }, "type-tools.tools"],
    ["type-tools-obj", { prompt: "x", tools: { a: 1 } }, "type-tools-obj.tools"],
  ])("skips the wrong field type in %s at its path", (key, entry, path) => {
    expectSkipped(key, entry, `${FIELD}.${path}`);
  });

  it("skips more tools than a profile file allows", () => {
    const many = Array.from({ length: MAX_PROFILE_TOOLS + 1 }, (_, i) => `t${i}`);
    expectSkipped("many-tools", { prompt: "x", tools: many }, `more than ${MAX_PROFILE_TOOLS} entries`);
  });

  it.each([["entry-text", "text"], ["entry-list", ["x"]], ["entry-null", null], ["entry-num", 7]])(
    "skips the non-object entry %s",
    (key, entry) => {
      expectSkipped(key, entry, `${FIELD}.${key}: expected an object`);
    },
  );

  it.each([["a string"], [["review"]], [3], [true]])(
    "rejects a non-object node %j, as webhooks and fileTriggers do",
    (raw) => {
      const run = () => parseAgentProfilesConfig(raw, FIELD);
      expect(run).toThrow(ConfigValidationError);
      expect(run).toThrow(`${FIELD}: expected an object keyed by profile name`);
    },
  );
});
