import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Persistent, on-disk analytics state kept in `<stateDir>/analytics.json`.
 * Holds only an anonymous, randomly-generated install id and two
 * "fire once" flags. No IP, hostname, username, or any machine-derived
 * value is stored here — the id is a bare UUID with no link back to the
 * user or the device.
 */
export interface AnalyticsState {
  /** Anonymous, stable-per-install identifier (random UUID). */
  installId: string;
  /** Whether the one-time `app_installed` event was already sent. */
  appInstalledSent: boolean;
  /** Whether the one-time `first_message_sent` event was already sent. */
  firstMessageSent: boolean;
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

  constructor(private readonly filePath: string) {
    this.state = this.load();
  }

  getInstallId(): string {
    return this.state.installId;
  }

  isAppInstalledSent(): boolean {
    return this.state.appInstalledSent;
  }

  isFirstMessageSent(): boolean {
    return this.state.firstMessageSent;
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

  private load(): AnalyticsState {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<AnalyticsState>;
      if (typeof parsed.installId === "string" && parsed.installId.length > 0) {
        return {
          installId: parsed.installId,
          appInstalledSent: parsed.appInstalledSent === true,
          firstMessageSent: parsed.firstMessageSent === true,
        };
      }
    } catch {
      // Missing or malformed file → treat as a fresh install.
    }
    const fresh: AnalyticsState = {
      installId: randomUUID(),
      appInstalledSent: false,
      firstMessageSent: false,
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
