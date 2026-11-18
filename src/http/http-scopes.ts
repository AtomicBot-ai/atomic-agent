/**
 * ATO-583 (first slice): what a caller of the HTTP API may do.
 *
 * Every authenticated route needs one scope; a named token carries a role,
 * and a role is a fixed set of scopes. Modelled on OpenClaw's operator
 * scopes and AnythingLLM's admin / manager / default roles:
 *
 *  - `read`:  look at chats, tasks, memory, settings that hold no secret.
 *  - `chat`:  run and steer turns, answer the agent's approvals and
 *             questions, create and run tasks.
 *  - `admin`: change settings, skills, MCP servers, memory, webhooks,
 *             channels; delete chats; read the config file.
 *
 * The serve API key (`--api-key` / `ATOMIC_AGENT_API_KEY`) is always
 * `admin`, so a server with no named tokens behaves exactly as before.
 */
export type HttpScope = "read" | "chat" | "admin";

export const HTTP_SCOPES: readonly HttpScope[] = ["read", "chat", "admin"];

export type HttpRole = "admin" | "member" | "viewer";

export const HTTP_ROLES: readonly HttpRole[] = ["admin", "member", "viewer"];

export const ROLE_SCOPES: Readonly<Record<HttpRole, readonly HttpScope[]>> = {
  admin: ["read", "chat", "admin"],
  member: ["read", "chat"],
  viewer: ["read"],
};

export function isHttpRole(value: unknown): value is HttpRole {
  return typeof value === "string" && (HTTP_ROLES as readonly string[]).includes(value);
}

export function roleHasScope(role: HttpRole, scope: HttpScope): boolean {
  return ROLE_SCOPES[role].includes(scope);
}

/** `"POST /api/config"`: how a route is named in the scope table and in errors. */
export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/**
 * The scope each authenticated route of `buildRouteTable` needs. Pinned by
 * `http-scopes.test.ts`: a new authenticated route without an entry here,
 * or an entry for a route that is gone, fails that test. A route that is
 * missing at runtime anyway (a test server's own routes) needs `admin`.
 */
