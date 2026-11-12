import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  chatFoldersPath,
  coerceRailChatFolders,
  folderHeaderAt,
  groupRailByFolder,
  NO_CHAT_FOLDERS,
  readRailChatFolders,
  type RailChatFolders,
} from "./chat-folders.js";
import { SessionRailOrchestrator } from "./session-rail-orchestrator.js";

/**
 * ATO-1180: the desktop's chat folders (`<stateDir>/chat-folders.json`,
 * written by `desktop/main/chat-folders.ts`), read by the terminal and
 * shown as groups in the rail and the picker.
 */

const desktopFile = {
  version: 1,
  folders: [
    { id: "fwork1", name: "Work", collapsed: false },
    { id: "fhome1", name: "Home", collapsed: true },
  ],
  chats: { "s-1": "fwork1", "s-2": "fhome1", "s-3": null, "s-4": "fwork1" },
  autoSort: true,
  projects: {},
  auto: {},
  projectSort: true,
};

function folders(): RailChatFolders {
  return coerceRailChatFolders(desktopFile);
}

const row = (sessionId: string, pinned = false) => ({ sessionId, pinned });
const ids = (rows: readonly { sessionId: string }[]) =>
  rows.map((r) => r.sessionId);

describe("readRailChatFolders", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chat-folders-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the folders and chat links the desktop writes", () => {
    writeFileSync(chatFoldersPath(dir), JSON.stringify(desktopFile));
    const read = readRailChatFolders(dir);
    expect(read.folders).toEqual([
      { id: "fwork1", name: "Work" },
      { id: "fhome1", name: "Home" },
    ]);
    expect([...read.chats]).toEqual([
      ["s-1", "fwork1"],
      ["s-2", "fhome1"],
      ["s-4", "fwork1"],
    ]);
  });

  it("is no folders when there is no file", () => {
    expect(readRailChatFolders(dir)).toBe(NO_CHAT_FOLDERS);
  });

  it("is no folders for a file that does not parse, and leaves it where it is", () => {
    writeFileSync(chatFoldersPath(dir), "{ not json");
    expect(readRailChatFolders(dir)).toBe(NO_CHAT_FOLDERS);
    // The desktop sets a bad file aside itself; the terminal never moves it.
    expect(readdirSync(dir)).toEqual(["chat-folders.json"]);
  });

  it("is no folders for a file of the wrong shape", () => {
    writeFileSync(chatFoldersPath(dir), JSON.stringify([1, 2, 3]));
    expect(readRailChatFolders(dir)).toBe(NO_CHAT_FOLDERS);
    writeFileSync(chatFoldersPath(dir), "null");
    expect(readRailChatFolders(dir)).toBe(NO_CHAT_FOLDERS);
  });
});

describe("coerceRailChatFolders", () => {
  it("drops bad ids, empty names, duplicates and links to missing folders", () => {
    const read = coerceRailChatFolders({
      folders: [
        { id: "fok1", name: "  Kept  " },
        { id: "fok1", name: "Duplicate" },
        { id: "BAD", name: "Bad id" },
        { id: "fempty", name: "   " },
        { id: "fnum", name: 7 },
        null,
      ],
      chats: { "s-1": "fok1", "s-2": "fmissing", "s-3": 5 },
    });
    expect(read.folders).toEqual([{ id: "fok1", name: "Kept" }]);
    expect([...read.chats]).toEqual([["s-1", "fok1"]]);
  });

  it("puts a multi-line name on one line", () => {
    const read = coerceRailChatFolders({
      folders: [{ id: "fa", name: "Two\nlines" }],
      chats: {},
    });
    expect(read.folders[0]?.name).toBe("Two lines");
  });
});

describe("groupRailByFolder", () => {
  it("lists each folder's chats in folder order, then the unfiled ones", () => {
    const grouped = groupRailByFolder(
      [row("s-5"), row("s-2"), row("s-4"), row("s-3"), row("s-1")],
      folders(),
    );
    expect(ids(grouped)).toEqual(["s-4", "s-1", "s-2", "s-5", "s-3"]);
    expect(grouped.map((r) => r.folder)).toEqual([
      "Work",
      "Work",
      "Home",
      undefined,
      undefined,
    ]);
  });

  it("keeps the pinned block on top, folder names stamped", () => {
    const grouped = groupRailByFolder(
      [row("s-2", true), row("s-5"), row("s-1")],
      folders(),
    );
    expect(ids(grouped)).toEqual(["s-2", "s-1", "s-5"]);
    expect(grouped[0]).toEqual({ sessionId: "s-2", pinned: true, folder: "Home" });
  });

  it("returns the list unchanged when there are no folders", () => {
    const entries = [row("s-2"), row("s-1")];
    expect(groupRailByFolder(entries, NO_CHAT_FOLDERS)).toEqual(entries);
  });
});

describe("folderHeaderAt", () => {
  const rows = [
    { pinned: true, folder: "Home" },
    { pinned: false, folder: "Work" },
    { pinned: false, folder: "Work" },
    { pinned: false, folder: "Home" },
    { pinned: false },
    { pinned: false },
  ];

  it("opens each folder run, then the unfiled rows, never the pinned block", () => {
    expect(rows.map((_, i) => folderHeaderAt(rows, i))).toEqual([
      null,
      "Work",
      null,
      "Home",
      "no folder",
      null,
    ]);
  });

  it("names the folder at the top of a window that starts mid-group", () => {
    expect(folderHeaderAt(rows.slice(2), 0)).toBe("Work");
  });

  it("draws nothing when no row is in a folder", () => {
    const plain = [{ pinned: false }, { pinned: false }];
    expect(plain.map((_, i) => folderHeaderAt(plain, i))).toEqual([null, null]);
  });
});

describe("SessionRailOrchestrator with chat folders", () => {
  const entry = (sessionId: string) => ({
    sessionId,
    workingDir: "/tmp/w",
    turnCount: 1,
    stepCount: 1,
    updatedAt: 0,
    preview: sessionId,
    pinned: false,
  });

  it("groups the arranged rail by folder and moves against that list", () => {
    let layout = { order: [] as string[], pinned: [] as string[] };
    const rail = new SessionRailOrchestrator(
      {
        read: () => layout,
        write: (next) => {
          layout = next;
        },
      },
      () => {},
      () => null,
      folders,
    );
    const arranged = rail.arrange([entry("s-3"), entry("s-2"), entry("s-1")]);
    expect(ids(arranged)).toEqual(["s-1", "s-2", "s-3"]);
    expect(arranged.map((e) => e.folder)).toEqual(["Work", "Home", undefined]);
    // The first move snapshots the list as displayed, grouped.
    rail.moveSession("s-3", 0);
    expect(layout.order).toEqual(["s-3", "s-1", "s-2"]);
  });
});
