import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ApprovalGate } from "../../approval/approval-gate.js";
import { ApprovalDeniedError } from "../../approval/dangerous-tool.js";
import { appendLogbookEntry } from "../../logbook/logbook-store.js";
import { DEFAULT_LOGBOOK_SETTINGS, writeLogbookSettings } from "../../logbook/logbook-settings.js";
import { ToolRegistry } from "../tool-registry.js";
import { registerLogbookTools } from "./index.js";
import { buildLogbookQueryTool, LOGBOOK_QUERY_TOOL, type LogbookQueryToolOptions } from "./logbook-query-tool.js";

const NOW = new Date(2026, 10, 27, 16, 0);
const ctx = { workingDir: "/work", sessionId: "s", stepIndex: 0, signal: new AbortController().signal };

function gate(approved: boolean) {
  return {
    request: vi.fn(async () => ({ approved, ...(approved ? {} : { reason: "no" }) })),
  } as unknown as ApprovalGate;
}

/** A loopback model serves the chat unless `notesStayLocal` says otherwise. */
function options(stateDir: string, extra: Partial<LogbookQueryToolOptions> = {}): LogbookQueryToolOptions {
  return { stateDir, approvals: gate(true), approvalRequired: true, notesStayLocal: () => true, ...extra };
}

function stateWithNotes(): string {
  const dir = mkdtempSync(join(tmpdir(), "atomic-logbook-tool-"));
  appendLogbookEntry(dir, { at: new Date(2026, 10, 26, 9, 10).toISOString(), app: "Mail", bundleId: "com.apple.mail", text: "Answering the vendor about invoices" });
  appendLogbookEntry(dir, { at: new Date(2026, 10, 26, 14, 40).toISOString(), app: "Code", bundleId: "com.microsoft.VSCode", text: "Coding the logbook sidecar" });
  return dir;
}

describe("logbook.query", () => {
  it("answers 'what did I do yesterday afternoon' from the day file", async () => {
    const tool = buildLogbookQueryTool(options(stateWithNotes(), { now: () => NOW }));
    const result = await tool.run({ day: "yesterday", part: "afternoon" }, ctx);
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("14:40  Code  Coding the logbook sidecar");
    expect(result.summary).not.toContain("invoices");
    expect(result.details).toMatchObject({ day: "2026-11-26", count: 1, total: 2 });
  });

  it("is read-only and framed as outside data", () => {
    const tool = buildLogbookQueryTool(options("/nowhere"));
    expect(tool.readonly).toBe(true);
    expect(tool.untrustedOutput).toBeTruthy();
  });

  it("says how to turn the logbook on when it is off and empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-logbook-tool-empty-"));
    const tool = buildLogbookQueryTool(options(dir, { now: () => NOW }));
    const off = await tool.run({}, ctx);
    expect(off.status).toBe("ok");
    expect(off.summary).toMatch(/logbook start/);
    writeLogbookSettings(dir, { ...DEFAULT_LOGBOOK_SETTINGS, excludeApps: [], enabled: true });
    const on = await tool.run({}, ctx);
    expect(on.summary).not.toMatch(/logbook start/);
  });

  it("refuses a bad day or time with a sentence", async () => {
    const tool = buildLogbookQueryTool(options(stateWithNotes(), { now: () => NOW }));
    expect((await tool.run({ day: "someday" }, ctx)).status).toBe("error");
    expect((await tool.run({ from: "18:00", to: "09:00" }, ctx)).status).toBe("error");
  });

  it("reads without asking while a model on this computer serves the chat", async () => {
    const approvals = gate(true);
    const seen: (string | undefined)[] = [];
    const tool = buildLogbookQueryTool(options(stateWithNotes(), {
      approvals,
      now: () => NOW,
      notesStayLocal: (id) => { seen.push(id); return true; },
    }));
    const result = await tool.run({ day: "yesterday" }, { ...ctx, providerId: "local-llama" });
    expect(result.status).toBe("ok");
    expect(seen).toEqual(["local-llama"]);
    expect(approvals.request).not.toHaveBeenCalled();
  });

  it("asks as logbook_cloud before notes go to a model off this computer (ATO-2363)", async () => {
    const approvals = gate(true);
    const tool = buildLogbookQueryTool(options(stateWithNotes(), { approvals, now: () => NOW, notesStayLocal: () => false }));
    const result = await tool.run({ day: "yesterday" }, ctx);
    expect(result.status).toBe("ok");
    const request = (approvals.request as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(request).toMatchObject({ category: "logbook_cloud", tool: LOGBOOK_QUERY_TOOL, sessionId: "s" });
    expect(request.reason).toMatch(/not on this computer/);
  });

  it("reads no note when that approval is denied", async () => {
    const tool = buildLogbookQueryTool(options(stateWithNotes(), { approvals: gate(false), now: () => NOW, notesStayLocal: () => false }));
    await expect(tool.run({ day: "yesterday" }, ctx)).rejects.toBeInstanceOf(ApprovalDeniedError);
  });

  it("registers under its name", () => {
    const registry = new ToolRegistry();
    registerLogbookTools(registry, options("/nowhere"));
    expect(registry.has(LOGBOOK_QUERY_TOOL)).toBe(true);
  });
});
