/**
 * `/council` in the TUI (ATO-2432): runs the runtime's model council and
 * shows it as chat notices, the way `/btw` shows its answer. Nothing is
 * written to the session: the council is an aside the model never sees in
 * later turns.
 *
 * The notices: one line to start (the question and the cost forecast),
 * one per stage as it happens (answers in, judging and ranking, the
 * chairman), then the whole verdict in one block, final answer first
 * (`formatCouncilReport`). One council at a time; `/council stop` and
 * every exit path stop it quietly.
 */

import type { AtomicAgentConfig } from "../config/index.js";
import { formatCouncilReport, type CouncilProgress } from "../llm/toolcall-bench/index.js";
import { runRuntimeCouncil, type CouncilServiceDeps } from "../runtime/council-service.js";
import type { CouncilCommand } from "./commands/council-command.js";
import type { TuiAction } from "./tui-action.js";

export interface TuiCouncilDeps {
  emit: (action: TuiAction) => void;
  config: () => AtomicAgentConfig;
  completePlain?: CouncilServiceDeps["completePlain"];
  /** Test seam: the council itself. */
  run?: typeof runRuntimeCouncil;
}

export interface TuiCouncil {
  handle(command: CouncilCommand): Promise<void>;
  /** Stop a running council quietly. */
  cancel(): void;
  readonly running: boolean;
}

/** The stage line a progress event shows, or null for one not worth a line. */
export function councilProgressLine(event: CouncilProgress): string | null {
  switch (event.stage) {
    case "answered":
      return event.done === event.total ? `council: ${event.total} of ${event.total} answered` : null;
    case "reviewing":
      return event.rankers > 0
        ? `council: ${event.judge} is comparing the answers; ${event.rankers} members are ranking each other`
        : `council: ${event.judge} is comparing the answers`;
    case "chairman":
      return `council: ${event.chairman} is writing the final answer`;
    default:
      return null;
  }
}

export function createTuiCouncil(deps: TuiCouncilDeps): TuiCouncil {
  let controller: AbortController | null = null;
  const notice = (text: string, variant?: "warn") =>
    deps.emit({ type: "system_message", text, ...(variant ? { variant } : {}) });
  return {
    get running() {
      return controller !== null;
    },
    cancel() {
      controller?.abort();
      controller = null;
    },
    async handle(command) {
      if (command.kind === "usage") {
        notice(command.message);
        return;
      }
      if (command.kind === "stop") {
        if (!controller) {
          notice("No council is running.");
          return;
        }
        controller.abort();
        controller = null;
        notice("Council stopped.");
        return;
      }
      if (controller) {
        notice("A council is already running; wait for it or type /council stop.", "warn");
        return;
      }
      const own = new AbortController();
      controller = own;
      const { request } = command;
      try {
        const result = await (deps.run ?? runRuntimeCouncil)(
          {
            question: request.question,
            ...(request.models !== undefined ? { models: request.models } : {}),
            ...(request.judge !== undefined ? { judge: request.judge } : {}),
            ...(request.chairman !== undefined ? { chairman: request.chairman } : {}),
            ...(request.rank !== undefined ? { rank: request.rank } : {}),
            ...(request.maxUsd !== undefined ? { maxUsd: request.maxUsd } : {}),
            ...(request.dryRun ? { forecastOnly: true } : {}),
            signal: own.signal,
            onForecast: (costLine) =>
              notice(
                request.dryRun
                  ? `council: ${request.question}\n${costLine}. Nothing was sent (--dry-run).`
                  : `council: ${request.question}\n${costLine}. Asking now; nothing is saved to this chat.`,
              ),
            onProgress: (event) => {
              if (own.signal.aborted) return;
              const line = councilProgressLine(event);
              if (line) notice(line);
            },
          },
          { config: deps.config(), ...(deps.completePlain ? { completePlain: deps.completePlain } : {}) },
        );
        if (own.signal.aborted) return;
        for (const line of result.skipped ?? []) notice(`council: skipped ${line}`, "warn");
        if (!result.ok) {
          notice(`Could not run the council: ${result.reason}.`, "warn");
          return;
        }
        if (!result.report) return;
        notice(formatCouncilReport(result.report).trimEnd());
      } catch (error) {
        if (own.signal.aborted) return;
        const reason = error instanceof Error ? error.message : String(error);
        notice(`Could not run the council: ${reason}.`, "warn");
      } finally {
        if (controller === own) controller = null;
      }
    },
  };
}