export const ROUTE_SCOPES: Readonly<Record<string, HttpScope>> = {
  "GET /metrics": "read",
  // Turns.
  "POST /v1/chat/completions": "chat",
  "POST /v1/chat/completions/{completion_id}/cancel": "chat",
  "POST /v1/messages": "chat",
  "POST /v1/messages/count_tokens": "chat",
  "POST /v1/responses": "chat",
  "POST /api/ag-ui": "chat",
  "POST /api/complete": "chat",
  "POST /api/context-preview": "chat",
  "GET /api/capabilities": "read",
  "GET /api/model-tiers": "read",
  // Settings.
  "GET /api/config": "admin",
  "PATCH /api/config": "admin",
  "PUT /api/config": "admin",
  "GET /api/skills": "read",
  "GET /api/skills/{name}": "read",
  "POST /api/skills/install": "admin",
  "POST /api/skills/uninstall": "admin",
  "GET /api/project-trust": "read",
  "POST /api/project-trust": "admin",
  "POST /api/mcp/servers/{name}/restart": "admin",
  "POST /api/mcp/servers/{name}/enable": "admin",
  "POST /api/mcp/servers/{name}/disable": "admin",
  "POST /api/mcp/servers/{name}/auth/start": "admin",
  "GET /api/mcp/servers/{name}/auth": "admin",
  "POST /api/mcp/servers/{name}/auth/signout": "admin",
  "GET /api/coding-mode": "read",
  "POST /api/coding-mode": "admin",
  "GET /api/offline-mode": "read",
  "POST /api/offline-mode": "admin",
  "POST /api/local-model/recheck": "admin",
  "POST /api/llm/active": "admin",
  "POST /api/memory/embeddings/reconnect": "admin",
  // Sessions.
  "GET /api/sessions": "read",
  "GET /api/sessions/search": "read",
  "GET /api/sessions/{id}": "read",
  "DELETE /api/sessions/{id}": "admin",
  "PATCH /api/sessions/{id}": "chat",
  "POST /api/sessions/{id}/compact": "chat",
  "GET /api/sessions/{id}/compaction": "read",
  "GET /api/sessions/{id}/export": "read",
  "POST /api/sessions/{id}/working-dir": "chat",
  "GET /api/sessions/{id}/goal": "read",
  "POST /api/sessions/{id}/goal": "chat",
  "GET /api/sessions/{id}/next-step": "read",
  "POST /api/sessions/{id}/archived": "chat",
  "POST /api/sessions/{id}/rollback-last-turn": "chat",
  "GET /api/sessions/{id}/rewind-points": "read",
  "POST /api/sessions/{id}/rewind/preview": "chat",
  "POST /api/sessions/{id}/rewind": "chat",
  "POST /api/sessions/{id}/fork": "chat",
  "POST /api/sessions/{id}/fs/restore": "chat",
  "POST /api/sessions/{id}/resume": "chat",
  "POST /api/sessions/{id}/steer": "chat",
  "GET /api/sessions/{id}/steer": "read",
  "DELETE /api/sessions/{id}/steer": "chat",
  "GET /api/sessions/{id}/fusion/workers": "read",
  "POST /api/sessions/{id}/fusion/workers/{taskId}/stop": "chat",
  "POST /api/sessions/{id}/fusion/workers/{taskId}/steer": "chat",
  "POST /api/sessions/{id}/fusion/workers/{taskId}/escalate": "chat",
  // Approvals and questions: the person running a turn answers them.
  "POST /api/approval/resolve": "chat",
  "GET /api/events": "read",
  "POST /api/question/answer": "chat",
  "GET /api/approval-rules": "read",
  "DELETE /api/approval-rules/{id}": "admin",
  // Memory: the owner's notes and profile.
  "GET /api/memory/notes": "read",
  "PATCH /api/memory/notes/{id}": "admin",
  "DELETE /api/memory/notes/{id}": "admin",
  "GET /api/memory/profile": "read",
  "GET /api/memory/profile/{key}/history": "read",
  "PATCH /api/memory/profile/{key}": "admin",
  "DELETE /api/memory/profile/{key}": "admin",
  "GET /api/memory/changes": "read",
  "POST /api/memory/changes/{id}/restore": "admin",
  "POST /api/memory/profile/{key}/restore": "admin",
  // Channels.
  "POST /api/telegram/pairing": "admin",
  "GET /api/telegram/pairing": "admin",
  "DELETE /api/telegram/pairing": "admin",
  "GET /api/telegram/channel": "read",
  // Tasks and ideas.
  "POST /api/tasks": "chat",
  "GET /api/tasks": "read",
  "GET /api/tasks/{id}": "read",
  "DELETE /api/tasks/{id}": "chat",
  "POST /api/tasks/{id}/run": "chat",
  "POST /api/tasks/{id}/pause": "chat",
  "POST /api/tasks/{id}/resume": "chat",
  "GET /api/tasks/{id}/runs": "read",
  "POST /api/tasks/drain": "chat",
  "POST /api/tasks/wake": "chat",
  "GET /api/ideas": "read",
  "POST /api/ideas/refresh": "chat",
  "POST /api/ideas/{id}/accept": "chat",
  "POST /api/ideas/{id}/dismiss": "chat",
  // Webhooks: the list shows bindings and their settings.
  "GET /api/webhooks": "admin",
  "POST /api/webhooks/{name}": "chat",
  "POST /api/webhooks": "admin",
  "DELETE /api/webhooks/{name}": "admin",
};

/** The scope a route needs; `admin` for one the table does not know. */
export function scopeForRoute(method: string, path: string): HttpScope {
  return ROUTE_SCOPES[routeKey(method, path)] ?? "admin";
}
