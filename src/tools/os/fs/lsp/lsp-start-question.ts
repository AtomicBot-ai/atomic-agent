/**
 * The start question for a language server in an untrusted folder
 * (ATO-503): a language server runs the project's own code (tsconfig
 * plugins, a local TypeScript, pyright's environment), which is the
 * same trust as the folder's own skills and instruction files. So
 * outside a trusted folder the first start in a work tree goes through
 * the approval gate as `trust_config`, the category for "this changes
 * what runs on the operator's behalf": it asks until level 5 and is
 * never granted for the session, and a surface that cannot ask (a
 * refuse policy, no window) refuses on its own.
 */
import {
  ApprovalDeniedError,
  requireApproval,
  type DangerousToolOptions,
} from "../../../../approval/dangerous-tool.js";
import type { LspStartAnswer, LspStartQuestion } from "./lsp-diagnostics.js";

/** Tool name on the approval card. */
export const LSP_START_TOOL = "os.fs.lsp_start";

export function lspStartQuestionText(question: Pick<LspStartQuestion, "root" | "server">): string {
  return (
    `start ${question.server} in ${question.root} to check edits for errors; ` +
    "it runs this project's own config and plugins. Asked once for this folder."
  );
}

export function askToStartLspThroughApprovals(
  options: DangerousToolOptions,
): (question: LspStartQuestion) => Promise<LspStartAnswer> {
  return async (question) => {
    try {
      await requireApproval(
        options,
        {
          sessionId: question.sessionId,
          tool: LSP_START_TOOL,
          category: "trust_config",
          reason: lspStartQuestionText(question),
          affectedResources: [question.root],
          workdir: question.root,
        },
        question.signal,
      );
      return "yes";
    } catch (err) {
      if (err instanceof ApprovalDeniedError) {
        // A person said no (now or earlier this turn): remembered. A
        // refusal nobody made (refuse policy, timeout, no window) is not.
        return err.byUser || err.declinedEarlier ? "no" : "unanswered";
      }
      return "unanswered";
    }
  };
}
