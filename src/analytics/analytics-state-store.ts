import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { resolveSharedInstallId } from "./resolve-shared-install-id.js";
import type { AnalyticsSurface } from "./resolve-surface.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Persistent, on-disk analytics state kept in `<stateDir>/analytics.json`.
 * Holds only an anonymous, randomly-generated install id, the install
 * timestamp, and three "fire once" flags. No IP, hostname, username, or
 * any machine-derived value is stored here — the id is a bare UUID with
 * no link back to the user or the device.
 */
export interface AnalyticsState {
  /** Anonymous, stable-per-install identifier (random UUID). */
  installId: string;
  /** Whether the one-time `app_installed` event was already sent. */
  appInstalledSent: boolean;
  /** Whether the one-time `first_message_sent` event was already sent. */
  firstMessageSent: boolean;
  /** Whether the one-time `model_configured` event was already sent. */
  modelConfiguredSent: boolean;
  /**
   * ISO timestamp of the fresh install that created this file. Absent in
   * files written before it existed — deliberately not backfilled, since
   * "now" would understate the age of an old install.
   */
  installedAt?: string;
}

/**
 * File-backed store for {@link AnalyticsState}. A missing / malformed
 * file is treated as a fresh install: a new `installId` is minted and
 * both flags start `false`. Every mutation is written back atomically
 * enough for a single-process local runtime — the file is tiny and
 * writes are synchronous, mirroring `WebhookSessionStore`.
 */
export class AnalyticsStateStore {
  private state: AnalyticsState;
  private sharedInstallId: string | undefined;

  constructor(private readonly filePath: string) {
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

  isAppInstalledSent(): boolean {
    return this.state.appInstalledSent;
  }

  isFirstMessageSent(): boolean {
    return this.state.firstMessageSent;
  }

  isModelConfiguredSent(): boolean {
    return this.state.modelConfiguredSent;
  }

  markAppInstalledSent(): void {
    if (this.state.appInstalledSent) return;
    this.state.appInstalledSent = true;
    this.persist();
  }

  markFirstMessageSent(): void {
    if (this.state.firstMessageSent) return;
    this.state.firstMessageSent = true;
    this.persist();
  }

  markModelConfiguredSent(): void {
    if (this.state.modelConfiguredSent) return;
    this.state.modelConfiguredSent = true;
    this.persist();
  }

  private load(): AnalyticsState {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<AnalyticsState>;
      if (typeof parsed.installId === "string" && parsed.installId.length > 0) {
        return {
          installId: parsed.installId,
          appInstalledSent: parsed.appInstalledSent === true,
          firstMessageSent: parsed.firstMessageSent === true,
          // Absent in files written before `model_configured` existed.
          // Defaulting to `false` lets an install that is already set up
          // emit the event once on its next verified provider save,
          // rather than never — the flag means "already reported", and
          // an old file has genuinely never reported it.
          modelConfiguredSent: parsed.modelConfiguredSent === true,
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
      firstMessageSent: false,
      modelConfiguredSent: false,
      installedAt: new Date().toISOString(),
    };
    this.state = fresh;
    this.persist();
    return fresh;
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
    } catch {
      // Analytics persistence is best-effort — never throw back into the
      // runtime. A failed write just means the "fire once" flags reset on
      // the next boot, at worst re-sending an idempotent event.
    }
  }
}
