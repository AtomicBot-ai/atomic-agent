/**
 * Provider and backend events: `provider_key_checked`, `model_configured`
 * (once per desktop state dir), `backend_switched`, `fusion_configured`,
 * `local_backend_started`, `local_backend_supervised`, `local_backend_crashed`.
 */

import { curatedMeta } from "../model-catalog.js";
import { backendFailReason, daemonEffect, keyCheckResult, presetOf, supervisedProps, switchOutcome } from "./classify.js";
import { localEngineOf, readConfigFile } from "./environment.js";
import { analyticsEnabled, currentRunMode, flagsStore, refreshRunMode, track } from "./core.js";

let stateDir = "";
export function configureSetup(opts: { stateDir: string }): void {
  stateDir = opts.stateDir;
}

const modelIdProp = (id: unknown): string => (typeof id === "string" && curatedMeta(id) ? id : "hf_custom");

/* ATO-278: the server log's failure line (daemon-watch describeFault), handed
   in by daemon-watch so this module never reads the server's files itself. */
let serverFault: () => string | null = () => null;
export function readServerFaultWith(read: () => string | null): void {
  serverFault = read;
}

/** ATO-278: `reason` for a start that failed, from its error text, its stderr tail and the server log; null for any other result. */
function startFailReason(effect: string, failure: unknown): string | null {
  if (effect !== "start_failed") return null;
  const f = (failure && typeof failure === "object" ? failure : {}) as { error?: unknown; daemonError?: unknown };
  const text = [f.error, f.daemonError].filter((t): t is string => typeof t === "string").join("\n");
  let line: string | null = null;
  try { line = serverFault(); } catch { /* no log line */ }
  return backendFailReason(text, line);
}

/** Around `verifyProviderKey`: the result enum and the HTTP status only. */
export function providerKeyChecked(providerId: unknown, res: unknown): void {
  try {
    const { result, http_status } = keyCheckResult(res as Parameters<typeof keyCheckResult>[0]);
    track("provider_key_checked", { provider_preset: presetOf(providerId), result, http_status });
  } catch {
    /* never */
  }
}

/** The provider the config now routes to, as `model_configured` names it. */
function configuredRoute(): { provider: string; kind: "local" | "cloud" | "custom" } | null {
  const cfg = readConfigFile(stateDir);
  if (!cfg) return null;
  const llm = cfg["llm"] as { activeTextProvider?: unknown; providers?: unknown } | undefined;
  const active = typeof llm?.activeTextProvider === "string" ? llm.activeTextProvider : "local-llama";
  const providers = Array.isArray(llm?.providers) ? (llm!.providers as Array<Record<string, unknown>>) : [];
  const entry = providers.find((p) => p && p["id"] === active);
  const lm = cfg["localModels"] as { mode?: unknown } | undefined;
  if (active === "local-llama" || entry?.["kind"] === "llama-server") {
    // An external llama-server (the wizard's custom-endpoint branch) is `custom`.
    // The managed backend is `llama.cpp`, as the agent runtime names it in its own model_configured.
    return lm?.mode === "external" ? { provider: "custom", kind: "custom" } : { provider: "llama.cpp", kind: "local" };
  }
  const preset = presetOf(active);
  return { provider: preset, kind: preset === "custom" ? "custom" : "cloud" };
}

/** A switch / activation / custom-endpoint write landed with a usable provider: `model_configured`, once. */
export function maybeModelConfigured(): void {
  try {
    if (!analyticsEnabled()) return;
    const store = flagsStore();
    if (!store || store.get().modelConfiguredSent) return;
    const route = configuredRoute();
    if (!route) return;
    track("model_configured", route);
    store.set({ modelConfiguredSent: true });
  } catch {
    /* never */
  }
}

/** Before a switch runs: the mode it leaves, and the clock. Reads nothing while analytics is off. */
export function switchBegin(): { from: string | null; at: number } {
  if (!analyticsEnabled()) return { from: null, at: Date.now() };
  return { from: currentRunMode() ?? refreshRunMode(), at: Date.now() };
}

/** What a `switched()` call was: a Fusion action, and whether the user asked for a mode change outright. */
export interface SwitchKind {
  action?: "enter" | "swap_legs" | "set_workers" | "pick_worker_model";
  /** `cli:switchBackend` / `cli:enterFusion`: reported even when the mode stays (a refusal is news). */
  explicit?: boolean;
}

/** backend_switched is about the run mode: an explicit switch, or any call that actually moved it. */
export function shouldReportSwitch(kind: SwitchKind | undefined, from: string | null, to: string | null): boolean {
  return kind?.explicit === true || from !== to;
}

