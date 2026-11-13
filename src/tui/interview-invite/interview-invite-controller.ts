import {
  buildInterviewFormUrl,
  cachedFeatureFlag,
  INTERVIEW_INVITE_FLAG,
  interviewInviteBlockedBy,
  isDoNotTrackSet,
  readInterviewInviteState,
  recordInviteNever,
  recordInviteShown,
  TERMINAL_INVITE_LINE,
  updateInterviewInviteState,
  type InterviewInviteContext,
  type InterviewInviteVia,
} from "../../analytics/index.js";

/** What the terminal needs from the runtime (both optional on the contract). */
export interface InterviewInviteRuntime {
  interviewInviteIdentity?(): { installId: string; daysSinceInstall: number | undefined } | null;
  reportInterviewInvite?(
    kind: "shown" | "clicked" | "dismissed",
    props: { via?: string; reason?: string },
  ): void;
}

export interface InterviewInviteDeps {
  runtime: InterviewInviteRuntime;
  /** The shared state dir (`~/.atomic-agent`). */
  stateDir: string;
  /** Prints one quiet line in the transcript. */
  emitLine(text: string): void;
  /** Opens the form in the default browser. */
  openUrl(url: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** An agent turn is running right now. */
  isBusy(): boolean;
  /** An error was shown this launch (checked again right before the line). */
  sawError(): boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Test seam for the PostHog flag check. */
  flagEnabled?: (installId: string) => Promise<boolean>;
}

export interface InterviewInviteController {
  /**
   * The rare invite at session start: one quiet line, or nothing. Never
   * during first-run setup (`onboarding`), a turn or an error. Resolves
   * true when the line was shown.
   */
  maybeShowAtStart(input: { onboarding: boolean }): Promise<boolean>;
  /**
   * `/feedback` (the permanent entry, no limits): open the form and print
   * the link, for SSH sessions. `/feedback never` hides the rare invite
   * for good. `origin` is `menu` when the Help menu ran it.
   */
  runFeedback(verb: "open" | "never", origin?: "menu"): Promise<void>;
}

/**
 * The terminal side of the interview invite (ATO-1467). Every rule lives
 * in `src/analytics/interview-invite.ts`; this only reads the live
 * values, asks the flag, prints and records.
 */
export function createInterviewInviteController(deps: InterviewInviteDeps): InterviewInviteController {
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const flagEnabled =
    deps.flagEnabled ??
    ((installId: string) =>
      cachedFeatureFlag({ key: INTERVIEW_INVITE_FLAG, distinctId: installId, env }));
  let bannerShown = false;

  const identity = () => {
    try {
      return deps.runtime.interviewInviteIdentity?.() ?? null;
    } catch {
      return null;
    }
  };

  const report = (kind: "shown" | "clicked" | "dismissed", props: { via?: string; reason?: string }) => {
    try {
      deps.runtime.reportInterviewInvite?.(kind, props);
    } catch {
      // Analytics never breaks the command.
    }
  };

  const context = (onboarding: boolean): InterviewInviteContext => {
    const id = identity();
    return {
      now: now(),
      analyticsEnabled: id !== null,
      doNotTrack: isDoNotTrackSet(env),
      installId: id?.installId ?? null,
      daysSinceInstall: id?.daysSinceInstall,
      busy: deps.isBusy(),
      onboarding,
      error: deps.sawError(),
      state: readInterviewInviteState(deps.stateDir),
    };
  };

  return {
    async maybeShowAtStart({ onboarding }) {
      const before = context(onboarding);
      // Privacy, limits and "not now" first: no flag call unless they pass.
      if (interviewInviteBlockedBy(before) !== null || before.installId === null) return false;
      let on = false;
      try {
        on = await flagEnabled(before.installId);
      } catch {
        on = false;
      }
      if (!on) return false;
      // The flag took a moment: a turn or an error may have started since.
      if (interviewInviteBlockedBy(context(onboarding)) !== null) return false;
      // Recorded before it shows; a show that cannot be recorded does not happen.
      if (updateInterviewInviteState(deps.stateDir, (s) => recordInviteShown(s, now())) === null) {
        return false;
      }
      deps.emitLine(TERMINAL_INVITE_LINE);
      bannerShown = true;
      report("shown", { via: "banner" });
      return true;
    },

    async runFeedback(verb, origin) {
      if (verb === "never") {
        const saved = updateInterviewInviteState(deps.stateDir, (s) => recordInviteNever(s, now()));
        report("dismissed", { reason: "never" });
        deps.emitLine(
          saved === null
            ? "Could not save that. The invite may show again; /feedback never tries once more."
            : "Got it, the invite will not show again. /feedback still opens the form.",
        );
        return;
      }
      const id = identity();
      const url = buildInterviewFormUrl({
        source: "app-terminal",
        installId: id?.installId ?? null,
        analyticsEnabled: id !== null,
        doNotTrack: isDoNotTrackSet(env),
      });
      // Typed after the session's invite line: that line is what sent them.
      const via: InterviewInviteVia = origin === "menu" ? "menu" : bannerShown ? "banner" : "slash";
      report("clicked", { via });
      deps.emitLine(`15 min call with the team, $50 in OpenRouter credits after it. Form: ${url}`);
      const opened = await deps.openUrl(url).catch((err: unknown) => ({
        ok: false as const,
        reason: err instanceof Error ? err.message : String(err),
      }));
      if (!opened.ok) deps.emitLine(`Could not open the browser (${opened.reason}). Open the link above.`);
    },
  };
}
