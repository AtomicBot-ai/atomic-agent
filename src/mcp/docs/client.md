# MCP lifecycle, trust and sampling

Status: current
Owner: src/mcp/

McpManager owns configured client lifecycle and dynamic registry entries; restart/shutdown must remove the corresponding tools/catalog. Client transports and SDK usage belong to the client boundary. Per-server trust determines resource classification; third-party schemas cannot be assumed to share built-in flat shapes.

Resources and prompts are discovery/read tools, while sampling forwards an isolated completion rather than taking the main turn's slot. Stdio transport currently inherits every string-valued process.env entry, including bootstrap's state-directory .env, then overlays per-server keys. There is no environment allowlist today; configured subprocesses can therefore see unrelated credentials. Do not claim they are isolated. Preserve credential redaction in stderr/errors and explicit unsupported-operation refusals. Changing environment forwarding is separate behavior work requiring compatibility checks.

The old guide linked a nonexistent mcp-client.test.ts. Use the actual manager/transport and stderr tests below instead. Do not invent a missing test to satisfy a documentation link.

Sources: [manager](../mcp-manager.ts), [client](../mcp-client.ts), [sampling](../mcp-sampling-handler.ts), [trust](../mcp-resource-class.ts). Tests: [manager](../mcp-manager.test.ts), [stderr](../mcp-client-stderr.test.ts), [sampling](../mcp-sampling-handler.test.ts).
