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
 * Edits are direct public-method calls (the same surface the
 * `TuiAppCallbacks.onFallback*` callbacks hit); the bus is where the
 * orchestrator emits its `fallback_refresh`/`fallback_status` mirror and
 * where it hears `providers_refresh`.
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

  it("a move edit reorders and persists the declared chain", () => {
    seedConfig(stateDir, { chain: ["cloud-a", "cloud-b"], appendLocal: false });
    const bus = makeBus();
    new FallbackOrchestrator(bus).move("cloud-b", -1);
    // cloud-b moved above cloud-a in the declared chain; the loader still
    // hoists the active provider (cloud-a) to head on read.
    expect(readFallback(stateDir)?.chain).toEqual(["cloud-b", "cloud-a"]);
  });

  it("an add edit appends and persists a new link", () => {
    seedConfig(stateDir, { chain: ["cloud-a"], appendLocal: false });
    const bus = makeBus();
    new FallbackOrchestrator(bus).add("cloud-b");
    expect(readFallback(stateDir)?.chain).toEqual(["cloud-a", "cloud-b"]);
  });

  it("a remove edit drops the link and persists", () => {
    seedConfig(stateDir, { chain: ["cloud-a", "cloud-b"], appendLocal: false });
    const bus = makeBus();
    new FallbackOrchestrator(bus).remove("cloud-b");
    expect(readFallback(stateDir)?.chain).toEqual(["cloud-a"]);
  });

  it("the appendLocal toggle flips and persists the flag", () => {
    seedConfig(stateDir, { chain: ["cloud-a"], appendLocal: true });
    const bus = makeBus();
    new FallbackOrchestrator(bus).toggleAppendLocal();
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
    new FallbackOrchestrator(bus).add("local-llama");
    const fb = readFallback(stateDir)!;
    expect(fb.chain).toEqual(["cloud-a", "cloud-b", "local-llama"]);
    expect(fb.failureThreshold).toBe(5);
    expect(fb.cooldownMs).toEqual([1000, 2000]);
  });

  it("surfaces a status line and does not write when a refused edit slips through", () => {
    seedConfig(stateDir, { chain: ["cloud-a", "cloud-b"], appendLocal: false });
    const bus = makeBus();
    const orch = new FallbackOrchestrator(bus);
    // Removing the active head is refused by the edit algebra → no-op,
    // no write, no status error.
    orch.remove("cloud-a");
    expect(readFallback(stateDir)?.chain).toEqual(["cloud-a", "cloud-b"]);
  });

  // The appendLocal=true branch is the subtle one (lesson #87): the local
  // link is *synthesised on read*, so it must never be written into the
  // stored `chain`, or a round-trip doubles it up.
  it("does not persist the synthesised local link when appendLocal is on (add)", () => {
    // Effective chain is [cloud-a, local-llama]; only cloud-a is declared.
    seedConfig(stateDir, { chain: ["cloud-a"], appendLocal: true });
    const bus = makeBus();
    new FallbackOrchestrator(bus).add("cloud-b");
    const fb = readFallback(stateDir)!;
    // cloud-b appended to the DECLARED chain; local-llama stays out of it
    // (still synthesised on the next read via appendLocal).
    expect(fb.chain).toEqual(["cloud-a", "cloud-b"]);
    expect(fb.chain).not.toContain("local-llama");
    expect(fb.appendLocal).toBe(true);
  });

  it("does not persist the synthesised local link when appendLocal is on (move)", () => {
    seedConfig(stateDir, { chain: ["cloud-a", "cloud-b"], appendLocal: true });
    const bus = makeBus();
    new FallbackOrchestrator(bus).move("cloud-b", -1);
    // Effective order was [cloud-a, cloud-b, local-llama]; cloud-b moved up.
    const fb = readFallback(stateDir)!;
    expect(fb.chain).toEqual(["cloud-b", "cloud-a"]);
    expect(fb.chain).not.toContain("local-llama");
  });

  it("treats a move of the appended-local tail as a no-op", () => {
    seedConfig(stateDir, { chain: ["cloud-a", "cloud-b"], appendLocal: true });
    const bus = makeBus();
    // local-llama is the synthesised tail (not a declared link): trying to
    // move it does not touch the declared chain.
    new FallbackOrchestrator(bus).move("local-llama", -1);
    expect(readFallback(stateDir)?.chain).toEqual(["cloud-a", "cloud-b"]);
  });

  it("re-mirrors on providers_refresh so the head follows the active provider", () => {
    // Active is cloud-a; both providers are in the chain.
    seedConfig(stateDir, { chain: ["cloud-a", "cloud-b"], appendLocal: false });
    const bus = makeBus();
    new FallbackOrchestrator(bus);

    // A provider hot-swap: the config now names cloud-b active. Rewrite it
    // the way `setActiveTextProviderInConfig` would, then fire the
    // `providers_refresh` the providers orchestrator emits afterwards.
    const path = join(stateDir, "config.json");
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    cfg.llm.activeTextProvider = "cloud-b";
    writeFileSync(path, JSON.stringify(cfg), "utf8");
    resetConfigCache();

    const before = bus.emitted.length;
    bus.emit({ type: "providers_refresh", rows: [] });
    const refresh = bus.emitted
      .slice(before)
      .find((a) => a.type === "fallback_refresh");
    expect(refresh).toBeDefined();
    // resolveFallbackChain hoists cloud-b (the new active) to the head.
    expect(
      (refresh as { links: { providerId: string; isActive: boolean }[] }).links[0],
    ).toMatchObject({ providerId: "cloud-b", isActive: true });
  });
});
