import type { CompressedToolResult } from "../compressor/result-compressor.js";

export interface ToolContext {
  /** Working directory for OS tools and relative path resolution. */
  workingDir: string;
  sessionId: string;
  stepIndex: number;
  signal: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  readonly: boolean;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<CompressedToolResult>;
}

export class ToolNotFoundError extends Error {
  constructor(name: string) {
    super(`tool not registered: ${name}`);
    this.name = "ToolNotFoundError";
  }
}

/**
 * Tool registry: the agent loop calls `invoke()` and the registry takes
 * care of dispatch. Individual tools live in their own files and are
 * registered explicitly (no dynamic discovery).
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(definition: ToolDefinition): void {
    this.tools.set(definition.name, definition);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolNotFoundError(name);
    return tool;
  }

  async invoke(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<CompressedToolResult> {
    const tool = this.get(name);
    return tool.run(args, ctx);
  }
}
