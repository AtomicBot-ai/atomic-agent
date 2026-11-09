import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { resolveSharedInstallId } from "./resolve-shared-install-id.js";
import type { AnalyticsSurface } from "./resolve-surface.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Persistent, on-disk analytics state kept in `<stateDir>/analytics.json`.
 * Holds only an anonymous, randomly-generated install id, the install
 * timestamp, and the "fire once" flags. No IP, hostname, username, or
 * any machine-derived value is stored here — the id is a bare UUID with
 * no link back to the user or the device.
 *
 * The desktop app and the terminal share one state dir (`~/.atomic-agent`)
 * and so one file. `app_installed` is counted per surface, so it has two
 * flags: `appInstalledSent` for the terminal (`tui` / `cli`, and the only
 * flag files written before ATO-1227 have) and `appInstalledSentDesktop`
 * for the desktop. `first_message_sent` and `model_configured` are split
 * the same way (ATO-1262): `firstMessageSent` / `modelConfiguredSent`
 * for the terminal (the only ones older files have), and
 * `firstMessageSentDesktop` / `modelConfiguredSentDesktop` for the desktop.
 */
export interface AnalyticsState {
  /** Anonymous, stable-per-install identifier (random UUID). */
  installId: string;
  /** Whether the terminal's one-time `app_installed` was already sent. */
  appInstalledSent: boolean;
  /**
   * Whether the desktop's one-time `app_installed` was already sent.
   * Absent in files written before ATO-1227: read as `false`, so a
   * desktop sharing the folder with an earlier terminal reports once.
   */
  appInstalledSentDesktop: boolean;
  /** Whether the terminal's one-time `first_message_sent` was already sent. */
  firstMessageSent: boolean;
  /**
   * Whether the desktop's one-time `first_message_sent` was already sent.
   * Absent in files written before ATO-1262: read as `false`.
   */
  firstMessageSentDesktop: boolean;
  /** Whether the terminal's one-time `model_configured` was already sent. */
  modelConfiguredSent: boolean;
  /**
   * Whether the desktop's one-time `model_configured` was already sent.
   * Absent in files written before ATO-1262: read as `false`.
   */
  modelConfiguredSentDesktop: boolean;
  /**
   * ISO timestamp of the fresh install that created this file. Absent in
   * files written before it existed — deliberately not backfilled, since
   * "now" would understate the age of an old install.
   */
  installedAt?: string;
}

/** Which `app_installed` flag a surface uses. */
function appInstalledKey(
  surface: AnalyticsSurface | undefined,
): "appInstalledSent" | "appInstalledSentDesktop" {
  return surface === "desktop" ? "appInstalledSentDesktop" : "appInstalledSent";
}

/** Which `first_message_sent` flag a surface uses (ATO-1262). */
function firstMessageKey(
  surface: AnalyticsSurface | undefined,
): "firstMessageSent" | "firstMessageSentDesktop" {
  return surface === "desktop" ? "firstMessageSentDesktop" : "firstMessageSent";
}

/** Which `model_configured` flag a surface uses (ATO-1262). */
function modelConfiguredKey(
  surface: AnalyticsSurface | undefined,
): "modelConfiguredSent" | "modelConfiguredSentDesktop" {
  return surface === "desktop" ? "modelConfiguredSentDesktop" : "modelConfiguredSent";
}

/** The flag of the *other* surface (desktop <-> terminal). */
function otherAppInstalledKey(
  surface: AnalyticsSurface | undefined,
): "appInstalledSent" | "appInstalledSentDesktop" {
  return surface === "desktop" ? "appInstalledSent" : "appInstalledSentDesktop";
}

const FLAG_KEYS = [
  "appInstalledSent",
  "appInstalledSentDesktop",
  "firstMessageSent",
  "firstMessageSentDesktop",
  "modelConfiguredSent",
  "modelConfiguredSentDesktop",
] as const;