type SwitchLike = {
  ok?: boolean; restart?: boolean; daemon?: string; providerId?: string; modelId?: string;
  runMode?: { before?: string; after?: string; enteredFusion?: boolean };
} & Parameters<typeof switchOutcome>[0];

/**
 * After `switched()`: `backend_switched` (explicit switches and real mode
 * changes only — picking a provider or a model inside the same mode is not
 * one), any daemon effect, and `model_configured` the first time it lands.
 * The cached run mode is refreshed after every result.
 */
export function switchEnd(begin: { from: string | null; at: number }, res: unknown, kind?: SwitchKind): void {
  try {
    if (!analyticsEnabled()) return;
    const r = (res && typeof res === "object" ? res : null) as SwitchLike | null;
    const ms = Date.now() - begin.at;
    const to = refreshRunMode();
    const { result, refusal } = switchOutcome(r);
    if (shouldReportSwitch(kind, begin.from, to)) {
      track("backend_switched", { from: begin.from, to, result, refusal, restart: r?.restart === true, ms });
    }
    const effect = daemonEffect(r?.daemon);
    if (effect && effect !== "untouched" && effect !== "superseded" && effect !== "skipped") {
      track("local_backend_started", { via: "swap", result: effect, model_id: modelIdProp(r?.modelId), ms, engine: localEngineOf(readConfigFile(stateDir)), reason: startFailReason(effect, r) });
    }
    if (kind?.action && r?.ok) fusionConfigured(kind.action);
    if (r?.ok) maybeModelConfigured();
  } catch {
    /* never */
  }
}

function fusionConfigured(action: "enter" | "swap_legs" | "set_workers" | "pick_worker_model"): void {
  const cfg = readConfigFile(stateDir);
  const fusion = ((cfg?.["llm"] as Record<string, unknown> | undefined)?.["runMode"] as Record<string, unknown> | undefined)?.["fusion"] as
    | { workers?: unknown }
    | undefined;
  const workers = typeof fusion?.workers === "number" ? fusion.workers : null;
  track("fusion_configured", { action, workers, degraded: currentRunMode() !== "fusion" });
}

/** The launch start or a ⇄'s background bring-up said how it ended. `failure`: the bring-up's answer, read for `reason` only (ATO-278). */
export function localBackendStarted(via: "launch" | "swap", daemon: unknown, modelId: unknown, ms: number | null, failure?: unknown): void {
  try {
    const effect = daemonEffect(daemon);
    if (!effect) return;
    track("local_backend_started", {
      via, result: effect, model_id: modelIdProp(modelId), ms, engine: localEngineOf(readConfigFile(stateDir)),
      reason: startFailReason(effect, failure),
    });
  } catch {
    /* never */
  }
}

/**
 * ATO-773: the engine watchdog told the window something (main.ts
 * hostDaemonWatch): a restart beginning, done, failed, or given up. Codes and
 * counts only (classify.ts supervisedProps); `clear` and the CPU word are not sent.
 */
export function localBackendSupervised(notice: unknown, quickDeaths: number | null): void {
  try {
    if (!analyticsEnabled()) return;
    const props = supervisedProps(notice, quickDeaths);
    if (!props) return;
    track("local_backend_supervised", { ...props, engine: localEngineOf(readConfigFile(stateDir)) });
  } catch {
    /* never */
  }
}

/**
 * ATO-278: the managed server the app had brought up died mid-session (the
 * watchdog's `died`, daemon-watch). `faultLine` is the server log's failure
 * line: only its code is sent. `upMs`: how long it had been up.
 */
export function localBackendCrashed(modelId: unknown, faultLine: unknown, upMs: number | null): void {
  try {
    if (!analyticsEnabled()) return;
    track("local_backend_crashed", {
      reason: backendFailReason(null, faultLine),
      model_id: modelIdProp(modelId),
      up_ms: upMs,
      engine: localEngineOf(readConfigFile(stateDir)),
    });
  } catch {
    /* never */
  }
}

/**
 * The recovery card went up (main.ts noteEngine): the local engine did not
 * download, verify or start. Not `local_engine_failed`: the agent's `models`
 * command that failed already sends that one, so the desktop counts only what
 * it showed, and from where.
 */
export function engineRecoveryShown(stage: string, via: string): void {
  try {
    if (!analyticsEnabled()) return;
    track("engine_recovery_shown", { engine: localEngineOf(readConfigFile(stateDir)), stage, via });
  } catch {
    /* never */
  }
}
