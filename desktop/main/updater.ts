/**
 * ATO-229 — app updates, asked for, never done behind the person's back.
 *
 * The rules (product owner, 05.10):
 *  - Nothing is downloaded or installed without a click. `electron-updater`
 *    runs with autoDownload and autoInstallOnAppQuit both off.
 *  - The app looks for a newer version ~10 s after its window is up, then
 *    every 6 h, while "Check for updates automatically" is on (the default).
 *    A newer one is a toast at the top right: Update / Not now, and a small
 *    "Skip this version". Not now asks again on the next start; Skip never
 *    asks about that version again.
 *  - Update downloads with progress in the same toast (Cancel stops it), then
 *    offers Restart to update / Later. Later installs nothing on quit: only a
 *    Restart click (toast or Settings) does.
 *  - No restart while an agent turn runs: Restart then waits for the answer
 *    to finish, and says so.
 *  - A failed automatic check is quiet. Its result is shown only in
 *    Settings › General, and only after Check now.
 *
 * Where the feed is: electron-builder writes `app-update.yml` into the app's
 * resources when the build had a feed (ATAG_UPDATE_FEED_URL, see
 * desktop/electron-builder.cjs). A build without one has no such file, and
 * the updater stays off: Settings says "Updates are not set up for this
 * build". So does a dev run.
 *
 * The person's choices live in Electron userData/updates.json, beside the
 * sidebar's prefs.json — never in the agent's config.json.
 *
 * TEST ONLY — `--fake-update=<version>` makes every check find that version
 * (when it is newer than this build) without the network, fakes the download
 * progress, and makes Restart record the install instead of quitting. The
 * smoke (main/smoke-tasks/t65.ts) drives the same fake through the test hooks
 * at the bottom of this file.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { app } from "electron";

import * as A from "./analytics/index.js";

type UpdaterModule = typeof import("electron-updater");
type AppUpdater = import("electron-updater").AppUpdater;
type UpdateInfo = import("electron-updater").UpdateInfo;
type CancellationToken = import("electron-updater").CancellationToken;

/** First automatic check, after the window is up. */
export const FIRST_CHECK_DELAY_MS = 10_000;
/** Then every 6 h while the app runs. */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** While Restart waits for a running turn, how often it looks again. */
const TURN_POLL_MS = 2_000;

export type UpdatePhase =
  /** Nothing found (or not looked yet). */
  | "idle"
  | "checking"
  /** A newer version is known; nothing downloaded. */
  | "available"
  | "downloading"
  /** Downloaded; installs on Restart only. */
  | "ready"
  /** Restart was clicked while a turn runs: installs when it ends. */
  | "waiting"
  /** quitAndInstall was called (in the fake: recorded instead). */
  | "installing";

export type CheckResult =
  | { kind: "up-to-date"; version: string }
  | { kind: "available"; version: string }
  | { kind: "error"; reason: "offline" | "no-feed" | "other"; message: string };

/** What the renderer draws from: the toast and Settings › General. */
export interface UpdateState {
  /** False: this build has no feed, is a dev run, or an install type that cannot update itself. */
  enabled: boolean;
  /** Why not, in plain words, when `enabled` is false. */
  disabledText: string | null;
  autoCheck: boolean;
  currentVersion: string;
  channel: string;
  phase: UpdatePhase;
  /** The newer version, once one is known. */
  version: string | null;
  /** One line of its release notes, if the feed has any. */
  notes: string | null;
  /** 0–100 while downloading. */
  percent: number | null;
  /** Whether the toast is up. */
  toast: boolean;
  /** A turn of this window's chats is running: Restart says it will wait. */
  turnRunning: boolean;
  /** A download that failed, in plain words (shown in the toast and Settings). */
  downloadError: string | null;
  /** The last Check now, for Settings. Automatic checks never fill this. */
  manualCheck: { at: number; result: CheckResult } | null;
  /** True while Check now runs. */
  manualChecking: boolean;
  /** `--fake-update` / the smoke's fake. */
  fake: boolean;
}