const KNOWN_KEYS: ReadonlySet<string> = new Set<string>([
  "installId",
  "installedAt",
  ...FLAG_KEYS,
]);

/**
 * File-backed store for {@link AnalyticsState}. A missing / malformed
 * file is treated as a fresh install: a new `installId` is minted and
 * every flag starts `false`. Every mutation is written back atomically
 * enough for a single-process local runtime — the file is tiny and
 * writes are synchronous, mirroring `WebhookSessionStore`. Desktop and
 * terminal may hold the same file open at once, so every write merges
 * the file's current flags first and keeps keys this build does not know.
 */
export class AnalyticsStateStore {
  private state: AnalyticsState;
  /**
   * Keys a newer build wrote that this one does not know. Kept and
   * written back so this build never drops another build's flag.
   */
  private extra: Record<string, unknown> = {};
  private sharedInstallId: string | undefined;

  /**
   * `options.surface` is the surface this process reports as. It picks
   * the `first_message_sent` / `model_configured` flags when a call does
   * not name a surface itself; without it the terminal's flags are used,
   * as before ATO-1262.
   */
  constructor(
    private readonly filePath: string,
    private readonly options: { surface?: AnalyticsSurface } = {},
  ) {
    this.state = this.load();
  }

  /** This state dir's own id (the pre-shared-id identifier). */
  getInstallId(): string {
    return this.state.installId;
  }

  /**
   * The machine-wide id shared with the other surface (see
   * `resolveSharedInstallId`). `surface: "desktop"` lets a fresh shared
   * file adopt the terminal's id. While analytics is disabled the shared
   * file is not touched and the local id is returned. Cached once
   * resolved with analytics on.
   */
  getSharedInstallId(enabled: boolean, surface?: AnalyticsSurface): string {
    if (this.sharedInstallId !== undefined) return this.sharedInstallId;
    const id = resolveSharedInstallId({
      localId: this.state.installId,
      enabled,
      ...(surface ? { surface } : {}),
    });
    if (enabled) this.sharedInstallId = id;
    return id;
  }

  /**
   * Whole days since the fresh install that created this file, or
   * `undefined` when the install predates the `installedAt` field.
   */
  getDaysSinceInstall(now: number = Date.now()): number | undefined {
    if (this.state.installedAt === undefined) return undefined;
    const at = Date.parse(this.state.installedAt);
    if (!Number.isFinite(at)) return undefined;
    return Math.max(0, Math.floor((now - at) / DAY_MS));
  }

  /**
   * Whether `app_installed` already went out for `surface`: the desktop
   * has its own flag, the terminal (`tui` / `cli`, or no surface) the
   * original one. Re-reads the file first, since the other surface may
   * be running at the same time and share it.
   */
  isAppInstalledSent(surface?: AnalyticsSurface): boolean {
    this.mergeFromDisk();
    return this.state[appInstalledKey(surface)];
  }

  /**
   * Whether the *other* surface already reported its `app_installed`
   * from this folder: for the desktop, the terminal's flag; for the
   * terminal, the desktop's. Re-reads the file first.
   */
  isOtherSurfaceAppInstalledSent(surface?: AnalyticsSurface): boolean {
    this.mergeFromDisk();
    return this.state[otherAppInstalledKey(surface)];
  }

  /**
   * Whether `first_message_sent` already went out for `surface` (by
   * default this process's surface): the desktop and the terminal each
   * have their own flag (ATO-1262). Re-reads the file first.
   */
  isFirstMessageSent(surface: AnalyticsSurface | undefined = this.options.surface): boolean {
    this.mergeFromDisk();
    return this.state[firstMessageKey(surface)];
  }

  /** As {@link isFirstMessageSent}, for `model_configured`. */
  isModelConfiguredSent(surface: AnalyticsSurface | undefined = this.options.surface): boolean {
    this.mergeFromDisk();
    return this.state[modelConfiguredKey(surface)];
  }

