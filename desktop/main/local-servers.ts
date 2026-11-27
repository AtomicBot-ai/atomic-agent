/**
 * ATO-2489: what `atag local-servers --json` says runs on this computer
 * (src/cli/local-servers-command.ts, the core's detectLocalServers), read
 * into the shape the setup step and Settings › Local draw.
 *
 * Pure: no Electron, no process, so the Node tests load it from out/main.
 * The IPC that runs the command is local-servers-ipc.ts.
 */

export type LocalServerKind = "ollama" | "lmstudio" | "llama-app";

export interface LocalServer {
  kind: LocalServerKind;
  label: string;
  baseUrl: string;
  /** The provider preset that connects to it, or null for the Llama app (the External llama-server). */
  presetId: "ollama" | "lmstudio" | null;
  models: string[];
  loaded: string[];
}

export type LocalServersAnswer =
  | { ok: true; servers: LocalServer[] }
  /** `unsupported`: the agent has no `local-servers` (an older core); the UI shows nothing. */
  | { ok: false; unsupported?: boolean; remote?: boolean; error: string };

const KINDS: readonly LocalServerKind[] = ["ollama", "lmstudio", "llama-app"];

function strings(list: unknown): string[] {
  return Array.isArray(list) ? list.filter((s): s is string => typeof s === "string" && s.length > 0) : [];
}

/** One server row, or null when the row is not one the core writes. */
function readServer(raw: unknown): LocalServer | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind as LocalServerKind;
  if (!KINDS.includes(kind)) return null;
  if (typeof r.baseUrl !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(r.baseUrl)) return null;
  const presetId = r.presetId === "ollama" || r.presetId === "lmstudio" ? r.presetId : null;
  return {
    kind,
    label: typeof r.label === "string" && r.label ? r.label : kind,
    baseUrl: r.baseUrl,
    presetId,
    models: strings(r.models),
    loaded: strings(r.loaded),
  };
}

/** `local-servers --json` stdout; null when it is not that command's answer. */
export function parseLocalServers(stdout: string): LocalServer[] | null {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!line) return null;
  let body: unknown;
  try {
    body = JSON.parse(line);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || !Array.isArray((body as { servers?: unknown }).servers)) return null;
  return ((body as { servers: unknown[] }).servers).map(readServer).filter((s): s is LocalServer => s !== null);
}

/** Whether a failed run is an agent that has no such command (exit 2, "unknown command"). */
export function isUnsupportedCommand(stderr: string): boolean {
  return /unknown command/i.test(stderr || "");
}

/** "3 models, 1 loaded": the same words as the core's describeDetectedServer. */
export function serverFacts(server: Pick<LocalServer, "models" | "loaded">): string {
  const n = server.models.length;
  const parts = [n === 1 ? "1 model" : `${n} models`];
  if (server.loaded.length > 0) parts.push(`${server.loaded.length} loaded`);
  return parts.join(", ");
}

/* ---------------- Actions (ATO-2490) ----------------
   `atag local-servers <action> <ollama|lmstudio> [model] --json`
   (src/cli/local-servers-actions.ts): start, load, unload, pull, rm and
   adopt. The command prints `{type:"progress"}` lines (pull) and one
   `{type:"result", ok, ...}` line last. */

export type ServerAction = "start" | "load" | "unload" | "pull" | "rm" | "adopt";
const ACTIONS: readonly ServerAction[] = ["start", "load", "unload", "pull", "rm", "adopt"];

export interface ServerActionInput {
  action: ServerAction;
  kind: "ollama" | "lmstudio";
  model: string | null;
  /** unload every model. */
  all: boolean;
  /** adopt: copy when a link cannot be made. */
  copy: boolean;
}

/** A model name as Ollama or LM Studio writes it; never something that reads as a flag. */
export function isServerModelName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/.test(name);
}

/** What the renderer sent, checked; or a sentence when it is not an action this app offers. */
export function readActionInput(raw: unknown): ServerActionInput | { error: string } {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const action = o.action as ServerAction;
  if (!ACTIONS.includes(action)) return { error: "That is not something the app can do with a model server." };
  if (o.kind !== "ollama" && o.kind !== "lmstudio") return { error: "Only Ollama and LM Studio can be managed from here." };
  const kind = o.kind;
  const model = typeof o.model === "string" && o.model.trim() ? o.model.trim() : null;
  const all = o.all === true && action === "unload";
  if (model !== null && !isServerModelName(model)) return { error: "That model name has characters the app does not accept." };
  if (action === "start" && model) return { error: "Start takes no model." };
  if (action !== "start" && !model && !all) return { error: "Choose a model first." };
  if (action === "rm" && kind === "lmstudio") return { error: "Delete LM Studio models in LM Studio itself (My Models)." };
  return { action, kind, model: action === "start" || all ? null : model, all, copy: o.copy === true && action === "adopt" };
}

/** The agent command line for an action (always `--json`). */
export function actionArgs(a: ServerActionInput): string[] {
  const args = ["local-servers", a.action, a.kind];
  if (a.model) args.push(a.model);
  if (a.all) args.push("--all");
  if (a.copy) args.push("--copy");
  args.push("--json");
  return args;
}

export interface ServerActionProgress {
  status: string;
  completed: number | null;
  total: number | null;
}

export interface ServerActionResult {
  ok: boolean;
  /** A sentence for the screen. */
  error?: string;
  /** The other app's own words, behind Details. */
  detail?: string | null;
  /** adopt: the new local model's id. */
  id?: string;
  name?: string;
  how?: string;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** One stdout line: a progress step, the result, or null. */
export function readActionLine(line: string): { progress: ServerActionProgress } | { result: ServerActionResult } | null {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(line.trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  if (body.type === "progress") {
    return { progress: { status: typeof body.status === "string" ? body.status : "", completed: num(body.completed), total: num(body.total) } };
  }
  if (body.type !== "result") return null;
  if (body.ok === true) {
    const r: ServerActionResult = { ok: true };
    if (typeof body.id === "string") r.id = body.id;
    if (typeof body.name === "string") r.name = body.name;
    if (typeof body.how === "string") r.how = body.how;
    return { result: r };
  }
  return {
    result: {
      ok: false,
      error: typeof body.error === "string" && body.error ? body.error : "The model server did not do that.",
      detail: typeof body.detail === "string" && body.detail ? body.detail : null,
    },
  };
}

/** The answer of a finished run: its result line, else words for how it ended. */
export function actionAnswer(stdout: string, stderr: string, code: number | null): ServerActionResult {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const read = readActionLine(lines[i]!);
    if (read && "result" in read) return read.result;
  }
  if (isUnsupportedCommand(stderr)) return { ok: false, error: "This agent cannot manage model servers yet. Update Atomic Agent." };
  const said = stderr.trim().split(/\r?\n/).filter(Boolean).slice(0, 6).join("\n") || null;
  return { ok: false, error: code === null ? "The action was stopped." : "The model server did not do that.", detail: said };
}

/** "2.1 of 5.0 GB" / "42%", or the bare status, for the row under a download. */
export function progressWords(p: ServerActionProgress): string {
  if (p.total && p.completed !== null) {
    const pct = Math.min(100, Math.floor((p.completed / p.total) * 100));
    return `${(p.completed / 1e9).toFixed(1)} of ${(p.total / 1e9).toFixed(1)} GB (${pct}%)`;
  }
  return p.status;
}
