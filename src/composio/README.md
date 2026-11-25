# Composio integration

Status: current
Owner: src/composio/

Resolves hosted toolkits into an MCP server configuration/session. Keep provider credentials scoped and use the MCP client lifecycle rather than bypassing registry trust.

Entry point: [resolve-composio-server.ts](resolve-composio-server.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

## Several accounts per toolkit (ATO-548)

`composio.accounts` names connected accounts with a short local alias (`work`, `home`; lowercase letters, digits and `-`, up to 32 characters, unique per toolkit) and can mark one per toolkit as the default. Defaults are pinned on the tool-router session as `connected_accounts`, so every call for that toolkit acts through that account; a toolkit with no default is not pinned and Composio uses the most recently connected one, as it always did. `sessionPins` stamps the cached session with its pins, so changing a default makes the next mount create a new session. [composio-accounts.ts](composio-accounts.ts) holds the edits, [composio-accounts-api.ts](composio-accounts-api.ts) lists the user's connected accounts, [persist-composio-session.ts](persist-composio-session.ts) writes the list.

`atomic-agent composio accounts list|add|remove|default` ([../cli/composio-command.ts](../cli/composio-command.ts), ATO-1494) is the command-line face of these helpers. While Composio is mounted, the `### integrations` prompt block adds one line naming the account each app acts through (`buildComposioAccountsGuidance` in [../prompt/composio-guidance.ts](../prompt/composio-guidance.ts)); no named accounts, no line.

Checks: `npx vitest run src/composio` when tests are present; `npm run lint`; `npm run docs:check`.
