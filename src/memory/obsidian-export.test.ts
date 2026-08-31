import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";
import { MemoryStore } from "./memory-store.js";
import { LessonStore } from "./lessons/lesson-store.js";
import { ProcedureStore } from "./procedures/procedure-store.js";
import { LinkStore } from "./links/link-store.js";
import {
  ObsidianExportUsageError,
  exportMemoryToObsidian,
} from "./obsidian-export.js";

const T0 = Date.UTC(2026, 0, 2, 3, 4, 5); // 2026-01-02T03:04:05.000Z

/**
 * Build a small corpus exercising every exported edge kind: a
 * note→note link, a lesson with parents (one evicted), an archived
 * note, and a procedure sourced from both a lesson and a note.
 *
 * Returns the ids so assertions don't hardcode AUTOINCREMENT values.
 */
function buildCorpus(dbFile: string): {
  noteA: number;
  noteB: number;
  noteC: number;
  lesson: number;
  procedure: number;
} {
  const notes = new MemoryStore({ dbFile, maxEntries: 100, now: () => T0 });
  const lessons = new LessonStore({ dbFile, now: () => T0 });
  const procedures = new ProcedureStore({ dbFile, now: () => T0 });
  try {
    const noteA = notes.store({
      content: "Tap the simulator with a duration or taps get dropped.",
      tags: ["ios", "simulator"],
    }).id;
    const noteB = notes.store({ content: "idb is the reliable input path." }).id;
    const noteC = notes.store({ content: "A note that will be deleted." }).id;

    const links = new LinkStore({
      db: notes.getDatabaseHandleForEmbeddings(),
      now: () => T0,
    });
    links.add({ fromId: noteA, toId: noteB, kind: "RELATES_TO" });

    const lesson = lessons.create({
      activation: "when driving the ios simulator",
      principle: "Prefer idb, and always tap with an explicit duration.",
      tags: ["ios"],
      // 9999 is a soft pointer to an evicted episode — must not render.
      parentIds: [noteA, noteB, 9999],
    }).id;
    notes.archiveInto([noteA], lesson);

    const procedure = procedures.create({
      activation: "installing an app on the simulator",
      steps: [
        { description: "Boot the target simulator", toolHint: "os.exec" },
        { description: "Install and launch the app" },
      ],
      tags: ["ios"],
      parentLessonIds: [lesson],
      parentMemoryIds: [noteB, 9999],
    }).id;

    return { noteA, noteB, noteC, lesson, procedure };
  } finally {
    procedures.close();
    lessons.close();
    notes.close();
  }
}

