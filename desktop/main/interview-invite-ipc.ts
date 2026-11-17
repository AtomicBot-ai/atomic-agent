/**
 * ATO-1467: the interview invite's routes (rules in interview-invite.ts).
 *
 *   interview:check    {busy, onboarding, error} from the window → true when
 *                      the sidebar card may show now. Asks the PostHog flag
 *                      only when nothing else blocks it, once per launch.
 *   interview:shown    the card is about to show: record it (a show that
 *                      cannot be recorded does not happen) and send
 *                      `interview_invite_shown`. → true when recorded.
 *   interview:open     via menu | card | slash: open the form in the browser,
 *                      `interview_invite_clicked`. The permanent entry: no
 *                      limits, only no id in the link while analytics is off.
 *   interview:dismiss  later | never: `interview_invite_dismissed`; `never`
 *                      is stored for good.
 */

import { ipcMain, shell } from "electron";

import * as A from "./analytics/index.js";
import { flagsStore } from "./analytics/core.js";
import { doNotTrackIn } from "./analytics/environment.js";
import { daysSince } from "./analytics/identity.js";
import {
  fetchInviteFlag, inviteBlockedBy, interviewFormUrl, readInviteState, writeInviteState, type InviteContext,
} from "./interview-invite.js";

export interface InterviewInviteIpcDeps {
  /** The terminal's state dir (`~/.atomic-agent`), shared with it. */
  stateDir: string;
  /** Test seam for the flag check. */
  flag?: (installId: string) => Promise<boolean>;
}

const VIA = new Set(["menu", "card", "slash"]);

function flagOf(v: unknown): boolean {
  return v === true;
}

export function wireInterviewInviteIpc(deps: InterviewInviteIpcDeps): void {
  let flagAnswer: Promise<boolean> | null = null;

  const context = (input: unknown): InviteContext => {
    const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    // sendingAllowed: analytics on and not a test or dev run (those never write the real home).
    const on = A.sendingAllowed();
    return {
      now: Date.now(),
      analyticsEnabled: on,
      doNotTrack: doNotTrackIn(),
      installId: on ? A.installId() : null,
      daysSinceInstall: daysSince(flagsStore()?.get().installedAt ?? null),
      busy: flagOf(o.busy),
      onboarding: flagOf(o.onboarding),
      error: flagOf(o.error),
      state: readInviteState(deps.stateDir),
    };
  };

  ipcMain.handle("interview:check", async (_event, input: unknown) => {
    try {
      const c = context(input);
      if (inviteBlockedBy(c) !== null || !c.installId) return false;
      const id = c.installId;
      flagAnswer ??= (deps.flag ?? ((i: string) => fetchInviteFlag(i)))(id).catch(() => false);
      return (await flagAnswer) === true;
    } catch {
      return false;
    }
  });

  ipcMain.handle("interview:shown", (_event, input: unknown) => {
    try {
      // Checked again: a turn may have started while the flag was asked.
      if (inviteBlockedBy(context(input)) !== null) return false;
      if (writeInviteState(deps.stateDir, { shownAt: [Date.now()], neverAt: null }) === null) return false;
      A.track("interview_invite_shown", { via: "card" });
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle("interview:open", (_event, via: unknown) => {
    try {
      const on = A.sendingAllowed();
      const url = interviewFormUrl({ installId: on ? A.installId() : null, analyticsEnabled: on, doNotTrack: doNotTrackIn() });
      A.track("interview_invite_clicked", { via: typeof via === "string" && VIA.has(via) ? via : "menu" });
      void shell.openExternal(url);
      return url;
    } catch {
      return null;
    }
  });

  ipcMain.handle("interview:dismiss", (_event, reason: unknown) => {
    try {
      const never = reason === "never";
      const saved = never ? writeInviteState(deps.stateDir, { shownAt: [], neverAt: Date.now() }) !== null : true;
      A.track("interview_invite_dismissed", { reason: never ? "never" : "later" });
      return saved;
    } catch {
      return false;
    }
  });
}
