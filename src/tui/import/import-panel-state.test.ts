import { afterEach, describe, expect, it } from "vitest";

import {
  createInitialImportFormState,
  defaultSourceDir,
  importFocusOrder,
} from "./import-panel-state.js";

describe("importFocusOrder", () => {
  it("draws only the rows a source supports between source and overwrite", () => {
    expect(importFocusOrder("hermes")).toEqual([
      "sourceType", "source", "sessions", "cron", "secrets", "overwrite", "limit", "run",
    ]);
    expect(importFocusOrder("openclaw")).toEqual([
      "sourceType", "source", "sessions", "cron", "overwrite", "limit", "run",
    ]);
    expect(importFocusOrder("claude-code")).toEqual([
      "sourceType", "source", "skills", "memory", "mcp", "sessions", "secrets",
      "overwrite", "limit", "run",
    ]);
    expect(importFocusOrder("codex")).toEqual([
      "sourceType", "source", "skills", "memory", "sessions", "secrets",
      "overwrite", "limit", "run",
    ]);
  });
});

describe("defaultSourceDir", () => {
  const saved = {
    CLAUDE_CODE_STATE_DIR: process.env.CLAUDE_CODE_STATE_DIR,
    CODEX_STATE_DIR: process.env.CODEX_STATE_DIR,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("mirrors the CLI defaults for the two new sources", () => {
    delete process.env.CLAUDE_CODE_STATE_DIR;
    delete process.env.CODEX_STATE_DIR;
    expect(defaultSourceDir("claude-code")).toMatch(/[\\/]\.claude$/);
    expect(defaultSourceDir("codex")).toMatch(/[\\/]\.codex$/);
  });

  it("honours the *_STATE_DIR overrides the CLI honours", () => {
    process.env.CLAUDE_CODE_STATE_DIR = "/elsewhere/claude";
    process.env.CODEX_STATE_DIR = "/elsewhere/codex";
    expect(defaultSourceDir("claude-code")).toBe("/elsewhere/claude");
    expect(defaultSourceDir("codex")).toBe("/elsewhere/codex");
  });
});

describe("createInitialImportFormState", () => {
  it("starts on hermes with every non-secret option ticked", () => {
    const form = createInitialImportFormState();
    expect(form.source).toBe("hermes");
    expect(form.skills).toBe(true);
    expect(form.memory).toBe(true);
    expect(form.mcp).toBe(true);
    expect(form.sessions).toBe(true);
    expect(form.cron).toBe(true);
    expect(form.secrets).toBe(false);
    expect(form.overwrite).toBe(false);
  });
});
