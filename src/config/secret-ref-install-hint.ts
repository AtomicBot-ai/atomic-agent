/**
 * A human hint for a secret reference whose password-manager CLI is
 * missing (ATO-2756): "op was not found" alone does not say that the
 * 1Password CLI has to be installed. The hint comes first; the raw
 * detail stays after it in parentheses for a bug report.
 */
const CLI_HELP: Readonly<Record<string, { product: string; url: string; signIn: string }>> = {
  op: {
    product: "the 1Password CLI (op)",
    url: "https://developer.1password.com/docs/cli/get-started/",
    signIn: "sign in",
  },
  bw: {
    product: "the Bitwarden CLI (bw)",
    url: "https://bitwarden.com/help/cli/",
    signIn: "log in",
  },
};

/**
 * The message for `name` when `program` was not found or could not
 * start; null for a program with no known install page (the user's own
 * `cmd://` helper), so the caller keeps its plain message.
 */
export function missingCliMessage(
  name: string,
  program: string,
  failure: "not-found" | "could-not-run",
): string | null {
  const help = CLI_HELP[program];
  if (help === undefined) return null;
  const detail = failure === "not-found" ? `${program} was not found` : `${program} could not run`;
  const what =
    failure === "not-found"
      ? `${help.product} is not installed or not on PATH`
      : `${help.product} could not start; check that it is installed`;
  return `${name}: ${what}. Install it and ${help.signIn}: ${help.url} (${detail})`;
}
