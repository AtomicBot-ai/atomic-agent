/* ATO-41 — Settings › Diagnostics' "All settings" list.

   Every config.json key with its current value, default, type and
   description, so a setting can be found without reading the agent's
   source. The list comes from the agent itself: `atag config list --json`
   prints the reference generated from its config schema, so the desktop
   never carries a second copy that could drift from the agent it runs.

   An agent from before that flag ignores it and prints the old
   `key = value  (default …)` lines; those are read too, so the list still
   shows keys and values (no type or description) and says the agent is
   older. Not while the app runs on another computer's agent: that
   computer's config is not this one's to list. */

import type { IpcMain } from "electron";

import type { CliResult } from "./agent-cli.js";

/** One row, as `atag config list --json` prints it. */
export interface SettingRowWire {
  key: string;
  type: string;
  default: unknown;
  value: unknown;
  description: string;
  envVar: string | null;
  settable: boolean;
}

export interface SettingsReferenceDeps {
  ipcMain: Pick<IpcMain, "handle">;
  run: (args: string[], timeoutMs: number) => Promise<CliResult>;
  isRemote: () => boolean;
}

export const REMOTE_REFUSAL = "This app runs on an agent on another computer; its settings are on that computer (atag config list --describe there).";
export const OLDER_AGENT_NOTE = "This agent is older than the settings reference: keys and values only. Update the agent for types and descriptions.";

/* Secrets never reach the screen, whatever the agent printed. The agent
   masks them (`config list --json`, ATO-41 #1513), but an older agent's
   plain `config list` prints a list like `mcp.servers` whole, with each
   server's `env` tokens and `headers` in it. Same rules as the agent's
   settings-value-mask.ts: strings at a secret-named key (token, secret,
   password, apiKey, camelCase words) and every value under an `env` or
   `headers` map become `***`. */
const SECRET_WORDS = new Set(["secret", "token", "apikey", "password"]);
const MASK_ALL_MAPS = new Set(["env", "headers"]);
type MaskMode = "none" | "strings" | "all";

function secretName(name: string): boolean {
  const words = name.split(/(?=[A-Z])/).map((w) => w.toLowerCase());
  return words.some((w, i) => SECRET_WORDS.has(w) || SECRET_WORDS.has(w + (words[i + 1] ?? "")));
}

function maskModeFor(name: string, parent: MaskMode): MaskMode {
  if (parent === "all" || MASK_ALL_MAPS.has(name.toLowerCase())) return "all";
  if (parent === "strings" || secretName(name)) return "strings";
  return "none";
}

function maskNode(value: unknown, mode: MaskMode): unknown {
  if (Array.isArray(value)) return value.map((item) => maskNode(item, mode));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskNode(v, maskModeFor(k, mode));
    return out;
  }
  if (mode === "none") return value;
  if (typeof value === "string") return value.length > 0 ? "***" : value;
  if (mode === "strings" || value === null || value === undefined || typeof value === "boolean") return value;
  return "***";
}

/** A row's value with every secret in it masked, at any depth. */
export function maskSettingValue(key: string, value: unknown): unknown {
  return maskNode(value, maskModeFor(key.slice(key.lastIndexOf(".") + 1), "none"));
}

/** The rows `config list --json` printed, or null when stdout is not that. */
export function parseSettingsJson(stdout: string): SettingRowWire[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && typeof (r as { key?: unknown }).key === "string")
    .map((r) => ({
      key: r["key"] as string,
      type: typeof r["type"] === "string" ? r["type"] : "",
      default: maskSettingValue(r["key"] as string, r["default"]),
      value: maskSettingValue(r["key"] as string, r["value"]),
      description: typeof r["description"] === "string" ? r["description"] : "",
      envVar: typeof r["envVar"] === "string" ? r["envVar"] : null,
      settable: r["settable"] === true,
    }));
}

/** A JSON-ish value as the old `config list` printed it; anything that is not JSON stays text. */
function legacyValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The old `config list`: `key = value` per line, `  (default X)` after a
 * value that differs. Read-only rows with no type or description.
 */
export function parseLegacyList(stdout: string): SettingRowWire[] {
  const rows: SettingRowWire[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^([A-Za-z][\w.]*) = (.*?)(?:\s{2,}\(default (.*)\))?\s*$/.exec(line);
    if (!m) continue;
    const value = maskSettingValue(m[1]!, legacyValue(m[2] ?? ""));
    rows.push({
      key: m[1]!,
      type: "",
      default: m[3] === undefined ? value : maskSettingValue(m[1]!, legacyValue(m[3])),
      value,
      description: "",
      envVar: null,
      settable: false,
    });
  }
  return rows;
}

export function registerSettingsReferenceIpc(d: SettingsReferenceDeps): void {
  d.ipcMain.handle("settings:reference", async () => {
    if (d.isRemote()) return { ok: false, error: REMOTE_REFUSAL };
    const res = await d.run(["config", "list", "--json"], 30_000);
    const rows = parseSettingsJson(res.stdout);
    if (rows) return { ok: true, rows, legacy: false };
    const legacy = res.ok ? parseLegacyList(res.stdout) : [];
    if (legacy.length > 0) return { ok: true, rows: legacy, legacy: true, note: OLDER_AGENT_NOTE };
    const why = (res.stderr || res.error || res.stdout || "").trim().split("\n").filter(Boolean).slice(-2).join(" ");
    return { ok: false, error: `atag config list did not answer: ${why || "it did not say why"}` };
  });
}
