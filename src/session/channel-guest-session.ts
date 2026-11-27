import type { SessionState } from "./session-state.js";

/**
 * Sessions that serve a channel's guests (ATO-2221).
 *
 * A Telegram group with configured guests keeps two conversations: the
 * owner's, and one for the guests (`telegram/inbound-handler.ts`). The
 * guest one is a separate session id, so it has its own history and
 * none of the approval or read-scope grants the owner gave in theirs.
 * The stamp below marks it, and the dispatch-time read check
 * (`tools/read-scope/guest-reads.ts`, through `ToolContext.guest`)
 * confines every filesystem read of a stamped session to its working
 * directory, secrets excluded, at every approval level.
 *
 * Set by the channel when it creates the session, never by the agent.
 */
export const CHANNEL_GUEST_METADATA_KEY = "channelGuest";

/** The metadata a guest session is created with. */
export function channelGuestMetadata(): { [CHANNEL_GUEST_METADATA_KEY]: true } {
  return { [CHANNEL_GUEST_METADATA_KEY]: true };
}

/** True when `state` is a channel's guest session. */
export function isChannelGuestSession(
  state: Pick<SessionState, "metadata"> | null | undefined,
): boolean {
  return state?.metadata?.[CHANNEL_GUEST_METADATA_KEY] === true;
}
