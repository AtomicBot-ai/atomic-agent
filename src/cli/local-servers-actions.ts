import { getConfig } from "../config/index.js";
import { addCustomModel } from "../config/custom-models-store.js";
import { detectLocalServers, type DetectedLocalServer } from "../llm/provider/presets/detect-local-servers.js";
import { resolveModelsDir } from "../local-llm/backend-paths.js";
import {
  adoptExternalModel,
  describeAdoption,
  type AdoptResult,
} from "../local-llm/external-servers/adopt-external-model.js";
import { lmsGet, lmsLoad, lmsUnload } from "../local-llm/external-servers/lmstudio-cli.js";
import {
  deleteOllamaModel,
  loadOllamaModel,
  pullOllamaModel,
  unloadOllamaModel,
  type OllamaPullProgress,
} from "../local-llm/external-servers/ollama-control.js";
import { startExternalServer } from "../local-llm/external-servers/start-external-server.js";

/**
 * The actions of `atomic-agent local-servers` (ATO-2490): start Ollama or LM
 * Studio, load and unload a model, download and delete one, and use one on
 * our own engine without downloading it again. Ollama through its HTTP API
 * (`keep_alive: 0` to unload), LM Studio through its `lms` CLI.
 *
 * `--json` prints one `{ type: "result", ok, ... }` line last (`pull` prints
 * `{ type: "progress", status, completed, total }` lines before it), which is
 * what the desktop app reads; errors there carry `error` (a sentence) and
 * `detail` (the app's own words). Exit 0 done, 1 failed, 2 usage.
 */

export const ACTIONS_HELP = [
  "Actions:",
  "  start  <ollama|lmstudio>                 Start the app's server and wait until it answers",
  "  load   <ollama|lmstudio> <model>         Load a model into memory",
  "  unload <ollama|lmstudio> <model>|--all   Free a model's memory now (Ollama: keep_alive 0)",
  "  pull   <ollama|lmstudio> <model>         Download a model (ollama pull / lms get)",
  "  rm     ollama <model>                    Delete an Ollama model (ollama rm)",
  "  adopt  <ollama|lmstudio> <model>         Run it on Atomic Agent's own engine, no new download",
  "         [--copy] [--use]                  (--copy when it cannot be linked; --use switches to it)",
  "",
  "  --json   One { type: \"result\", ok, ... } line (pull: progress lines first)",
].join("\n");

export const ACTION_NAMES = ["start", "load", "unload", "pull", "rm", "adopt"] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

export interface ParsedAction {
  readonly action: ActionName;
  readonly kind: "ollama" | "lmstudio";
  readonly model: string | null;
  readonly all: boolean;
  readonly json: boolean;
  readonly copy: boolean;
  readonly use: boolean;
}

export function parseAction(args: readonly string[]): ParsedAction | { error: string } {
  const action = args[0] as ActionName;
  if (!ACTION_NAMES.includes(action)) return { error: `unknown action: ${args[0]}` };
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const words = args.slice(1).filter((a) => !a.startsWith("--"));
  for (const f of flags) if (!["--json", "--all", "--copy", "--use"].includes(f)) return { error: `unknown option: ${f}` };
  const kind = words[0];
  if (kind !== "ollama" && kind !== "lmstudio") return { error: `${action}: say which app, ollama or lmstudio` };
  const model = words[1] ?? null;
  if (words.length > 2) return { error: `${action}: one model at a time` };
  const all = flags.has("--all");
  if (action === "start" && model) return { error: "start takes no model" };
  if (action === "unload" && !model && !all) return { error: "unload: name a model, or --all" };
  if (action !== "start" && action !== "unload" && !model) return { error: `${action}: name a model` };
  if (all && action !== "unload") return { error: "--all goes with unload only" };
  if (action === "rm" && kind === "lmstudio") return { error: "LM Studio models are deleted in LM Studio itself (My Models)" };
  if ((flags.has("--copy") || flags.has("--use")) && action !== "adopt") return { error: "--copy and --use go with adopt only" };
  if (flags.has("--use") && flags.has("--json")) return { error: "--use cannot be combined with --json" };
  return { action, kind, model, all, json: flags.has("--json"), copy: flags.has("--copy"), use: flags.has("--use") };
}

export interface ActionDeps {
  readonly write?: (text: string) => void;
  readonly writeErr?: (text: string) => void;
  readonly detect?: () => Promise<DetectedLocalServer[]>;
  readonly start?: typeof startExternalServer;
  readonly ollama?: {
    load: typeof loadOllamaModel;
    unload: typeof unloadOllamaModel;
    pull: typeof pullOllamaModel;
    remove: typeof deleteOllamaModel;
  };
  readonly lms?: { load: typeof lmsLoad; unload: typeof lmsUnload; get: typeof lmsGet };
  readonly adopt?: typeof adoptExternalModel;
  readonly save?: (def: AdoptResult["def"]) => void;
  /** Where the managed engine keeps its data and models; from the config by default. */
  readonly paths?: () => { dataDir: string; managedModelsDir: string };
  readonly useModel?: (id: string) => Promise<number>;
}

const APP = { ollama: "Ollama", lmstudio: "LM Studio" } as const;

/** "2.1 GB of 5.0 GB (42%)", or the bare status. */
export function pullProgressLine(p: OllamaPullProgress): string {
  if (p.total && p.completed !== null) {
    const pct = Math.min(100, Math.floor((p.completed / p.total) * 100));
    return `${p.status}: ${(p.completed / 1e9).toFixed(1)} GB of ${(p.total / 1e9).toFixed(1)} GB (${pct}%)`;
  }
  return p.status;
}

