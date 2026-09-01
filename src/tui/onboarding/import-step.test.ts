import { describe, expect, it } from "vitest";

import { buildReport, type ImportItemResult } from "../../import/index.js";
import {
  buildImportAgentRows,
  buildImportOptionRows,
  shouldOfferImport,
  summarizeImportReport,
} from "./import-step.js";

describe("shouldOfferImport", () => {
  it("offers once, and never to an operator who skipped setup", () => {
    expect(shouldOfferImport({ outcome: "local", alreadyOffered: false })).toBe(true);
    expect(shouldOfferImport({ outcome: "cloud", alreadyOffered: false })).toBe(true);
    expect(shouldOfferImport({ outcome: "custom", alreadyOffered: false })).toBe(true);
    expect(shouldOfferImport({ outcome: "skipped", alreadyOffered: false })).toBe(false);
    expect(shouldOfferImport({ outcome: "local", alreadyOffered: true })).toBe(false);
  });
});

describe("buildImportOptionRows", () => {
  it("builds each picked agent's registry, secrets off by default", () => {
    const agents = buildImportAgentRows([
      { id: "hermes", label: "Hermes", dir: "/h" },
      { id: "claude-code", label: "Claude Code", dir: "/c" },
    ]);
    expect(agents.every((a) => a.enabled)).toBe(true);

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
    ]).map((row) => (row.id === "hermes" ? { ...row, enabled: false } : row));
    const rows = buildImportOptionRows(agents);
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
