/**
 * After-edit diagnostics from real language servers (ATO-503): after
 * `os.fs.write` / `os.fs.edit` / `os.fs.patch` change a source file of a
 * language with a server on PATH, the tool result also lists the
 * compiler and type errors the change added — "Type 'string' is not
 * assignable to 'number'", "Cannot find name 'foo'" — the way an IDE
 * would show them, so a model fixes them in the next step instead of
 * finding out from a failed run much later.
 *
 * Rules, all of them on purpose:
 *  - off unless `tools.lsp.enabled` is set (memory and start-up time
 *    next to a local model);
 *  - servers come from the shared pool (`lsp-server-pool.ts`): only
 *    inside a git work tree, only already on PATH, started lazily, one
 *    per language per repository, asked once in an untrusted folder;
 *  - only errors the change added (`lsp-delta.ts`);
 *  - advisory: bounded in time, never throws, never alters a write.
 *    No verdict in time is silence.
 */
import { formatNewErrors, newErrors } from "./lsp-delta.js";
import {
  createLspServerPool,
  type LspServerPool,
  type LspServerPoolOptions,
} from "./lsp-server-pool.js";

export {
  LSP_INITIALIZE_TIMEOUT_MS,
  type LspStartAnswer,
  type LspStartQuestion,
  type StartClient,
} from "./lsp-server-pool.js";

/** How long one file sync may wait for the server's diagnostics. */
export const LSP_DIAGNOSTICS_TIMEOUT_MS = 3000;
/** How long an edit waits for a server that is still starting. */
export const LSP_STARTUP_WAIT_MS = 5000;

export interface LspChangeInput {
  readonly absolute: string;
  /** The path as the model reads it (`displayPath`). */
  readonly display: string;
  readonly change: "write" | "edit" | "patch";
  /** The file before the change; omitted when new or unknown. */
  readonly before?: string;
  readonly after: string;
  /** The session making the change, for the start question. */
  readonly sessionId?: string;
  /** The tool call's signal; aborting it drops the start question. */
  readonly signal?: AbortSignal;
}

export interface LspDiagnostics {
  /** The warning block for the tool result, or null. Never throws. */
  diagnoseChange(input: LspChangeInput): Promise<string | null>;
  /** Stops every server of its pool. */
  dispose(): void;
}

export interface LspDiagnosticsOptions extends LspServerPoolOptions {
  /** `tools.lsp.enabled`; false makes every call a no-op. */
  readonly enabled: boolean;
  /**
   * The servers to use, shared with `os.code.lsp` (ATO-2373). Omitted:
   * a pool of its own, built from the other options.
   */
  readonly pool?: LspServerPool;
  readonly diagnosticsTimeoutMs?: number;
  readonly startupWaitMs?: number;
}

export function createLspDiagnostics(
  options: LspDiagnosticsOptions,
): LspDiagnostics {
  const pool = options.pool ?? createLspServerPool(options);
  const timeoutMs = options.diagnosticsTimeoutMs ?? LSP_DIAGNOSTICS_TIMEOUT_MS;
  const startupWaitMs = options.startupWaitMs ?? LSP_STARTUP_WAIT_MS;

  const run = async (input: LspChangeInput): Promise<string | null> => {
    const result = await pool.withServer(
      input.absolute,
      input,
      startupWaitMs,
      async ({ client, spec }) => {
        const languageId = spec.languageId(input.absolute);
        const before =
          input.before === undefined
            ? []
            : await client.diagnose(input.absolute, languageId, input.before, timeoutMs);
        if (before === null) return null;
        const after = await client.diagnose(
          input.absolute,
          languageId,
          input.after,
          timeoutMs,
        );
        if (after === null) return null;
        return formatNewErrors(
          input.display,
          input.change,
          spec.id,
          newErrors(before, after),
        );
      },
    );
    return result.ok ? result.value : null;
  };

  return {
    async diagnoseChange(input) {
      if (!options.enabled) return null;
      try {
        return await run(input);
      } catch {
        return null;
      }
    },
    dispose() {
      pool.dispose();
    },
  };
}
