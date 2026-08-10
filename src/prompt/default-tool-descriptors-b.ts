import type { ToolDescriptor } from "./stable-prefix.js";

/** Second half of `DEFAULT_TOOL_DESCRIPTORS` (order is load-bearing). */
export const DEFAULT_TOOL_DESCRIPTORS_B: readonly ToolDescriptor[] = [
  {
    name: "os.clipboard.read",
    summary: "Read the system clipboard as text.",
    argsSchema: "{}",
    tier: "rare",
  },
  {
    name: "os.clipboard.write",
    summary: "Write text to the system clipboard.",
    argsSchema: "{ value: string }",
    tier: "rare",
  },
  {
    name: "os.window.list",
    summary: "List window titles. Read-only.",
    argsSchema: "{}",
    tier: "rare",
  },
  {
    name: "os.window.focus",
    summary: "Focus a window by title substring.",
    argsSchema: "{ title: string }",
    tier: "rare",
  },
  {
    name: "os.notify",
    summary: "System notification (title + message).",
    argsSchema: "{ title: string, message: string, sound?: boolean }",
    tier: "rare",
  },
  {
    name: "skill.view",
    summary: "Load an installed skill body (SKILL.md) into the session tail.",
    argsSchema: "{ name: string }",
  },
  {
    name: "tool.view",
    summary: "Load full args schema for a tool listed in `# extras` into `### loaded-tools`.",
    argsSchema: '{ name: string } /* e.g. "os.git.show" */',
  },
  {
    name: "skill.run_script",
    summary: "Run a script from a skill's requires_scripts (may require approval).",
    argsSchema: "{ skill: string, script: string, args?: string[], timeoutMs?: number }",
    tier: "rare",
  },
  {
    name: "memory.profile.set",
    summary: "Upsert a durable user profile fact (pinned vs contextual with keywords).",
    argsSchema:
      "{ key: string, value: string, pinned?: boolean, keywords?: string[] /* required when pinned=false */ }",
    examples: [
      '{"key":"language","value":"ru"}',
      '{"key":"deploy_cmd","value":"pnpm run deploy","pinned":false,"keywords":["deploy","release","ship"]}',
    ],
  },
  {
    name: "memory.profile.remove",
    summary: "Delete a profile fact by key.",
    argsSchema: "{ key: string }",
  },
  {
    name: "memory.profile.list",
    summary: "List all profile facts with metadata. Read-only.",
    argsSchema: "{}",
  },
  {
    name: "memory.profile.history",
    summary: "Return the bi-temporal history of one profile key (oldest first; active value last).",
    argsSchema: "{ key: string }",
    examples: ['{"key":"language"}'],
  },
  {
    name: "memory.notes.store",
    summary: "Store a durable note (triggers: remember, outcomes, preferences; before reply on non-trivial work).",
    argsSchema: "{ content: string /* max 4000 chars */, tags?: string[] /* 1–4 */ }",
    examples: [
      '{"content":"Prefer pnpm; package-lock ignored","tags":["prefs","tooling"]}',
      '{"content":"Fix auth test via Date mock — 8f2a1c9","tags":["bugfix"]}',
    ],
  },
  {
    name: "memory.notes.recall",
    summary: "Search notes or fetch by id (from memory-index pointers).",
    argsSchema:
      "{ query?: string, id?: number, k?: number, scope?: 'project' | 'all', tags?: string[] }",
    examples: [
      '{"query":"pnpm","k":3}',
      '{"query":"flaky login","scope":"project"}',
      '{"id":42}',
    ],
  },
  {
    name: "memory.notes.forget",
    summary: "Delete a note by id (user asked to forget or note obsolete).",
    argsSchema: "{ id: number }",
    tier: "rare",
  },
  {
    name: "memory.lessons.recall",
    summary:
      "Read distilled lessons by id (pointer from `### lessons`) or BM25 query. Returns full principle bodies; the prompt only shows activation pointers.",
    argsSchema: "{ id?: number, query?: string, k?: number /* 1..10 */ }",
    examples: [
      '{"id":42}',
      '{"query":"pnpm install","k":2}',
    ],
  },
  {
    name: "memory.procedures.recall",
    summary:
      "Read advisory how-to procedures by id (pointer from `### procedures`) or BM25 query. Returns ordered steps (description + optional toolHint); the prompt only shows activation pointers. Steps are guidance, not commands — follow them or consciously deviate.",
    argsSchema: "{ id?: number, query?: string, k?: number /* 1..10 */ }",
    examples: [
      '{"id":17}',
      '{"query":"extract typescript function signatures","k":2}',
    ],
  },
  {
    name: "tasks.schedule",
    summary: "Schedule a one-shot task; current session or newSession.",
    argsSchema: '{ userMessage: string, at?: number, inSeconds?: number, newSession?: boolean, notify?: "telegram" }',
    examples: [
      '{"userMessage":"check build","inSeconds":300}',
      '{"userMessage":"PR follow-up","at":1735689600000,"newSession":true}',
    ],
    tier: "rare",
  },
  {
    name: "tasks.cron",
    summary: "Recurring cron task; runs in a dedicated persistent session.",
    argsSchema: '{ userMessage: string, expression: string, tz?: string /* IANA */, notify?: "telegram" /* report result to paired Telegram */ }',
    examples: ['{"userMessage":"digest","expression":"0 9 * * *","tz":"Europe/Berlin","notify":"telegram"}'],
    tier: "rare",
  },
  {
    name: "tasks.list",
    summary: "List tasks (filter by status CSV; optional session). Read-only.",
    argsSchema: "{ status?: string, sessionId?: string, limit?: number }",
    tier: "rare",
  },
  {
    name: "tasks.cancel",
    summary: "Cancel a task by id; idempotent on terminal rows.",
    argsSchema: "{ id: string }",
    tier: "rare",
  },
  {
    name: "tasks.show",
    summary: "One task by id. Read-only.",
    argsSchema: "{ id: string }",
    tier: "rare",
  },
  {
    // `frequent` tier: vision.describe needs the full args schema +
    // examples in the stable prefix so the model first-shots a valid
    // call. `rare` (single-line manifest) led to the model guessing
    // `{paths: [...]}` without `prompt` and burning a step on the
    // schema error before retrying with the right shape.
    name: "vision.describe",
    summary: "Describe one or more images via the configured vision LLM. Only available when the active model + provider support multimodal input.",
    argsSchema:
      "{ prompt: string, path?: string, paths?: string[] /* png|jpg|jpeg|webp|gif */ }",
    examples: [
      '{"path":"./screenshot.png","prompt":"What error is shown?"}',
      '{"paths":["a.png","b.png"],"prompt":"Compare these two diagrams"}',
    ],
  },
  {
    // MCP discovery / resource / prompt tools. The actual MCP tool
    // calls themselves come from the dynamic descriptor builder
    // (see `mcp-descriptor-builder.ts`) and ship at tier `rare`.
    name: "mcp.resource.list",
    summary:
      "List resources exposed by an MCP server. Pass `server` (one of the configured MCP server names) and optional `limit` (1..100, default 30).",
    argsSchema: "{ server: string, limit?: number /* 1..100 */ }",
    tier: "rare",
  },
  {
    name: "mcp.resource.read",
    summary:
      "Read a resource exposed by an MCP server. Pass `server` and the exact `uri` returned by `mcp.resource.list`.",
    argsSchema: "{ server: string, uri: string }",
    tier: "rare",
  },
  {
    name: "mcp.prompt.list",
    summary:
      "List prompt templates exposed by an MCP server. Pass `server` and optional `limit` (1..100, default 30).",
    argsSchema: "{ server: string, limit?: number /* 1..100 */ }",
    tier: "rare",
  },
  {
    name: "mcp.prompt.get",
    summary:
      "Render a prompt template from an MCP server. Pass `server`, `name`, and optional `arguments` (object of string values for the template parameters).",
    argsSchema:
      "{ server: string, name: string, arguments?: Record<string,string> }",
    tier: "rare",
  },
  {
    name: "reply",
    summary: "Final natural-language answer; ends the macro-turn. Never use to announce a pending action; keep text short (no huge dumps). If the task requires an exact answer format or marker, `text` must be ONLY that bare value or marker line — no preamble or commentary.",
    argsSchema: "{ text: string }",
  },
  {
    name: "finish",
    summary: "End the session with a final summary; only if the user asked to end.",
    argsSchema: "{ summary: string }",
  },
];
