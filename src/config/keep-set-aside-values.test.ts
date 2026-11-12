import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readUserConfigFileSync, writeUserConfigFileSync } from "./config-file.js";
import { setConfigNoticeSink } from "./config-primitives.js";
import { parseUserConfigFile, USER_CONFIG_DEFAULTS, USER_CONFIG_VERSION, type UserConfigFile } from "./config-schema.js";
import { isSetAsideOnReadKey } from "./keep-set-aside-values.js";
import { parseLlmProviderEntry } from "./llm-config.js";
import { scrubRunModeProviderPins } from "./llm-run-mode-config.js";

/*
 * ATO-1241 (follow-up of ATO-1239): the desktop app and the terminal share
 * one config.json. A value a newer build wrote that this build does not
 * know reads as the default or unset with one notice, and a whole-file
 * write by this build keeps it on disk.
 */
type Tree = Record<string, any>;
let dir: string;
let path: string;
let notices: string[];

const getIn = (tree: unknown, key: string): unknown =>
  key.split(".").reduce<any>((node, part) => (node == null ? undefined : node[part]), tree);
function setIn(tree: Tree, key: string, value: unknown): void {
  const parts = key.split(".");
  let node = tree;
  for (const part of parts.slice(0, -1)) node = node[part] ??= {};
  node[parts.at(-1)!] = value;
}
const disk = (): Tree => JSON.parse(readFileSync(path, "utf8"));
const said = (needle: string): number => notices.filter((line) => line.includes(needle)).length;

