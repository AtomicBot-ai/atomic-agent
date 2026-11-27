import { ConfigValidationError } from "./config-validation-error.js";

/**
 * Roles a non-owner Telegram user can hold (ATO-2221). Only `guest`
 * today: a guest may talk to the bot in a group (still mention-gated),
 * gets read-only tools, and every approval for a guest's turn goes to
 * the owner. The owner itself stays `telegram.ownerUserId` and is never
 * listed here.
 */
export type TelegramAllowedUserRole = "guest";

/** One entry of `telegram.allowedUsers`. */
export interface TelegramAllowedUser {
  /** Numeric Telegram user id. */
  userId: number;
  role: TelegramAllowedUserRole;
}

/**
 * Parse `telegram.allowedUsers`. Optional and presence-driven, like
 * `telegram.streamReplies`: an absent key means "no guests", so older
 * files need no migration and no config version bump.
 *
 * Accepts numeric ids as numbers or numeric strings (hand-edited files),
 * drops duplicates (first one wins) and rejects anything else, so a typo
 * fails loudly instead of letting the wrong account in.
 */
export function parseTelegramAllowedUsers(
  raw: unknown,
  field: string,
): TelegramAllowedUser[] {
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError(
      field,
      `expected an array of { userId, role }, got ${JSON.stringify(raw)}`,
    );
  }
  const seen = new Set<number>();
  const result: TelegramAllowedUser[] = [];
  for (let i = 0; i < raw.length; i++) {
    const at = `${field}[${i}]`;
    const entry: unknown = raw[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ConfigValidationError(
        at,
        `expected { userId, role }, got ${JSON.stringify(entry)}`,
      );
    }
    const record = entry as Record<string, unknown>;
    const userId = parseUserId(record.userId, `${at}.userId`);
    const role = parseRole(record.role, `${at}.role`);
    if (seen.has(userId)) continue;
    seen.add(userId);
    result.push({ userId, role });
  }
  return result;
}

function parseUserId(raw: unknown, field: string): number {
  const value =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new ConfigValidationError(
      field,
      `expected a positive integer Telegram user id, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

function parseRole(raw: unknown, field: string): TelegramAllowedUserRole {
  // Absent role means guest: it is the only role, and the least powerful.
  if (raw === undefined || raw === "guest") return "guest";
  throw new ConfigValidationError(
    field,
    `expected "guest", got ${JSON.stringify(raw)}`,
  );
}