describe("exportMemoryToObsidian", () => {
  let dir: string;
  let dbFile: string;
  let vaultDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-obsidian-export-"));
    dbFile = join(dir, "memory.sqlite");
    vaultDir = join(dir, "vault");
    mkdirSync(vaultDir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("exports notes, lessons and procedures as markdown with frontmatter", () => {
    const ids = buildCorpus(dbFile);
    const result = exportMemoryToObsidian({ dbFile, vaultDir });

    expect(result).toMatchObject({
      notes: 3,
      lessons: 1,
      procedures: 1,
      pruned: 0,
    });
    expect(result.root).toBe(join(vaultDir, "atomic-agent"));

    const noteA = readFileSync(
      join(result.root, "notes", `note-${ids.noteA}.md`),
      "utf8",
    );
    expect(noteA).toContain("type: memory-note");
    expect(noteA).toContain(`id: ${ids.noteA}`);
    expect(noteA).toContain("created: 2026-01-02T03:04:05.000Z");
    expect(noteA).toContain('source: "agent"');
    expect(noteA).toContain('  - "ios"');
    expect(noteA).toContain('  - "simulator"');
    expect(noteA).toContain(
      "Tap the simulator with a duration or taps get dropped.",
    );

    const lesson = readFileSync(
      join(result.root, "lessons", `lesson-${ids.lesson}.md`),
      "utf8",
    );
    expect(lesson).toContain("type: memory-lesson");
    expect(lesson).toContain('status: "active"');
    expect(lesson).toContain("**When:** when driving the ios simulator");
    expect(lesson).toContain(
      "Prefer idb, and always tap with an explicit duration.",
    );

    const procedure = readFileSync(
      join(result.root, "procedures", `procedure-${ids.procedure}.md`),
      "utf8",
    );
    expect(procedure).toContain("type: memory-procedure");
    expect(procedure).toContain('source: "consolidator"');
    expect(procedure).toContain("1. Boot the target simulator (`os.exec`)");
    expect(procedure).toContain("2. Install and launch the app");
  });

  it("renders wikilinks along schema edges and skips dangling soft pointers", () => {
    const ids = buildCorpus(dbFile);
    const result = exportMemoryToObsidian({ dbFile, vaultDir });

    const noteA = readFileSync(
      join(result.root, "notes", `note-${ids.noteA}.md`),
      "utf8",
    );
    expect(noteA).toContain(`- relates to [[note-${ids.noteB}]]`);
    expect(noteA).toContain(`- consolidated into [[lesson-${ids.lesson}]]`);

    const lesson = readFileSync(
      join(result.root, "lessons", `lesson-${ids.lesson}.md`),
      "utf8",
    );
    expect(lesson).toContain(`- [[note-${ids.noteA}]]`);
    expect(lesson).toContain(`- [[note-${ids.noteB}]]`);
    expect(lesson).not.toContain("9999");

    const procedure = readFileSync(
      join(result.root, "procedures", `procedure-${ids.procedure}.md`),
      "utf8",
    );
    expect(procedure).toContain(`- [[lesson-${ids.lesson}]]`);
    expect(procedure).toContain(`- [[note-${ids.noteB}]]`);
    expect(procedure).not.toContain("9999");

    // noteB has no outgoing edges and is not archived — no Links section.
    const noteB = readFileSync(
      join(result.root, "notes", `note-${ids.noteB}.md`),
      "utf8",
    );
    expect(noteB).not.toContain("## Links");
  });

  it("is idempotent: a re-export against an unchanged corpus is byte-identical", () => {
    buildCorpus(dbFile);
    const first = exportMemoryToObsidian({ dbFile, vaultDir });
    const snapshot = new Map<string, string>();
    for (const sub of ["notes", "lessons", "procedures"]) {
      for (const name of readdirSync(join(first.root, sub))) {
        snapshot.set(
          `${sub}/${name}`,
          readFileSync(join(first.root, sub, name), "utf8"),
        );
      }
    }

    const second = exportMemoryToObsidian({ dbFile, vaultDir });
    expect(second).toEqual(first);
    for (const [rel, content] of snapshot) {
      expect(readFileSync(join(first.root, rel), "utf8")).toBe(content);
    }
  });

  it("prunes machine-owned files of deleted records but never user files", () => {
    const ids = buildCorpus(dbFile);
    const first = exportMemoryToObsidian({ dbFile, vaultDir });
    const stale = join(first.root, "notes", `note-${ids.noteC}.md`);
    expect(existsSync(stale)).toBe(true);

    // A user file inside the export folder and one in the vault root:
    // both must survive every re-export.
    const userFile = join(first.root, "notes", "my own thoughts.md");
    writeFileSync(userFile, "hands off\n");
    const rootFile = join(vaultDir, "daily.md");
    writeFileSync(rootFile, "unrelated vault note\n");

    const notes = new MemoryStore({ dbFile, maxEntries: 100, now: () => T0 });
    try {
      expect(notes.remove(ids.noteC)).toBe(true);
    } finally {
      notes.close();
    }

    const second = exportMemoryToObsidian({ dbFile, vaultDir });
    expect(second.notes).toBe(2);
    expect(second.pruned).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(readFileSync(userFile, "utf8")).toBe("hands off\n");
    expect(readFileSync(rootFile, "utf8")).toBe("unrelated vault note\n");
  });

  it("overwrites an exported file after the underlying record changed", () => {
    const ids = buildCorpus(dbFile);
    const first = exportMemoryToObsidian({ dbFile, vaultDir });
    const path = join(first.root, "notes", `note-${ids.noteB}.md`);
    expect(readFileSync(path, "utf8")).toContain("idb is the reliable input path.");

    const db = new DatabaseCtor(dbFile);
    try {
      db.prepare(`UPDATE memories SET content = ? WHERE id = ?`).run(
        "idb is the ONLY reliable input path.",
        ids.noteB,
      );
    } finally {
      db.close();
    }

    exportMemoryToObsidian({ dbFile, vaultDir });
    expect(readFileSync(path, "utf8")).toContain(
      "idb is the ONLY reliable input path.",
    );
  });

  it("honors --folder and refuses folders escaping the vault", () => {
    buildCorpus(dbFile);
    const result = exportMemoryToObsidian({
      dbFile,
      vaultDir,
      folder: "zettel/agent-memory",
    });
    expect(result.root).toBe(join(vaultDir, "zettel", "agent-memory"));
    expect(existsSync(join(result.root, "notes"))).toBe(true);

    for (const folder of ["", "  ", "..", ".", "../outside"]) {
      expect(() =>
        exportMemoryToObsidian({ dbFile, vaultDir, folder }),
      ).toThrow(ObsidianExportUsageError);
    }
  });

  it("fails on a missing database or a missing vault directory", () => {
    expect(() => exportMemoryToObsidian({ dbFile, vaultDir })).toThrow(
      /no memory database/,
    );
    buildCorpus(dbFile);
    expect(() =>
      exportMemoryToObsidian({ dbFile, vaultDir: join(dir, "nope") }),
    ).toThrow(/vault directory does not exist/);
  });

  it("reads a pre-lessons legacy schema without migrating it", () => {
    // Hand-rolled v2-era database: only `memories`, no lessons /
    // procedures / links tables, no `consolidated_into` column.
    const db = new DatabaseCtor(dbFile);
    try {
      db.exec(`
        CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          source TEXT NOT NULL,
          session_id TEXT,
          working_dir TEXT,
          tags TEXT
        );
      `);
      db.prepare(
        `INSERT INTO memories (content, created_at, updated_at, source, tags)
         VALUES (?, ?, ?, 'agent', ?)`,
      ).run("legacy note", T0, T0, JSON.stringify(["old"]));
    } finally {
      db.close();
    }

    const result = exportMemoryToObsidian({ dbFile, vaultDir });
    expect(result).toMatchObject({ notes: 1, lessons: 0, procedures: 0 });
    const note = readFileSync(
      join(result.root, "notes", "note-1.md"),
      "utf8",
    );
    expect(note).toContain("legacy note");
    expect(note).toContain('  - "old"');

    // Read-only guarantee: the export created none of the newer tables.
    const check = new DatabaseCtor(dbFile, { readonly: true });
    try {
      const tables = check
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
        .all() as { name: string }[];
      expect(tables.map((t) => t.name)).toEqual(["memories", "sqlite_sequence"]);
    } finally {
      check.close();
    }
  });
});
