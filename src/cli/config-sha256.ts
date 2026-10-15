/**
 * Compare-and-swap flags for `atomic-agent config` (ATO-416).
 *
 * The desktop app and the terminal agent share one state dir, so both
 * write the same `config.json`. A client that reads the file, edits its
 * copy and writes it back would silently revert whatever the other wrote
 * in between. The read side, `config get --with-sha256`, prints
 * `{"sha256": "<hex>", "config": {...}}` from one read of the file; the
 * write side, `config set - --expect-sha256 <hex>`, writes only while the
 * file still hashes to `<hex>`, and otherwise exits with
 * `CONFIG_CHANGED_EXIT_CODE` and `CONFIG_CHANGED_MESSAGE` on stderr, so
 * the client re-reads and re-applies its edit.
 */

export const WITH_SHA256_FLAG = "--with-sha256";
export const EXPECT_SHA256_FLAG = "--expect-sha256";

/** Exit code of a `set` refused because the file changed since it was read. */
export const CONFIG_CHANGED_EXIT_CODE = 3;
/** The exact stderr line of that refusal; clients may match on it. */
export const CONFIG_CHANGED_MESSAGE = "config changed since it was read";

const SHA256_HEX = /^[0-9a-f]{64}$/i;

export type ExpectSha256Parse =
  | { ok: true; args: string[]; expected: string | null }
  | { ok: false; error: string };

/**
 * Pull `--expect-sha256 <hex>` (or `--expect-sha256=<hex>`) out of the
 * `set` arguments. `expected` is `null` when the flag is absent; the
 * remaining arguments are returned in order. The flag applies only to
 * the stdin form, `set -`: the JSON-argument form can be split across
 * argv by the shell, which makes a flag among its pieces ambiguous, and
 * the desktop — the client this exists for — writes through stdin.
 */
export function takeExpectSha256(args: string[]): ExpectSha256Parse {
  const rest: string[] = [];
  let expected: string | null = null;
  let seen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    let value: string | undefined;
    if (arg === EXPECT_SHA256_FLAG) {
      value = args[i + 1];
      i++;
    } else if (arg.startsWith(`${EXPECT_SHA256_FLAG}=`)) {
      value = arg.slice(EXPECT_SHA256_FLAG.length + 1);
    } else {
      rest.push(arg);
      continue;
    }
    if (seen) return { ok: false, error: `${EXPECT_SHA256_FLAG} given twice` };
    seen = true;
    if (value === undefined || !SHA256_HEX.test(value)) {
      return {
        ok: false,
        error: `${EXPECT_SHA256_FLAG} needs a 64-character hex sha256 (from \`config get ${WITH_SHA256_FLAG}\`)`,
      };
    }
    expected = value.toLowerCase();
  }
  if (seen && !(rest.length === 1 && rest[0] === "-")) {
    return {
      ok: false,
      error: `${EXPECT_SHA256_FLAG} applies only to \`config set -\` (the JSON read from stdin)`,
    };
  }
  return { ok: true, args: rest, expected };
}
