/**
 * Which of the agent's own tools `atomic-agent mcp-server` exposes
 * (ATO-549), built from the same tool builders the runtime registers.
 *
 * Read-only by default. `--allow-write` adds the two memory writes and
 * `--allow-exec` adds `os.shell.run`, which keeps its approval gate: the
 * caller hands in a gate whose session policy refuses every request
 * that would prompt, because an MCP client has no way to show one.
 */

import { compressToolResult } from "../compressor/result-compressor.js";
import type { ApprovalGate } from "../approval/approval-gate.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { ProfileStore } from "../memory/profile-store.js";
import type { LessonStore } from "../memory/lessons/lesson-store.js";
import type { ProcedureStore } from "../memory/procedures/procedure-store.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import { ToolRegistry, type ToolDefinition } from "../tools/tool-registry.js";
import {
  buildLessonsRecallTool,
  buildNotesRecallTool,
  buildNotesStoreTool,
  buildProceduresRecallTool,
  buildProfileListTool,
  buildProfileSetTool,
} from "../tools/memory/index.js";
import { buildSkillViewTool } from "../tools/skill/index.js";
import { buildOsShellTool } from "../tools/os/index.js";
import type { ShellJobRegistry } from "../tools/os/index.js";
import { getDefaultArgsJsonSchema } from "../prompt/default-tool-args-schemas.js";
import { McpServerUsageError, type McpServerArgs } from "./mcp-server-args.js";

export const SKILLS_LIST_TOOL = "skills.list";

/** Tools that change something; exposed only with `--allow-write`. */
export const MCP_SERVE_WRITE_TOOLS: readonly string[] = [
  "memory.notes.store",
  "memory.profile.set",
];

/** Tools that run commands; exposed only with `--allow-exec`. */
export const MCP_SERVE_EXEC_TOOLS: readonly string[] = ["os.shell.run"];

export interface McpServeToolDeps {
  /** A store left out means that memory family is off in the config. */
  notesStore?: MemoryStore;
  notesRecallDefaultK: number;
  notesMaxContentChars: number;
  profileStore?: ProfileStore;
  lessonStore?: LessonStore;
  procedureStore?: ProcedureStore;
  skillRegistry: SkillRegistry;
  /** The gate `os.shell.run` asks; see the module comment. */
  approvals: ApprovalGate;
  shell?: {
    defaultTimeoutMs?: number;
    envPassthrough?: readonly string[];
    jobs?: ShellJobRegistry;
  };
}

/** One exposed tool: its MCP name and the JSON Schema of its arguments. */
export interface McpServeTool {
  wireName: string;
  definition: ToolDefinition;
  inputSchema: Record<string, unknown>;
}

export interface McpServeToolSet {
  registry: ToolRegistry;
  tools: McpServeTool[];
  /** MCP name to registry name. */
  byWireName: Map<string, string>;
}

/**
 * MCP name of a registry tool. Dots become underscores: several clients
 * (Claude Code among them) only accept `[A-Za-z0-9_-]` in a tool name.
 */
export function toWireName(name: string): string {
  return name.replace(/\./g, "_");
}

export function buildMcpServeTools(
  args: Pick<McpServerArgs, "allowWrite" | "allowExec" | "tools">,
  deps: McpServeToolDeps,
): McpServeToolSet {
  const candidates: ToolDefinition[] = [];
  if (deps.notesStore) {
    candidates.push(
      buildNotesRecallTool({ store: deps.notesStore, defaultK: deps.notesRecallDefaultK }),
    );
  }
  if (deps.lessonStore) candidates.push(buildLessonsRecallTool({ store: deps.lessonStore }));
  if (deps.procedureStore) {
    candidates.push(buildProceduresRecallTool({ store: deps.procedureStore }));
  }
  if (deps.profileStore) candidates.push(buildProfileListTool({ store: deps.profileStore }));
  candidates.push(buildSkillsListTool(deps.skillRegistry));
  candidates.push(buildSkillViewTool(deps.skillRegistry));

  if (args.allowWrite) {
    if (deps.notesStore) {
      candidates.push(
        buildNotesStoreTool({
          store: deps.notesStore,
          maxContentChars: deps.notesMaxContentChars,
        }),
      );
    }
    if (deps.profileStore) candidates.push(buildProfileSetTool({ store: deps.profileStore }));
  }
  if (args.allowExec) {
    candidates.push(
      buildOsShellTool({
        approvals: deps.approvals,
        // Always through the gate: the level and saved rules decide, and
        // the session's refuse policy answers whatever would prompt.
        approvalRequired: true,
        ...(deps.shell?.defaultTimeoutMs !== undefined
          ? { defaultTimeoutMs: deps.shell.defaultTimeoutMs }
          : {}),
        ...(deps.shell?.envPassthrough !== undefined
          ? { envPassthrough: deps.shell.envPassthrough }
          : {}),
        ...(deps.shell?.jobs !== undefined ? { jobs: deps.shell.jobs } : {}),
      }),
    );
  }

  const selected = narrow(candidates, args.tools);
  const registry = new ToolRegistry();
  const byWireName = new Map<string, string>();
  const tools: McpServeTool[] = [];
  for (const definition of selected) {
    registry.register(definition);
    const wireName = toWireName(definition.name);
    byWireName.set(wireName, definition.name);
    tools.push({ wireName, definition, inputSchema: inputSchemaFor(definition.name) });
  }
  return { registry, tools, byWireName };
}

function narrow(candidates: ToolDefinition[], wanted: readonly string[]): ToolDefinition[] {
  if (wanted.length === 0) return candidates;
  const known = new Map<string, ToolDefinition>();
  for (const c of candidates) {
    known.set(c.name, c);
    known.set(toWireName(c.name), c);
  }
  const picked = new Set<ToolDefinition>();
  for (const name of wanted) {
    const hit = known.get(name);
    if (!hit) {
      throw new McpServerUsageError(
        `--tool ${name}: not available with these flags (available: ${candidates
          .map((c) => toWireName(c.name))
          .join(", ")})`,
      );
    }
    picked.add(hit);
  }
  return candidates.filter((c) => picked.has(c));
}

function inputSchemaFor(name: string): Record<string, unknown> {
  if (name === SKILLS_LIST_TOOL) {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  const schema = getDefaultArgsJsonSchema(name);
  // MCP requires an object schema; an unknown tool takes any object.
  return schema && schema.type === "object" ? schema : { type: "object" };
}

/**
 * `skills.list`: the enabled skills with their descriptions. The agent
 * itself reads this from its prompt catalog, so it has no tool of its
 * own; an MCP client needs one to know what `skill_view` can open.
 */
export function buildSkillsListTool(registry: SkillRegistry): ToolDefinition {
  return {
    name: SKILLS_LIST_TOOL,
    description:
      "List the installed, enabled Atomic Agent skills (name, description, source). Open one with skill_view.",
    readonly: true,
    async run() {
      const skills = registry.list();
      const output =
        skills.length === 0
          ? "(no skills installed)"
          : skills
              .map(
                (s) =>
                  `- ${s.manifest.name}: ${s.manifest.description.replace(/\s+/g, " ").trim()} (${s.source})`,
              )
              .join("\n");
      return compressToolResult(
        {
          tool: SKILLS_LIST_TOOL,
          status: "ok",
          output,
          details: { count: skills.length },
        },
        { maxSummaryLength: 16_000, maxTailLines: 2_000 },
      );
    },
  };
}
