import { compressToolResult } from "../../compressor/result-compressor.js";
import {
  LessonStore,
  LessonValidationError,
  type Lesson,
  LESSON_RECALL_DEFAULT_K,
  LESSON_RECALL_MAX_K,
} from "../../memory/lessons/lesson-store.js";
import type { ToolDefinition } from "../tool-registry.js";

export interface LessonsRecallToolOptions {
  store: LessonStore;
}

/**
 * Memory-v2 phase 5. `memory.lessons.recall { id?, query?, k? }` —
 * the agent's read access to distilled lessons.
 *
 *   - `{ id }`  direct lookup; returns the lesson even when
 *               `status='deprecated'`. This is the path the agent
 *               takes after seeing `*<id>` pointers under the
 *               `### lessons` section (cross-phase invariant 9:
 *               archived items remain readable by id).
 *   - `{ query }` BM25 lookup over `activation + principle + tags`.
 *               Defaults to `active`-only matches; `k` defaults to
 *               `LESSON_RECALL_DEFAULT_K` (2), capped at
 *               `LESSON_RECALL_MAX_K` (10).
 *
 * The full `principle` body is rendered in the tool output —
 * **this is the only path that exposes the full body**. The hot
 * `### lessons` section in the prompt tail carries only the
 * `activation` pointer view (cross-phase invariant 10).
 */
export function buildLessonsRecallTool(
  options: LessonsRecallToolOptions,
): ToolDefinition {
  return {
    name: "memory.lessons.recall",
    description:
      "Read distilled lessons. Pass `id` (number) to fetch one lesson by row id (including deprecated rows — useful when chasing a *<id> pointer from `### lessons`). Pass `query` (string, plus optional `k` 1..10) to BM25-search active lessons by activation/principle/tags. Returns activation + principle + tags + parent ids.",
    readonly: true,
    async run(rawArgs) {
      const id = rawArgs.id;
      const query = rawArgs.query;
      const k = rawArgs.k;
      try {
        if (id !== undefined && id !== null) {
          const lessonId = coerceId(id);
          const lesson = options.store.getById(lessonId);
          if (!lesson) {
            return compressToolResult({
              tool: "memory.lessons.recall",
              status: "ok",
              output: `(no lesson with id ${lessonId})`,
              details: { id: lessonId, count: 0, lessons: [] },
            });
          }
          return compressToolResult(
            {
              tool: "memory.lessons.recall",
              status: "ok",
              output: renderLessonBody(lesson),
              details: {
                count: 1,
                lessons: [serialiseLesson(lesson)],
              },
            },
            { maxSummaryLength: 4000, maxTailLines: 200 },
          );
        }
        if (typeof query !== "string" || query.trim().length === 0) {
          return compressToolResult({
            tool: "memory.lessons.recall",
            status: "error",
            output: "validation: query: pass either `id` or non-empty `query`",
            details: {
              field: "query",
              reason: "either `id` or `query` is required",
            },
          });
        }
        const lessons = options.store.recall({
          query,
          k: coerceK(k),
        });
        if (lessons.length === 0) {
          return compressToolResult({
            tool: "memory.lessons.recall",
            status: "ok",
            output: `(no active lessons matched "${query.slice(0, 60)}")`,
            details: { query, count: 0, lessons: [] },
          });
        }
        return compressToolResult(
          {
            tool: "memory.lessons.recall",
            status: "ok",
            output: lessons.map(renderLessonBody).join("\n\n---\n"),
            details: {
              query,
              count: lessons.length,
              lessons: lessons.map(serialiseLesson),
            },
          },
          { maxSummaryLength: 6000, maxTailLines: 200 },
        );
      } catch (error) {
        if (error instanceof LessonValidationError) {
          return compressToolResult({
            tool: "memory.lessons.recall",
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
  throw new LessonValidationError(
    "id",
    "id must be a positive integer (or an integer-only string)",
  );
}

function coerceK(raw: unknown): number {
  if (raw === undefined || raw === null) return LESSON_RECALL_DEFAULT_K;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
    return Math.min(raw, LESSON_RECALL_MAX_K);
  }
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    const parsed = Number.parseInt(raw, 10);
    if (parsed > 0) return Math.min(parsed, LESSON_RECALL_MAX_K);
  }
  return LESSON_RECALL_DEFAULT_K;
}

function renderLessonBody(lesson: Lesson): string {
  const tagSegment =
    lesson.tags.length > 0 ? ` [${lesson.tags.join(",")}]` : "";
  const statusSegment =
    lesson.status === "deprecated" ? " (deprecated)" : "";
  return [
    `*${lesson.id}${tagSegment}${statusSegment}`,
    `activation: ${lesson.activation}`,
    `principle: ${lesson.principle}`,
    `parents: ${lesson.parentIds.join(", ")}`,
  ].join("\n");
}

function serialiseLesson(lesson: Lesson): Record<string, unknown> {
  return {
    id: lesson.id,
    activation: lesson.activation,
    principle: lesson.principle,
    tags: lesson.tags,
    status: lesson.status,
    parentIds: lesson.parentIds,
    workingDir: lesson.workingDir,
    successCount: lesson.successCount,
    failureCount: lesson.failureCount,
    createdAt: lesson.createdAt,
    updatedAt: lesson.updatedAt,
    deprecatedAt: lesson.deprecatedAt,
  };
}
