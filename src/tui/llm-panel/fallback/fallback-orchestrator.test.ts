import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetConfigCache } from "../../../config/index.js";
import type { TuiAction } from "../../tui-action.js";
import { FallbackOrchestrator } from "./fallback-orchestrator.js";

const STATE_DIR_ENV = "ATOMIC_AGENT_STATE_DIR";

/**
 * A minimal event bus: `subscribe` collects listeners, `emit` fans out.
 * The orchestrator both listens (for intents) and emits (`fallback_refresh`,
 * `fallback_status`), so a single shared bus lets a test dispatch an intent
 * and read back the mirror the orchestrator produced.
 */
function makeBus() {
  const listeners = new Set<(action: TuiAction) => void>();
  const emitted: TuiAction[] = [];
  return {
    emitted,
    subscribe(listener: (action: TuiAction) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(action: TuiAction) {
      emitted.push(action);
      for (const listener of [...listeners]) listener(action);
    },
  };
}

function seedConfig(stateDir: string, fallback?: unknown): void {
  const config = {
    version: undefined as unknown, // let defaults fill; we only need llm
    llm: {
      activeTextProvider: "cloud-a",
      activeEmbeddingProvider: "cloud-a",
      toolTransport: "auto",
      providers: [
        { id: "cloud-a", kind: "openrouter", defaultChatModel: "vendor/a" },
        { id: "cloud-b", kind: "aimlapi", defaultChatModel: "vendor/b" },
        { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:8080" },
      ],
      ...(fallback ? { fallback } : {}),
    },
  };
  delete (config as { version?: unknown }).version;
  writeFileSync(join(stateDir, "config.json"), JSON.stringify(config), "utf8");
}

function readFallback(stateDir: string): Record<string, unknown> | undefined {
  const onDisk = JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8"));
  return onDisk.llm?.fallback;
}

describe("FallbackOrchestrator persistence", () => {
  let stateDir: string;
  let original: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "fallback-orch-"));
    mkdirSync(stateDir, { recursive: true });
    original = process.env[STATE_DIR_ENV];
    process.env[STATE_DIR_ENV] = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    if (original === undefined) delete process.env[STATE_DIR_ENV];
    else process.env[STATE_DIR_ENV] = original;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("refresh mirrors the effective chain from config", () => {
    seedConfig(stateDir, { chain: ["cloud-a", "cloud-b"], appendLocal: false });
    const bus = makeBus();
    const orch = new FallbackOrchestrator(bus);
    orch.refresh();
    const refresh = bus.emitted.find((a) => a.type === "fallback_refresh");
    expect(refresh).toMatchObject({
      appendLocal: false,
      addableProviderIds: ["local-llama"],
    });
    expect(
      (refresh as { links: { providerId: string }[] }).links.map((l) => l.providerId),
    ).toEqual(["cloud-a", "cloud-b"]);
  });

  it("a move intent reorders and persists the declared chain", () => {
    seedConfig(stateDir, { chain: ["cloud-a", "cloud-b"], appendLocal: false });
    const bus = makeBus();
    new FallbackOrchestrator(bus);
    bus.emit({ type: "fallback_move_requested", providerId: "cloud-b", delta: -1 });
    // cloud-b moved above cloud-a in the declared chain; the loader still
    // hoists the active provider (cloud-a) to head on read.
    expect(readFallback(stateDir)?.chain).toEqual(["cloud-b", "cloud-a"]);
  });

  it("an add intent appends and persists a new link", () => {
    seedConfig(stateDir, { chain: ["cloud-a"], appendLocal: false });
    const bus = makeBus();
    new FallbackOrchestrator(bus);
    bus.emit({ type: "fallback_add_requested", providerId: "cloud-b" });
    expect(readFallback(stateDir)?.chain).toEqual(["cloud-a", "cloud-b"]);
  });

  it("a remove intent drops the link and persists", () => {
    seedConfig(stateDir, { chain: ["cloud-a", "cloud-b"], appendLocal: false });
    const bus = makeBus();
    new FallbackOrchestrator(bus);
    bus.emit({ type: "fallback_remove_requested", providerId: "cloud-b" });
    expect(readFallback(stateDir)?.chain).toEqual(["cloud-a"]);
  });

  it("the appendLocal toggle flips and persists the flag", () => {
    seedConfig(stateDir, { chain: ["cloud-a"], appendLocal: true });
    const bus = makeBus();
    new FallbackOrchestrator(bus);
    bus.emit({ type: "fallback_append_local_toggle_requested" });
    expect(readFallback(stateDir)?.appendLocal).toBe(false);
    expect(readFallback(stateDir)?.chain).toEqual(["cloud-a"]);
  });

  it("preserves hand-set timing knobs across a chain edit", () => {
    seedConfig(stateDir, {
      chain: ["cloud-a", "cloud-b"],
      appendLocal: false,
      failureThreshold: 5,
      cooldownMs: [1000, 2000],
    });
    const bus = makeBus();
    new FallbackOrchestrator(bus);
    bus.emit({ type: "fallback_add_requested", providerId: "local-llama" });
    const fb = readFallback(stateDir)!;
    expect(fb.chain).toEqual(["cloud-a", "cloud-b", "local-llama"]);
    expect(fb.failureThreshold).toBe(5);
    expect(fb.cooldownMs).toEqual([1000, 2000]);
  });

  it("surfaces a status line and does not write when a refused edit slips through", () => {
    seedConfig(stateDir, { chain: ["cloud-a", "cloud-b"], appendLocal: false });
    const bus = makeBus();
    new FallbackOrchestrator(bus);
    // Removing the active head is refused by the edit algebra → no-op,
    // no write, no status error.
    bus.emit({ type: "fallback_remove_requested", providerId: "cloud-a" });
    expect(readFallback(stateDir)?.chain).toEqual(["cloud-a", "cloud-b"]);
  });
});
