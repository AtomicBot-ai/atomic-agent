import type { TelegramSessionPointer } from "./telegram-session-pointer.js";
import { telegramGuestChatKey } from "./telegram-session-pointer.js";

/**
 * The owner's `/new` in a group also starts the guests' conversation
 * over (ATO-2703).
 *
 * Guests talk to the group's own guest session (`<chat>#guests`,
 * ATO-2221). Before this, `/new` rotated only the owner's pointer, so a
 * guest history the owner wanted gone (a derailed or poisoned chat)
 * stayed until a `/switch`. The guest pointer is rotated the same way
 * as the owner's: the old session is archived in the pointer's history
 * and the next guest message creates a fresh guest session. As for the
 * owner's, a guest turn still running keeps its approval binding until
 * it settles (`releaseIfMovedOn` drops it then).
 *
 * Precedent: OpenClaw's `/new` in a group resets that group's session,
 * whoever was talking in it.
 */
export interface GuestSessionResetContext {
  sessionPointer: Pick<TelegramSessionPointer, "get" | "rotate">;
  inflight: Pick<Map<string, AbortController>, "has">;
  releaseApprovalSession?: (sessionId: string) => void;
}

/**
 * Rotate the guest session of the group whose chat key is `chatKey`.
 * Returns the archived guest session id, or `undefined` when the group
 * had none.
 */
export function rotateGuestSession(
  chatKey: string,
  ctx: GuestSessionResetContext,
): string | undefined {
  const guestKey = telegramGuestChatKey(chatKey);
  const previous = ctx.sessionPointer.get(guestKey).current;
  if (!previous) return undefined;
  ctx.sessionPointer.rotate(guestKey);
  if (!ctx.inflight.has(guestKey)) ctx.releaseApprovalSession?.(previous);
  return previous;
}
