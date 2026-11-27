/**
 * ATO-1716: an imported provider never brings its `apiKeyCommand`.
 *
 * `apiKeyCommand` is not a value but a program this app runs on the first
 * request to that provider (`llm/provider/openai/api-key-command.ts`).
 * Copied as is from another data folder, a tampered `config.json` would
 * make the import run any command it names, for example one that prints
 * another provider's key to a `baseUrl` of the file's choosing. So the
 * command is dropped whatever the secrets option says, and the report
 * says how to put it back after the person has looked at it.
 *
 * Precedent: Claude Code does not run an `apiKeyHelper` from project
 * settings before the folder is trusted; git does not run hooks or
 * `core.fsmonitor` from a repository it did not create; VS Code keeps
 * workspace tasks off until the workspace is trusted. The shared setup
 * import already drops the command the same way
 * (`setup-share/known-provider-env.ts` `stripUnknownKeySources`).
 */

/** Remove `apiKeyCommand` from one provider entry (mutated); true when there was one. */
export function dropApiKeyCommand(entry: Record<string, unknown>): boolean {
  if (!("apiKeyCommand" in entry)) return false;
  delete entry.apiKeyCommand;
  return true;
}

/**
 * The report reason for an imported provider: what did not come along
 * and, for a dropped key command, how to add it back by hand. Empty when
 * the provider came over whole.
 */
export function providerImportReason(
  id: string,
  sourceConfigPath: string,
  dropped: { keyless: boolean; droppedCommand: boolean },
): { reason?: string } {
  const parts: string[] = [];
  if (dropped.keyless) parts.push("without its API key (secrets off)");
  if (dropped.droppedCommand) {
    parts.push(
      `without its apiKeyCommand, a program the agent would run: check it in ${sourceConfigPath}, ` +
        `then if you trust it add "apiKeyCommand" to provider "${id}" yourself, ` +
        "in the file `atomic-agent config path` prints",
    );
  }
  return parts.length > 0 ? { reason: parts.join("; ") } : {};
}