  markAppInstalledSent(surface?: AnalyticsSurface): void {
    const key = appInstalledKey(surface);
    if (this.state[key]) return;
    this.state[key] = true;
    this.persist();
  }

  markFirstMessageSent(surface: AnalyticsSurface | undefined = this.options.surface): void {
    const key = firstMessageKey(surface);
    if (this.state[key]) return;
    this.state[key] = true;
    this.persist();
  }

  markModelConfiguredSent(surface: AnalyticsSurface | undefined = this.options.surface): void {
    const key = modelConfiguredKey(surface);
    if (this.state[key]) return;
    this.state[key] = true;
    this.persist();
  }

  /** The file as it is on disk now, or `undefined` if unreadable. */
  private readDisk(): Record<string, unknown> | undefined {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Fold the file's current flags into memory. Flags only ever go from
   * `false` to `true`, so a flag set on disk by another process (the
   * other surface, or a second copy of this one) is kept, never undone.
   * Unknown keys from a newer build are kept too. A file that now holds
   * a different install id is not merged from.
   */
  private mergeFromDisk(): void {
    const disk = this.readDisk();
    if (!disk || disk.installId !== this.state.installId) return;
    for (const key of FLAG_KEYS) {
      if (disk[key] === true) this.state[key] = true;
    }
    for (const [key, value] of Object.entries(disk)) {
      if (!KNOWN_KEYS.has(key)) this.extra[key] = value;
    }
  }

  private load(): AnalyticsState {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<AnalyticsState> &
        Record<string, unknown>;
      if (typeof parsed.installId === "string" && parsed.installId.length > 0) {
        for (const [key, value] of Object.entries(parsed)) {
          if (!KNOWN_KEYS.has(key)) this.extra[key] = value;
        }
        return {
          installId: parsed.installId,
          appInstalledSent: parsed.appInstalledSent === true,
          // Absent in files written before ATO-1227 (one flag for both
          // surfaces): `false`, so the desktop still reports once.
          appInstalledSentDesktop: parsed.appInstalledSentDesktop === true,
          firstMessageSent: parsed.firstMessageSent === true,
          // Absent in files written before ATO-1262 (one flag for both
          // surfaces): `false`, so the desktop reports once.
          firstMessageSentDesktop: parsed.firstMessageSentDesktop === true,
          // Absent in files written before `model_configured` existed.
          // Defaulting to `false` lets an install that is already set up
          // emit the event once on its next verified provider save,
          // rather than never — the flag means "already reported", and
          // an old file has genuinely never reported it.
          modelConfiguredSent: parsed.modelConfiguredSent === true,
          modelConfiguredSentDesktop: parsed.modelConfiguredSentDesktop === true,
          ...(typeof parsed.installedAt === "string"
            ? { installedAt: parsed.installedAt }
            : {}),
        };
      }
    } catch {
      // Missing or malformed file → treat as a fresh install.
    }
    const fresh: AnalyticsState = {
      installId: randomUUID(),
      appInstalledSent: false,
      appInstalledSentDesktop: false,
      firstMessageSent: false,
      firstMessageSentDesktop: false,
      modelConfiguredSent: false,
      modelConfiguredSentDesktop: false,
      installedAt: new Date().toISOString(),
    };
    this.state = fresh;
    this.persist();
    return fresh;
  }

  private persist(): void {
    try {
      // Another process may have set a flag since this one loaded the
      // file (desktop and terminal share it); merge first so writing
      // this process's view never clears it.
      this.mergeFromDisk();
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(
        this.filePath,
        JSON.stringify({ ...this.extra, ...this.state }, null, 2),
        "utf8",
      );
    } catch {
      // Analytics persistence is best-effort — never throw back into the
      // runtime. A failed write just means the "fire once" flags reset on
      // the next boot, at worst re-sending an idempotent event.
    }
  }
}