/**
 * Ollama sends a progress line many times a second. Pass one on when the
 * step changes or the percent moves by `step` points, so the terminal and
 * the desktop's row are not flooded.
 */
export function progressGate(step: number): (p: OllamaPullProgress) => boolean {
  let lastStatus = "";
  let lastPct = -Infinity;
  return (p) => {
    const pct = p.total && p.completed !== null ? Math.floor((p.completed / p.total) * 100) : null;
    if (p.status !== lastStatus) {
      lastStatus = p.status;
      lastPct = pct ?? -Infinity;
      return true;
    }
    if (pct === null || pct - lastPct < step) return false;
    lastPct = pct;
    return true;
  };
}

function configPaths(): { dataDir: string; managedModelsDir: string } {
  const dataDir = getConfig().paths.localModelsDataDir;
  return { dataDir, managedModelsDir: resolveModelsDir(dataDir) };
}

async function perform(a: ParsedAction, deps: ActionDeps, say: (line: string, progress?: object) => void): Promise<Record<string, unknown>> {
  const ol = deps.ollama ?? { load: loadOllamaModel, unload: unloadOllamaModel, pull: pullOllamaModel, remove: deleteOllamaModel };
  const lm = deps.lms ?? { load: lmsLoad, unload: lmsUnload, get: lmsGet };
  const model = a.model ?? "";
  switch (a.action) {
    case "start": {
      const r = await (deps.start ?? startExternalServer)(a.kind, deps.detect ? { detect: deps.detect } : {});
      say(r.started ? `${APP[a.kind]} is running at ${r.server.baseUrl}.` : `${APP[a.kind]} was already running at ${r.server.baseUrl}.`);
      return { started: r.started, server: r.server };
    }
    case "load":
      if (a.kind === "ollama") await ol.load(model);
      else await lm.load(model);
      say(`${model} is loaded in ${APP[a.kind]}.`);
      return { model };
    case "unload": {
      if (a.kind === "lmstudio") {
        await lm.unload(a.all ? null : model);
        say(a.all ? "LM Studio unloaded every model." : `${model} is unloaded from LM Studio.`);
        return { model: a.all ? null : model };
      }
      const names = a.all
        ? ((await (deps.detect ?? (() => detectLocalServers()))()).find((s) => s.kind === "ollama")?.loaded ?? [])
        : [model];
      for (const name of names) await ol.unload(name);
      say(names.length ? `Unloaded from Ollama: ${names.join(", ")}.` : "Ollama has no model in memory.");
      return { unloaded: names };
    }
    case "pull":
      if (a.kind === "ollama") {
        const shown = progressGate(a.json ? 1 : 10);
        await ol.pull(model, (p) => {
          if (shown(p)) say(pullProgressLine(p), { type: "progress", status: p.status, completed: p.completed, total: p.total });
        });
      } else {
        await lm.get(model, { onLine: (line) => say(line, { type: "progress", status: line, completed: null, total: null }) });
      }
      say(`${model} is downloaded in ${APP[a.kind]}.`);
      return { model };
    case "rm":
      await ol.remove(model);
      say(`${model} is deleted from Ollama.`);
      return { model };
    case "adopt": {
      const where = (deps.paths ?? configPaths)();
      const r = await (deps.adopt ?? adoptExternalModel)(a.kind, model, { ...where, copy: a.copy });
      (deps.save ?? addCustomModel)(r.def);
      say(`${model} from ${APP[a.kind]} is added to Atomic Agent as ${r.def.id}: ${describeAdoption(r)}.`);
      if (!a.use) say(`Run it with: atomic-agent models use ${r.def.id}`);
      return { id: r.def.id, name: r.def.name, path: r.path, sourcePath: r.sourcePath, how: r.how };
    }
  }
}

export async function runLocalServersAction(args: readonly string[], deps: ActionDeps = {}): Promise<number> {
  const write = deps.write ?? ((t: string) => { process.stdout.write(t); });
  const writeErr = deps.writeErr ?? ((t: string) => { process.stderr.write(t); });
  const parsed = parseAction(args);
  if ("error" in parsed) {
    writeErr(`${parsed.error}\n\n${ACTIONS_HELP}\n`);
    return 2;
  }
  const say = (line: string, progress?: object) => {
    if (!parsed.json) write(`${line}\n`);
    else if (progress) write(`${JSON.stringify(progress)}\n`);
  };
  try {
    const result = await perform(parsed, deps, say);
    if (parsed.json) write(`${JSON.stringify({ type: "result", ok: true, action: parsed.action, kind: parsed.kind, ...result })}\n`);
    if (parsed.action === "adopt" && parsed.use && typeof result.id === "string") {
      return await (deps.useModel ?? (async (id: string) => (await import("./models-handlers.js")).runLocalModelsUse(id)))(result.id);
    }
    return 0;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const detail = err && typeof err === "object" && "detail" in err && typeof (err as { detail: unknown }).detail === "string"
      ? (err as { detail: string }).detail
      : null;
    if (parsed.json) write(`${JSON.stringify({ type: "result", ok: false, action: parsed.action, kind: parsed.kind, error, detail })}\n`);
    else writeErr(`${error}${detail ? `\n  ${APP[parsed.kind]} said: ${detail}` : ""}\n`);
    return 1;
  }
}
