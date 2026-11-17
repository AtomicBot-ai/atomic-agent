import { ASK_USER_TOOL } from "../../approval/user-question.js";

/**
 * Which turns are offered `ask_user` (ATO-489). A question is only
 * useful where a person sees it as a card and can pick an answer, so
 * the tool is listed only for surfaces that draw one:
 *   - the TUI (`tui`) and the headless CLI (`cli`, also a turn that
 *     names no origin), which answer it in the composer / prompt;
 *   - Telegram (`telegram`), one button per option;
 *   - an HTTP client that declares it can show questions
 *     (`X-Atomic-Questions` on an extensions request, `questions: true`).
 *
 * Hidden everywhere else: the desktop app (the sidecar, and an HTTP
 * extensions client that does not declare the flag) has no question
 * card yet, so its Allow button would be refused and the turn would
 * wait forever; a plain OpenAI client, Discord, scheduled tasks and
 * fusion workers have nobody who can answer.
 *
 * TODO(ATO-1502): once the desktop draws the question card, drop the
 * desktop hide (`answerChannel === "desktop"` / `sidecar` below) or
 * have the desktop send `X-Atomic-Questions: 1`.
 *
 * Takes the origin as a plain string so `src/tools` does not import
 * from `src/runtime`.
 */
export function surfaceShowsQuestions(input: {
  origin?: string;
  answerChannel?: string;
  /** The client said it can (true) or cannot (false) show a question card. */
  questions?: boolean;
}): boolean {
  if (input.questions !== undefined) return input.questions;
  // The desktop app, however it reached the turn (ATO-1502 removes this).
  if (input.answerChannel === "desktop") return false;
  switch (input.origin ?? "cli") {
    case "tui":
    case "cli":
    case "telegram":
      return true;
    default:
      return false;
  }
}

/**
 * The turn's tool filter with `ask_user` hidden when the surface cannot
 * show a question. A surface that can gets the caller's filter back
 * untouched (`undefined` stays `undefined`).
 */
export function withAskUserVisibility(
  filter: ((name: string) => boolean) | undefined,
  showsQuestions: boolean,
): ((name: string) => boolean) | undefined {
  if (showsQuestions) return filter;
  return filter
    ? (name) => name !== ASK_USER_TOOL && filter(name)
    : (name) => name !== ASK_USER_TOOL;
}
