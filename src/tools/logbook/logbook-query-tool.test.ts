import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { appendLogbookEntry } from "../../logbook/logbook-store.js";
import { DEFAULT_LOGBOOK_SETTINGS, writeLogbookSettings } from "../../logbook/logbook-settings.js";
import { ToolRegistry } from "../tool-registry.js";
import { registerLogbookTools } from "./index.js";
import { buildLogbookQueryTool, LOGBOOK_QUERY_TOOL } from "./logbook-query-tool.js";

const NOW = new Date(2026, 10, 27, 16, 0);
const ctx = { workingDir: "/work", sessionId: "s", stepIndex: 0, signal: new AbortController().signal };

function stateWithNotes(): string {
  const dir = mkdtempSync(join(tmpdir(), "atomic-logbook-tool-"));
  appendLogbookEntry(dir, { at: new Date(2026, 10, 26, 9, 10).toISOString(), app: "Mail", bundleId: "com.apple.mail", text: "Answering the vendor about invoices" });
  appendLogbookEntry(dir, { at: new Date(2026, 10, 26, 14, 40).toISOString(), app: "Code", bundleId: "com.microsoft.VSCode", text: "Coding the logbook sidecar" });
  return dir;
}

describe("logbook.query", () => {
  it("answers 'what did I do yesterday afternoon' from the day file", async () => {
    const tool = buildLogbookQueryTool({ stateDir: stateWithNotes(), now: () => NOW });
    const result = await tool.run({ day: "yesterday", part: "afternoon" }, ctx);
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("14:40  Code  Coding the logbook sidecar");
    expect(result.summary).not.toContain("invoices");
    expect(result.details).toMatchObject({ day: "2026-11-26", count: 1, total: 2 });
  });

  it("is read-only and framed as outside data", () => {
    const tool = buildLogbookQueryTool({ stateDir: "/nowhere" });
    expect(tool.readonly).toBe(true);
    expect(tool.untrustedOutput).toBeTruthy();
  });

  it("says how to turn the logbook on when it is off and empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-logbook-tool-empty-"));
    const tool = buildLogbookQueryTool({ stateDir: dir, now: () => NOW });
    const off = await tool.run({}, ctx);
    expect(off.status).toBe("ok");
    expect(off.summary).toMatch(/logbook start/);
    writeLogbookSettings(dir, { ...DEFAULT_LOGBOOK_SETTINGS, excludeApps: [], enabled: true });
    const on = await tool.run({}, ctx);
    expect(on.summary).not.toMatch(/logbook start/);
  });

  it("refuses a bad day or time with a sentence", async () => {
    const tool = buildLogbookQueryTool({ stateDir: stateWithNotes(), now: () => NOW });
    expect((await tool.run({ day: "someday" }, ctx)).status).toBe("error");
    expect((await tool.run({ from: "18:00", to: "09:00" }, ctx)).status).toBe("error");
  });

  it("registers under its name", () => {
    const registry = new ToolRegistry();
    registerLogbookTools(registry, { stateDir: "/nowhere" });
    expect(registry.has(LOGBOOK_QUERY_TOOL)).toBe(true);
  });
});
