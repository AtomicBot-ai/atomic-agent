# Organization policy

Status: draft
Owner: src/policy/

Rules an administrator sets for every agent on a machine (ATO-587): which shell commands, file writes, web requests, skills and MCP servers are allowed, need a person's yes, or are blocked. The user cannot loosen them from the agent.

## Where the policy comes from

Read at start, weakest first. Rules from all sources are evaluated together, so a `deny` in any of them wins.

1. `<stateDir>/policy.json` (usually `~/.atomic-agent/policy.json`).
2. The machine-wide file: macOS `/Library/Application Support/AtomicAgent/policy.json`, Linux `/etc/atomic-agent/policy.json`, Windows `%ProgramData%\AtomicAgent\policy.json`.
3. `ATOMIC_POLICY_URL`: fetched once at start with a 3 s timeout. A good copy is cached in `<stateDir>/policy-cache.json`; when the fetch fails the cached copy for the same URL is used. A policy server that is down never stops the agent.

A missing file is no policy. A broken file is ignored with a warning in the log and shown as `invalid` by `atag policy show`.

## Format

```json
{
  "version": 1,
  "rules": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "shell", "resource": "git status*", "effect": "allow" },
    { "action": "shell", "resource": "rm -rf *", "effect": "deny", "note": "ask IT" },
    { "action": "webfetch", "resource": "https://*.internal.example.com/*", "effect": "deny" },
    { "action": "skill", "resource": "publish-*", "effect": "deny" },
    { "action": "mcp", "resource": "github/delete_*", "effect": "deny" }
  ],
  "mcpAllowlist": { "servers": ["github", "https://mcp.example.com/*"], "warnOnly": false }
}
```

- `action`: `shell` (the command line and each command in it), `edit` (file paths written, moved or trashed), `webfetch` (URLs), `websearch` (the query), `skill` (skill name), `mcp` (`<server>/<tool>`).
- `resource`: glob; `*` is any run of characters including `/`, `?` one character. Default `*`.
- `effect`: for one call the last matching rule wins, except that any matching `deny` wins wherever it sits. `allow` only cancels an earlier `ask` of the policy; it never skips a prompt the user's own settings would show.
- `mcpAllowlist.servers`: globs matched against a server's name, URL or stdio command line. With a list present, a server not on it stays down with the reason as its error. `warnOnly: true` logs it and lets it connect. No list: every server may connect.

## Where it is enforced

- Dispatch (`agent/dispatch/batch-gates.ts`, `refuseByOrgPolicy`): a denied call of any tool is refused before it runs.
- Approval gate (`ApprovalGate.setOrgPolicy`): a policy `deny` or `ask` acts like a saved rule of the user's, above them; `ask` prompts whatever the approval level or session grants say.
- MCP (`McpManagerDeps.serverPolicy`): the allowlist, checked before every connect.
- Skills: `prepareSkillInstall` refuses a denied skill (`policy_denied`, HTTP 403); the registry does not load one.

## Not done yet

`ask` only prompts where the tool already asks the gate: shell commands that need approval, file writes, HTTP requests, gated MCP tools. `os.web.search`, read-only MCP tools and shell commands the guard deems safe honour `deny` but are not prompted on `ask`. The policy is read once per start. No cloud publishing of skills or MCP servers per organization, no admin UI.

## Entry points

- [policy-schema.ts](policy-schema.ts): the file format and its parser.
- [policy-evaluator.ts](policy-evaluator.ts): rule order, deny wins, the MCP allowlist.
- [policy-loader.ts](policy-loader.ts): files, URL, cache.
- [policy-targets.ts](policy-targets.ts): a gate request or a tool call as action and resources.
- [policy-enforce.ts](policy-enforce.ts): answers for the gate, the dispatcher, skills and MCP.
- [policy-active.ts](policy-active.ts): the policy installed at boot.

## Validation

`npx vitest run src/policy src/approval/approval-gate-org-policy.test.ts src/agent/dispatch/batch-gates.test.ts src/mcp/mcp-manager.test.ts src/skills/skill-installer.test.ts src/cli/policy-command.test.ts`; `npm run lint`; `npm run docs:check`.
