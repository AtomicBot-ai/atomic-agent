import type { AtomicAgentConfig } from "../../config/index.js";
import {
  answerProjectTrust,
  inspectProjectTrust,
  ProjectTrustConflictError,
  type ProjectTrustAnswer,
  type ProjectTrustStatus,
} from "../../runtime/project-trust.js";

export interface ProjectTrustDeps {
  /** Read lazily, so building the orchestrator touches nothing. */
  config(): AtomicAgentConfig;
  /** The folder the TUI was opened in. */
  workingDir(): string;
  emit(action: unknown): void;
  /** Rebuild the local catalog and the Skills panel after an answer. */
  refresh(): Promise<void> | void;
}

/**
 * Asks once per set of new project skills and instruction files in the
 * folder the TUI was opened in, and records the operator's answer. A
 * failure never blocks the launch: nothing is trusted then.
 */
export class ProjectTrustOrchestrator {
  private shown: ProjectTrustStatus | null = null;
  constructor(private readonly deps: ProjectTrustDeps) {}

  check(): void {
    try {
      this.ask(inspectProjectTrust(this.deps.config(), this.deps.workingDir()));
    } catch (error) {
      this.deps.emit({ type: "runtime_info", line: `[trust] could not inspect this folder: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  async answer(answer: ProjectTrustAnswer): Promise<void> {
    const shown = this.shown;
    if (!shown?.questionId) return;
    this.shown = null;
    try {
      const status = answerProjectTrust(this.deps.config(), this.deps.workingDir(), answer, shown.questionId);
      const count = shown.pending.skills.length + shown.pending.instructions.length;
      this.deps.emit({ type: "runtime_info", line: answer === "trust"
        ? `[trust] trusted ${count} project item${count === 1 ? "" : "s"} in ${status.workingDir}`
        : `[trust] not loading ${count} project item${count === 1 ? "" : "s"} in ${status.workingDir}; trust later with ${status.hint}` });
      await this.deps.refresh();
    } catch (error) {
      // Something new appeared while the question was up: ask about the current set instead.
      if (error instanceof ProjectTrustConflictError) { this.ask(error.status); return; }
      this.deps.emit({ type: "runtime_info", line: `[trust] answer not saved: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private ask(status: ProjectTrustStatus): void {
    if (!status.question || !status.questionId) return;
    this.shown = status;
    this.deps.emit({ type: "project_trust_asked", prompt: { workingDir: status.workingDir, question: status.question, questionId: status.questionId } });
  }
}
