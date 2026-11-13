/**
 * The iMessage channel's own settings, read from the generic
 * `channels.imessage.options` block of `config.json`:
 *
 * ```json
 * { "channels": { "imessage": {
 *     "enabled": true,
 *     "ownerIds": ["+14155551212", "me@icloud.com"],
 *     "options": { "binary": "/opt/homebrew/bin/imsg", "allowGroups": false } } } }
 * ```
 *
 * Unknown keys are ignored so a newer config still loads on an older
 * build. A wrong type is an error the channel reports as `down` on
 * start, rather than a silent fallback to a default the operator did
 * not choose.
 */

export interface ImessageOptions {
  /** `imsg` executable: a name looked up on PATH, or an absolute path. */
  binary: string;
  /** Answer owners in group chats too. Off: direct chats only. */
  allowGroups: boolean;
}

export const IMESSAGE_DEFAULT_BINARY = "imsg";

export function parseImessageOptions(
  options: Readonly<Record<string, string | number | boolean>>,
): { ok: true; value: ImessageOptions } | { ok: false; error: string } {
  const binary = options.binary ?? IMESSAGE_DEFAULT_BINARY;
  if (typeof binary !== "string" || binary.trim().length === 0) {
    return { ok: false, error: "channels.imessage.options.binary must be a non-empty string" };
  }
  const allowGroups = options.allowGroups ?? false;
  if (typeof allowGroups !== "boolean") {
    return { ok: false, error: "channels.imessage.options.allowGroups must be true or false" };
  }
  return { ok: true, value: { binary: binary.trim(), allowGroups } };
}
