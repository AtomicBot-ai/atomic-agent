import { describe, expect, it } from "vitest";

import {
  IMPORT_SOURCE_IDS,
  importSourceLabel,
  importSourcePlaceholder,
  importSourceSupports,
  importSourceToggles,
  nextImportSource,
} from "./import-sources.js";

describe("import sources registry", () => {
  it("offers all four agents in a fixed cycle order", () => {
    expect(IMPORT_SOURCE_IDS).toEqual([
      "hermes",
      "openclaw",
      "claude-code",
      "codex",
    ]);
  });

  it("cycles forward and back, wrapping at both ends", () => {
    expect(nextImportSource("hermes", 1)).toBe("openclaw");
    expect(nextImportSource("openclaw", 1)).toBe("claude-code");
    expect(nextImportSource("claude-code", 1)).toBe("codex");
    expect(nextImportSource("codex", 1)).toBe("hermes");
    expect(nextImportSource("hermes", -1)).toBe("codex");
    expect(nextImportSource("codex", -1)).toBe("claude-code");
  });

  it("lists only the toggles each importer supports, in row order", () => {
    const ids = (source: Parameters<typeof importSourceToggles>[0]) =>
      importSourceToggles(source).map((meta) => meta.id);
    expect(ids("hermes")).toEqual(["sessions", "cron", "secrets"]);
    expect(ids("openclaw")).toEqual(["sessions", "cron"]);
    expect(ids("claude-code")).toEqual([
      "skills",
      "memory",
      "mcp",
      "sessions",
      "secrets",
    ]);
    expect(ids("codex")).toEqual(["skills", "memory", "sessions", "secrets"]);
    expect(importSourceSupports("openclaw", "secrets")).toBe(false);
    expect(importSourceSupports("codex", "mcp")).toBe(false);
    expect(importSourceSupports("claude-code", "mcp")).toBe(true);
  });

  it("labels and placeholders name the agent, not the id", () => {
    expect(importSourceLabel("claude-code")).toBe("Claude Code");
    expect(importSourceLabel("codex")).toBe("Codex");
    expect(importSourcePlaceholder("claude-code")).toBe("~/.claude");
    expect(importSourcePlaceholder("codex")).toBe("~/.codex");
  });
});
