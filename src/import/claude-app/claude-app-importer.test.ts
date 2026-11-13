import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JSZip from "jszip";

import { SessionStore } from "../../session/index.js";
import { groupImportReport } from "../grouping.js";
import { ClaudeAppImporter, resolveClaudeAppOptions } from "./claude-app-importer.js";
import { ClaudeAppSource } from "./claude-app-source.js";

/* A Claude data export, cut down to the fields the importer reads (the
   shapes are the export's; the values are made up). */
const PROJECTS = [
  {
    uuid: "proj-1",
    name: "Thesis",
    description: "My master's thesis",
    is_private: true,
    is_starter_project: false,
    prompt_template: "Answer as a strict reviewer.",
    created_at: "2026-05-01T10:00:00.000000Z",
    updated_at: "2026-05-01T10:00:00.000000Z",
    docs: [{ uuid: "doc-1", filename: "outline.md", content: "1. Intro\n2. Method", created_at: "2026-05-01T10:00:00Z" }],
  },
  {
    uuid: "proj-starter",
    name: "How to use Claude",
    is_starter_project: true,
    prompt_template: "",
    docs: [],
  },
];

function conversation(uuid: string, extra: Record<string, unknown> = {}) {
  return {
    uuid,
    name: `Chat ${uuid}`,
    created_at: "2026-06-01T09:00:00.000000Z",
    updated_at: "2026-06-01T09:05:00.000000Z",
    account: { uuid: "acc" },
    chat_messages: [
      {
        uuid: `${uuid}-m1`,
        sender: "human",
        text: "Summarise this",
        content: [{ type: "text", text: "Summarise this" }],
        created_at: "2026-06-01T09:00:00.000000Z",
        attachments: [{ file_name: "notes.txt", file_size: 10, file_type: "txt", extracted_content: "long text" }],
        files: [],
      },
      {
        uuid: `${uuid}-m2`,
        sender: "assistant",
        text: "Here is the summary.",
        content: [
          { type: "thinking", thinking: "short one" },
          { type: "text", text: "Here is the summary." },
        ],
        created_at: "2026-06-01T09:01:00.000000Z",
        attachments: [],
        files: [],
      },
    ],
    ...extra,
  };
}

describe("ClaudeAppImporter", () => {
  let root: string;
  let stateDir: string;
  let exportDir: string;
  let sessionStore: SessionStore;
  let notes: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claude-app-"));
    stateDir = join(root, "state");
    exportDir = join(root, "export");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(exportDir, { recursive: true });
    sessionStore = new SessionStore({ dbFile: join(stateDir, "sessions.sqlite") });
    notes = [];
  });

  afterEach(() => {
    sessionStore.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function writeExport(conversations: unknown[]): void {
    writeFileSync(join(exportDir, "conversations.json"), JSON.stringify(conversations));
    writeFileSync(join(exportDir, "projects.json"), JSON.stringify(PROJECTS));
    writeFileSync(join(exportDir, "users.json"), JSON.stringify([{ uuid: "acc", full_name: "Someone" }]));
  }

  function importer(path = exportDir): ClaudeAppImporter {
    return new ClaudeAppImporter({
      source: new ClaudeAppSource(path),
      sessionStore,
      memoryStore: {
        list: () => notes.map((content) => ({ content })),
        store: (input: { content: string }) => {
          notes.push(input.content);
        },
      },
      workingDir: "/home/someone",
    });
  }

  async function run(execute: boolean, path?: string) {
    const report = await importer(path).run({ options: resolveClaudeAppOptions(), execute, overwrite: false });
    return groupImportReport(report, { stateDir, execute });
  }

  it("imports conversations with titles, times, reasoning and attachment names", async () => {
    writeExport([conversation("c1")]);
    await run(true);
    const state = sessionStore.load("claude-app:c1")!;
    expect(state.metadata).toMatchObject({ importedFrom: "claude-app", title: "Chat c1" });
    expect(state.workingDir).toBe("/home/someone");
    expect(state.createdAt).toBe(Date.parse("2026-06-01T09:00:00Z"));
    expect(state.turns).toMatchObject([
      { kind: "user", text: "Summarise this\n\n[Attached: notes.txt]" },
      { kind: "assistant_reply", text: "Here is the summary.", reasoning: "short one" },
    ]);
  });

  it("files chats into a folder per project when the export links them", async () => {
    writeExport([
      conversation("c1", { project_uuid: "proj-1" }),
      conversation("c2", { project: { uuid: "proj-1", name: "Thesis" } }),
      conversation("c3"),
    ]);
    const report = await run(true);
    expect(report.items.filter((i) => i.kind === "folders")).toEqual([
      { kind: "folders", source: "Thesis", status: "migrated", reason: "new folder; 2 chats; 2 added" },
    ]);
    const folders = JSON.parse(readFileSync(join(stateDir, "chat-folders.json"), "utf8"));
    const thesis = folders.folders.find((f: { name: string }) => f.name === "Thesis");
    expect(folders.chats).toMatchObject({ "claude-app:c1": thesis.id, "claude-app:c2": thesis.id });
    expect(folders.chats["claude-app:c3"]).toBeUndefined();
    // The starter project is Claude's sample, not the person's.
    expect(folders.folders.map((f: { name: string }) => f.name)).toEqual(["Thesis"]);
    // Instructions and files ride along as notes.
    expect(notes).toEqual([
      'Claude project "Thesis" instructions:\n\nMy master\'s thesis\n\nAnswer as a strict reviewer.',
      'Claude project "Thesis" file outline.md:\n\n1. Intro\n2. Method',
    ]);

    const again = await run(true);
    expect(again.summary.migrated).toBe(0);
    expect(JSON.parse(readFileSync(join(stateDir, "chat-folders.json"), "utf8"))).toEqual(folders);
    expect(notes).toHaveLength(2);
  });

  it("brings the projects as empty folders and says so when the export has no links", async () => {
    writeExport([conversation("c1"), conversation("c2")]);
    const report = await run(false);
    expect(report.items.filter((i) => i.kind === "folders")).toEqual([
      expect.objectContaining({ status: "skipped", reason: expect.stringContaining("does not say which project") }),
      { kind: "folders", source: "Thesis", status: "migrated", reason: "new folder; 0 chats" },
    ]);
    expect(report.items.filter((i) => i.kind === "sessions" && i.status === "migrated")).toHaveLength(2);
  });

  it("reads the .zip as downloaded, files one folder down included", async () => {
    const zip = new JSZip();
    zip.file("data-2026-06-02/conversations.json", JSON.stringify([conversation("z1")]));
    zip.file("data-2026-06-02/projects.json", JSON.stringify(PROJECTS));
    const zipPath = join(root, "claude-export.zip");
    writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer" }));
    await run(true, zipPath);
    expect(sessionStore.load("claude-app:z1")).not.toBeNull();
  });

  it("reports a folder without conversations.json as an error", async () => {
    const report = await run(false);
    expect(report.items[0]).toMatchObject({ kind: "sessions", status: "error", reason: expect.stringContaining("conversations.json") });
  });
});
