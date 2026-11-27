/**
 * Mention detection for Linear comments (ATO-2324).
 *
 * A comment addresses the agent when it names one of the configured
 * handles (`options.mention`, default `agent`). Linear stores a mention
 * in the comment markdown in one of two forms, depending on the client:
 * plain `@handle` text, or a link to the user's profile
 * (`https://linear.app/<org>/profiles/<handle>`, optionally wrapped as
 * `[@Name](...)`). Both count. `@handle` must stand alone: an email
 * address (`me@agent.dev`) or a longer handle (`@agents`) does not match.
 */

const HANDLE_CHARS = "A-Za-z0-9._-";

function escape(handle: string): string {
  return handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function atPattern(handle: string): RegExp {
  // Not preceded by a handle char (emails), not followed by one (longer handles).
  // A trailing `.` is sentence punctuation, not part of the handle.
  return new RegExp(`(?<![${HANDLE_CHARS}])@${escape(handle)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, "gi");
}

function profilePattern(handle: string): RegExp {
  return new RegExp(
    `(?:\\[[^\\]]*\\]\\()?https?://linear\\.app/[A-Za-z0-9_-]+/profiles/${escape(handle)}(?![A-Za-z0-9._-])\\)?`,
    "gi",
  );
}

/** True when `body` mentions any of `handles` (lower-case, no `@`). */
export function mentionsAgent(body: string, handles: readonly string[]): boolean {
  return handles.some((h) => atPattern(h).test(body) || profilePattern(h).test(body));
}

/**
 * The comment text with every mention of `handles` removed and blank
 * runs collapsed: what the agent is asked to do.
 */
export function stripAgentMention(body: string, handles: readonly string[]): string {
  let text = body;
  for (const h of handles) {
    text = text.replace(profilePattern(h), " ").replace(atPattern(h), " ");
  }
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/^[,:]\s*/, "");
}
