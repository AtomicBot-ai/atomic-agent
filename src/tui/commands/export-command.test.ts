import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEmptySessionState, type SessionState } from "../../session/session-state.js";
import { parseExportCommand, resolveExportPath, writeChatExport } from "./export-command.js";

function chat(text = "Plan a trip"): SessionState {
  return {
    ...createEmptySessionState({ id: "s-tui-export", workingDir: "/tmp/w", metadata: { title: "Trip plan" } }),
    turns: [
      { kind: "user", text, at: 1 },
      { kind: "assistant_reply", text: "Day 1: **Lisbon**", at: 2 },
    ],
  };
}

describe("/export arguments (ATO-1054)", () => {
  it("defaults to Markdown in the current folder", () => {
    expect(parseExportCommand("")).toEqual({ format: "markdown", path: null });
    expect(parseExportCommand("   ")).toEqual({ format: "markdown", path: null });
  });

  it("takes a format word, then a path that may hold spaces or quotes", () => {
    expect(parseExportCommand("PDF")).toEqual({ format: "pdf", path: null });
    expect(parseExportCommand("word")).toEqual({ format: "docx", path: null });
    expect(parseExportCommand("docx ~/Documents/My trip.docx")).toEqual({ format: "docx", path: "~/Documents/My trip.docx" });
    expect(parseExportCommand('md "a b.md"')).toEqual({ format: "markdown", path: "a b.md" });
  });

  it("picks the format from the extension when no format word is given", () => {
    expect(parseExportCommand("notes.pdf")).toEqual({ format: "pdf", path: "notes.pdf" });
    expect(parseExportCommand("notes.HTML")).toEqual({ format: "html", path: "notes.HTML" });
    expect(parseExportCommand("notes")).toEqual({ format: "markdown", path: "notes" });
    expect(parseExportCommand("notes.txt")).toEqual({ format: "markdown", path: "notes.txt" });
  });
});

describe("/export writing the file (ATO-1054)", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tui-export-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves home, folders and missing extensions", () => {
    const state = chat();
    expect(resolveExportPath(state, { format: "pdf", path: "~/x" }, dir, "/home/me")).toBe("/home/me/x.pdf");
    expect(resolveExportPath(state, { format: "docx", path: "sub/" }, dir)).toBe(join(dir, "sub", "Trip plan.docx"));
    mkdirSync(join(dir, "out"));
    expect(resolveExportPath(state, { format: "markdown", path: "out" }, dir)).toBe(join(dir, "out", "Trip plan.md"));
    expect(resolveExportPath(state, { format: "markdown", path: "/abs/c.txt" }, dir)).toBe("/abs/c.txt");
  });

  it("writes Markdown named after the chat and never over an earlier export", async () => {
    const first = await writeChatExport(chat(), { format: "markdown", path: null }, dir);
    expect(first).toBe(`chat exported as Markdown: ${join(dir, "Trip plan.md")}`);
    expect(readFileSync(join(dir, "Trip plan.md"), "utf8")).toContain("## You\n\nPlan a trip");
    const second = await writeChatExport(chat(), { format: "markdown", path: null }, dir);
    expect(second).toBe(`chat exported as Markdown: ${join(dir, "Trip plan (2).md")}`);
  });

  it("overwrites a path that was named, as Claude Code's /export does", async () => {
    writeFileSync(join(dir, "c.md"), "old");
    await writeChatExport(chat(), { format: "markdown", path: "c.md" }, dir);
    expect(readFileSync(join(dir, "c.md"), "utf8")).toContain("Lisbon");
  });

  it("writes a PDF and mentions the font limit only when the chat needs it", async () => {
    const plain = await writeChatExport(chat(), { format: "pdf", path: "a.pdf" }, dir);
    expect(plain).toBe(`chat exported as PDF: ${join(dir, "a.pdf")}`);
    expect(readFileSync(join(dir, "a.pdf")).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const cyrillic = await writeChatExport(chat("Привет"), { format: "pdf", path: "b.pdf" }, dir);
    expect(cyrillic).toMatch(/transliterated/);
  });

  it("says why when there is nothing to export or the folder is missing", async () => {
    expect(await writeChatExport(null, { format: "markdown", path: null }, dir)).toMatch(/nothing to export/);
    const empty = { ...chat(), turns: [] };
    expect(await writeChatExport(empty, { format: "markdown", path: null }, dir)).toMatch(/nothing to export/);
    expect(await writeChatExport(chat(), { format: "markdown", path: "missing/x.md" }, dir)).toMatch(
      /^export failed \(.*missing\/x\.md\): /,
    );
  });
});
