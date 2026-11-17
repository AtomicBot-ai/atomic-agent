import type { CompletionRequest, CompletionResult } from "../../llm/provider/completion-types.js";
import { buildCloudSubcallRequest } from "../../llm/provider/cloud-subcall.js";
import { isLocalServerUrl } from "../../llm/provider/openai/local-server-url.js";
import {
  assertImportFactsEngineAllowed,
  type ImportFactsComplete,
  type ImportFactsEngine,
} from "../../memory/import-facts/index.js";

/**
 * Bind the model that reads a chat export (ATO-1617, option A) to one
 * provider, chosen up front and called directly.
 *
 * Not through the runtime's `llmComplete`: that one rides the fallback
 * chain, which may move a refused call on to another link, possibly a
 * cloud one. Here the link is fixed for the whole run:
 *
 * - `local`: the active text provider when it is local (a llama-server
 *   entry, or any entry whose URL is this machine), otherwise the first
 *   local entry in the config. No local entry: refused, nothing sent.
 * - `cloud`: exactly the provider the person picked, only with this
 *   run's consent ({@link assertImportFactsEngineAllowed}), and only if
 *   it really is a cloud entry.
 *
 * A llama-server link is asked under the reflection grammar; any other
 * link through one synthetic emit function, as reflection does on a
 * native-tools link.
 */

/** The parts of a config provider entry this module reads. */
export interface ImportFactsProviderEntry {
  id: string;
  kind: string;
  baseUrl?: string;
  url?: string;
}

/** The provider surface used: one completion. */
export interface ImportFactsProviderLink {
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export interface BindImportFactsModelInput {
  engine: ImportFactsEngine;
  providers: readonly ImportFactsProviderEntry[];
  activeTextProvider: string;
  getProvider(id: string): ImportFactsProviderLink | undefined;
}

export interface BoundImportFactsModel {
  providerId: string;
  local: boolean;
  complete: ImportFactsComplete;
}

export class ImportFactsModelError extends Error {
  constructor(
    message: string,
    readonly code: "no_local_model" | "unknown_provider" | "not_cloud",
  ) {
    super(message);
    this.name = "ImportFactsModelError";
  }
}

/** Partition id for the calls; never a conversation's. */
export const IMPORT_FACTS_PARTITION = "import-facts";

const EMIT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    lines: { type: "string", description: "NONE or newline-separated SET/NOTE lines" },
  },
  required: ["lines"],
  additionalProperties: false,
};

export function isLocalProviderEntry(entry: ImportFactsProviderEntry): boolean {
  return entry.kind === "llama-server" || isLocalServerUrl(entry.baseUrl ?? entry.url);
}

export function bindImportFactsModel(input: BindImportFactsModelInput): BoundImportFactsModel {
  assertImportFactsEngineAllowed(input.engine);
  const entry = pickEntry(input);
  const link = input.getProvider(entry.id);
  if (!link) {
    throw new ImportFactsModelError(`provider "${entry.id}" is configured but not running`, "unknown_provider");
  }
  const grammarLink = entry.kind === "llama-server";
  const complete: ImportFactsComplete = async (prompt, options) => {
    const request: CompletionRequest = grammarLink
      ? {
          prompt,
          grammar: options.grammar,
          slotId: -1,
          cachePrompt: false,
          sessionId: IMPORT_FACTS_PARTITION,
          signal: options.signal,
        }
      : {
          ...buildCloudSubcallRequest({
            prompt,
            emitFunctionName: "emit_facts",
            argsSchema: EMIT_SCHEMA,
            description: "Emit the facts found",
            sessionId: IMPORT_FACTS_PARTITION,
          }),
          signal: options.signal,
        };
    const result = await link.complete(request);
    return grammarLink ? result.content : emittedLines(result);
  };
  return { providerId: entry.id, local: isLocalProviderEntry(entry), complete };
}

function pickEntry(input: BindImportFactsModelInput): ImportFactsProviderEntry {
  const { engine, providers } = input;
  if (engine.kind === "local") {
    const active = providers.find((p) => p.id === input.activeTextProvider);
    if (active && isLocalProviderEntry(active)) return active;
    const firstLocal = providers.find(isLocalProviderEntry);
    if (firstLocal) return firstLocal;
    throw new ImportFactsModelError(
      "no local model is set up; start a local model, or tick the cloud option for this import",
      "no_local_model",
    );
  }
  const picked = providers.find((p) => p.id === engine.provider);
  if (!picked) throw new ImportFactsModelError(`unknown provider "${engine.provider}"`, "unknown_provider");
  if (isLocalProviderEntry(picked)) {
    throw new ImportFactsModelError(
      `"${engine.provider}" is a local model; choose the local option instead`,
      "not_cloud",
    );
  }
  return picked;
}

function emittedLines(result: CompletionResult): string {
  const args = result.toolCalls?.[0]?.function?.arguments;
  if (typeof args === "string" && args.length > 0) {
    try {
      const parsed = JSON.parse(args) as { lines?: unknown };
      if (typeof parsed.lines === "string") return parsed.lines;
    } catch {
      // fall back to the prose answer
    }
  }
  return result.content ?? "";
}
