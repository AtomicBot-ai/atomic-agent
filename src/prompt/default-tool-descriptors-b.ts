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
    name: "tasks.schedule",
    summary: "Schedule a one-shot task; current session or newSession.",
    argsSchema: "{ userMessage: string, at?: number, inSeconds?: number, newSession?: boolean }",
    examples: [
      '{"userMessage":"check build","inSeconds":300}',
      '{"userMessage":"PR follow-up","at":1735689600000,"newSession":true}',
    ],
    tier: "rare",
  },
  {
    name: "tasks.cron",
    summary: "Recurring cron task; runs in a dedicated persistent session.",
    argsSchema: '{ userMessage: string, expression: string, tz?: string /* IANA */ }',
    examples: ['{"userMessage":"digest","expression":"0 9 * * *","tz":"Europe/Berlin"}'],
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
    name: "reply",
    summary: "Final natural-language answer; ends the macro-turn. Never use to announce a pending action; keep text short (no huge dumps).",
    argsSchema: "{ text: string }",
  },
  {
    name: "finish",
    summary: "End the session with a final summary; only if the user asked to end.",
    argsSchema: "{ summary: string }",
  },
];
