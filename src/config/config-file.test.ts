import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureUserConfigFileSync,
  getUserConfigPath,
  readUserConfigFileSync,
  writeUserConfigFileSync,
} from "./config-file.js";
import {
  ConfigValidationError,
  USER_CONFIG_DEFAULTS,
  USER_CONFIG_VERSION,
} from "./config-schema.js";

describe("user config file IO", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("getUserConfigPath joins stateDir with config.json", () => {
    expect(getUserConfigPath(dir)).toBe(join(dir, "config.json"));
  });

  it("readUserConfigFileSync returns null when the file is absent", () => {
    expect(readUserConfigFileSync(getUserConfigPath(dir))).toBeNull();
  });

  it("writeUserConfigFileSync persists a valid file that parses back", () => {
    const path = getUserConfigPath(dir);
    writeUserConfigFileSync(path, USER_CONFIG_DEFAULTS);
    const loaded = readUserConfigFileSync(path);
    expect(loaded).toEqual(USER_CONFIG_DEFAULTS);
    const raw = readFileSync(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("readUserConfigFileSync throws on invalid JSON", () => {
    const path = getUserConfigPath(dir);
    writeFileSync(path, "not-json", "utf8");
    expect(() => readUserConfigFileSync(path)).toThrow(ConfigValidationError);
  });

  it("ensureUserConfigFileSync creates defaults and warns once", () => {
    const path = getUserConfigPath(dir);
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const first = ensureUserConfigFileSync(path);
    expect(first).toEqual(USER_CONFIG_DEFAULTS);
    expect(readFileSync(path, "utf8")).toContain("\"localModels\"");
    expect(warn).toHaveBeenCalledOnce();

    const second = ensureUserConfigFileSync(path);
    expect(second).toEqual(USER_CONFIG_DEFAULTS);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("ensureUserConfigFileSync migrates v5 on disk and preserves user values", () => {
    const path = getUserConfigPath(dir);
    const v5 = {
      version: 5,
      localModels: {
        url: "http://127.0.0.1:9999",
        mode: "managed",
        managed: {
          modelId: "qwen-3.5-4b",
          port: 19091,
          dataDirOverride: null,
          autoUpdate: false,
        },
      },
      log: { level: "debug" },
      agent: USER_CONFIG_DEFAULTS.agent,
      http: USER_CONFIG_DEFAULTS.http,
      tracing: USER_CONFIG_DEFAULTS.tracing,
      memory: USER_CONFIG_DEFAULTS.memory,
      webhooks: {},
    };
    writeFileSync(path, JSON.stringify(v5, null, 2) + "\n", "utf8");

    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const migrated = ensureUserConfigFileSync(path);

    expect(migrated.version).toBe(USER_CONFIG_VERSION);
    expect(migrated.localModels.url).toBe("http://127.0.0.1:9999");
    expect(migrated.localModels.completionMaxTokens).toBe(
      USER_CONFIG_DEFAULTS.localModels.completionMaxTokens,
    );
    expect(migrated.log.level).toBe("debug");
    expect(migrated.vision).toEqual(USER_CONFIG_DEFAULTS.vision);

    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.version).toBe(USER_CONFIG_VERSION);
    expect(onDisk.vision).toEqual(USER_CONFIG_DEFAULTS.vision);
    expect(onDisk.localModels.url).toBe("http://127.0.0.1:9999");
    expect(onDisk.localModels.completionMaxTokens).toBe(
      USER_CONFIG_DEFAULTS.localModels.completionMaxTokens,
    );

    const calls = warn.mock.calls.map((args) => String(args[0]));
    expect(
      calls.some((line) => line.includes(`migrated config v5 → v${USER_CONFIG_VERSION}`)),
    ).toBe(true);
    warn.mockRestore();
  });

  it("ensureUserConfigFileSync migrates v15 → v16 by filling memory.voting defaults", () => {
    const path = getUserConfigPath(dir);
    const memoryWithoutV16 = {
      profile: USER_CONFIG_DEFAULTS.memory.profile,
      reflection: USER_CONFIG_DEFAULTS.memory.reflection,
      notes: USER_CONFIG_DEFAULTS.memory.notes,
      recallInjection: USER_CONFIG_DEFAULTS.memory.recallInjection,
      index: USER_CONFIG_DEFAULTS.memory.index,
      dedup: USER_CONFIG_DEFAULTS.memory.dedup,
      eviction: USER_CONFIG_DEFAULTS.memory.eviction,
      embeddings: USER_CONFIG_DEFAULTS.memory.embeddings,
      links: USER_CONFIG_DEFAULTS.memory.links,
      evolution: USER_CONFIG_DEFAULTS.memory.evolution,
      lessons: USER_CONFIG_DEFAULTS.memory.lessons,
      consolidation: USER_CONFIG_DEFAULTS.memory.consolidation,
    };
    const v15 = {
      version: 15,
      localModels: USER_CONFIG_DEFAULTS.localModels,
      log: { level: "info" },
      agent: USER_CONFIG_DEFAULTS.agent,
      http: USER_CONFIG_DEFAULTS.http,
      tracing: USER_CONFIG_DEFAULTS.tracing,
      memory: memoryWithoutV16,
      webhooks: {},
      vision: USER_CONFIG_DEFAULTS.vision,
      skills: { disabled: [] },
      telegram: USER_CONFIG_DEFAULTS.telegram,
    };
    writeFileSync(path, JSON.stringify(v15, null, 2) + "\n", "utf8");

    const warn = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const migrated = ensureUserConfigFileSync(path);

    expect(migrated.version).toBe(USER_CONFIG_VERSION);
    expect(migrated.memory.voting).toEqual(USER_CONFIG_DEFAULTS.memory.voting);
    expect(migrated.memory.voting.enabled).toBe(false);
    expect(migrated.memory.voting.maxVotePerItem).toBe(50);
    expect(migrated.memory.voting.signalDecay).toBeCloseTo(0.95);
    expect(migrated.memory.voting.scoreBlend).toBeCloseTo(0.6);

    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.version).toBe(USER_CONFIG_VERSION);
    expect(onDisk.memory.voting).toEqual(USER_CONFIG_DEFAULTS.memory.voting);
    warn.mockRestore();
  });

  it("ensureUserConfigFileSync migrates v14 → v15 by filling memory.lessons + memory.consolidation defaults", () => {
    const path = getUserConfigPath(dir);
    // Build a synthetic v14 by stripping the new `memory.lessons` and
    // `memory.consolidation` blocks.
    const memoryWithoutV15 = {
      profile: USER_CONFIG_DEFAULTS.memory.profile,
      reflection: USER_CONFIG_DEFAULTS.memory.reflection,
      notes: USER_CONFIG_DEFAULTS.memory.notes,
      recallInjection: USER_CONFIG_DEFAULTS.memory.recallInjection,
      index: USER_CONFIG_DEFAULTS.memory.index,
      dedup: USER_CONFIG_DEFAULTS.memory.dedup,
      eviction: USER_CONFIG_DEFAULTS.memory.eviction,
      embeddings: USER_CONFIG_DEFAULTS.memory.embeddings,
      links: USER_CONFIG_DEFAULTS.memory.links,
      evolution: USER_CONFIG_DEFAULTS.memory.evolution,
    };
    const v14 = {
      version: 14,
      localModels: USER_CONFIG_DEFAULTS.localModels,
      log: { level: "info" },
      agent: USER_CONFIG_DEFAULTS.agent,
      http: USER_CONFIG_DEFAULTS.http,
      tracing: USER_CONFIG_DEFAULTS.tracing,
      memory: memoryWithoutV15,
      webhooks: {},
      vision: USER_CONFIG_DEFAULTS.vision,
      skills: { disabled: [] },
      telegram: USER_CONFIG_DEFAULTS.telegram,
    };
    writeFileSync(path, JSON.stringify(v14, null, 2) + "\n", "utf8");

    const warn = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const migrated = ensureUserConfigFileSync(path);

    expect(migrated.version).toBe(USER_CONFIG_VERSION);
    expect(migrated.memory.lessons).toEqual(
      USER_CONFIG_DEFAULTS.memory.lessons,
    );
    expect(migrated.memory.consolidation).toEqual(
      USER_CONFIG_DEFAULTS.memory.consolidation,
    );
    expect(migrated.memory.lessons.enabled).toBe(false);
    expect(migrated.memory.consolidation.enabled).toBe(false);

    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.version).toBe(USER_CONFIG_VERSION);
    expect(onDisk.memory.lessons).toEqual(USER_CONFIG_DEFAULTS.memory.lessons);
    expect(onDisk.memory.consolidation).toEqual(
      USER_CONFIG_DEFAULTS.memory.consolidation,
    );
    warn.mockRestore();
  });

  it("ensureUserConfigFileSync migrates v13 → v14 by filling memory.evolution defaults (via v15)", () => {
    const path = getUserConfigPath(dir);
    // Build a synthetic v13 by stripping the new `memory.evolution` block.
    const memoryWithoutV14 = {
      profile: USER_CONFIG_DEFAULTS.memory.profile,
      reflection: USER_CONFIG_DEFAULTS.memory.reflection,
      notes: USER_CONFIG_DEFAULTS.memory.notes,
      recallInjection: USER_CONFIG_DEFAULTS.memory.recallInjection,
      index: USER_CONFIG_DEFAULTS.memory.index,
      dedup: USER_CONFIG_DEFAULTS.memory.dedup,
      eviction: USER_CONFIG_DEFAULTS.memory.eviction,
      embeddings: USER_CONFIG_DEFAULTS.memory.embeddings,
      links: USER_CONFIG_DEFAULTS.memory.links,
    };
    const v13 = {
      version: 13,
      localModels: USER_CONFIG_DEFAULTS.localModels,
      log: { level: "info" },
      agent: USER_CONFIG_DEFAULTS.agent,
      http: USER_CONFIG_DEFAULTS.http,
      tracing: USER_CONFIG_DEFAULTS.tracing,
      memory: memoryWithoutV14,
      webhooks: {},
      vision: USER_CONFIG_DEFAULTS.vision,
      skills: { disabled: [] },
      telegram: USER_CONFIG_DEFAULTS.telegram,
    };
    writeFileSync(path, JSON.stringify(v13, null, 2) + "\n", "utf8");

    const warn = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const migrated = ensureUserConfigFileSync(path);

    expect(migrated.version).toBe(USER_CONFIG_VERSION);
    expect(migrated.memory.evolution).toEqual(
      USER_CONFIG_DEFAULTS.memory.evolution,
    );
    expect(migrated.memory.evolution.enabled).toBe(false);

    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.version).toBe(USER_CONFIG_VERSION);
    expect(onDisk.memory.evolution).toEqual(
      USER_CONFIG_DEFAULTS.memory.evolution,
    );
    warn.mockRestore();
  });

  it("ensureUserConfigFileSync migrates v12 → v13 by filling memory.links defaults", () => {
    const path = getUserConfigPath(dir);
    // Build a synthetic v12 by stripping the new `memory.links` block.
    const memoryWithoutV13 = {
      profile: USER_CONFIG_DEFAULTS.memory.profile,
      reflection: USER_CONFIG_DEFAULTS.memory.reflection,
      notes: USER_CONFIG_DEFAULTS.memory.notes,
      recallInjection: USER_CONFIG_DEFAULTS.memory.recallInjection,
      index: USER_CONFIG_DEFAULTS.memory.index,
      dedup: USER_CONFIG_DEFAULTS.memory.dedup,
      eviction: USER_CONFIG_DEFAULTS.memory.eviction,
      embeddings: USER_CONFIG_DEFAULTS.memory.embeddings,
    };
    const v12 = {
      version: 12,
      localModels: USER_CONFIG_DEFAULTS.localModels,
      log: { level: "info" },
      agent: USER_CONFIG_DEFAULTS.agent,
      http: USER_CONFIG_DEFAULTS.http,
      tracing: USER_CONFIG_DEFAULTS.tracing,
      memory: memoryWithoutV13,
      webhooks: {},
      vision: USER_CONFIG_DEFAULTS.vision,
      skills: { disabled: [] },
      telegram: USER_CONFIG_DEFAULTS.telegram,
    };
    writeFileSync(path, JSON.stringify(v12, null, 2) + "\n", "utf8");

    const warn = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const migrated = ensureUserConfigFileSync(path);

    expect(migrated.version).toBe(USER_CONFIG_VERSION);
    expect(migrated.memory.links).toEqual(USER_CONFIG_DEFAULTS.memory.links);
    expect(migrated.memory.links.enabled).toBe(false);

    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.version).toBe(USER_CONFIG_VERSION);
    expect(onDisk.memory.links).toEqual(USER_CONFIG_DEFAULTS.memory.links);
    warn.mockRestore();
  });

  it("ensureUserConfigFileSync migrates v11 → v12 by filling memory.embeddings + localModels.embeddings defaults", () => {
    const path = getUserConfigPath(dir);
    // Build a synthetic v11 by stripping the new embedding blocks
    // from both the memory and the localModels sections.
    const localModelsWithoutV12 = {
      url: USER_CONFIG_DEFAULTS.localModels.url,
      mode: USER_CONFIG_DEFAULTS.localModels.mode,
      completionMaxTokens:
        USER_CONFIG_DEFAULTS.localModels.completionMaxTokens,
      managed: USER_CONFIG_DEFAULTS.localModels.managed,
    };
    const memoryWithoutV12 = {
      profile: USER_CONFIG_DEFAULTS.memory.profile,
      reflection: USER_CONFIG_DEFAULTS.memory.reflection,
      notes: USER_CONFIG_DEFAULTS.memory.notes,
      recallInjection: USER_CONFIG_DEFAULTS.memory.recallInjection,
      index: USER_CONFIG_DEFAULTS.memory.index,
      dedup: USER_CONFIG_DEFAULTS.memory.dedup,
      eviction: USER_CONFIG_DEFAULTS.memory.eviction,
    };
    const v11 = {
      version: 11,
      localModels: localModelsWithoutV12,
      log: { level: "info" },
      agent: USER_CONFIG_DEFAULTS.agent,
      http: USER_CONFIG_DEFAULTS.http,
      tracing: USER_CONFIG_DEFAULTS.tracing,
      memory: memoryWithoutV12,
      webhooks: {},
      vision: USER_CONFIG_DEFAULTS.vision,
      skills: { disabled: [] },
      telegram: USER_CONFIG_DEFAULTS.telegram,
    };
    writeFileSync(path, JSON.stringify(v11, null, 2) + "\n", "utf8");

    const warn = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const migrated = ensureUserConfigFileSync(path);

    expect(migrated.version).toBe(USER_CONFIG_VERSION);
    // Both new blocks default to disabled — the operator opts in via
    // explicit `use-embedding <id>` + `embeddings.enabled=true`.
    expect(migrated.memory.embeddings).toEqual(
      USER_CONFIG_DEFAULTS.memory.embeddings,
    );
    expect(migrated.localModels.embeddings).toEqual(
      USER_CONFIG_DEFAULTS.localModels.embeddings,
    );
    expect(migrated.memory.embeddings.enabled).toBe(false);
    expect(migrated.localModels.embeddings.enabled).toBe(false);

    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.version).toBe(USER_CONFIG_VERSION);
    expect(onDisk.memory.embeddings).toEqual(
      USER_CONFIG_DEFAULTS.memory.embeddings,
    );
    expect(onDisk.localModels.embeddings).toEqual(
      USER_CONFIG_DEFAULTS.localModels.embeddings,
    );
    warn.mockRestore();
  });

  it("ensureUserConfigFileSync migrates v10 → v11 by filling memory.dedup / memory.eviction defaults", () => {
    const path = getUserConfigPath(dir);
    // Build a synthetic v10 by copying memory defaults minus the new
    // dedup/eviction blocks. Casting through unknown so the partial
    // memory shape compiles even though the v11 type now requires the
    // two new blocks.
    const memoryWithoutV11 = {
      profile: USER_CONFIG_DEFAULTS.memory.profile,
      reflection: USER_CONFIG_DEFAULTS.memory.reflection,
      notes: USER_CONFIG_DEFAULTS.memory.notes,
      recallInjection: USER_CONFIG_DEFAULTS.memory.recallInjection,
      index: USER_CONFIG_DEFAULTS.memory.index,
    };
    const v10 = {
      version: 10,
      localModels: USER_CONFIG_DEFAULTS.localModels,
      log: { level: "info" },
      agent: USER_CONFIG_DEFAULTS.agent,
      http: USER_CONFIG_DEFAULTS.http,
      tracing: USER_CONFIG_DEFAULTS.tracing,
      memory: memoryWithoutV11,
      webhooks: {},
      vision: USER_CONFIG_DEFAULTS.vision,
      skills: { disabled: [] },
      telegram: USER_CONFIG_DEFAULTS.telegram,
    };
    writeFileSync(path, JSON.stringify(v10, null, 2) + "\n", "utf8");

    const warn = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const migrated = ensureUserConfigFileSync(path);

    expect(migrated.version).toBe(USER_CONFIG_VERSION);
    expect(migrated.memory.dedup).toEqual(USER_CONFIG_DEFAULTS.memory.dedup);
    expect(migrated.memory.eviction).toEqual(
      USER_CONFIG_DEFAULTS.memory.eviction,
    );

    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.version).toBe(USER_CONFIG_VERSION);
    expect(onDisk.memory.dedup).toEqual(USER_CONFIG_DEFAULTS.memory.dedup);
    warn.mockRestore();
  });

  it("ensureUserConfigFileSync migrates v8 → v9 by filling telegram defaults", () => {
    const path = getUserConfigPath(dir);
    const v8 = {
      version: 8,
      localModels: USER_CONFIG_DEFAULTS.localModels,
      log: { level: "info" },
      agent: USER_CONFIG_DEFAULTS.agent,
      http: USER_CONFIG_DEFAULTS.http,
      tracing: USER_CONFIG_DEFAULTS.tracing,
      memory: USER_CONFIG_DEFAULTS.memory,
      webhooks: {},
      vision: USER_CONFIG_DEFAULTS.vision,
      skills: { disabled: ["legacy-skill"] },
    };
    writeFileSync(path, JSON.stringify(v8, null, 2) + "\n", "utf8");

    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const migrated = ensureUserConfigFileSync(path);

    expect(migrated.version).toBe(USER_CONFIG_VERSION);
    expect(migrated.telegram).toEqual(USER_CONFIG_DEFAULTS.telegram);
    expect(migrated.skills.disabled).toEqual(["legacy-skill"]);

    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.version).toBe(USER_CONFIG_VERSION);
    expect(onDisk.telegram).toEqual(USER_CONFIG_DEFAULTS.telegram);

    const calls = warn.mock.calls.map((args) => String(args[0]));
    expect(
      calls.some((line) => line.includes(`migrated config v8 → v${USER_CONFIG_VERSION}`)),
    ).toBe(true);
    warn.mockRestore();
  });

  it("ensureUserConfigFileSync migrates v6 → v7 by filling completionMaxTokens default", () => {
    const path = getUserConfigPath(dir);
    const v6 = {
      version: 6,
      localModels: {
        url: "http://127.0.0.1:9999",
        mode: "managed",
        managed: {
          modelId: "qwen-3.5-4b",
          port: 19091,
          dataDirOverride: null,
          autoUpdate: false,
        },
      },
      log: { level: "debug" },
      agent: USER_CONFIG_DEFAULTS.agent,
      http: USER_CONFIG_DEFAULTS.http,
      tracing: USER_CONFIG_DEFAULTS.tracing,
      memory: USER_CONFIG_DEFAULTS.memory,
      webhooks: {},
      vision: USER_CONFIG_DEFAULTS.vision,
    };
    writeFileSync(path, JSON.stringify(v6, null, 2) + "\n", "utf8");

    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const migrated = ensureUserConfigFileSync(path);

    expect(migrated.version).toBe(USER_CONFIG_VERSION);
    expect(migrated.localModels.url).toBe("http://127.0.0.1:9999");
    expect(migrated.localModels.completionMaxTokens).toBe(
      USER_CONFIG_DEFAULTS.localModels.completionMaxTokens,
    );

    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.version).toBe(USER_CONFIG_VERSION);
    expect(onDisk.localModels.completionMaxTokens).toBe(
      USER_CONFIG_DEFAULTS.localModels.completionMaxTokens,
    );

    const calls = warn.mock.calls.map((args) => String(args[0]));
    expect(
      calls.some((line) => line.includes(`migrated config v6 → v${USER_CONFIG_VERSION}`)),
    ).toBe(true);
    warn.mockRestore();
  });

  it("parseUserConfigFile rejects out-of-range completionMaxTokens", () => {
    const path = getUserConfigPath(dir);
    const bad = {
      ...USER_CONFIG_DEFAULTS,
      localModels: {
        ...USER_CONFIG_DEFAULTS.localModels,
        completionMaxTokens: 16,
      },
    };
    writeFileSync(path, JSON.stringify(bad, null, 2) + "\n", "utf8");
    expect(() => readUserConfigFileSync(path)).toThrow(ConfigValidationError);
  });

  it("ensureUserConfigFileSync leaves an up-to-date file untouched on disk", () => {
    const path = getUserConfigPath(dir);
    writeUserConfigFileSync(path, USER_CONFIG_DEFAULTS);
    const before = statSync(path).mtimeMs;

    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = ensureUserConfigFileSync(path);
    expect(result).toEqual(USER_CONFIG_DEFAULTS);
    expect(warn).not.toHaveBeenCalled();
    expect(statSync(path).mtimeMs).toBe(before);
    warn.mockRestore();
  });
});
