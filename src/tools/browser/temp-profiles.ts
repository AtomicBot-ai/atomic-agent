import type { Browser as PwBrowser, BrowserContext as PwBrowserContext } from "playwright-core";

/**
 * Which profile a session browses in (ATO-959):
 *
 * - `"agent"`: the agent's own Chrome profile, with the logins it keeps.
 * - `"temp"`: a throwaway, logged-out profile of the session's own. It is
 *   a separate browser context in the same Chrome (like an incognito
 *   window): no cookies, storage or logins from the agent's profile, and
 *   nothing of it is written to disk. It is gone when its context closes.
 */
export type BrowserProfileChoice = "agent" | "temp";

export const BROWSER_PROFILE_CHOICES: readonly BrowserProfileChoice[] = ["agent", "temp"];

/** A throwaway context's cookies and local storage, kept in memory only. */
export type TempProfileState = Awaited<ReturnType<PwBrowserContext["storageState"]>>;

/** One throwaway profile as it was before a Chrome restart (`snapshot` / `restore`). */
export interface TempProfileSnapshot {
  sessionId: string;
  state: TempProfileState | null;
  urls: string[];
}

/** Throwaway profiles kept open at once; the least recently used closes first. */
export const MAX_TEMP_PROFILES = 4;
/** Sessions whose per-call choice is remembered (oldest forgotten first). */
const MAX_REMEMBERED_CHOICES = 256;

/**
 * The throwaway profiles of one browser: a context per session, opened on
 * first use and closed when the session's last tab in it closes, when more
 * than {@link MAX_TEMP_PROFILES} are open (oldest first), or with the
 * browser. Also remembers each session's latest `profile` choice.
 */
export class TempProfiles {
  private readonly contexts = new Map<string, PwBrowserContext>();
  private readonly choices = new Map<string, BrowserProfileChoice>();

  constructor(private readonly maxOpen = MAX_TEMP_PROFILES) {}

  /** A session's latest choice, else `fallback` (the `browser.profile` setting). */
  choiceFor(sessionId: string, fallback: BrowserProfileChoice): BrowserProfileChoice {
    return this.choices.get(sessionId) ?? fallback;
  }

  choose(sessionId: string, choice: BrowserProfileChoice): void {
    this.choices.delete(sessionId);
    this.choices.set(sessionId, choice);
    while (this.choices.size > MAX_REMEMBERED_CHOICES) {
      this.choices.delete(this.choices.keys().next().value as string);
    }
  }

  /** The session's throwaway context, opened in `browser` when it has none. */
  async open(
    browser: PwBrowser,
    sessionId: string,
    state?: TempProfileState | null,
  ): Promise<PwBrowserContext> {
    const existing = this.contexts.get(sessionId);
    if (existing) {
      this.contexts.delete(sessionId);
      this.contexts.set(sessionId, existing);
      return existing;
    }
    const context = await browser.newContext(state ? { storageState: state } : undefined);
    this.contexts.set(sessionId, context);
    while (this.contexts.size > this.maxOpen) {
      const [oldestId, oldest] = this.contexts.entries().next().value as [string, PwBrowserContext];
      this.contexts.delete(oldestId);
      await oldest.close().catch(() => undefined);
    }
    return context;
  }

  /** Close the session's throwaway profile once it has no tab left. */
  async closeIfEmpty(sessionId: string): Promise<void> {
    const context = this.contexts.get(sessionId);
    if (!context || context.pages().some((page) => !page.isClosed())) return;
    this.contexts.delete(sessionId);
    await context.close().catch(() => undefined);
  }

  /** Close the session's context now, tabs and all (a fusion worker ended). */
  async close(sessionId: string): Promise<void> {
    const context = this.contexts.get(sessionId);
    if (!context) return;
    this.contexts.delete(sessionId);
    await context.close().catch(() => undefined);
  }

  /** Open tabs across every context here (for `browser.maxTabs`). */
  tabCount(): number {
    let count = 0;
    for (const context of this.contexts.values()) count += context.pages().filter((page) => !page.isClosed()).length;
    return count;
  }

  isTemp(context: PwBrowserContext): boolean {
    for (const open of this.contexts.values()) if (open === context) return true;
    return false;
  }

  get openCount(): number {
    return this.contexts.size;
  }

  /**
   * Every open throwaway profile, oldest first: its cookies and local
   * storage (in memory, never on disk) and its web tabs. Taken before the
   * agent's Chrome restarts with a window, so `restore` can bring the
   * session back where it was (a take over in a logged-out chat, ATO-508).
   */
  async snapshot(): Promise<TempProfileSnapshot[]> {
    const out: TempProfileSnapshot[] = [];
    for (const [sessionId, context] of this.contexts) {
      const urls = context
        .pages()
        .filter((page) => !page.isClosed())
        .map((page) => page.url())
        .filter((url) => /^https?:/i.test(url));
      const state = await context.storageState().catch(() => null);
      out.push({ sessionId, state, urls });
    }
    return out;
  }

  /**
   * Reopen what `snapshot` took in a new `browser`: each session's context
   * with its cookies and storage, and its tabs at the same URLs. A tab that
   * fails to load stays open on its URL; nothing here throws.
   */
  async restore(browser: PwBrowser, snapshots: readonly TempProfileSnapshot[]): Promise<void> {
    for (const snap of snapshots) {
      if (snap.urls.length === 0) continue;
      const context = await this.open(browser, snap.sessionId, snap.state).catch(() => null);
      if (!context) continue;
      for (const url of snap.urls) {
        const page = await context.newPage().catch(() => null);
        if (page) await page.goto(url).catch(() => undefined);
      }
    }
  }

  /** Close every throwaway profile (the browser is going away). */
  async closeAll(): Promise<void> {
    const open = [...this.contexts.values()];
    this.contexts.clear();
    await Promise.all(open.map((context) => context.close().catch(() => undefined)));
  }
}
