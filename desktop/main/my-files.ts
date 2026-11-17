/**
 * ATO-1624: "My files", the desktop half of the folder index. The agent owns
 * the index (ATO-1621): it walks the folders, reads the files, keeps the
 * chunks and answers `files.search`. The desktop only asks it, through the
 * routes of the shared contract
 * (linear-week/wave6/reports/w6-memory-files-my-files-contract.md):
 *
 *   GET    /api/files/folders          → { folders: Folder[] }
 *   POST   /api/files/folders {path}   → { folder: Folder }   400 { error: { code, message } }
 *   DELETE /api/files/folders {path}   → { removed: boolean }
 *   GET    /api/files/status           → Status
 *
 * A runtime without a file index answers 501; an agent from before the
 * routes answers the router's 404 "No route for …". Both are `unsupported`,
 * and the screen asks to update the agent. Pure: no Electron, so
 * test/my-files.test.mjs reads it from `out/`. Main reads no files itself.
 */

/** Every path in one place, so a change of the agent's routes is one edit. */
export const MY_FILES_PATHS = {
  folders: "/api/files/folders",
  status: "/api/files/status",
} as const;

export interface MyFilesFolder {
  path: string;
  name: string;
  fileCount: number;
  indexedCount: number;
  addedAt: string;
}

export interface MyFilesStatus {
  running: boolean;
  found: number;
  indexed: number;
  failed: number;
  skipped: number;
  current?: string;
  lastError?: { path: string; message: string; at: string };
  updatedAt: string;
  /** Derived here so the screen does not repeat the rule: `!running && indexed + failed + skipped >= found`. */
  done: boolean;
}

export type MyFilesFailure = {
  ok: false;
  reason: "remote" | "unsupported" | "invalid" | "rejected" | "not_running" | "error";
  error: string;
  /** The agent's own code on a 400 (`not_found`, `already_added`, …). */
  code?: string;
  status?: number;
};

export type MyFilesResult<T> = ({ ok: true } & T) | MyFilesFailure;

export const MY_FILES_TEXT = {
  remote:
    "This app is connected to an agent on another computer. Folders for My files are added on that computer, in its own terminal.",
  unsupported: "My files needs a newer agent. Update the agent, then open this screen again.",
  notRunning: "The agent is not running. Start it and try again.",
  badReply: "The agent sent an answer this app cannot read.",
} as const;

/** The agent's 400 codes, in words a person can act on. Unknown codes keep the agent's own message. */
const REJECT_TEXT: Record<string, string> = {
  not_absolute: "Pick the folder with the Add folder button.",
  not_found: "That folder does not exist any more.",
  not_a_directory: "That is a file, not a folder.",
  already_added: "This folder is already in My files.",
  inside_added: "This folder is inside a folder that is already in My files.",
  too_broad: "That folder is too big to index. Pick a folder with your documents in it.",
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** One folder row, or null when it has no usable path. */
export function parseFolder(raw: unknown): MyFilesFolder | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const path = str(r.path).trim();
  if (!path) return null;
  const fileCount = num(r.fileCount);
  return {
    path,
    name: str(r.name).trim() || basename(path),
    fileCount,
    indexedCount: Math.min(num(r.indexedCount), fileCount || num(r.indexedCount)),
    addedAt: str(r.addedAt),
  };
}

export function parseFolders(raw: unknown): MyFilesFolder[] | null {
  const list = (raw as { folders?: unknown } | null | undefined)?.folders;
  if (!Array.isArray(list)) return null;
  return list.map(parseFolder).filter((f): f is MyFilesFolder => f !== null);
}

export function parseStatus(raw: unknown): MyFilesStatus | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.running !== "boolean") return null;
  const found = num(r.found);
  const indexed = num(r.indexed);
  const failed = num(r.failed);
  const skipped = num(r.skipped);
  const status: MyFilesStatus = {
    running: r.running,
    found,
    indexed,
    failed,
    skipped,
    updatedAt: str(r.updatedAt),
    done: !r.running && indexed + failed + skipped >= found,
  };
  const current = str(r.current).trim();
  if (current) status.current = current;
  const le = r.lastError as Record<string, unknown> | null | undefined;
  if (le && typeof le === "object" && str(le.message)) {
    status.lastError = { path: str(le.path), message: str(le.message), at: str(le.at) };
  }
  return status;
}

/** True when `/api/capabilities` says the agent has the file index (`fileIndex: true`, top level or under `agent` / `features`). */
export function hasFileIndex(caps: unknown): boolean {
  if (!caps || typeof caps !== "object") return false;
  const c = caps as Record<string, unknown>;
  const nested = (k: string) => (c[k] && typeof c[k] === "object" ? (c[k] as Record<string, unknown>).fileIndex : undefined);
  return c.fileIndex === true || nested("agent") === true || nested("features") === true;
}

function errorBody(text: string): { code: string; message: string } {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } | string };
    if (typeof parsed?.error === "string") return { code: "", message: parsed.error };
    return { code: str(parsed?.error?.code), message: str(parsed?.error?.message) };
  } catch {
    return { code: "", message: "" };
  }
}

