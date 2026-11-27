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
