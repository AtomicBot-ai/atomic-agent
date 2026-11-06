import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expandVars, isPartDisabled, loadEnabledPlugins, pluginDataDir } from "../plugins/index.js";
import type { LoadedPlugins } from "../plugins/index.js";
import { pluginCodeAllowed } from "../plugins/plugin-install.js";
import { isValidMatcher } from "./hook-matcher.js";
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  KNOWN_HOOK_EVENTS,
  type HookCommand,
  type HookConfig,
  type HookEventName,
  type HookMatcherGroup,
  type HookSource,
  type LoadedHooks,
} from "./hook-types.js";

/** The user's own hooks file. Kept out of config.json on purpose. */
export function userHooksPath(stateDir: string): string {
  return join(stateDir, "hooks.json");
}

/** Longest timeout a hook may ask for: ten minutes, as in Claude Code. */
const MAX_TIMEOUT_MS = 600_000;

function label(source: HookSource): string {
  return source.kind === "user" ? source.file : `plugin ${source.plugin}`;
}

/**
 * Parse a Claude-format hooks object. Accepts the wrapped form
 * (`{ "hooks": { ... } }`, as in `hooks.json` and `settings.json`) and the
 * bare event map. `timeout` is in seconds, like Claude; a top-level
 * `defaultTimeout` (seconds) overrides the 60 s default for this file.
 * Bad entries are skipped with a diagnostic; nothing throws.
 */
export function parseHooksObject(raw: unknown, source: HookSource, defaultTimeoutMs = DEFAULT_HOOK_TIMEOUT_MS): LoadedHooks {
  const diagnostics: string[] = [];
  const config: HookConfig = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { config, diagnostics: [`${label(source)}: hooks must be a JSON object`] };
  }
  const obj = raw as Record<string, unknown>;
  const fileDefault = seconds(obj.defaultTimeout);
  const timeoutDefault = fileDefault ?? defaultTimeoutMs;
  const events = obj.hooks !== undefined ? obj.hooks : obj;
  if (events === null || typeof events !== "object" || Array.isArray(events)) {
    return { config, diagnostics: [`${label(source)}: "hooks" must be an object of events`] };
  }
  for (const [event, groups] of Object.entries(events as Record<string, unknown>)) {
    if (event === "defaultTimeout" || event === "description") continue;
    if (!(KNOWN_HOOK_EVENTS as readonly string[]).includes(event)) {
      diagnostics.push(`${label(source)}: unknown hook event "${event}" skipped`);
      continue;
    }
    if (!Array.isArray(groups)) {
      diagnostics.push(`${label(source)}: ${event} must be a list`);
      continue;
    }
    const parsed: HookMatcherGroup[] = [];
    groups.forEach((group, gi) => {
      const where = `${label(source)}: ${event}[${gi}]`;
      if (group === null || typeof group !== "object" || Array.isArray(group)) {
        diagnostics.push(`${where} must be an object`);
        return;
      }
      const g = group as Record<string, unknown>;
      const matcher = typeof g.matcher === "string" ? g.matcher.trim() : "";
      if (!isValidMatcher(matcher)) {
        diagnostics.push(`${where}: matcher "${matcher}" is not a valid pattern; compared as plain text`);
      }
      if (!Array.isArray(g.hooks)) {
        diagnostics.push(`${where}: "hooks" must be a list`);
        return;
      }
      const hooks: HookCommand[] = [];
      g.hooks.forEach((hook, hi) => {
        const h = hook as Record<string, unknown> | null;
        if (h === null || typeof h !== "object" || h.type !== "command" || typeof h.command !== "string" || h.command.trim() === "") {
          diagnostics.push(`${where}.hooks[${hi}]: only {"type":"command","command":"..."} is supported; skipped`);
          return;
        }
        const timeoutMs = seconds(h.timeout) ?? timeoutDefault;
        hooks.push({ type: "command", command: h.command, timeoutMs, source });
      });
      if (hooks.length > 0) parsed.push({ matcher, hooks });
    });
    if (parsed.length > 0) config[event as HookEventName] = parsed;
  }
  return { config, diagnostics };
}

function seconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(Math.round(value * 1000), MAX_TIMEOUT_MS);
}