/** userData/updates.json. */
export interface UpdatePrefs {
  autoCheck: boolean;
  skippedVersion: string | null;
  lastDismissed: { version: string; at: number } | null;
  /** Written just before quitAndInstall; read on the next start for update_installed. */
  pendingInstall: { from: string; to: string; at: number } | null;
}

const PREFS_DEFAULT: UpdatePrefs = { autoCheck: true, skippedVersion: null, lastDismissed: null, pendingInstall: null };

export function updatePrefsPath(): string {
  return join(app.getPath("userData"), "updates.json");
}

const VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/;

function cleanVersion(v: unknown): string | null {
  return typeof v === "string" && VERSION_RE.test(v.trim()) ? v.trim() : null;
}

export function coerceUpdatePrefs(raw: unknown): UpdatePrefs {
  const out: UpdatePrefs = { ...PREFS_DEFAULT };
  if (!raw || typeof raw !== "object") return out;
  const src = raw as Record<string, unknown>;
  if (typeof src.autoCheck === "boolean") out.autoCheck = src.autoCheck;
  out.skippedVersion = cleanVersion(src.skippedVersion);
  const d = src.lastDismissed as { version?: unknown; at?: unknown } | null | undefined;
  const dv = cleanVersion(d?.version);
  if (dv && typeof d?.at === "number" && Number.isFinite(d.at)) out.lastDismissed = { version: dv, at: d.at };
  const p = src.pendingInstall as { from?: unknown; to?: unknown; at?: unknown } | null | undefined;
  const pf = cleanVersion(p?.from);
  const pt = cleanVersion(p?.to);
  if (pf && pt && typeof p?.at === "number" && Number.isFinite(p.at)) out.pendingInstall = { from: pf, to: pt, at: p.at };
  return out;
}

export function readUpdatePrefs(): UpdatePrefs {
  try {
    return coerceUpdatePrefs(JSON.parse(readFileSync(updatePrefsPath(), "utf8")));
  } catch {
    return { ...PREFS_DEFAULT };
  }
}

function writeUpdatePrefs(prefs: UpdatePrefs): void {
  try {
    const path = updatePrefsPath();
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(coerceUpdatePrefs(prefs)));
    renameSync(tmp, path);
  } catch (err) {
    console.error(`[updater] could not save updates.json: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** -1, 0, 1 for two `x.y.z[-pre]` versions; a prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core = "", pre = ""] = v.split("-", 2);
    return { nums: core.split(".").map((n) => Number(n) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

/** One plain line of release notes: the first non-empty line, tags and markdown marks stripped. */
export function firstNotesLine(notes: unknown): string | null {
  let text = "";
  if (typeof notes === "string") text = notes;
  else if (Array.isArray(notes)) {
    const first = notes.find((n) => n && typeof (n as { note?: unknown }).note === "string" && (n as { note: string }).note.trim());
    text = first ? (first as { note: string }).note : "";
  }
  if (!text) return null;
  const plain = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|h\d|div)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  for (const raw of plain.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, "").replace(/[*_`]/g, "").trim();
    if (line) return line.length > 160 ? `${line.slice(0, 157).trimEnd()}…` : line;
  }
  return null;
}

/** A failed check or download, in plain words. */
export function plainUpdateError(err: unknown): { reason: "offline" | "no-feed" | "other"; message: string } {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  if (/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_CONNECTION|ERR_TIMED_OUT|ERR_PROXY|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|socket hang up/i.test(text)) {
    return { reason: "offline", message: "Couldn’t reach the update server. Check your internet connection and try again." };
  }
  if (/\b404\b|Cannot find channel|Cannot find latest|app-update\.yml|ENOENT/i.test(text)) {
    return { reason: "no-feed", message: "No update information was found for this build." };
  }
  return { reason: "other", message: "Couldn’t check for updates. Try again later." };
}

