/**
 * `{{secret:NAME}}` in a command the model writes (ATO-476).
 *
 * The model never holds a secret's value: it writes the placeholder, the
 * human approves the command with the placeholder in it, and only the
 * process that starts gets the value, substituted after approval. What
 * the transcript, the trace and the approval card keep is the call as the
 * model wrote it. Precedent: 1Password `op run`, which resolves `op://`
 * references only in the child's environment.
 *
 * Fail closed:
 * - a placeholder-like text that is not a valid placeholder
 *   (`{{secret:}}`, `{{secret:a-b}}`) is an error, not passed through;
 * - in a command line a shell reads (`sh -c`, `cmd.exe /c`), a value
 *   holding anything but plain token characters is refused, since the
 *   shell would read it as syntax. Direct argv takes any value.
 */

/** A valid placeholder; `NAME` is an env-style name. */
const PLACEHOLDER = /\{\{\s*secret:([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
/** Anything that starts like one. */
const PLACEHOLDER_START = /\{\{\s*secret:/g;
/**
 * What a shell reads literally outside quotes on every platform it runs
 * on here: no `$`, quotes, spaces, `%`, `^`, `!`, `~`, `,`, globs or brackets.
 */
const SHELL_SAFE_VALUE = /^[A-Za-z0-9_+=:./@-]+$/;

export class SecretPlaceholderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretPlaceholderError";
  }
}

/**
 * The secret names `texts` refer to, in first-use order, without
 * duplicates. Throws `SecretPlaceholderError` on a malformed placeholder.
 */
export function secretPlaceholderNames(texts: readonly string[]): string[] {
  const names: string[] = [];
  for (const text of texts) {
    if (!text.includes("secret:")) continue;
    const starts = [...text.matchAll(PLACEHOLDER_START)].length;
    const valid = [...text.matchAll(PLACEHOLDER)];
    if (valid.length !== starts) {
      throw new SecretPlaceholderError(
        "a secret placeholder must be written {{secret:NAME}}, NAME made of letters, digits and _",
      );
    }
    for (const match of valid) {
      const name = match[1]!;
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/**
 * `text` with every placeholder replaced by its value from `values`.
 * `shell: true` for a line a shell will parse. Throws
 * `SecretPlaceholderError` for a name missing from `values` or a value
 * the shell would misread; the message names the secret, never the value.
 */
export function substituteSecretPlaceholders(
  text: string,
  values: ReadonlyMap<string, string>,
  options: { shell: boolean },
): string {
  if (!text.includes("secret:")) return text;
  return text.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = values.get(name);
    if (value === undefined) throw new SecretPlaceholderError(`unknown secret ${name}`);
    if (options.shell && !SHELL_SAFE_VALUE.test(value)) {
      throw new SecretPlaceholderError(
        `secret ${name} holds characters a shell would read as syntax; pass it as its own argument (cmd plus args, no shell operators) instead`,
      );
    }
    return value;
  });
}
