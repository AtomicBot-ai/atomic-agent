import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChatSessionMap } from "./chat-session-map.js";

describe("ChatSessionMap", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-chat-session-map-"));
    path = join(dir, "telegram-session.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads an empty map when the file does not exist", () => {
    const map = new ChatSessionMap(path);
    expect(map.read()).toEqual({ chats: {} });
    expect(map.get("100")).toEqual({ current: null });
    expect(map.entries()).toEqual([]);
  });

  it("keeps one session per chat key", () => {
    const map = new ChatSessionMap(path);
    map.setCurrent("100", "s-a", "Project A");
    map.setCurrent("200", "s-b", "Project B");
    expect(map.get("100").current).toBe("s-a");
    expect(map.get("200").current).toBe("s-b");
    expect(map.get("300").current).toBeNull();
    // Survives a fresh read from disk.
    const again = new ChatSessionMap(path);
    expect(again.get("100").label).toBe("Project A");
    expect(again.entries().map((e) => e.chatKey)).toEqual(["100", "200"]);
  });

  it("writes the v2 shape with a version marker", () => {
    const map = new ChatSessionMap(path);
    map.setCurrent("100", "s-a");
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(raw.version).toBe(2);
    expect(raw.chats).toMatchObject({ "100": { current: "s-a" } });
  });

  it("rotate archives the current id for that chat only", () => {
    const map = new ChatSessionMap(path);
    map.setCurrent("100", "s-a");
    map.setCurrent("200", "s-b");
    map.rotate("100");
    expect(map.get("100")).toMatchObject({ current: null, history: ["s-a"] });
    expect(map.get("200").current).toBe("s-b");
  });

  it("rotate is idempotent when the chat has no current session", () => {
    const map = new ChatSessionMap(path);
    map.rotate("100");
    expect(map.get("100")).toEqual({ current: null });
    map.setCurrent("100", "s-a");
    map.rotate("100");
    map.rotate("100");
    expect(map.get("100").history).toEqual(["s-a"]);
  });

  it("caps history at the 16 most recent ids, newest first", () => {
    const map = new ChatSessionMap(path);
    for (let i = 1; i <= 20; i += 1) {
      map.setCurrent("100", `s-${i}`);
      map.rotate("100");
    }
    const { history } = map.get("100");
    expect(history).toHaveLength(16);
    expect(history![0]).toBe("s-20");
    expect(history![15]).toBe("s-5");
  });

  it("setCurrent over a different current pushes the old one into history (/switch)", () => {
    const map = new ChatSessionMap(path);
    map.setCurrent("100", "s-a");
    map.setCurrent("100", "s-b");
    expect(map.get("100")).toMatchObject({ current: "s-b", history: ["s-a"] });
    // Re-pointing at the same id changes nothing in history.
    map.setCurrent("100", "s-b");
    expect(map.get("100").history).toEqual(["s-a"]);
    // Going back does not duplicate the id in history.
    map.setCurrent("100", "s-a");
    expect(map.get("100")).toMatchObject({ current: "s-a", history: ["s-b"] });
  });

  it("setCurrent keeps the existing label when none is given", () => {
    const map = new ChatSessionMap(path);
    map.setCurrent("100", "s-a", "Ops");
    map.setCurrent("100", "s-b");
    expect(map.get("100").label).toBe("Ops");
  });

  describe("v1 migration", () => {
    it("reads a v1 pointer as legacy and hands it to the first DM that asks", () => {
      writeFileSync(
        path,
        JSON.stringify({ current: "s-old", history: ["s-older"] }),
      );
      const map = new ChatSessionMap(path);
      expect(map.read()).toEqual({
        chats: {},
        legacy: { current: "s-old", history: ["s-older"] },
      });
      expect(map.hasLegacy()).toBe(true);
      expect(map.adoptLegacy("42", "DM")).toBe("s-old");
      expect(map.get("42")).toMatchObject({
        current: "s-old",
        history: ["s-older"],
        label: "DM",
      });
      // Adopted exactly once.
      expect(map.hasLegacy()).toBe(false);
      expect(map.adoptLegacy("43")).toBeNull();
      expect(map.get("43").current).toBeNull();
    });

    it("does not adopt over a chat that already has an entry", () => {
      writeFileSync(path, JSON.stringify({ current: "s-old" }));
      const map = new ChatSessionMap(path);
      map.setCurrent("42", "s-new");
      expect(map.adoptLegacy("42")).toBeNull();
      expect(map.get("42").current).toBe("s-new");
      // Legacy survives for a later DM.
      expect(map.hasLegacy()).toBe(true);
    });

    it("carries the legacy pointer through v2 writes until adopted", () => {
      writeFileSync(path, JSON.stringify({ current: "s-old" }));
      const map = new ChatSessionMap(path);
      map.setCurrent("200", "s-group");
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<
        string,
        unknown
      >;
      expect(raw.legacy).toEqual({ current: "s-old" });
      expect(new ChatSessionMap(path).adoptLegacy("42")).toBe("s-old");
    });

    it("treats an empty v1 pointer as nothing to adopt", () => {
      writeFileSync(path, JSON.stringify({ current: null }));
      const map = new ChatSessionMap(path);
      expect(map.read()).toEqual({ chats: {} });
      expect(map.adoptLegacy("42")).toBeNull();
    });
  });

  describe("robustness", () => {
    it("reads corrupt JSON as an empty map instead of throwing", () => {
      writeFileSync(path, "{ not json");
      expect(new ChatSessionMap(path).read()).toEqual({ chats: {} });
    });

    it("drops malformed entries and non-string ids", () => {
      writeFileSync(
        path,
        JSON.stringify({
          version: 2,
          chats: {
            "100": { current: 7, history: ["s-1", 3, ""] },
            "200": "nope",
            "300": { current: "s-3", label: "" },
          },
        }),
      );
      const map = new ChatSessionMap(path);
      expect(map.get("100")).toEqual({ current: null, history: ["s-1"] });
      expect(map.get("200")).toEqual({ current: null });
      expect(map.get("300")).toEqual({ current: "s-3" });
    });

    it("remove forgets one chat and reset forgets everything", () => {
      writeFileSync(path, JSON.stringify({ current: "s-old" }));
      const map = new ChatSessionMap(path);
      map.setCurrent("100", "s-a");
      map.setCurrent("200", "s-b");
      map.remove("100");
      expect(map.entries().map((e) => e.chatKey)).toEqual(["200"]);
      map.reset();
      expect(map.read()).toEqual({ chats: {} });
      expect(map.hasLegacy()).toBe(false);
    });
  });
});

describe("ChatSessionMap — history cap on /switch", () => {
  it("frees the target's own slot before capping, so nothing is evicted needlessly", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-chat-session-cap-"));
    const map = new ChatSessionMap(join(dir, "m.json"));
    for (let i = 1; i <= 16; i += 1) {
      map.setCurrent("c", `s-${i}`);
      map.rotate("c");
    }
    map.setCurrent("c", "s-now");
    expect(map.get("c").history).toHaveLength(16);
    expect(map.get("c").history!.at(-1)).toBe("s-1");
    // Switch back to the oldest archived id: s-now goes in, s-1 comes out
    // of history because it is now current — s-2 (the next oldest) stays.
    map.setCurrent("c", "s-1");
    const { history } = map.get("c");
    expect(history).toHaveLength(16);
    expect(history![0]).toBe("s-now");
    expect(history).toContain("s-2");
    expect(history).not.toContain("s-1");
    rmSync(dir, { recursive: true, force: true });
  });
});
