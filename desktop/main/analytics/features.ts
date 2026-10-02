/**
 * Feature usage counted in main: voice, tasks, skills, Telegram, import,
 * the workspace chooser and the debug bundle. Each takes the IPC's own
 * answer and keeps only an enum or a count from it — never a skill name, a
 * task id, a token, a transcript or a path.
 */

import { voiceError } from "./classify.js";
import { track } from "./core.js";

const ok = (res: unknown): boolean => !!res && typeof res === "object" && (res as { ok?: unknown }).ok === true;

/* ---- voice ---- */

let voiceStartedAt: number | null = null;
let voiceLocale: string | null = null;
let voiceSetupReported = false;

export function voiceStarted(res: unknown): void {
  const r = (res ?? {}) as { ok?: boolean; error?: string; locales?: string[] };
  voiceLocale = Array.isArray(r.locales) && typeof r.locales[0] === "string" ? r.locales[0] : null;
  voiceStartedAt = r.ok ? Date.now() : null;
  track("voice_used", {
    action: "start",
    result: r.ok ? "ok" : "error",
    locale: voiceLocale,
    error: r.ok ? null : voiceError(r.error),
  });
}

function voiceSeconds(): number | null {
  return voiceStartedAt === null ? null : (Date.now() - voiceStartedAt) / 1000;
}

export function voiceEnded(action: "stop" | "cancel"): void {
  if (voiceStartedAt === null) return;
  track("voice_used", { action, result: "ok", duration_s: voiceSeconds(), locale: voiceLocale, error: null });
  voiceStartedAt = null;
}

/** A frame the speech helper streamed: only its `error` frames are counted. */
export function voiceFrame(payload: unknown): void {
  const p = (payload ?? {}) as { type?: unknown; code?: unknown };
  if (p.type !== "error") return;
  track("voice_used", { action: "stop", result: "error", duration_s: voiceSeconds(), locale: voiceLocale, error: voiceError(p.code) });
  voiceStartedAt = null;
}

/** `voice:probe` — reported once per app session when the helper is unavailable. */
export function voiceProbed(probe: unknown): void {
  const p = (probe ?? {}) as { ok?: boolean; reason?: string };
  if (p.ok || voiceSetupReported) return;
  voiceSetupReported = true;
  track("voice_setup", { result: "unavailable", reason: p.reason ?? null });
}

export function voiceInstalled(res: unknown): void {
  track("voice_setup", { result: ok(res) ? "ok" : "install_failed", reason: null });
}

/* ---- tasks, skills ---- */

export function taskCreated(kind: unknown, res: unknown): void {
  if (ok(res)) track("task_created", { kind });
}

export function taskAction(action: "run" | "cancel", res: unknown): void {
  if (ok(res)) track("task_action", { action });
}

export function skillInstalled(res: unknown, riskAcknowledged: boolean): void {
  const r = (res ?? {}) as { ok?: boolean; blocked?: boolean };
  track("skill_installed", { result: r.ok ? "ok" : r.blocked === true ? "blocked" : "error", risk_acknowledged: riskAcknowledged });
}

export function skillAction(action: "enable" | "disable" | "remove", res: unknown): void {
  if (ok(res)) track("skill_action", { action });
}

/* ---- telegram (never the token) ---- */

export function telegramStep(step: "enable" | "pair" | "token_saved" | "token_cleared" | "owner_cleared", res: unknown): void {
  track("telegram_setup", { step, result: ok(res) ? "ok" : "error" });
}

/** Config writes that are Telegram steps: `telegram.enabled true`, unsetting `telegram.ownerUserId`. */
export function telegramConfigWrite(key: string, value: string | null, res: unknown): void {
  if (key === "telegram.enabled" && value === "true") telegramStep("enable", res);
  if (key === "telegram.ownerUserId" && value === null) telegramStep("owner_cleared", res);
}

/* ---- import ---- */

export function tuiImportDone(flags: Record<string, boolean>, res: unknown): void {
  const r = (res ?? {}) as { ok?: boolean; error?: string; copied?: Record<string, number | boolean> };
  // ok with an error beside it: some arms copied, one did not.
  const result = !r.ok ? "error" : r.error ? "partial" : "ok";
  track("import_run", { source: "tui", parts: flags, result, counts: r.copied ?? {} });
}

/** `atag import <source> --yes`: previews are not runs. */
export function agentImportDone(source: string, execute: boolean, res: unknown): void {
  if (!execute) return;
  const r = (res ?? {}) as { ok?: boolean; state?: string; report?: { summary?: { error?: number; conflict?: number } } };
  const s = r.report?.summary;
  const result = !r.ok ? "error" : s && ((s.error ?? 0) > 0 || (s.conflict ?? 0) > 0) ? "partial" : "ok";
  track("import_run", { source, result });
}

/* ---- the rest ---- */

export function workspaceChosen(dir: unknown): void {
  if (typeof dir === "string" && dir) track("workspace_chosen");
}

export function debugReportSaved(kind: unknown, res: unknown): void {
  if (ok(res)) track("debug_report_saved", { kind: kind === "report" ? "report" : "dump" });
}
