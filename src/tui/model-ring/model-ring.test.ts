import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cloudState, fusionState, localState } from "../composer-switch/composer-switch-fixtures.js";
import type { LocalModelId } from "../../local-llm/index.js";
import {
  cleanModelRing,
  currentModelRingEntry,
  describeModelRing,
  MODEL_RING_MAX,
  modelRingReadoutLabel,
  nextModelRingEntry,
  parseModelRingEntry,
  parseModelRingList,
  toggleModelRingEntry,
} from "./model-ring.js";
import { parseModelRingCommand } from "./model-ring-command.js";
import { MODEL_RING_FILE, readModelRing, writeModelRing } from "./model-ring-store.js";

const e = (provider: string, model: string) => ({ provider, model });

describe("model ring entries", () => {
  it("splits on the first slash, so a model id keeps its own", () => {
    expect(parseModelRingEntry("openrouter/anthropic/claude-sonnet")).toEqual(e("openrouter", "anthropic/claude-sonnet"));
    expect(parseModelRingEntry(" local-llama/qwen-3.5-4b ")).toEqual(e("local-llama", "qwen-3.5-4b"));
    for (const bad of ["gpt-5", "/gpt-5", "openai/", "", "a b/c"]) expect(parseModelRingEntry(bad)).toBeNull();
  });

  it("cleans a stored list: junk and repeats out, capped", () => {
    expect(cleanModelRing(["openai/a", "openai/a", 7, "nope", "local-llama/q"])).toEqual([e("openai", "a"), e("local-llama", "q")]);
    expect(cleanModelRing("not a list")).toEqual([]);
    const many = Array.from({ length: MODEL_RING_MAX + 4 }, (_, i) => `openai/m${i}`);
    expect(cleanModelRing(many)).toHaveLength(MODEL_RING_MAX);
  });

  it("toggles an entry in and out; a full ring drops its oldest", () => {
    const one = toggleModelRingEntry([], e("openai", "a"));
    expect(one).toEqual({ ring: [e("openai", "a")], added: true });
    expect(toggleModelRingEntry(one.ring, e("openai", "a"))).toEqual({ ring: [], added: false });
    const full = Array.from({ length: MODEL_RING_MAX }, (_, i) => e("openai", `m${i}`));
    const next = toggleModelRingEntry(full, e("openai", "new"));
    expect(next.ring).toHaveLength(MODEL_RING_MAX);
    expect(next.ring[0]).toEqual(e("openai", "m1"));
    expect(next.ring.at(-1)).toEqual(e("openai", "new"));
  });
});

describe("the next favorite", () => {
  const ring = [e("openrouter", "a"), e("local-llama", "b"), e("openai", "c")];

  it("three presses from the first come back to it", () => {
    let current = ring[0]!;
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const next = nextModelRingEntry(ring, current)!;
      seen.push(next.entry.model);
      current = next.entry;
    }
    expect(seen).toEqual(["b", "c", "a"]);
  });

  it("off the ring, or with no model, the first favorite is next; an empty ring has none", () => {
    expect(nextModelRingEntry(ring, e("openai", "elsewhere"))).toEqual({ entry: ring[0], index: 0 });
    expect(nextModelRingEntry(ring, null)).toEqual({ entry: ring[0], index: 0 });
    expect(nextModelRingEntry([], null)).toBeNull();
  });

  it("walks backwards with direction -1, wrapping; off the ring the last one is previous (ATO-2500)", () => {
    expect(nextModelRingEntry(ring, ring[0]!, -1)).toEqual({ entry: ring[2], index: 2 });
    expect(nextModelRingEntry(ring, ring[2]!, -1)).toEqual({ entry: ring[1], index: 1 });
    expect(nextModelRingEntry(ring, e("openai", "elsewhere"), -1)).toEqual({ entry: ring[2], index: 2 });
    expect(nextModelRingEntry(ring, null, -1)).toEqual({ entry: ring[2], index: 2 });
    expect(nextModelRingEntry([], null, -1)).toBeNull();
  });

  it("the bar readout names the place on the ring, and nothing off it (ATO-2500)", () => {
    expect(modelRingReadoutLabel(ring, e("local-llama", "b"))).toBe(" · fav 2/3");
    expect(modelRingReadoutLabel(ring, e("openai", "elsewhere"))).toBeNull();
    expect(modelRingReadoutLabel(ring, null)).toBeNull();
    expect(modelRingReadoutLabel([], e("openai", "c"))).toBeNull();
  });

  it("names the current model of a cloud and a managed local route, not of Fusion or an external server", () => {
    expect(currentModelRingEntry(cloudState())).toEqual(e("openrouter", "qwen/qwen3.7-max"));
    expect(currentModelRingEntry(cloudState({ chatModel: null }))).toBeNull();
    const local = localState("managed");
    const withModel = { ...local, localModelsPanel: { ...local.localModelsPanel, activeModelId: "qwen-3.5-4b" as LocalModelId } };
    expect(currentModelRingEntry(withModel)).toEqual(e("local-llama", "qwen-3.5-4b"));
    const external = localState("external");
    expect(currentModelRingEntry({ ...external, localModelsPanel: { ...external.localModelsPanel, activeModelId: "qwen-3.5-4b" as LocalModelId } })).toBeNull();
    expect(currentModelRingEntry(fusionState())).toBeNull();
  });

  it("lists the ring with the current one marked", () => {
    const text = describeModelRing(ring, e("local-llama", "b"));
    expect(text).toContain("ctrl+p");
    expect(text).toContain("  1. openrouter/a");
    expect(text).toContain("* 2. local-llama/b");
    expect(describeModelRing([], null)).toContain("No favorite models yet");
  });
});

