import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import {
  createInitialImportPanelState,
  type ImportFormState,
  type ImportPanelState,
} from "../import/import-panel-state.js";
import { ImportPanel } from "./import-panel.js";

function panelWith(form: Partial<ImportFormState>): ImportPanelState {
  const base = createInitialImportPanelState();
  return { ...base, form: { ...base.form, ...form } };
}

function rows(frame: string | undefined): string[] {
  return (frame ?? "").split("\n").map((line) => line.replace(/\s+$/, ""));
}

describe("ImportPanel — configure form", () => {
  it("offers all four sources on the source-type row", () => {
    const { lastFrame } = render(
      <ImportPanel panel={panelWith({ source: "hermes" })} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Import · Hermes");
    expect(frame).toContain("‹hermes›");
    expect(frame).toContain("openclaw");
    expect(frame).toContain("claude-code");
    expect(frame).toContain("codex");
  });

  it("draws the Claude Code rows: skills, memory, mcp, sessions, secrets", () => {
    const { lastFrame } = render(
      <ImportPanel
        panel={panelWith({ source: "claude-code", sourceDir: "" })}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Import · Claude Code");
    expect(frame).toContain("~/.claude");
    const labels = rows(lastFrame())
      .map((line) => /^[^a-z]*([a-z-]+)\s*:/.exec(line)?.[1])
      .filter((label): label is string => label !== undefined);
    expect(labels).toEqual([
      "source-of",
      "source",
      "skills",
      "memory",
      "mcp",
      "sessions",
      "secrets",
      "overwrite",
      "limit",
    ]);
    expect(frame).toContain("ANTHROPIC_API_KEY");
    expect(frame).not.toContain("cron");
  });

  it("draws the Codex rows without an mcp row", () => {
    const { lastFrame } = render(
      <ImportPanel panel={panelWith({ source: "codex", sourceDir: "" })} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Import · Codex");
    expect(frame).toContain("~/.codex");
    expect(frame).toContain("AGENTS.md");
    expect(frame).toContain("OPENAI_API_KEY");
    expect(frame).not.toMatch(/^\s*\S?\s*mcp\s*:/m);
  });

  it("keeps the OpenClaw form free of a secrets row", () => {
    const { lastFrame } = render(
      <ImportPanel panel={panelWith({ source: "openclaw" })} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Import · OpenClaw");
    expect(frame).not.toMatch(/^\s*\S?\s*secrets\s*:/m);
  });
});
