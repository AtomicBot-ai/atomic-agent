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
  async open(browser: PwBrowser, sessionId: string): Promise<PwBrowserContext> {
    const existing = this.contexts.get(sessionId);
    if (existing) {
      this.contexts.delete(sessionId);
      this.contexts.set(sessionId, existing);
      return existing;
    }
    const context = await browser.newContext();
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

  isTemp(context: PwBrowserContext): boolean {
    for (const open of this.contexts.values()) if (open === context) return true;
    return false;
  }

  get openCount(): number {
    return this.contexts.size;
  }

  /** Close every throwaway profile (the browser is going away). */
  async closeAll(): Promise<void> {
    const open = [...this.contexts.values()];
    this.contexts.clear();
    await Promise.all(open.map((context) => context.close().catch(() => undefined)));
  }
}