/** `<stateDir>/hooks.json`; a missing file is no hooks, a broken one a diagnostic. */
export function loadUserHooks(stateDir: string): LoadedHooks {
  const file = userHooksPath(stateDir);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { config: {}, diagnostics: [] };
    return { config: {}, diagnostics: [`${file}: ${(err as Error).message}`] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { config: {}, diagnostics: [`${file}: not valid JSON (${(err as Error).message}); no user hooks loaded`] };
  }
  return parseHooksObject(raw, { kind: "user", file });
}

/**
 * Hooks of enabled plugins. A plugin's hooks run commands on this machine,
 * so they load only when the user accepted that (`runsCodeAccepted`);
 * otherwise the plugin gets one diagnostic and its hooks stay off. An event
 * the user switched off for the plugin (`hook:<Event>`) is dropped.
 */
export function loadPluginHooks(stateDir: string, loaded: LoadedPlugins = loadEnabledPlugins(stateDir)): LoadedHooks {
  const diagnostics: string[] = [];
  const config: HookConfig = {};
  for (const { record, bundle } of loaded.plugins) {
    if (!bundle.hooksFile && !bundle.manifest.hooksInline) continue;
    if (!pluginCodeAllowed(record)) {
      diagnostics.push(`plugin ${record.name}: hooks not run, the plugin is not allowed to run code on this computer (allow it with \`atomic-agent plugin allow-code ${record.name}\`)`);
      continue;
    }
    const source: HookSource = { kind: "plugin", plugin: record.name, root: bundle.root, data: pluginDataDir(stateDir, record.name) };
    const raws: unknown[] = [];
    if (bundle.hooksFile) {
      try {
        raws.push(JSON.parse(readFileSync(bundle.hooksFile, "utf8")));
      } catch (err) {
        diagnostics.push(`plugin ${record.name}: ${bundle.hooksFile}: ${(err as Error).message}`);
      }
    }
    if (bundle.manifest.hooksInline) raws.push(bundle.manifest.hooksInline);
    for (const raw of raws) {
      const parsed = parseHooksObject(raw, source);
      diagnostics.push(...parsed.diagnostics);
      for (const [event, groups] of Object.entries(parsed.config) as [HookEventName, HookMatcherGroup[]][]) {
        if (isPartDisabled(record, `hook:${event}`)) continue;
        const expanded = groups.map((group) => ({
          ...group,
          hooks: group.hooks.map((hook) => ({ ...hook, command: expandVars(hook.command, { root: source.root, data: source.data }) as string })),
        }));
        config[event] = [...(config[event] ?? []), ...expanded];
      }
    }
  }
  return { config, diagnostics };
}

/** User hooks first, then plugin hooks, per event. */
export function mergeHookConfigs(...configs: HookConfig[]): HookConfig {
  const out: HookConfig = {};
  for (const config of configs) {
    for (const [event, groups] of Object.entries(config) as [HookEventName, HookMatcherGroup[]][]) {
      out[event] = [...(out[event] ?? []), ...groups];
    }
  }
  return out;
}

let cache: { key: string; plugins: LoadedPlugins; value: LoadedHooks } | null = null;

/**
 * Every hook that applies right now. Re-read when `hooks.json` changes
 * (mtime) or the plugin set changes (the plugin runtime returns a new object
 * when `plugins.json` changes), so editing the file needs no restart.
 */
export function loadAllHooks(stateDir: string): LoadedHooks {
  const file = userHooksPath(stateDir);
  let mtime = "none";
  try {
    mtime = String(statSync(file).mtimeMs);
  } catch {
    // no user hooks file
  }
  const key = `${stateDir}\0${mtime}`;
  const plugins = loadEnabledPlugins(stateDir);
  if (cache && cache.key === key && cache.plugins === plugins) return cache.value;
  const user = loadUserHooks(stateDir);
  const fromPlugins = loadPluginHooks(stateDir, plugins);
  const value: LoadedHooks = {
    config: mergeHookConfigs(user.config, fromPlugins.config),
    diagnostics: [...user.diagnostics, ...fromPlugins.diagnostics],
  };
  cache = { key, plugins, value };
  return value;
}

/** Drop the cache (tests). */
export function resetHooksCache(): void {
  cache = null;
}
