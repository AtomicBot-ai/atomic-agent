/**
 * Which profile facts name the user, and whether the user ever said
 * that name.
 *
 * A name is the one fact a small model reliably invents: older builds
 * stored `name = Анна` for a user who never typed it in any of 56
 * sessions, and the agent then greeted her as Анна. Name-like facts
 * therefore carry a grounding status (`profile_facts.name_grounding`),
 * and only a name the user's own messages vouch for reaches the prompt.
 */

const NAME_KEY =
  /^(?:user_|my_)?(?:full_|first_|last_|given_|family_|preferred_|display_|real_|nick_?)?name$|^(?:nickname|username|user_name|alias|handle|user_handle|user_identity|identity)$/;

/** `true` when a profile key names the user (`name`, `full_name`, …). */
export function isNameProfileKey(key: string): boolean {
  return NAME_KEY.test(key.toLowerCase());
}

/**
 * How a name-like fact compares with the user's own messages:
 *  - `grounded`     — some user message carries the name (or the user
 *    answered "yes" to the assistant asking for it);
 *  - `ungrounded`   — no stored user message does: the name was
 *    invented, and is kept on disk but never rendered;
 *  - `unverifiable` — the user writes in a script the check cannot
 *    compare with the stored spelling; fails open, like reflection.
 * `null` on a row means "not checked yet" (a row an older build wrote,
 * or one written before the startup check ran).
 */
export type NameGroundingStatus = "grounded" | "ungrounded" | "unverifiable";

export function isNameGroundingStatus(value: unknown): value is NameGroundingStatus {
  return value === "grounded" || value === "ungrounded" || value === "unverifiable";
}

/**
 * Whether a fact may go into `### profile` (and so into the vote
 * allowlist and reflection's view of the profile). Every non-name fact
 * may; a name-like fact only once a check has vouched for it — an
 * unchecked one waits for the startup check rather than greet the user
 * with a name nobody verified.
 */
export function isProfileFactPromptVisible(fact: {
  key: string;
  nameGrounding?: NameGroundingStatus | null;
}): boolean {
  if (!isNameProfileKey(fact.key)) return true;
  return fact.nameGrounding === "grounded" || fact.nameGrounding === "unverifiable";
}

/**
 * Short marker for listings (`memory.profile.list`, `/memory`) — `null`
 * for a fact that needs none.
 */
export function nameGroundingMarker(fact: {
  key: string;
  nameGrounding?: NameGroundingStatus | null;
}): string | null {
  if (!isNameProfileKey(fact.key)) return null;
  switch (fact.nameGrounding ?? null) {
    case "ungrounded":
      return "unconfirmed: the user never wrote this name; not used until they confirm it";
    case null:
      return "not checked yet: not used until it is";
    default:
      return null;
  }
}
