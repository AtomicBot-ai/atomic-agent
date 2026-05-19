import { compressToolResult } from "../../compressor/result-compressor.js";
import {
  ProcedureStore,
  ProcedureValidationError,
  type Procedure,
  PROCEDURE_RECALL_DEFAULT_K,
  PROCEDURE_RECALL_MAX_K,
} from "../../memory/procedures/procedure-store.js";
import type { ToolDefinition } from "../tool-registry.js";

export interface ProceduresRecallToolOptions {
  store: ProcedureStore;
}

/**
 * Memory-v2 phase 7b. `memory.procedures.recall { id?, query?, k? }`
 * — the agent's read access to advisory procedure templates. The
 * full `steps[]` body is rendered in the tool output; the hot
 * `### procedures` section in the prompt tail carries only the
 * `activation` pointer view (cross-phase invariant 22).
 *
 *   - `{ id }`    direct lookup; returns the procedure even when
 *                 `status='deprecated'` (audit / cascade traceback).
 *   - `{ query }` BM25 lookup over `activation + steps + tags`.
 *                 Defaults to `active`-only matches; `k` defaults to
 *                 `PROCEDURE_RECALL_DEFAULT_K` (2), capped at
 *                 `PROCEDURE_RECALL_MAX_K` (10).
 *
 * Cross-phase invariant 20 (read-only — must pass): the runtime
 * **never** feeds `Procedure.steps` into `toolRegistry.invoke`. The
 * agent reads the steps and either follows them on the next
 * inference, consciously deviates, or ignores them.
 */
export function buildProceduresRecallTool(
  options: ProceduresRecallToolOptions,
): ToolDefinition {
  return {
    name: "memory.procedures.recall",
    description:
      "Read advisory procedures (how-to templates). Pass `id` (number) to fetch one procedure by row id (including deprecated rows). Pass `query` (string, plus optional `k` 1..10) to BM25-search active procedures. Returns activation + ordered steps (each step has description and optional toolHint) + tags + parent ids. Procedures are guidance, not commands — they are never auto-executed.",
    readonly: true,
    async run(rawArgs) {
      const id = rawArgs.id;
      const query = rawArgs.query;
      const k = rawArgs.k;
      try {
        if (id !== undefined && id !== null) {
          const procedureId = coerceId(id);
          const procedure = options.store.getById(procedureId);
          if (!procedure) {
            return compressToolResult({
              tool: "memory.procedures.recall",
              status: "ok",
              output: `(no procedure with id ${procedureId})`,
              details: { id: procedureId, count: 0, procedures: [] },
            });
          }
          return compressToolResult(
            {
              tool: "memory.procedures.recall",
              status: "ok",
              output: renderProcedureBody(procedure),
              details: {
                count: 1,
                procedures: [serialiseProcedure(procedure)],
              },
            },
            { maxSummaryLength: 4000, maxTailLines: 200 },
          );
        }
        if (typeof query !== "string" || query.trim().length === 0) {
          return compressToolResult({
            tool: "memory.procedures.recall",
            status: "error",
            output: "validation: query: pass either `id` or non-empty `query`",
            details: {
              field: "query",
              reason: "either `id` or `query` is required",
            },
          });
        }
        const procedures = options.store.recall({
          query,
          k: coerceK(k),
        });
        if (procedures.length === 0) {
          return compressToolResult({
            tool: "memory.procedures.recall",
            status: "ok",
            output: `(no active procedures matched "${query.slice(0, 60)}")`,
            details: { query, count: 0, procedures: [] },
          });
        }
        return compressToolResult(
          {
            tool: "memory.procedures.recall",
            status: "ok",
            output: procedures.map(renderProcedureBody).join("\n\n---\n"),
            details: {
              query,
              count: procedures.length,
              procedures: procedures.map(serialiseProcedure),
            },
          },
          { maxSummaryLength: 6000, maxTailLines: 200 },
        );
      } catch (error) {
        if (error instanceof ProcedureValidationError) {
          return compressToolResult({
            tool: "memory.procedures.recall",
            status: "error",
            output: `validation: ${error.field}: ${error.message}`,
            details: { field: error.field, reason: error.message },
          });
        }
        throw error;
      }
    },
  };
}

function coerceId(raw: unknown): number {
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    const parsed = Number.parseInt(raw, 10);
    if (parsed > 0) return parsed;
  }
  throw new ProcedureValidationError(
    "id",
    "id must be a positive integer (or an integer-only string)",
  );
}

function coerceK(raw: unknown): number {
  if (raw === undefined || raw === null) return PROCEDURE_RECALL_DEFAULT_K;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
    return Math.min(raw, PROCEDURE_RECALL_MAX_K);
  }
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    const parsed = Number.parseInt(raw, 10);
    if (parsed > 0) return Math.min(parsed, PROCEDURE_RECALL_MAX_K);
  }
  return PROCEDURE_RECALL_DEFAULT_K;
}

function renderProcedureBody(procedure: Procedure): string {
  const tagSegment =
    procedure.tags.length > 0 ? ` [${procedure.tags.join(",")}]` : "";
  const statusSegment =
    procedure.status === "deprecated" ? " (deprecated)" : "";
  const stepsRendered = procedure.steps
    .map((s, idx) => {
      const hint = s.toolHint ? ` @${s.toolHint}` : "";
      return `  ${idx + 1}. ${s.description}${hint}`;
    })
    .join("\n");
  return [
    `>${procedure.id}${tagSegment}${statusSegment}`,
    `activation: ${procedure.activation}`,
    `steps:`,
    stepsRendered,
    `parent lessons: ${procedure.parentLessonIds.join(", ")}`,
    `parent memories: ${procedure.parentMemoryIds.join(", ")}`,
  ].join("\n");
}

function serialiseProcedure(procedure: Procedure): Record<string, unknown> {
  return {
    id: procedure.id,
    activation: procedure.activation,
    steps: procedure.steps,
    tags: procedure.tags,
    status: procedure.status,
    parentLessonIds: procedure.parentLessonIds,
    parentMemoryIds: procedure.parentMemoryIds,
    source: procedure.source,
    workingDir: procedure.workingDir,
    successCount: procedure.successCount,
    failureCount: procedure.failureCount,
    useCount: procedure.useCount,
    voteScore: procedure.voteScore,
    createdAt: procedure.createdAt,
    updatedAt: procedure.updatedAt,
    deprecatedAt: procedure.deprecatedAt,
  };
}
