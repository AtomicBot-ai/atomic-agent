import { statSync } from "node:fs";
import type { CompressedToolResult } from "../compressor/result-compressor.js";
import { fullToolResult } from "../compressor/result-compressor.js";
import { readArgumentAliases, withAliasNote } from "./argument-aliases.js";
import { coerceToolArgs } from "./coerce-tool-args.js";
import { resolveUserPath } from "./os/expand-home.js";
import { markUntrustedResult } from "./untrusted-tool-output.js";
import {
  maskErrorSecrets,
  maskResultSecrets,
  UNMASKED_TOOLS,
} from "./tool-output-secrets.js";
import {
  knownSecretsFromEnv,
  type KnownSecret,
} from "../error-reporting/secret-detector.js";
import type { ToolRole } from "./tool-roles.js";
import type { FileReadVersions } from "./os/fs/fs-read-freshness.js";
import type { ToolOutputSpill } from "./tool-output-spill.js";

export interface ToolContext {
  workspaceSkills?: import("../skills/workspace-skills.js").WorkspaceSkills;
  modelMode?: "local" | "cloud";
  /**
   * Context window (tokens) of the model serving this step, when known.
   * `browser.*` picks its page view and size from it (ATO-956).
   */
  contextWindowTokens?: number;
  /** Working directory for OS tools and relative path resolution. */
  workingDir: string;
  sessionId: string;
  stepIndex: number;
  signal: AbortSignal;
  /**
   * The turn's tool role (`tool-roles.ts`), when the step knows it.
   * `tool.view` reads it to tell a tool that is already described in
   * full for this role (nothing to load) from one outside the role
   * (load it). Absent ⇒ `full`.
   */
  toolRole?: ToolRole;
  /**
   * Absolute paths the user named in this session's own messages
   * (`userNamedPaths`, `src/tools/read-scope/`), recomputed by the step
   * from the transcript. Under `agent.readScope: "working-dir"` a read
   * may go under any of these as well as under `workingDir`. Absent ⇒
   * nothing named.
   */
  readRoots?: readonly string[];
  /**
   * This session's texts that may vouch for a name the user gave —
   * their own messages (`groundingTextsOf`, `src/memory/name-grounding.ts`),
   * recomputed by the step from the transcript. `memory.profile.set`
   * checks a name against them before writing one (ATO-200). Absent ⇒
   * the step did not compute them; the tool then relies on the stored
   * sessions alone.
   */
  userGroundingTexts?: readonly string[];
  /**
   * The provider id this step's completions are pinned to
   * (`StepDependencies.providerId` — a fusion worker runs on the local
   * leg). Absent ⇒ the step runs on the active text provider. Read by
   * tools that call a model themselves (`vision.describe`) so they talk
   * to the provider serving the step, not the one active at boot.
   */
  providerId?: string;
  /**
   * What `os.fs.read` last saw of each file this turn, so `os.fs.write`,
   * `os.fs.edit` and `os.fs.patch` can say when their target changed
   * since (`fs-read-freshness.ts`, ATO-659). Absent ⇒ no notice.
   */
  fileVersions?: FileReadVersions;
}

export interface ToolDefinition {
  name: string;
  description: string;
  readonly: boolean;
  /**
   * Set when the result carries text from outside (a web page, an MCP
   * server): a short label naming the source. The registry then
   * neutralises chat-template markers in the summary and frames it as
   * data, not instructions (`untrusted-tool-output.ts`).
   */
  untrustedOutput?: string;
  run: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<CompressedToolResult>;
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
export interface ToolRegistryOptions {
  /**
   * Saves the complete output of a clipped local result to a file and
   * puts the path in the summary (`tool-output-spill.ts`, ATO-663).
   * Absent ⇒ local results stay as the tool returned them.
   */
  outputSpill?: Pick<ToolOutputSpill, "spill">;
  /**
   * Exact secret values to mask in every tool result, read on each call
   * so a key added mid-session is covered (`tool-output-secrets.ts`,
   * ATO-1077). Shape-based masking applies regardless. Absent ⇒ the
   * secret-looking variables of `process.env`, which carries the agent's
   * `.env`.
   */
  knownSecrets?: () => readonly KnownSecret[];
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly outputSpill: Pick<ToolOutputSpill, "spill"> | undefined;
  private readonly knownSecrets: () => readonly KnownSecret[];

  constructor(options: ToolRegistryOptions = {}) {
    this.outputSpill = options.outputSpill;
    this.knownSecrets = options.knownSecrets ?? (() => knownSecretsFromEnv());
  }

  register(definition: ToolDefinition): void {
    this.tools.set(definition.name, definition);
  }

  /**
   * Remove a tool by name. Returns `true` when a tool was actually
   * unregistered, `false` when the name was not known. Used by the
   * MCP manager to detach a server's tools cleanly on stop /
   * restart — the static native tools never call this.
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
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
    // An alias shape the tool reads (`argument-aliases.ts`: `os.fs.move`
    // `{paths, destination}`) is rewritten here, before any wrapper
    // (read scope) sees the call, and the result's last line says how
    // it was read.
    const aliased = readArgumentAliases(name, args, {
      isFile: (path) => isExistingFile(path, ctx.workingDir),
    });
    const masks = !UNMASKED_TOOLS.has(name);
    let result: CompressedToolResult;
    try {
      // Models sometimes emit a JSON value one level over-encoded (a
      // number as "200000", an array as "[\"a.png\"]"). Unwrap those
      // before dispatch; anything that cannot be coerced is passed
      // through untouched so the tool reports its own error.
      result = await tool.run(coerceToolArgs(name, aliased?.args ?? args), ctx);
    } catch (err) {
      // Same error object (its class matters to callers), one more line.
      // A message that cannot be set (a getter-only DOMException) is left
      // as it is: the error itself must reach the caller unchanged.
      if (aliased !== null && err instanceof Error && !ctx.signal.aborted) {
        try {
          err.message = `${err.message}\n${aliased.note}`;
        } catch {
          // keep `err` as thrown
        }
      }
      throw masks ? maskErrorSecrets(err, this.knownSecrets()) : err;
    }
    if (aliased !== null) result = withAliasNote(result, aliased.note);
    // Secrets are masked first, so the cloud promotion, the spill file
    // and the untrusted framing below all see the marker, never the key.
    if (masks) result = maskResultSecrets(result, this.knownSecrets());
    const shown =
      ctx.modelMode === "cloud"
        ? fullToolResult(result)
        : this.outputSpill
          ? await this.outputSpill.spill(name, ctx.sessionId, result)
          : result;
    return tool.untrustedOutput === undefined
      ? shown
      : markUntrustedResult(shown, tool.untrustedOutput);
  }
}

/** `path` (resolved against `workingDir`) is an existing file; any failure is no. */
function isExistingFile(path: string, workingDir: string): boolean {
  try {
    return statSync(resolveUserPath(path, workingDir)).isFile();
  } catch {
    return false;
  }
}
