import { describe, expect, it } from "vitest";

import {
  nothingSelectedNotice,
  resolveImportFormOptions,
} from "./import-form-options.js";
import {
  createInitialImportFormState,
  type ImportFormState,
} from "./import-panel-state.js";

function form(over: Partial<ImportFormState>): ImportFormState {
  return { ...createInitialImportFormState(), ...over };
}

describe("resolveImportFormOptions", () => {
  it("maps the Claude Code form onto its option ids, secrets by opt-in only", () => {
    expect(resolveImportFormOptions(form({ source: "claude-code" }))).toEqual([
      "skills",
      "memory",
      "mcp",
      "sessions",
    ]);
    expect(
      resolveImportFormOptions(
        form({ source: "claude-code", mcp: false, secrets: true }),
      ),
    ).toEqual(["skills", "memory", "sessions", "secrets"]);
  });

  it("maps the Codex form, which has no mcp row to honour", () => {
    expect(
      resolveImportFormOptions(form({ source: "codex", memory: false })),
    ).toEqual(["skills", "sessions"]);
  });

  it("keeps the Hermes and OpenClaw behaviour", () => {
    expect(
      resolveImportFormOptions(
        form({ source: "hermes", cron: false, secrets: true }),
      ),
    ).toEqual(["sessions", "secrets"]);
    expect(
      resolveImportFormOptions(form({ source: "openclaw", sessions: false })),
    ).toEqual(["cron"]);
  });

  it("ignores toggles a source does not draw", () => {
    // skills/memory are off, but OpenClaw never shows them.
    expect(
      resolveImportFormOptions(
        form({ source: "openclaw", skills: false, memory: false }),
      ),
    ).toEqual(["sessions", "cron"]);
  });

  it("returns nothing when every drawn row is off, with a source-specific notice", () => {
    const empty = form({
      source: "claude-code",
      skills: false,
      memory: false,
      mcp: false,
      sessions: false,
    });
    expect(resolveImportFormOptions(empty)).toEqual([]);
    expect(nothingSelectedNotice(empty)).toBe(
      "nothing selected to import — enable skills, memory, mcp, sessions or secrets",
    );
    expect(nothingSelectedNotice(form({ source: "openclaw" }))).toBe(
      "nothing selected to import — enable sessions or cron",
    );
  });
});
