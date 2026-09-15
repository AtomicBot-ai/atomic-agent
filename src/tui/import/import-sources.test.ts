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
  it("offers all six agents in a fixed cycle order", () => {
    expect(IMPORT_SOURCE_IDS).toEqual([
      "hermes",
      "openclaw",
      "claude-code",
      "codex",
      "pi",
      "oh-my-pi",
    ]);
  });

  it("cycles forward and back, wrapping at both ends", () => {
    expect(nextImportSource("hermes", 1)).toBe("openclaw");
    expect(nextImportSource("openclaw", 1)).toBe("claude-code");
    expect(nextImportSource("claude-code", 1)).toBe("codex");
    expect(nextImportSource("codex", 1)).toBe("pi");
    expect(nextImportSource("pi", 1)).toBe("oh-my-pi");
    expect(nextImportSource("oh-my-pi", 1)).toBe("hermes");
    expect(nextImportSource("hermes", -1)).toBe("oh-my-pi");
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
    expect(ids("pi")).toEqual(["skills", "sessions"]);
    expect(ids("oh-my-pi")).toEqual(["skills", "mcp", "sessions"]);
    expect(importSourceSupports("openclaw", "secrets")).toBe(false);
    expect(importSourceSupports("codex", "mcp")).toBe(false);
    expect(importSourceSupports("claude-code", "mcp")).toBe(true);
    expect(importSourceSupports("pi", "mcp")).toBe(false);
    expect(importSourceSupports("oh-my-pi", "mcp")).toBe(true);
    expect(importSourceSupports("oh-my-pi", "secrets")).toBe(false);
  });

  it("labels and placeholders name the agent, not the id", () => {
    expect(importSourceLabel("claude-code")).toBe("Claude Code");
    expect(importSourceLabel("codex")).toBe("Codex");
    expect(importSourceLabel("pi")).toBe("Pi");
    expect(importSourceLabel("oh-my-pi")).toBe("Oh-My-Pi");
    expect(importSourcePlaceholder("claude-code")).toBe("~/.claude");
    expect(importSourcePlaceholder("codex")).toBe("~/.codex");
    expect(importSourcePlaceholder("pi")).toBe("~/.pi/agent");
    expect(importSourcePlaceholder("oh-my-pi")).toBe("~/.omp/agent");
  });
});
