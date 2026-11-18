import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FactCandidate } from "../../memory/import-facts/extract-fact-candidates.js";
import { MemoryStore } from "../../memory/memory-store.js";
import { ProfileStore } from "../../memory/profile-store.js";
import {
  IMPORTED_FACTS_TAG,
  removeImportedFactNotes,
  saveFactCandidates,
  undoImportedFacts,
} from "./save-fact-candidates.js";

const CANDIDATES: FactCandidate[] = [
  { id: "c0-0", kind: "profile", key: "job", value: "designer", pinned: true, chatId: "a", quote: "I'm a designer" },
  { id: "c0-1", kind: "profile", key: "city", value: "Berlin", pinned: true, chatId: "a", quote: "from Berlin" },
  {
    id: "c1-0",
    kind: "note",
    key: null,
    value: "The person is building a portfolio site for a job search.",
    pinned: false,
    chatId: "b",
    quote: "help me with my portfolio",
  },
  { id: "c1-1", kind: "profile", key: "language", value: "German", pinned: true, chatId: "b", quote: "x" },
];

let dir: string;
let profile: ProfileStore;
let memory: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "user-facts-save-"));
  const dbFile = join(dir, "memory.sqlite");
  profile = new ProfileStore({ dbFile });
  memory = new MemoryStore({ dbFile, maxEntries: 100 });
});

afterEach(() => {
  profile.close();
  memory.close();
  rmSync(dir, { recursive: true, force: true });
});

function save(approvedIds: string[], now = 1_000) {
  return saveFactCandidates({
    candidates: CANDIDATES,
    approvedIds,
    source: "chatgpt",
    profileStore: profile,
    memoryStore: memory,
    now,
  });
}

describe("saveFactCandidates (ATO-1625)", () => {
  it("writes only what the person ticked, notes tagged with the source", () => {
    const { report, receipt } = save(["c0-0", "c0-1", "c1-0"]);
    expect(report.summary.migrated).toBe(3);
    expect(profile.get("job")?.value).toBe("designer");
    expect(profile.get("city")?.value).toBe("Berlin");
    expect(profile.get("language")).toBeNull();
    const notes = memory.list({ scope: "all" });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.content).toBe("From ChatGPT: The person is building a portfolio site for a job search.");
    expect(notes[0]!.tags).toEqual(expect.arrayContaining([IMPORTED_FACTS_TAG, "from-chatgpt"]));
    expect(notes[0]!.source).toBe("user");
    expect(receipt.profile.map((p) => p.key).sort()).toEqual(["city", "job"]);
    expect(receipt.noteIds).toEqual([notes[0]!.id]);
  });

  it("a second run adds nothing", () => {
    save(["c0-0", "c0-1", "c1-0"]);
    const { report, receipt } = save(["c0-0", "c0-1", "c1-0"], 2_000);
    expect(report.summary.migrated).toBe(0);
    expect(report.summary.skipped).toBe(3);
    expect(receipt.profile).toEqual([]);
    expect(receipt.noteIds).toEqual([]);
    expect(memory.list({ scope: "all" })).toHaveLength(1);
  });

  it("never overwrites a different stored value: reports was / would be", () => {
    profile.set("city", "Lisbon");
    const { report } = save(["c0-1"]);
    expect(report.summary.conflict).toBe(1);
    expect(report.items[0]!.reason).toContain('was "Lisbon"');
    expect(report.items[0]!.reason).toContain('would be "Berlin"');
    expect(profile.get("city")?.value).toBe("Lisbon");
  });

  it("undo removes only what the import wrote; older memory stays", () => {
    profile.set("name", "Nadia", { nameGrounding: "grounded" });
    const old = memory.store({ content: "An older note the person wrote", source: "user" });
    const { receipt } = save(["c0-0", "c0-1", "c1-0"]);
    const res = undoImportedFacts(receipt, profile, memory);
    expect(res).toEqual({ profileRemoved: 2, profileKept: 0, notesRemoved: 1 });
    expect(profile.get("job")).toBeNull();
    expect(profile.get("city")).toBeNull();
    expect(profile.get("name")?.value).toBe("Nadia");
    expect(memory.get(old.id)?.content).toBe("An older note the person wrote");
  });

  it("undo keeps a profile key changed after the import", () => {
    const { receipt } = save(["c0-0"]);
    profile.set("job", "art director");
    const res = undoImportedFacts(receipt, profile, memory);
    expect(res.profileKept).toBe(1);
    expect(profile.get("job")?.value).toBe("art director");
  });

  it("removes imported notes by tag without a receipt", () => {
    memory.store({ content: "Unrelated note", source: "user" });
    save(["c1-0"]);
    expect(removeImportedFactNotes("claude", memory)).toBe(0);
    expect(removeImportedFactNotes("chatgpt", memory)).toBe(1);
    expect(memory.list({ scope: "all" }).map((n) => n.content)).toEqual(["Unrelated note"]);
  });
});
