import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";

import { MetricsCollector } from "../tracing/metrics-collector.js";
import { AgentMetrics } from "../tracing/agent-metrics.js";

import { ProfileStore } from "./profile-store.js";

/**
 * Memory-v2 phase 4. Bi-temporal CRUD on `ProfileStore`. Pins:
 *
 *   - Same-key SET auto-chains the active row.
 *   - Cross-key supersession via `supersedesKey` opts.
 *   - `history(key)` walks the full chain in temporal order.
 *   - Partial unique index `idx_profile_active_key` enforces "at
 *     most one active row per key" — pinned by inspecting the
 *     intermediate state via `db.prepare`.
 *   - `remove()` deletes only the active row; historical chain is
 *     preserved.
 *   - Legacy v6 → v7 migration produces one v7 row per legacy row
 *     with `valid_from = updated_at`, `superseded_by = NULL`.
 *   - The `agent.memory.profile.superseded` counter fires on every
 *     supersession (4.A.4).
 */

interface Harness {
  dir: string;
  store: ProfileStore;
  events: Array<{ name: string; value: number; tags?: Record<string, string> }>;
  dispose: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "atomic-profile-bt-"));
  const events: Harness["events"] = [];
  const collector = new MetricsCollector({
    sinks: [
      (e) =>
        events.push({
          name: e.name,
          value: e.value,
          tags: e.tags as Record<string, string> | undefined,
        }),
    ],
  });
  const metrics = new AgentMetrics(collector);
  const store = new ProfileStore({
    dbFile: join(dir, "memory.sqlite"),
    metrics,
  });
  return {
    dir,
    store,
    events,
    dispose: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("ProfileStore (bi-temporal phase 4)", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.dispose();
  });

  it("scenario 4.A — language change preserves history", () => {
    h.store.set("language", "ru", 1_000);
    expect(h.store.get("language")?.value).toBe("ru");
    h.store.set("language", "en", 2_000);
    // 4.A.1 — active row is `en`, only one active.
    expect(h.store.get("language")?.value).toBe("en");
    expect(h.store.list().map((f) => f.value)).toEqual(["en"]);
    // 4.A.2 — history returns both rows in temporal order.
    const chain = h.store.history("language");
    expect(chain.map((r) => r.value)).toEqual(["ru", "en"]);
    expect(chain[0]?.supersededBy).toBe(chain[1]?.id);
    expect(chain[1]?.supersededBy).toBeNull();
    expect(chain[1]?.supersedes).toBe(chain[0]?.id);
    // 4.A.4 — superseded metric fired.
    const superseded = h.events.find(
      (e) => e.name === "agent.memory.profile.superseded",
    );
    expect(superseded).toBeDefined();
    expect(superseded?.tags?.key).toBe("language");
  });

  it("4.A.3 — partial unique index forbids two active rows for one key", () => {
    h.store.set("language", "ru", 1_000);
    h.store.set("language", "en", 2_000);
    // Inspect raw rows: exactly one row with `superseded_by IS NULL`.
    const db = new DatabaseCtor(join(h.dir, "memory.sqlite"));
    try {
      const activeCount = db
        .prepare(
          `SELECT COUNT(*) AS c FROM profile_facts
            WHERE key = 'language' AND superseded_by IS NULL`,
        )
        .get() as { c: number };
      expect(activeCount.c).toBe(1);
      const totalCount = db
        .prepare(`SELECT COUNT(*) AS c FROM profile_facts WHERE key = 'language'`)
        .get() as { c: number };
      expect(totalCount.c).toBe(2);
      // The partial unique index is what enforces this — make sure
      // it exists on the table.
      const indexes = db
        .prepare(`PRAGMA index_list('profile_facts')`)
        .all() as Array<{ name: string; unique: number; partial: number }>;
      const partialUnique = indexes.find(
        (i) => i.name === "idx_profile_active_key",
      );
      expect(partialUnique?.unique).toBe(1);
      expect(partialUnique?.partial).toBe(1);
    } finally {
      db.close();
    }
  });

  it("remove() deletes only the active row, history chain intact", () => {
    h.store.set("language", "ru", 1_000);
    h.store.set("language", "en", 2_000);
    expect(h.store.remove("language")).toBe(true);
    expect(h.store.get("language")).toBeNull();
    // Historical chain still walks the old `ru` row.
    const chain = h.store.history("language");
    expect(chain.length).toBe(1);
    expect(chain[0]?.value).toBe("ru");
  });

  it("history() returns empty when key has never been written", () => {
    expect(h.store.history("nope")).toEqual([]);
  });

  it("history() returns single-row chain for an active key with no supersession", () => {
    h.store.set("name", "Alex", 5_000);
    const chain = h.store.history("name");
    expect(chain.length).toBe(1);
    expect(chain[0]?.supersededBy).toBeNull();
    expect(chain[0]?.supersedes).toBeNull();
  });

  it("chains across many writes (5 versions)", () => {
    for (let i = 0; i < 5; i += 1) {
      h.store.set("counter", String(i), 1_000 + i);
    }
    const chain = h.store.history("counter");
    expect(chain.map((r) => r.value)).toEqual(["0", "1", "2", "3", "4"]);
    // Only the last is active.
    expect(chain.filter((r) => r.supersededBy === null).length).toBe(1);
    expect(chain[chain.length - 1]?.supersededBy).toBeNull();
    // Every earlier row points forward correctly.
    for (let i = 0; i < chain.length - 1; i += 1) {
      expect(chain[i]?.supersededBy).toBe(chain[i + 1]?.id);
    }
  });

  it("cross-key supersession via supersedesKey opt flips the source row", () => {
    h.store.set("name", "Alex", 1_000);
    h.store.set(
      "full_name",
      "Alexei Kalina",
      { supersedesKey: "name" },
      2_000,
    );
    // `name` no longer active.
    expect(h.store.get("name")).toBeNull();
    // `full_name` is active.
    expect(h.store.get("full_name")?.value).toBe("Alexei Kalina");
    // The `name` row still exists in its own history.
    const nameChain = h.store.history("name");
    expect(nameChain.length).toBe(1);
    expect(nameChain[0]?.supersededBy).toBe(h.store.get("full_name")?.id);
  });

  it("supersedesKey of a non-existent key is a no-op (still inserts cleanly)", () => {
    const fact = h.store.set(
      "lang",
      "ru",
      { supersedesKey: "language" },
      1_000,
    );
    expect(fact.value).toBe("ru");
    expect(fact.supersedes).toBeNull();
  });

  it("pinned + keywords survive every version", () => {
    h.store.set("deploy_cmd", "v1", {
      pinned: false,
      keywords: ["deploy"],
    });
    h.store.set("deploy_cmd", "v2", {
      pinned: false,
      keywords: ["deploy", "ship"],
    });
    const active = h.store.get("deploy_cmd");
    expect(active?.pinned).toBe(false);
    expect(active?.keywords).toEqual(["deploy", "ship"]);
    const chain = h.store.history("deploy_cmd");
    expect(chain[0]?.keywords).toEqual(["deploy"]);
    expect(chain[1]?.keywords).toEqual(["deploy", "ship"]);
  });

  it("legacy v3 row migrates to v7 with valid_from = updated_at and active state", () => {
    // Build a synthetic pre-v7 state with a populated profile_facts.
    h.store.close();
    const dbFile = join(h.dir, "memory-legacy.sqlite");
    const seed = new DatabaseCtor(dbFile);
    seed.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE profile_facts (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 1,
        keywords TEXT
      );
      INSERT INTO profile_facts (key, value, updated_at, pinned, keywords)
        VALUES ('language', 'ru', 12345, 1, NULL),
               ('deploy_cmd', 'pnpm deploy', 67890, 0, '["deploy","ship"]');
      INSERT INTO schema_meta (key, value) VALUES ('version', '6');
    `);
    seed.close();

    // Reopen via ProfileStore — applyMigrations should run v7.
    const reopened = new ProfileStore({ dbFile });
    try {
      // 4.B.2 — list renders identically.
      const facts = reopened.list();
      expect(facts.map((f) => ({ k: f.key, v: f.value }))).toEqual([
        { k: "deploy_cmd", v: "pnpm deploy" },
        { k: "language", v: "ru" },
      ]);
      // 4.B.1 — every legacy row landed in v7 shape with proper
      // valid_from + NULL superseded_by + NULL supersedes.
      for (const fact of facts) {
        expect(fact.supersededBy).toBeNull();
        expect(fact.supersedes).toBeNull();
        expect(fact.id).toBeGreaterThan(0);
        // valid_from should match the legacy updated_at.
        if (fact.key === "language") expect(fact.validFrom).toBe(12345);
        if (fact.key === "deploy_cmd") expect(fact.validFrom).toBe(67890);
      }
      // Keywords/pinned preserved.
      const deploy = reopened.get("deploy_cmd");
      expect(deploy?.pinned).toBe(false);
      expect(deploy?.keywords).toEqual(["deploy", "ship"]);
    } finally {
      reopened.close();
    }
  });

  it("getById returns the row regardless of supersession", () => {
    const first = h.store.set("language", "ru", 1_000);
    h.store.set("language", "en", 2_000);
    const fetched = h.store.getById(first.id);
    expect(fetched?.value).toBe("ru");
    expect(fetched?.supersededBy).not.toBeNull();
  });
});
