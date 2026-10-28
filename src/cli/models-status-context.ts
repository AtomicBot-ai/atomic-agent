import type { LaunchRecord } from "../local-llm/index.js";

/**
 * The `models status` line for the window the live daemon runs with, and
 * how far a growing auto window may still grow (`context-growth.ts`).
 * A launch that does not grow (no `autoContextCeiling`) says nothing
 * about growing. `null` when no daemon of ours is up or its window was
 * left to llama.cpp.
 */
export function formatStatusContextLine(
  launch: Pick<LaunchRecord, "contextSize" | "autoContextCeiling"> | null,
): string | null {
  if (!launch || !(launch.contextSize > 0)) return null;
  const ceiling = launch.autoContextCeiling ?? null;
  return (
    `context:        ${launch.contextSize} tokens` +
    (ceiling !== null && ceiling > launch.contextSize
      ? ` (auto: grows up to ${ceiling} as the conversation does)`
      : "") +
    "\n"
  );
}