/** Reads `channel:` from the app-update.yml electron-builder wrote (no YAML parser needed for one key). */
function feedChannel(file: string): string {
  try {
    const m = /^channel:\s*["']?([A-Za-z0-9_-]+)["']?\s*$/m.exec(readFileSync(file, "utf8"));
    return m?.[1] ?? "latest";
  } catch {
    return "latest";
  }
}

export interface UpdaterDeps {
  /** `--fake-update=<version>`, or null. */
  fakeVersion: string | null;
  /** A smoke run: no automatic schedule (nothing goes to the network). */
  smoke: boolean;
  /** Push the state to the window. */
  send: (state: UpdateState) => void;
  /** A turn of this window's chats runs now (cheap, synchronous: the Restart label). */
  turnRunningHere: () => boolean;
  /** Any turn the agent runs: this window's, Telegram's, a task's (asked before installing). */
  turnRunningAnywhere: () => Promise<boolean>;
  /** Stop the agent and the model server before the installer starts (Windows, Linux). */
  prepareQuit: () => Promise<void>;
}

type Disabled = { text: string } | null;

export class AppUpdateController {
  private readonly deps: UpdaterDeps;
  private prefs: UpdatePrefs;
  private readonly currentVersion: string;
  private readonly channel: string;
  /** app-update.yml in the app's resources, when packaged. */
  private readonly feed: string | null;
  private disabled: Disabled;
  private fakeVersion: string | null;
  private mod: UpdaterModule | null = null;
  private updater: AppUpdater | null = null;

  private phase: UpdatePhase = "idle";
  private version: string | null = null;
  private notes: string | null = null;
  private percent: number | null = null;
  private toast = false;
  /** The version Not now / Cancel / Later put away for this session. */
  private dismissedThisSession: string | null = null;
  private downloadError: string | null = null;
  private manualCheck: { at: number; result: CheckResult } | null = null;
  private manualChecking = false;
  private checking: Promise<CheckResult> | null = null;
  private token: CancellationToken | null = null;
  private cancelRequested = false;
  private fakeTimer: ReturnType<typeof setInterval> | null = null;
  private waitTimer: ReturnType<typeof setInterval> | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private everyTimer: ReturnType<typeof setInterval> | null = null;
  private installAsking = false;

  /* Test hooks (the smoke). */
  private fakeTurnBusy: boolean | null = null;
  fakeInstalls = 0;

  constructor(deps: UpdaterDeps) {
    this.deps = deps;
    this.prefs = readUpdatePrefs();
    this.currentVersion = app.getVersion();
    this.fakeVersion = deps.fakeVersion;
    this.feed = app.isPackaged ? join(process.resourcesPath, "app-update.yml") : null;
    this.channel = this.feed && existsSync(this.feed) ? feedChannel(this.feed) : "stable";
    this.disabled = this.whyDisabled(this.feed);
    this.reportInstalled();
  }

  private whyDisabled(feed: string | null): Disabled {
    if (this.fakeVersion) return null;
    if (!feed || !existsSync(feed)) return { text: "Updates are not set up for this build." };
    // electron-updater updates a Linux AppImage, not a .deb (that one comes from the package manager).
    if (process.platform === "linux" && !process.env.APPIMAGE) {
      return { text: "This install updates through your package manager." };
    }
    return null;
  }

  /** The update that was being installed when the app last quit: it landed when this build is that version. */
  private reportInstalled(): void {
    const p = this.prefs.pendingInstall;
    if (!p) return;
    if (compareVersions(this.currentVersion, p.to) === 0) A.track("update_installed", { version: p.to, from_version: p.from });
    this.prefs.pendingInstall = null;
    writeUpdatePrefs(this.prefs);
  }

  get fake(): boolean {
    return this.fakeVersion !== null;
  }

  state(): UpdateState {
    return {
      enabled: this.disabled === null,
      disabledText: this.disabled?.text ?? null,
      autoCheck: this.prefs.autoCheck,
      currentVersion: this.currentVersion,
      channel: this.channel,
      phase: this.phase,
      version: this.version,
      notes: this.notes,
      percent: this.percent,
      toast: this.toast,
      turnRunning: this.turnRunningHere(),
      downloadError: this.downloadError,
      manualCheck: this.manualCheck,
      manualChecking: this.manualChecking,
      fake: this.fake,
    };
  }

  private emit(): void {
    try {
      this.deps.send(this.state());
    } catch {
      /* a window that is going away */
    }
  }

  private turnRunningHere(): boolean {
    if (this.fakeTurnBusy !== null) return this.fakeTurnBusy;
    try {
      return this.deps.turnRunningHere();
    } catch {
      return false;
    }
  }

  private async turnRunningAnywhere(): Promise<boolean> {
    if (this.fakeTurnBusy !== null) return this.fakeTurnBusy;
    try {
      return this.turnRunningHere() || (await this.deps.turnRunningAnywhere());
    } catch {
      return this.turnRunningHere();
    }
  }

  /** main's chat listener: a turn began or ended (the Restart label, and a waiting install). */
  turnsChanged(): void {
    if (this.phase === "ready" || this.phase === "waiting") this.emit();
  }

  /* ---------------------------------------------------------------- schedule */

  /** Called once the window is on screen. */
  start(): void {
    if (this.disabled || this.firstTimer) return;
    // A smoke run reaches no network on its own; its check drives the fake itself.
    if (this.deps.smoke) return;
    this.firstTimer = setTimeout(() => void this.autoCheck(), FIRST_CHECK_DELAY_MS);
    this.everyTimer = setInterval(() => void this.autoCheck(), CHECK_EVERY_MS);
  }

  stop(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.everyTimer) clearInterval(this.everyTimer);
    if (this.waitTimer) clearInterval(this.waitTimer);
    if (this.fakeTimer) clearInterval(this.fakeTimer);
    this.firstTimer = this.everyTimer = this.waitTimer = this.fakeTimer = null;
  }

  /** The timer's check: nothing when the switch is off; quiet on failure. */
  async autoCheck(): Promise<void> {
    if (this.disabled || !this.prefs.autoCheck) return;
    await this.check("auto");
  }

  /** Settings' Check now. */
  async checkNow(): Promise<UpdateState> {
    if (this.disabled) return this.state();
    this.manualChecking = true;
    this.emit();
    const result = await this.check("manual");
    this.manualChecking = false;
    this.manualCheck = { at: Date.now(), result };
    this.emit();
    return this.state();
  }

  /* ------------------------------------------------------------------- check */

  private check(trigger: "auto" | "manual"): Promise<CheckResult> {
    // Past the check already: the answer is what is in hand.
    if (this.phase === "downloading" || this.phase === "ready" || this.phase === "waiting" || this.phase === "installing") {
      return Promise.resolve({ kind: "available", version: this.version ?? this.currentVersion });
    }
    if (this.checking) return this.checking;
    const run = async (): Promise<CheckResult> => {
      const before = this.phase;
      // A toast already up stays as it is (its Update keeps working) while the feed is read again.
      if (before === "idle") this.phase = "checking";
      if (trigger === "manual") this.emit();
      try {
        const found = await this.lookUp();
        // Update was clicked while the feed was read again: the download owns the state now.
        if (this.phase !== "checking" && this.phase !== "available") {
          return { kind: "available", version: this.version ?? this.currentVersion };
        }
        if (!found || compareVersions(found.version, this.currentVersion) <= 0) {
          this.phase = "idle";
          this.toast = false;
          return { kind: "up-to-date", version: this.currentVersion };
        }
        const isNew = found.version !== this.version;
        this.version = found.version;
        this.notes = firstNotesLine(found.releaseNotes);
        this.phase = "available";
        this.downloadError = null;
        if (isNew) A.track("update_available", { version: found.version, trigger });
        const skipped = this.prefs.skippedVersion === found.version;
        const putAway = this.dismissedThisSession === found.version;
        if (!skipped && !putAway) this.toast = true;
        return { kind: "available", version: found.version };
      } catch (err) {
        if (this.phase === "checking") this.phase = before === "checking" ? "idle" : before;
        const plain = plainUpdateError(err);
        console.error(`[updater] check failed (${trigger}): ${err instanceof Error ? err.message : String(err)}`);
        return { kind: "error", reason: plain.reason, message: plain.message };
      } finally {
        this.checking = null;
        this.emit();
      }
    };
    this.checking = run();
    return this.checking;
  }

  /** The newest version the feed (or the fake) names, or null when there is no answer. */
  private async lookUp(): Promise<{ version: string; releaseNotes: unknown } | null> {
    if (this.fakeVersion) {
      await new Promise((r) => setTimeout(r, 300));
      return { version: this.fakeVersion, releaseNotes: "Smoother model downloads and fixes for long chats." };
    }
    const updater = this.ensureUpdater();
    const res = await updater.checkForUpdates();
    const info: UpdateInfo | undefined = res?.updateInfo;
    return info && cleanVersion(info.version) ? { version: info.version, releaseNotes: info.releaseNotes } : null;
  }

  private ensureUpdater(): AppUpdater {
    if (this.updater) return this.updater;
    // Loaded on first use: a build without a feed never touches it.
    this.mod ??= require("electron-updater") as UpdaterModule;
    const u = this.mod.autoUpdater;
    u.autoDownload = false;
    u.autoInstallOnAppQuit = false;
    u.allowPrerelease = false;
    u.allowDowngrade = false;
    u.logger = {
      info: (m?: unknown) => console.log(`[updater] ${String(m)}`),
      warn: (m?: unknown) => console.warn(`[updater] ${String(m)}`),
      error: (m?: unknown) => console.error(`[updater] ${String(m)}`),
      debug: () => undefined,
    };
    /* Every error is also a rejected promise this file handles; the event
       matters only where there is no promise: Squirrel.Mac taking the
       download, or refusing it at quitAndInstall. */
    u.on("error", (err: Error) => {
      if (this.phase === "downloading") this.downloadFailed(err);
      else if (this.phase === "installing") this.installFailed(err);
    });
    u.on("download-progress", (p: { percent?: number }) => {
      if (this.phase !== "downloading") return;
      this.percent = Math.max(0, Math.min(100, Math.floor(typeof p?.percent === "number" ? p.percent : 0)));
      this.emit();
    });
    u.on("update-downloaded", () => {
      if (this.phase === "downloading") this.downloaded();
    });
    this.updater = u;
    return u;
  }

  /* ---------------------------------------------------------------- the toast */

  /** Not now: away until the next start (persisted for the record only). */
  dismiss(): UpdateState {
    if (this.version) {
      this.dismissedThisSession = this.version;
      this.prefs.lastDismissed = { version: this.version, at: Date.now() };
      writeUpdatePrefs(this.prefs);
      A.track("update_dismissed", { version: this.version, via: "not_now" });
    }
    this.toast = false;
    this.downloadError = null;
    this.emit();
    return this.state();
  }

  /** Skip this version: never asked about it again. */
  skip(): UpdateState {
    if (this.version) {
      this.prefs.skippedVersion = this.version;
      writeUpdatePrefs(this.prefs);
      A.track("update_skipped", { version: this.version });
    }
    this.toast = false;
    this.downloadError = null;
    this.emit();
    return this.state();
  }

  /** Settings' switch. */
  setAutoCheck(on: boolean): UpdateState {
    this.prefs.autoCheck = on;
    writeUpdatePrefs(this.prefs);
    this.emit();
    return this.state();
  }

  /* ---------------------------------------------------------------- download */

  async download(): Promise<UpdateState> {
    if (this.disabled || !this.version) return this.state();
    if (this.phase !== "available") return this.state();
    A.track("update_accepted", { version: this.version });
    this.phase = "downloading";
    this.percent = 0;
    this.toast = true;
    this.downloadError = null;
    this.cancelRequested = false;
    this.emit();
    if (this.fakeVersion) {
      this.fakeDownload();
      return this.state();
    }
    try {
      const updater = this.ensureUpdater();
      this.token = new (this.mod as UpdaterModule).CancellationToken();
      await updater.downloadUpdate(this.token);
      if (this.phase === "downloading") this.downloaded();
    } catch (err) {
      if (this.cancelRequested) return this.state();
      if (this.phase === "downloading") this.downloadFailed(err);
    } finally {
      this.token = null;
    }
    return this.state();
  }

  private fakeDownload(): void {
    if (this.fakeTimer) clearInterval(this.fakeTimer);
    this.fakeTimer = setInterval(() => {
      if (this.phase !== "downloading") {
        if (this.fakeTimer) clearInterval(this.fakeTimer);
        this.fakeTimer = null;
        return;
      }
      this.percent = Math.min(100, (this.percent ?? 0) + 7);
      if (this.percent >= 100) {
        if (this.fakeTimer) clearInterval(this.fakeTimer);
        this.fakeTimer = null;
        this.downloaded();
        return;
      }
      this.emit();
    }, 120);
  }

  private downloaded(): void {
    this.phase = "ready";
    this.percent = 100;
    this.emit();
  }

  private downloadFailed(err: unknown): void {
    console.error(`[updater] download failed: ${err instanceof Error ? err.message : String(err)}`);
    const plain = plainUpdateError(err);
    this.phase = "available";
    this.percent = null;
    this.downloadError = plain.reason === "offline"
      ? "The download stopped. Check your internet connection and try again."
      : "The update could not be downloaded. Try again later.";
    this.emit();
  }

  /** Cancel during the download: back to "available", the toast away for this session. */
  cancel(): UpdateState {
    if (this.phase !== "downloading") return this.state();
    this.cancelRequested = true;
    try {
      this.token?.cancel();
    } catch {
      /* already settled */
    }
    if (this.fakeTimer) clearInterval(this.fakeTimer);
    this.fakeTimer = null;
    this.phase = "available";
    this.percent = null;
    this.toast = false;
    if (this.version) {
      this.dismissedThisSession = this.version;
      A.track("update_dismissed", { version: this.version, via: "cancel" });
    }
    this.emit();
    return this.state();
  }

  /* ----------------------------------------------------------------- install */

  /** Later: the toast goes; nothing installs until Restart is clicked (toast or Settings). */
  later(): UpdateState {
    if (this.phase === "waiting") this.stopWaiting();
    if (this.version) {
      this.dismissedThisSession = this.version;
      A.track("update_dismissed", { version: this.version, via: "later" });
    }
    this.toast = false;
    this.emit();
    return this.state();
  }

  /** Restart: now when no turn runs, else as soon as the running one ends. */
  async install(): Promise<UpdateState> {
    if ((this.phase !== "ready" && this.phase !== "waiting") || this.installAsking) return this.state();
    // The agent's /health can take a moment: a second click meanwhile is the same click.
    this.installAsking = true;
    let busy: boolean;
    try {
      busy = await this.turnRunningAnywhere();
    } finally {
      this.installAsking = false;
    }
    // Later was clicked while the agent answered: nothing to do.
    if (this.phase !== "ready" && this.phase !== "waiting") return this.state();
    if (busy) {
      if (this.phase !== "waiting") {
        this.phase = "waiting";
        this.toast = true;
        this.emit();
        this.waitTimer = setInterval(() => void this.retryInstall(), TURN_POLL_MS);
      }
      return this.state();
    }
    await this.installNow();
    return this.state();
  }

  private async retryInstall(): Promise<void> {
    if (this.phase !== "waiting") return this.stopWaiting();
    if (await this.turnRunningAnywhere()) return;
    this.stopWaiting();
    await this.installNow();
  }

  private stopWaiting(): void {
    if (this.waitTimer) clearInterval(this.waitTimer);
    this.waitTimer = null;
    if (this.phase === "waiting") this.phase = "ready";
  }

  private async installNow(): Promise<void> {
    if (!this.version) return;
    this.phase = "installing";
    this.toast = true;
    this.emit();
    if (this.fakeVersion) {
      // The fake installs nothing and quits nothing: the smoke reads this count.
      this.fakeInstalls += 1;
      return;
    }
    this.prefs.pendingInstall = { from: this.currentVersion, to: this.version, at: Date.now() };
    writeUpdatePrefs(this.prefs);
    try {
      /* Windows: the installer starts at once and replaces the agent's and the
         model server's files, so both stop first. macOS: Squirrel replaces
         the app only after it has quit, and quitting stops both as usual
         (before-quit); stopping them here would leave the app without its
         agent if Squirrel then refused the update. */
      if (process.platform !== "darwin") await this.deps.prepareQuit();
      // Silent installer on Windows (the person already said yes), and the app starts again after it.
      this.ensureUpdater().quitAndInstall(true, true);
    } catch (err) {
      this.installFailed(err);
    }
  }

  /* On Windows the agent may already be stopped by now (prepareQuit), so the
     honest way on is a fresh start of the app, which offers the update again. */
  private installFailed(err: unknown): void {
    console.error(`[updater] install failed: ${err instanceof Error ? err.message : String(err)}`);
    this.prefs.pendingInstall = null;
    writeUpdatePrefs(this.prefs);
    this.phase = "ready";
    this.toast = true;
    this.downloadError = "The update could not be installed. Quit and open Atomic Agent again to retry.";
    this.emit();
  }

  /* ------------------------------------------------------------- test hooks */

  /** The smoke: a fake feed (or none), the toast state reset, the session choices forgotten. */
  testReset(fakeVersion: string | null): void {
    this.stop();
    this.fakeVersion = fakeVersion;
    this.disabled = this.whyDisabled(this.feed);
    this.phase = "idle";
    this.version = null;
    this.notes = null;
    this.percent = null;
    this.toast = false;
    this.dismissedThisSession = null;
    this.downloadError = null;
    this.manualCheck = null;
    this.manualChecking = false;
    this.checking = null;
    this.fakeTurnBusy = null;
    this.fakeInstalls = 0;
    this.prefs = readUpdatePrefs();
    this.emit();
  }

  /** The smoke's last step: the launch's own fake (or none) again, and a clean state. */
  testRestore(): void {
    this.testReset(this.deps.fakeVersion);
  }

  /** The smoke: a turn runs (true), none runs (false), or the real answer (null). */
  testTurnBusy(busy: boolean | null): void {
    this.fakeTurnBusy = busy;
    this.turnsChanged();
  }

  /** The smoke: a new app start, as far as the session's choices go. */
  testNewSession(): void {
    this.dismissedThisSession = null;
    this.prefs = readUpdatePrefs();
  }

  testPrefs(): UpdatePrefs {
    return { ...this.prefs };
  }
}

let controller: AppUpdateController | null = null;

export function initAppUpdater(deps: UpdaterDeps): AppUpdateController {
  controller ??= new AppUpdateController(deps);
  return controller;
}

/** The one controller, once main has made it (null before app.whenReady). */
export function appUpdater(): AppUpdateController | null {
  return controller;
}

/** `--fake-update=<version>` (test only), or null. */
export function fakeUpdateArg(argv: readonly string[] = process.argv): string | null {
  const hit = argv.find((a) => a.startsWith("--fake-update="));
  return hit ? cleanVersion(hit.slice("--fake-update=".length)) : null;
}
