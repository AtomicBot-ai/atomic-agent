/**
 * ATO-1716: an imported provider never brings a key source this app did
 * not choose.
 *
 * `apiKeyCommand` is not a value but a program this app runs on the first
 * request to that provider (`llm/provider/openai/api-key-command.ts`).
 * Copied as is from another data folder, a tampered `config.json` would
 * make the import run any command it names, for example one that prints
 * another provider's key to a `baseUrl` of the file's choosing. The same
 * file could also name this computer's `ANTHROPIC_API_KEY` (or any other
 * key variable) in `apiKeyEnvVar` / `extraApiKeyEnvVars` next to a
 * foreign `baseUrl`, and that key would be sent there. So the importer
 * runs every provider through the shared setup import's filter
 * (`setup-share/known-provider-env.ts` `stripUnknownKeySources`): the
 * command always goes, a key variable name stays only when it is the
 * known one for the entry's endpoint (`GROQ_API_KEY` at api.groq.com).
 * This holds whatever the secrets option says, and the report says how
 * to put the dropped fields back after the person has looked at them.
 *
 * Precedent: Claude Code does not run an `apiKeyHelper` from project
 * settings before the folder is trusted; git does not run hooks or
 * `core.fsmonitor` from a repository it did not create; VS Code keeps
 * workspace tasks off until the workspace is trusted.
 */

/**
 * The report reason for an imported provider: what did not come along
 * and how to add it back by hand. `droppedKeySources` are the field names
 * `stripUnknownKeySources` returned, never their values or command text.
 * Empty when the provider came over whole.
 */
export function providerImportReason(
  id: string,
  sourceConfigPath: string,
  dropped: { keyless: boolean; droppedKeySources: readonly string[] },
): { reason?: string } {
  const parts: string[] = [];
  if (dropped.keyless) parts.push("without its API key (secrets off)");
  const howToAdd =
    `check it in ${sourceConfigPath}, then if you trust it add it to provider "${id}" yourself, ` +
    "in the file `atomic-agent config path` prints";
  if (dropped.droppedKeySources.includes("apiKeyCommand")) {
    parts.push(`without its apiKeyCommand, a program the agent would run: ${howToAdd}`);
  }
  const names = dropped.droppedKeySources.filter((f) => f !== "apiKeyCommand");
  if (names.length > 0) {
    parts.push(
      `without ${names.join(", ")}: the key variable named there is not the known one for this baseUrl, ` +
        `so that key could be sent to it; ${howToAdd}`,
    );
  }
  return parts.length > 0 ? { reason: parts.join("; ") } : {};
}