describe("/model favorite parsing", () => {
  it("reads list, clear, add and remove, with or without a model", () => {
    expect(parseModelRingCommand("")).toEqual({ kind: "list" });
    expect(parseModelRingCommand("list")).toEqual({ kind: "list" });
    expect(parseModelRingCommand("clear")).toEqual({ kind: "clear" });
    expect(parseModelRingCommand("add")).toEqual({ kind: "add", entry: null });
    expect(parseModelRingCommand("ADD openai/gpt-5")).toEqual({ kind: "add", entry: e("openai", "gpt-5") });
    expect(parseModelRingCommand("remove openrouter/a/b")).toEqual({ kind: "remove", entry: e("openrouter", "a/b") });
    for (const bad of ["add gpt-5", "drop", "add a/b c/d", "clear now"]) expect(parseModelRingCommand(bad)).toBeNull();
  });
});

describe("--models", () => {
  it("reads a comma list in order, repeats and blanks dropped", () => {
    expect(parseModelRingList("openai/gpt-5, local-llama/qwen-3.5-4b,,openai/gpt-5")).toEqual({
      ring: [e("openai", "gpt-5"), e("local-llama", "qwen-3.5-4b")],
    });
  });

  it("names a bad entry, refuses an empty list and one past the cap", () => {
    expect(parseModelRingList("openai/gpt-5,gpt-5")).toEqual({ error: expect.stringContaining('"gpt-5" is not provider/model') });
    expect(parseModelRingList(" , ")).toEqual({ error: expect.stringContaining("at least one") });
    const many = Array.from({ length: MODEL_RING_MAX + 1 }, (_, i) => `openai/m${i}`).join(",");
    expect(parseModelRingList(many)).toEqual({ error: expect.stringContaining(`at most ${MODEL_RING_MAX}`) });
  });
});

describe("the ring file", () => {
  let stateDir = "";
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), "atomic-model-ring-")); });
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

  it("is empty until written, then round-trips in order", () => {
    expect(readModelRing(stateDir)).toEqual([]);
    expect(writeModelRing(stateDir, [e("openai", "a"), e("local-llama", "b")])).toBe(true);
    expect(readModelRing(stateDir)).toEqual([e("openai", "a"), e("local-llama", "b")]);
    expect(JSON.parse(readFileSync(join(stateDir, MODEL_RING_FILE), "utf8"))).toEqual({ models: ["openai/a", "local-llama/b"] });
  });

  it("keeps as many favorites as the desktop picker does (ATO-2500: one shared list)", () => {
    expect(MODEL_RING_MAX).toBe(20);
    const twenty = Array.from({ length: 20 }, (_, i) => e("openai", `m${i}`));
    writeModelRing(stateDir, twenty);
    expect(readModelRing(stateDir)).toEqual(twenty);
  });

  it("reads a broken file as no favorites", () => {
    writeFileSync(join(stateDir, MODEL_RING_FILE), "{not json");
    expect(readModelRing(stateDir)).toEqual([]);
  });
});
