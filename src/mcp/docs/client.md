# MCP lifecycle, trust and sampling

Status: current
Owner: src/mcp/

McpManager owns configured client lifecycle and dynamic registry entries; restart/shutdown must remove the corresponding tools/catalog. Client transports and SDK usage belong to the client boundary. Per-server `enabledTools` / `disabledTools` drop tools at discovery (`mcp-tool-filter.ts`), so a turned-off tool is absent from the catalog, descriptors, grammar and registry. Per-server trust determines resource classification; third-party schemas cannot be assumed to share built-in flat shapes.

Resources and prompts are discovery/read tools, while sampling forwards an isolated completion rather than taking the main turn's slot. Stdio transport passes only an allowlist of service variables from the agent environment ([mcp-stdio-env.ts](../mcp-stdio-env.ts): PATH, HOME, locale, temp and XDG dirs, display, SSH agent socket, Docker host, Windows profile/system variables such as SystemRoot, APPDATA, USERPROFILE, ComSpec, PATHEXT and PSModulePath, proxies and CA bundles), matched case-insensitively, then overlays the server's configured `env`, which wins. Provider keys and bot tokens loaded from the state-directory .env are not forwarded; a server that needs a key must list it in its own `env`. This is environment hygiene, not a sandbox: the subprocess still runs as the user and can read files the user can. Preserve credential redaction in stderr/errors and explicit unsupported-operation refusals. Do not add credential-shaped names to the allowlist.

The old guide linked a nonexistent mcp-client.test.ts. Use the actual manager/transport and stderr tests below instead. Do not invent a missing test to satisfy a documentation link.

Sources: [manager](../mcp-manager.ts), [client](../mcp-client.ts), [sampling](../mcp-sampling-handler.ts), [trust](../mcp-resource-class.ts). Tests: [manager](../mcp-manager.test.ts), [stderr](../mcp-client-stderr.test.ts), [sampling](../mcp-sampling-handler.test.ts).
