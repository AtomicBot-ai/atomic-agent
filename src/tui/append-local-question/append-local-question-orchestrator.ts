import type { AtomicAgentConfig } from "../../config/index.js";
import {
  answerAppendLocalQuestion,
  inspectAppendLocalQuestion,
  type AppendLocalAnswer,
  type AppendLocalQuestionPaths,
} from "../../runtime/append-local-question.js";

export interface AppendLocalQuestionDeps {
  /** Read lazily, so building the orchestrator touches nothing. */
  config(): AtomicAgentConfig;
  emit(action: unknown): void;
  /** Re-mirror the Fallback pane after "Turn off". */
  refreshFallback(): void;
}

/**
 * Asks once, at startup, whether the old "local model as the last-resort
 * fallback" switch should stay on (ATO-1461), and records the answer
 * through `runtime/append-local-question.ts`, the same files the desktop
 * reads. A failure never blocks the launch: nothing changes then, and
 * the question comes back on the next start.
 */
export class AppendLocalQuestionOrchestrator {
  private shown = false;
  constructor(private readonly deps: AppendLocalQuestionDeps) {}

  check(): void {
    try {
      const status = inspectAppendLocalQuestion(this.paths());
      if (status.question === null || status.detail === null) return;
      this.shown = true;
      this.deps.emit({ type: "append_local_asked", prompt: { question: status.question, detail: status.detail } });
    } catch (error) {
      this.deps.emit({ type: "runtime_info", line: `[fallback] could not read the last-resort setting: ${messageOf(error)}` });
    }
  }

  answer(answer: AppendLocalAnswer): void {
    if (!this.shown) return;
    this.shown = false;
    try {
      answerAppendLocalQuestion(this.paths(), answer);
      this.deps.emit({
        type: "runtime_info",
        line: answer === "keep"
          ? "[fallback] kept: the local model stays the last-resort fallback"
          : "[fallback] turned off: a cloud failure no longer switches the chat to the local model",
      });
      if (answer === "off") this.deps.refreshFallback();
    } catch (error) {
      this.deps.emit({ type: "runtime_info", line: `[fallback] answer not saved: ${messageOf(error)}` });
    }
  }

  private paths(): AppendLocalQuestionPaths {
    const config = this.deps.config();
    return { userConfigFile: config.paths.userConfigFile, stateDir: config.paths.stateDir };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
