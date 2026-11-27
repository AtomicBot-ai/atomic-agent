import type { TelegramAllowedUser } from "../../config/telegram-allowed-users.js";
import type { ToolRegistry } from "../../tools/tool-registry.js";
import type { SenderRole } from "../sender-identity.js";

/**
 * Guests in Telegram groups (ATO-2221).
 *
 * The owner (`telegram.ownerUserId`) drives the bot as before. A user
 * listed in `telegram.allowedUsers` is a guest: heard in a group only
 * (still mention-gated: an @mention, a reply to the bot, `/cmd@bot`),
 * with read-only tools, no memory writes, and every approval routed to
 * the owner. Everyone else is dropped, exactly as before.
 *
 * Precedent: OpenClaw's channel allowlists (mention gating in groups, a
 * per-sender allowlist, a narrower tool policy for non-owner sessions)
 * and Hermes' per-profile approvals in group rooms, where the room can
 * talk to the agent but only the owner approves.
 */

/**
 * Who `fromId` is to this bot, or `null` to drop the message. Fail
 * closed: with no owner configured nobody could approve a guest's
 * request, so guests are refused too; and guests are never heard in a
 * DM (a private-chat allowlist is separate, later work).
 */
export function resolveSenderRole(input: {
  fromId: number;
  isPrivate: boolean;
  ownerUserId: number | null;
  allowedUsers: readonly TelegramAllowedUser[] | undefined;
}): SenderRole | null {
  const { fromId, isPrivate, ownerUserId, allowedUsers } = input;
  if (ownerUserId === null) return null;
  if (fromId === ownerUserId) return "owner";
  if (isPrivate) return null;
  const entry = allowedUsers?.find((u) => u.userId === fromId);
  return entry?.role === "guest" ? "guest" : null;
}

/** True when at least one guest is configured. */
export function hasGuests(
  allowedUsers: readonly TelegramAllowedUser[] | undefined,
): boolean {
  return (allowedUsers?.length ?? 0) > 0;
}

/**
 * Slash commands a guest may run. Only the help text: every other
 * command reads or changes the owner's state (`/status` and `/sessions`
 * list sessions and tasks, `/switch` and `/new` move the chat's session,
 * `/model` switches the provider, `/cron` schedules work, `/cancel`
 * aborts whatever turn runs here, possibly the owner's).
 */
const GUEST_COMMANDS: ReadonlySet<string> = new Set(["/start", "/help"]);

export function isGuestCommandAllowed(verb: string): boolean {
  return GUEST_COMMANDS.has(verb.toLowerCase());
}

/** The plain-text answer a guest gets for any other command. */
export function guestCommandRefusal(verb: string): string {
  return `${verb} is for the bot's owner. As a guest you can ask me questions here; /help lists what I do.`;
}

/**
 * Tools a guest turn may reach, by name, before the read-only check.
 *
 * An allowlist, not "every read-only tool": several read-only tools read
 * the owner's private surfaces (`os.email.inbox`, `os.clipboard.read`,
 * screen capture, `sessions.*` with the owner's other chats, `memory.*`
 * recall, the owner's logged-in browser, MCP resources, `github.*` with
 * the owner's token) and a guest must not see those. A tool added later
 * stays hidden from guests until it is listed here.
 */
const GUEST_TOOL_PREFIXES: readonly string[] = ["os.fs.", "os.git.", "os.web."];
const GUEST_TOOL_NAMES: ReadonlySet<string> = new Set([
  "reply",
  "finish",
  "plan.update",
  "tool.view",
  "tool.search",
  "skill.view",
  "files.search",
  "os.code.search",
  "vision.describe",
  "verify.syntax",
]);

function isGuestListed(name: string): boolean {
  return (
    GUEST_TOOL_NAMES.has(name) ||
    GUEST_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/**
 * `runTurn`'s `toolFilter` for a guest turn: listed above AND declared
 * `readonly` by the registry (so `os.fs.write` stays out even though it
 * matches `os.fs.`). The terminal verbs pass without the registry check:
 * they are how the reply reaches the chat. A name the registry does not
 * know is hidden. The filter is enforced at dispatch as well as in the
 * prompt (`batch-gates.ts`), so a model naming a hidden tool gets a
 * refusal, not a run.
 */
export function guestToolFilter(
  registry: Pick<ToolRegistry, "has" | "get"> | undefined,
): (name: string) => boolean {
  return (name) => {
    if (!isGuestListed(name)) return false;
    if (name === "reply" || name === "finish") return true;
    if (!registry || !registry.has(name)) return false;
    return registry.get(name).readonly === true;
  };
}

/**
 * Extra `runTurn` options for a guest turn: the tool filter above, and
 * memory read-only so a guest's words never become the owner's notes,
 * lessons or profile facts.
 */
export function guestTurnOptions(
  registry: Pick<ToolRegistry, "has" | "get"> | undefined,
): { toolFilter: (name: string) => boolean; memoryReadOnly: true } {
  return { toolFilter: guestToolFilter(registry), memoryReadOnly: true };
}
