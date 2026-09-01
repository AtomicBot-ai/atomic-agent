import { describe, expect, it } from "vitest";

import { buildReport, type ImportItemResult } from "../../import/index.js";
import {
  buildImportAgentRows,
  buildImportOptionRows,
  buildImportPickRows,
  importActionLabel,
  shouldOfferImport,
  summarizeImportReport,
} from "./import-step.js";

describe("shouldOfferImport", () => {
  it("offers exactly once — the stamp is the only gate", () => {
    expect(shouldOfferImport({ alreadyOffered: false })).toBe(true);
    expect(shouldOfferImport({ alreadyOffered: true })).toBe(false);
  });
});

describe("buildImportPickRows", () => {
  const detected = [
    { id: "hermes" as const, label: "Hermes", dir: "/h" },
    { id: "claude-code" as const, label: "Claude Code", dir: "/c" },
  ];

  it("starts every agent unticked, with the skip row last and no import row", () => {
    const agents = buildImportAgentRows(detected);
    expect(agents.every((a) => !a.enabled)).toBe(true);
    const rows = buildImportPickRows(agents);
    expect(rows.map((r) => r.kind)).toEqual(["agent", "agent", "skip"]);
  });

  it("grows the import row above skip once something is ticked", () => {
    const agents = buildImportAgentRows(detected).map((row, index) =>
      index === 0 ? { ...row, enabled: true } : row,
    );
    const rows = buildImportPickRows(agents);
    expect(rows.map((r) => r.kind)).toEqual(["agent", "agent", "import", "skip"]);
    const action = rows[2];
    expect(action?.kind === "import" && action.picked).toBe(1);
  });

  it("labels the import row with the ticked count", () => {
    expect(importActionLabel(1)).toBe("Import from 1 agent");
    expect(importActionLabel(3)).toBe("Import from 3 agents");
  });
});

describe("buildImportOptionRows", () => {
  it("builds each picked agent's registry, secrets off by default", () => {
    const agents = buildImportAgentRows([
      { id: "hermes", label: "Hermes", dir: "/h" },
      { id: "claude-code", label: "Claude Code", dir: "/c" },
    ]).map((row) => ({ ...row, enabled: true }));

    const rows = buildImportOptionRows(agents);
    expect(rows.map((r) => `${r.agent}:${r.option}`)).toEqual([
      "hermes:sessions",
      "hermes:cron",
      "hermes:secrets",
      "claude-code:skills",
      "claude-code:memory",
      "claude-code:mcp",
      "claude-code:sessions",
      "claude-code:secrets",
    ]);
    for (const row of rows) {
      expect(row.enabled).toBe(!row.secret);
      expect(row.secret).toBe(row.option === "secrets");
    }
  });

  it("skips unticked agents", () => {
    const agents = buildImportAgentRows([
      { id: "hermes", label: "Hermes", dir: "/h" },
      { id: "codex", label: "Codex", dir: "/x" },
    ]).map((row) => (row.id === "codex" ? { ...row, enabled: true } : row));
    const rows = buildImportOptionRows(agents);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.agent === "codex")).toBe(true);
  });
});

describe("summarizeImportReport", () => {
  const items: ImportItemResult[] = [
    { kind: "Claude Code skills", status: "migrated" },
    { kind: "Claude Code skills", status: "skipped" },
    { kind: "Claude Code sessions", status: "migrated" },
    { kind: "Claude Code sessions", status: "conflict" },
    { kind: "Codex secrets", status: "error" },
  ];

  it("reads in the future tense for a preview", () => {
    expect(summarizeImportReport(buildReport(items, false))).toEqual([
      "Claude Code skills: 1 to migrate, 1 skipped",
      "Claude Code sessions: 1 to migrate, 1 in conflict",
      "Codex secrets: 1 failed",
    ]);
  });

  it("reads in the past tense once executed", () => {
    expect(summarizeImportReport(buildReport(items, true))[0]).toBe(
      "Claude Code skills: 1 migrated, 1 skipped",
    );
  });
});
