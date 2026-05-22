import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ProfileStore,
  ProfileValidationError,
  PROFILE_KEY_MAX_LENGTH,
  PROFILE_VALUE_MAX_LENGTH,
} from "./profile-store.js";

describe("ProfileStore", () => {
  let tmp: string;
  let store: ProfileStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-profile-"));
    store = new ProfileStore({ dbFile: join(tmp, "memory.sqlite") });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("upserts and reads back a fact", () => {
    store.set("language", "ru", 1_000);
    const got = store.get("language");
    expect(got).toMatchObject({
      key: "language",
      value: "ru",
      validFrom: 1_000,
      updatedAt: 1_000,
      pinned: true,
      keywords: [],
      supersedes: null,
      supersededBy: null,
    });
    expect(got?.id).toBeGreaterThan(0);
  });

  it("auto-chains the active row on a same-key set (memory-v2 phase 4)", () => {
    store.set("timezone", "Europe/Moscow", 1_000);
    store.set("timezone", "UTC", 2_000);
    const active = store.get("timezone");
    expect(active).toMatchObject({
      key: "timezone",
      value: "UTC",
      validFrom: 2_000,
      pinned: true,
      keywords: [],
      supersededBy: null,
    });
    // The second SET should supersede the first.
    expect(active?.supersedes).not.toBeNull();
    const chain = store.history("timezone");
    expect(chain).toHaveLength(2);
    expect(chain[0]?.value).toBe("Europe/Moscow");
    expect(chain[0]?.supersededBy).toBe(active?.id);
    expect(chain[1]?.value).toBe("UTC");
    expect(chain[1]?.supersededBy).toBeNull();
  });

  it("persists pinned=false with keywords for contextual facts", () => {
    store.set("deploy_cmd", "pnpm run deploy", {
      pinned: false,
      keywords: ["deploy", "release", "ship"],
    });
    const got = store.get("deploy_cmd");
    expect(got?.pinned).toBe(false);
    expect(got?.keywords).toEqual(["deploy", "release", "ship"]);
  });

  it("discards keywords when pinned=true", () => {
    store.set("language", "ru", {
      pinned: true,
      keywords: ["lang"],
    });
    const got = store.get("language");
    expect(got?.pinned).toBe(true);
    expect(got?.keywords).toEqual([]);
  });

  it("deduplicates and lowercases keywords", () => {
    store.set("ci_url", "https://ci.example/foo", {
      pinned: false,
      keywords: ["CI", "ci", "  Deploy  "],
    });
    const got = store.get("ci_url");
    expect(got?.keywords).toEqual(["ci", "deploy"]);
  });

  it("defaults pinned=true for the legacy 3-arg set(key, value, now) call form", () => {
    store.set("language", "ru", 1_000);
    const got = store.get("language");
    expect(got?.pinned).toBe(true);
    expect(got?.updatedAt).toBe(1_000);
  });

  it("removes a fact and reports whether it existed", () => {
    store.set("name", "Alex", 1_000);
    expect(store.remove("name")).toBe(true);
    expect(store.remove("name")).toBe(false);
    expect(store.get("name")).toBeNull();
  });

  it("lists facts in alphabetical key order", () => {
    store.set("zulu", "z", 3_000);
    store.set("alpha", "a", 1_000);
    store.set("mike", "m", 2_000);
    expect(store.list().map((f) => f.key)).toEqual(["alpha", "mike", "zulu"]);
  });

  it("rejects invalid keys", () => {
    expect(() => store.set("", "x")).toThrow(ProfileValidationError);
    expect(() => store.set("  ", "x")).toThrow(ProfileValidationError);
    expect(() => store.set("has space", "x")).toThrow(ProfileValidationError);
    expect(() => store.set("_leading_underscore", "x")).toThrow(
      ProfileValidationError,
    );
    expect(() => store.set("a".repeat(PROFILE_KEY_MAX_LENGTH + 1), "x")).toThrow(
      ProfileValidationError,
    );
  });

  it("rejects invalid values", () => {
    expect(() => store.set("k", "")).toThrow(ProfileValidationError);
    expect(() =>
      store.set("k", "x".repeat(PROFILE_VALUE_MAX_LENGTH + 1)),
    ).toThrow(ProfileValidationError);
  });

  it("trims whitespace from keys but preserves value whitespace", () => {
    store.set("  language  ", "  ru  ", 1_000);
    expect(store.get("language")?.value).toBe("  ru  ");
  });

  it("survives reopen — durable across store instances", () => {
    store.set("name", "Alex", 1_000);
    store.close();
    const reopened = new ProfileStore({ dbFile: join(tmp, "memory.sqlite") });
    try {
      expect(reopened.get("name")?.value).toBe("Alex");
    } finally {
      reopened.close();
    }
    store = new ProfileStore({ dbFile: join(tmp, "memory.sqlite") });
  });
});
