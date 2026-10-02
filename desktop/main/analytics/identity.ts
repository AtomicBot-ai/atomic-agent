/**
 * The shared install id (one per machine, shared with the terminal agent)
 * and the desktop's own once-flags file.
 *
 * Shared id file: `$ATOMIC_AGENT_INSTALL_ID_FILE`, else
 * `~/.atomic-agent-install-id` — plain text, one UUID line. Resolution
 * (core.ts installIdSources gives the order):
 *   1. the shared file holds a valid UUID → use it;
 *   2. else an `installId` in a local `analytics.json` — the terminal
 *      agent's (unless its config opted out), then the desktop state dir's
 *      → write it to the shared file;
 *   3. else mint one and write it.
 * The shared file is only touched when the caller says writes are allowed
 * (analytics on, not a test run). Every fs failure falls back to an
 * in-memory id; nothing here throws.
 *
 * Once-flags live in `<DESKTOP_STATE_DIR>/desktop-analytics.json`, per
 * state dir, so `model_configured` fires once for the desktop surface.
 * seedDesktopFlags: a desktop that was already set up before this file
 * existed (an upgrade) gets modelConfiguredSent=true and no install date,
 * so it never reports a fake first setup or a made-up install age.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v.trim());
}

export function sharedIdPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env.ATOMIC_AGENT_INSTALL_ID_FILE;
  return typeof override === "string" && override.trim() ? override.trim() : join(home, ".atomic-agent-install-id");
}

/** temp file + rename, so a reader never sees half a file. */
export function writeAtomic(path: string, body: string): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJson(path: string): Record<string, unknown> | null {
  const raw = readText(path);
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface ResolveIdInput {
  sharedPath: string;
  /** Local `analytics.json` files to adopt an id from, in order. */
  localFiles: string[];
  /** False under tests or with analytics off: read only, never write. */
  allowWrite: boolean;
  mint?: () => string;
}

export function resolveInstallId(input: ResolveIdInput): { id: string; source: "shared" | "local" | "minted" } {
  const shared = readText(input.sharedPath)?.trim();
  if (isUuid(shared)) return { id: shared!, source: "shared" };
  for (const f of input.localFiles) {
    const id = readJson(f)?.installId;
    if (isUuid(id)) {
      if (input.allowWrite) writeAtomic(input.sharedPath, `${id.trim()}\n`);
      return { id: id.trim(), source: "local" };
    }
  }
  const id = (input.mint ?? randomUUID)();
  if (input.allowWrite) writeAtomic(input.sharedPath, `${id}\n`);
  return { id, source: "minted" };
}

/* ---- desktop once-flags ---- */

export interface DesktopFlags {
  /** ms epoch of the first launch this file saw. */
  installedAt: number | null;
  modelConfiguredSent: boolean;
  /** Set while a session runs, cleared on a clean quit: still set at launch = the last one crashed. */
  sessionOpen: boolean;
}

export class DesktopFlagsStore {
  private flags: DesktopFlags;
  /** The file was there (and readable) when the store was made. */
  readonly existed: boolean;
  constructor(private readonly path: string, private readonly allowWrite: () => boolean) {
    const json = readJson(path);
    this.existed = json !== null;
    const raw: Record<string, unknown> = json ?? {};
    const at = raw["installedAt"];
    this.flags = {
      installedAt: typeof at === "number" && Number.isFinite(at) ? at : null,
      modelConfiguredSent: raw.modelConfiguredSent === true,
      sessionOpen: raw.sessionOpen === true,
    };
  }

  get(): Readonly<DesktopFlags> {
    return this.flags;
  }

  set(patch: Partial<DesktopFlags>): void {
    this.flags = { ...this.flags, ...patch };
    if (this.allowWrite()) writeAtomic(this.path, `${JSON.stringify(this.flags, null, 2)}\n`);
  }
}

/** First sight of the flags file: a fresh install dates itself; an upgrade claims nothing. */
export function seedDesktopFlags(store: DesktopFlagsStore, freshState: boolean, now: number = Date.now()): void {
  if (store.existed) return;
  if (freshState) store.set({ installedAt: now });
  else store.set({ installedAt: null, modelConfiguredSent: true });
}

export function daysSince(at: number | null, now: number = Date.now()): number | undefined {
  if (at === null || at > now) return undefined;
  return Math.floor((now - at) / 86_400_000);
}