/** A non-2xx answer, read. */
export function interpretFailure(status: number, text: string): MyFilesFailure {
  const { code, message } = errorBody(text);
  if (status === 501 || status === 405) return { ok: false, reason: "unsupported", error: MY_FILES_TEXT.unsupported, status };
  // The router's own 404 (http-server.ts): this agent has no such route.
  if (status === 404 && (!message || /^No route for /.test(message))) {
    return { ok: false, reason: "unsupported", error: MY_FILES_TEXT.unsupported, status };
  }
  if (status === 400) {
    return { ok: false, reason: "rejected", error: REJECT_TEXT[code] ?? (message || `HTTP ${status}`), code: code || undefined, status };
  }
  return { ok: false, reason: "error", error: message || `HTTP ${status}`, status };
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return undefined;
  }
}

export function interpretList(status: number, text: string): MyFilesResult<{ folders: MyFilesFolder[] }> {
  if (status < 200 || status >= 300) return interpretFailure(status, text);
  const folders = parseFolders(parseJson(text));
  return folders ? { ok: true, folders } : { ok: false, reason: "error", error: MY_FILES_TEXT.badReply, status };
}

export function interpretAdd(status: number, text: string): MyFilesResult<{ folder: MyFilesFolder }> {
  if (status < 200 || status >= 300) return interpretFailure(status, text);
  const folder = parseFolder((parseJson(text) as { folder?: unknown } | null | undefined)?.folder);
  return folder ? { ok: true, folder } : { ok: false, reason: "error", error: MY_FILES_TEXT.badReply, status };
}

export function interpretRemove(status: number, text: string): MyFilesResult<{ removed: boolean }> {
  if (status < 200 || status >= 300) return interpretFailure(status, text);
  const removed = (parseJson(text) as { removed?: unknown } | null | undefined)?.removed;
  return typeof removed === "boolean" ? { ok: true, removed } : { ok: false, reason: "error", error: MY_FILES_TEXT.badReply, status };
}

export function interpretStatus(status: number, text: string): MyFilesResult<{ status: MyFilesStatus }> {
  if (status < 200 || status >= 300) return interpretFailure(status, text);
  const parsed = parseStatus(parseJson(text));
  return parsed ? { ok: true, status: parsed } : { ok: false, reason: "error", error: MY_FILES_TEXT.badReply, status };
}

/** The folder path the renderer sent, checked before it goes on the wire. */
export function checkFolderPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.trim();
  if (!path || path.length > 4096 || path.includes("\0")) return null;
  // Absolute on this computer (posix, a Windows drive, or a UNC share). The agent checks again.
  return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path) ? path : null;
}

export interface MyFilesTarget {
  base: string;
  headers: Record<string, string>;
}

export interface MyFilesEnv {
  isRemote: () => boolean;
  /** Throws "agent is not running" when there is none. */
  target: () => MyFilesTarget;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const REMOTE: MyFilesFailure = { ok: false, reason: "remote", error: MY_FILES_TEXT.remote };

async function call(env: MyFilesEnv, method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<{ status: number; text: string } | MyFilesFailure> {
  let t: MyFilesTarget;
  try {
    t = env.target();
  } catch {
    return { ok: false, reason: "not_running", error: MY_FILES_TEXT.notRunning };
  }
  try {
    const res = await (env.fetchImpl ?? fetch)(`${t.base}${path}`, {
      method,
      headers: t.headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(env.timeoutMs ?? 20_000),
    });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    return { ok: false, reason: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

const failed = (r: { status: number; text: string } | MyFilesFailure): r is MyFilesFailure => "ok" in r;

/**
 * The four calls. Each never throws. Listing and status also work on a remote
 * agent (it reports its own folders); adding and removing are refused there:
 * a folder picked on this computer does not exist on the other one.
 */
export async function listFolders(env: MyFilesEnv) {
  const r = await call(env, "GET", MY_FILES_PATHS.folders);
  return failed(r) ? r : interpretList(r.status, r.text);
}

export async function indexStatus(env: MyFilesEnv) {
  const r = await call(env, "GET", MY_FILES_PATHS.status);
  return failed(r) ? r : interpretStatus(r.status, r.text);
}

export async function addFolder(env: MyFilesEnv, rawPath: unknown) {
  if (env.isRemote()) return REMOTE;
  const path = checkFolderPath(rawPath);
  if (!path) return { ok: false, reason: "invalid", error: REJECT_TEXT.not_absolute } as MyFilesFailure;
  const r = await call(env, "POST", MY_FILES_PATHS.folders, { path });
  return failed(r) ? r : interpretAdd(r.status, r.text);
}

export async function removeFolder(env: MyFilesEnv, rawPath: unknown) {
  if (env.isRemote()) return REMOTE;
  const path = checkFolderPath(rawPath);
  if (!path) return { ok: false, reason: "invalid", error: "That folder path is not valid." } as MyFilesFailure;
  const r = await call(env, "DELETE", MY_FILES_PATHS.folders, { path });
  return failed(r) ? r : interpretRemove(r.status, r.text);
}

/** Refusal for the folder picker on a remote agent: the dialog would show this computer's disks. */
export function pickRefusal(isRemote: boolean): MyFilesFailure | null {
  return isRemote ? REMOTE : null;
}
