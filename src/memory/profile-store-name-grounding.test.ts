import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProfileStore } from "./profile-store.js";

// ATO-199: name-like facts carry a grounding verdict, and only a name a
// check vouched for reaches the prompt. Nothing is ever deleted for it.
describe("ProfileStore — name grounding", () => {
  let tmp: string;
  let store: ProfileStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-profile-names-"));
    store = new ProfileStore({ dbFile: join(tmp, "memory.sqlite") });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("stamps the verdict on a name-like key only", () => {
    const name = store.set("name", "Надя", { nameGrounding: "grounded" }, 1_000);
    const tz = store.set("timezone", "UTC", { nameGrounding: "grounded" }, 1_000);
    expect(name.nameGrounding).toBe("grounded");
    expect(tz.nameGrounding).toBeNull();
    expect(store.get("name")?.nameGrounding).toBe("grounded");
    expect(store.get("timezone")?.nameGrounding).toBeNull();
  });

  it("keeps an invented or unchecked name out of the prompt but in list()", () => {
    store.set("name", "Анна", { nameGrounding: "ungrounded" }, 1_000);
    store.set("nickname", "Ann", 1_000);
    store.set("full_name", "Xiaoming Li", { nameGrounding: "unverifiable" }, 1_000);
    store.set("language", "ru", 1_000);
    expect(store.list().map((f) => f.key)).toEqual([
      "full_name",
      "language",
      "name",
      "nickname",
    ]);
    expect(store.listForPrompt().map((f) => f.key)).toEqual(["full_name", "language"]);
  });

  it("lists the names still to check: unchecked, and ungrounded with their check time", () => {
    store.set("name", "Анна", { nameGrounding: "ungrounded" }, 1_000);
    store.set("nickname", "Ann", 2_000);
    store.set("first_name", "Надя", { nameGrounding: "grounded" }, 3_000);
    store.set("timezone", "UTC", 4_000);
    const pending = store.listNameFactsToCheck();
    expect(pending.map((p) => [p.fact.key, p.checkedAt])).toEqual([
      ["name", 1_000],
      ["nickname", null],
    ]);
  });

  it("records a verdict without touching the row's value or updated_at", () => {
    const fact = store.set("name", "Анна", 1_000);
    expect(store.listForPrompt()).toEqual([]);
    expect(store.markNameGrounding(fact.id, "grounded", 5_000)).toBe(true);
    const after = store.get("name");
    expect(after?.value).toBe("Анна");
    expect(after?.updatedAt).toBe(1_000);
    expect(after?.nameGrounding).toBe("grounded");
    expect(store.listForPrompt().map((f) => f.key)).toEqual(["name"]);
    expect(store.listNameFactsToCheck()).toEqual([]);
  });

  it("refuses a verdict on a non-name key or a missing row", () => {
    const tz = store.set("timezone", "UTC", 1_000);
    expect(store.markNameGrounding(tz.id, "ungrounded")).toBe(false);
    expect(store.get("timezone")?.nameGrounding).toBeNull();
    expect(store.markNameGrounding(9_999, "grounded")).toBe(false);
  });

  it("ifUnconfirmed never overwrites a confirmation recorded meanwhile", () => {
    const fact = store.set("name", "Надя", 1_000);
    expect(store.markNameGrounding(fact.id, "grounded", 2_000)).toBe(true);
    expect(
      store.markNameGrounding(fact.id, "ungrounded", 3_000, { ifUnconfirmed: true }),
    ).toBe(false);
    expect(store.get("name")?.nameGrounding).toBe("grounded");
    const other = store.set("nickname", "Ann", 1_000);
    expect(
      store.markNameGrounding(other.id, "ungrounded", 3_000, { ifUnconfirmed: true }),
    ).toBe(true);
  });

  it("a new version of a name starts with its own verdict", () => {
    store.set("name", "Анна", { nameGrounding: "ungrounded" }, 1_000);
    store.set("name", "Надя", { nameGrounding: "grounded" }, 2_000);
    expect(store.get("name")?.nameGrounding).toBe("grounded");
    const chain = store.history("name");
    expect(chain.map((f) => [f.value, f.nameGrounding])).toEqual([
      ["Анна", "ungrounded"],
      ["Надя", "grounded"],
    ]);
  });
});