function baseTree(): Tree {
  const tree = structuredClone(USER_CONFIG_DEFAULTS) as Tree;
  tree.version = USER_CONFIG_VERSION;
  tree.llm = {
    activeTextProvider: "local-llama",
    activeEmbeddingProvider: "local-llama",
    toolTransport: "auto",
    providers: [
      { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:9931" },
      { id: "cloud", kind: "openai-compatible", baseUrl: "https://api.example.com/v1" },
    ],
    runMode: { fusion: {} },
  };
  return tree;
}
const writeTree = (tree: Tree): void => writeFileSync(path, JSON.stringify(tree));
/** A whole-file write of an unrelated change, as every settings toggle does. */
function writeUnrelated(parsed: UserConfigFile): void {
  writeUserConfigFileSync(path, { ...parsed, log: { ...parsed.log, level: "debug" } });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "set-aside-1241-"));
  path = join(dir, "config.json");
  notices = [];
  setConfigNoticeSink((line) => notices.push(line));
});
afterEach(() => {
  setConfigNoticeSink(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("enum-like values a newer build wrote (ATO-1241)", () => {
  const cases: ReadonlyArray<{ key: string; future: string; reads: unknown; chosen: string }> = [
    { key: "llm.toolTransport", future: "future-transport-1241", reads: "auto", chosen: "grammar" },
    { key: "llm.runMode.mode", future: "future-mode-1241", reads: undefined, chosen: "cloud" },
    { key: "llm.runMode.fusion.workerReasoning", future: "future-effort-1241", reads: undefined, chosen: "low" },
    { key: "llm.runMode.fusion.escalation", future: "future-escalation-1241", reads: undefined, chosen: "advisor" },
    { key: "llm.runMode.fusion.judge", future: "future-judge-1241", reads: undefined, chosen: "on" },
    { key: "llm.runMode.fusion.isolation", future: "future-isolation-1241", reads: undefined, chosen: "worktree" },
    { key: "agent.tools.search", future: "future-search-1241", reads: "auto", chosen: "on" },
    { key: "agent.compaction.mode", future: "future-compaction-1241", reads: "auto", chosen: "model" },
    { key: "agent.prompt.compact", future: "future-compact-1330", reads: "auto", chosen: "on" },
    { key: "tui.whileBusySubmit", future: "future-submit-1241", reads: "steer", chosen: "queue" },
  ];

  for (const { key, future, reads, chosen } of cases) {
    describe(key, () => {
      beforeEach(() => {
        const tree = baseTree();
        setIn(tree, key, future);
        writeTree(tree);
      });

      it("loads without throwing, reads as the default, and says so once", () => {
        const first = readUserConfigFileSync(path)!;
        const second = readUserConfigFileSync(path)!;
        expect(getIn(first, key)).toEqual(reads);
        expect(getIn(second, key)).toEqual(reads);
        expect(said(future)).toBe(1);
        expect(notices.find((line) => line.includes(future))).toContain(key);
      });

      it("a whole-file write of an unrelated change keeps the newer value on disk", () => {
        writeUnrelated(readUserConfigFileSync(path)!);
        expect(getIn(disk(), key)).toBe(future);
        expect(disk().log.level).toBe("debug");
      });

      it("a value chosen here replaces it", () => {
        const parsed = readUserConfigFileSync(path)! as unknown as Tree;
        const next = structuredClone(parsed);
        setIn(next, key, chosen);
        writeUserConfigFileSync(path, next as unknown as UserConfigFile);
        expect(getIn(disk(), key)).toBe(chosen);
      });

      it("a value of the wrong type is still a broken file", () => {
        const tree = baseTree();
        setIn(tree, key, 7);
        expect(() => parseUserConfigFile(tree)).toThrow(new RegExp(key.split(".").at(-1)!));
      });
    });
  }
});

describe("a fusion role a newer build added (ATO-1241)", () => {
  function roleTree(): Tree {
    const tree = baseTree();
    tree.llm.runMode.fusion.roles = { build: "cloud", "future-role-1241": "cloud" };
    return tree;
  }
  beforeEach(() => writeTree(roleTree()));

  it("loads without throwing: the role is skipped, with one notice", () => {
    const first = readUserConfigFileSync(path)!;
    readUserConfigFileSync(path);
    expect(first.llm!.runMode!.fusion!.roles).toEqual({ build: "cloud" });
    expect(said("future-role-1241")).toBe(1);
  });

  it("a whole-file write of an unrelated change keeps its pin", () => {
    writeUnrelated(readUserConfigFileSync(path)!);
    expect(disk().llm.runMode.fusion.roles).toEqual(roleTree().llm.runMode.fusion.roles);
  });

  it("a pin to a provider removed here does not come back", () => {
    const parsed = readUserConfigFileSync(path)!;
    const llm = parsed.llm!;
    writeUserConfigFileSync(path, {
      ...parsed,
      llm: {
        ...llm,
        providers: llm.providers.filter((p) => p.id !== "cloud"),
        runMode: scrubRunModeProviderPins(llm.runMode, "cloud")!,
      },
    });
    expect(disk().llm.runMode.fusion.roles).toBeUndefined();
  });

  it("config set refuses a role key this build does not know", () => {
    expect(isSetAsideOnReadKey("llm.runMode.fusion.roles.future-role-1241")).toBe(true);
  });
});

describe("a provider a newer build added (ATO-1241)", () => {
  function futureTree(): Tree {
    const tree = baseTree();
    tree.llm.providers.push({ id: "future", kind: "quantum-cloud-1241", baseUrl: "https://future.example.com" });
    tree.llm.activeTextProvider = "future";
    tree.llm.activeEmbeddingProvider = "future";
    tree.llm.fallback = { chain: ["cloud", "future"] };
    tree.llm.runMode = {
      mode: "fusion",
      fusion: { orchestratorProvider: "future", orchestratorModel: "future-model", workerProvider: "local-llama" },
    };
    return tree;
  }
  beforeEach(() => writeTree(futureTree()));

  it("loads without throwing: the entry and every reference to it are set aside, with one notice", () => {
    const parsed = readUserConfigFileSync(path)!;
    readUserConfigFileSync(path);
    const llm = parsed.llm!;
    expect(llm.providers.map((p) => p.id)).toEqual(["local-llama", "cloud"]);
    expect(llm.activeTextProvider).toBe("local-llama");
    expect(llm.activeEmbeddingProvider).toBe("local-llama");
    expect(llm.fallback?.chain).toEqual(["cloud"]);
    expect(llm.runMode?.mode).toBe("fusion");
    expect(llm.runMode?.fusion).toEqual({ workerProvider: "local-llama" });
    expect(said("quantum-cloud-1241")).toBe(1);
  });

  it("a whole-file write of an unrelated change keeps the entry and its references", () => {
    writeUnrelated(readUserConfigFileSync(path)!);
    expect(disk().llm).toEqual(futureTree().llm);
  });

  it("a provider chosen here replaces the active one; the newer entry stays", () => {
    const parsed = readUserConfigFileSync(path)!;
    writeUserConfigFileSync(path, { ...parsed, llm: { ...parsed.llm!, activeTextProvider: "cloud" } });
    const llm = disk().llm;
    expect(llm.activeTextProvider).toBe("cloud");
    expect(llm.providers.map((p: Tree) => p.id)).toEqual(["local-llama", "cloud", "future"]);
  });

  it("an unknown subscription CLI sets its entry aside too", () => {
    const tree = baseTree();
    tree.llm.providers.push({ id: "sub", kind: "subscription-cli", subscriptionCli: { cli: "future-cli-1241" } });
    writeTree(tree);
    expect(readUserConfigFileSync(path)!.llm!.providers.map((p) => p.id)).toEqual(["local-llama", "cloud"]);
    expect(said("future-cli-1241")).toBe(1);
    writeUnrelated(readUserConfigFileSync(path)!);
    expect(disk().llm.providers.at(-1)).toEqual(tree.llm.providers.at(-1));
  });

  describe("escalation, judge and role pins", () => {
    function pinnedTree(): Tree {
      const tree = baseTree();
      tree.llm.providers.push({ id: "future", kind: "quantum-cloud-1241", baseUrl: "https://future.example.com" });
      tree.llm.runMode = {
        mode: "fusion",
        fusion: {
          escalationProvider: "future",
          judgeProvider: "future",
          roles: { build: "future", review: "cloud" },
        },
      };
      return tree;
    }
    beforeEach(() => writeTree(pinnedTree()));

    it("read as unpinned instead of refusing the file", () => {
      const fusion = readUserConfigFileSync(path)!.llm!.runMode!.fusion!;
      expect(fusion.escalationProvider).toBeUndefined();
      expect(fusion.judgeProvider).toBeUndefined();
      expect(fusion.roles).toEqual({ review: "cloud" });
    });

    it("leave no empty roles block when every role was pinned to the provider", () => {
      const tree = pinnedTree();
      tree.llm.runMode.fusion.roles = { build: "future" };
      writeTree(tree);
      expect(readUserConfigFileSync(path)!.llm!.runMode!.fusion!.roles).toBeUndefined();
    });

    it("come back on a whole-file write of an unrelated change", () => {
      writeUnrelated(readUserConfigFileSync(path)!);
      expect(disk().llm).toEqual(pinnedTree().llm);
    });

    it("a pin chosen here replaces the newer one", () => {
      const parsed = readUserConfigFileSync(path)!;
      const llm = parsed.llm!;
      writeUserConfigFileSync(path, {
        ...parsed,
        llm: {
          ...llm,
          runMode: {
            ...llm.runMode!,
            fusion: { ...llm.runMode!.fusion!, judgeProvider: "cloud", roles: { build: "cloud", review: "cloud" } },
          },
        },
      });
      const fusion = disk().llm.runMode.fusion;
      expect(fusion.judgeProvider).toBe("cloud");
      expect(fusion.roles).toEqual({ build: "cloud", review: "cloud" });
      expect(fusion.escalationProvider).toBe("future");
    });

    it("a pin that names no provider at all is still a broken file", () => {
      const tree = pinnedTree();
      tree.llm.runMode.fusion.judgeProvider = "nobody";
      expect(() => parseUserConfigFile(tree)).toThrow(/llm\.runMode\.fusion\.judgeProvider/);
    });
  });

  it("a kind of the wrong type is still a broken file, and a provider typed in stays strict", () => {
    const tree = baseTree();
    tree.llm.providers.push({ id: "bad", kind: 7 });
    expect(() => parseUserConfigFile(tree)).toThrow(/llm\.providers\[2\]\.kind/);
    expect(() => parseLlmProviderEntry({ id: "typed", kind: "quantum-cloud-1241" }, "provider")).toThrow(/provider\.kind/);
  });
});

describe("keys a newer build added inside the llm block", () => {
  function futureKeysTree(): Tree {
    const tree = baseTree();
    tree.llm.futureLlmKey = "a";
    tree.llm.fallback = { chain: ["cloud"], futureFallbackKey: 1 };
    tree.llm.runMode = {
      mode: "fusion",
      futureRunModeKey: true,
      fusion: {
        workerProvider: "local-llama",
        escalationProvider: "cloud",
        judgeProvider: "cloud",
        roles: { build: "cloud" },
        futureFusionKey: { deep: 1 },
      },
    };
    return tree;
  }
  beforeEach(() => writeTree(futureKeysTree()));

  it("a whole-file write of an unrelated change keeps them", () => {
    writeUnrelated(readUserConfigFileSync(path)!);
    expect(disk().llm).toEqual(futureKeysTree().llm);
  });

  it("pins a caller removed stay removed, next to the keys that are kept", () => {
    const parsed = readUserConfigFileSync(path)!;
    const llm = parsed.llm!;
    writeUserConfigFileSync(path, {
      ...parsed,
      llm: {
        ...llm,
        providers: llm.providers.filter((p) => p.id !== "cloud"),
        fallback: { ...llm.fallback!, chain: [] },
        runMode: scrubRunModeProviderPins(llm.runMode, "cloud")!,
      },
    });
    const written = disk().llm;
    expect(written.runMode.fusion).toEqual({ workerProvider: "local-llama", futureFusionKey: { deep: 1 } });
    expect(written.runMode.futureRunModeKey).toBe(true);
    expect(written.fallback).toEqual({ chain: [], futureFallbackKey: 1 });
    expect(written.futureLlmKey).toBe("a");
  });

  it("a block a caller removed is not brought back", () => {
    const parsed = readUserConfigFileSync(path)!;
    const { fallback: _fallback, runMode: _runMode, ...llm } = parsed.llm!;
    writeUserConfigFileSync(path, { ...parsed, llm });
    expect(disk().llm.fallback).toBeUndefined();
    expect(disk().llm.runMode).toBeUndefined();
    expect(disk().llm.futureLlmKey).toBe("a");
  });
});

describe("model modes a newer build added (ATO-1241)", () => {
  function modesTree(): Tree {
    const tree = baseTree();
    tree.llm.providers[1] = {
      ...tree.llm.providers[1],
      modelMode: "future-policy-1241",
      modelModes: { "m-new": "future-model-policy-1241", "m-old": "cloud" },
    };
    return tree;
  }
  beforeEach(() => writeTree(modesTree()));

  it("loads without throwing: unknown modes read as unset, once each", () => {
    const cloud = readUserConfigFileSync(path)!.llm!.providers[1]!;
    readUserConfigFileSync(path);
    expect(cloud.modelMode).toBeUndefined();
    expect(cloud.modelModes).toEqual({ "m-old": "cloud" });
    expect(said("future-policy-1241")).toBe(1);
    expect(said("future-model-policy-1241")).toBe(1);
  });

  it("a whole-file write keeps them; a mode typed in stays strict", () => {
    writeUnrelated(readUserConfigFileSync(path)!);
    expect(disk().llm.providers[1]).toEqual(modesTree().llm.providers[1]);
    expect(() => parseLlmProviderEntry({ id: "x", kind: "openrouter", modelMode: "future-policy-1241" }, "provider"))
      .toThrow(/provider\.modelMode/);
  });
});
