import { readFileSync, statSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { loadEnabledPlugins } from "./plugin-runtime.js";
import { isPartDisabled } from "./plugin-store.js";

/**
 * A subagent profile from a plugin's `agents/*.md` (Claude format:
 * frontmatter `name`, `description`, `tools`, `model`; body = system prompt).
 * A Fusion task can name one as `plugin:agent` (ATO-566, see
 * `src/agent-profiles/`); the Plugins screen lists them.
 */
export interface PluginSubagentProfile {
  /** `plugin:agent` */
  name: string;
  plugin: string;
  description: string;
  /** Tool names as the plugin wrote them (Claude names); a hint, never a grant. */
  tools: string[];
  model?: string;
  prompt: string;
  file: string;
}

const MAX_AGENT_BYTES = 128 * 1024;

export function parseSubagentFile(content: string, fallbackName: string): Omit<PluginSubagentProfile, "plugin" | "file"> {
  const text = content.replace(/\r\n/g, "\n");
  let meta: Record<string, unknown> = {};
  let body = text;
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---", 4);
    if (end !== -1) {
      const parsed = parseYaml(text.slice(4, end));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
      body = text.slice(end + 4).replace(/^\n+/, "");
    }
  }
  const tools = Array.isArray(meta.tools)
    ? meta.tools.filter((t): t is string => typeof t === "string")
    : typeof meta.tools === "string" ? meta.tools.split(",").map(t => t.trim()).filter(Boolean) : [];
  return {
    name: typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : fallbackName,
    description: typeof meta.description === "string" ? meta.description.trim() : "",
    tools,
    ...(typeof meta.model === "string" && meta.model.trim() ? { model: meta.model.trim() } : {}),
    prompt: body,
  };
}

export function listPluginSubagents(stateDir: string): { profiles: PluginSubagentProfile[]; diagnostics: string[] } {
  const profiles: PluginSubagentProfile[] = [];
  const diagnostics: string[] = [];
  for (const { record, bundle } of loadEnabledPlugins(stateDir).plugins) {
    for (const agent of bundle.agents) {
      if (isPartDisabled(record, `agent:${agent.name}`)) continue;
      try {
        if (statSync(agent.file).size > MAX_AGENT_BYTES) throw new Error("larger than 128 KiB");
        const parsed = parseSubagentFile(readFileSync(agent.file, "utf8"), agent.name);
        profiles.push({ ...parsed, name: `${bundle.name}:${parsed.name}`, plugin: bundle.name, file: agent.file });
      } catch (err) {
        diagnostics.push(`plugin ${bundle.name} agent ${agent.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { profiles, diagnostics };
}
