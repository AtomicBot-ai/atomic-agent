import { ToolRegistry } from "./tool-registry.js";
import { finishTool } from "./finish.js";
import { replyTool } from "./conversation/index.js";

export { ToolRegistry, ToolNotFoundError } from "./tool-registry.js";
export type { ToolContext, ToolDefinition } from "./tool-registry.js";
export { finishTool } from "./finish.js";
export { replyTool } from "./conversation/index.js";

/**
 * Default registry with the conversation terminals (`reply`, `finish`).
 * Browser, OS and skill tools are registered by their respective builders
 * (see `src/tools/browser/`, `src/tools/os/`, `src/skills/`).
 */
export function buildDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(finishTool);
  registry.register(replyTool);
  return registry;
}
