import {
  formatApprovalCategory,
  formatNeverGrantedNote,
} from "../approval/approval-level.js";
import {
  canGrantCategory,
  describeCategoryGrant,
  describeMcpToolGrant,
  canGrantShape,
  type ApprovalGrantScope,
  type ApprovalRequest,
} from "../approval/approval-gate.js";
import {
  canGrantAlways,
  describeAlwaysRule,
} from "../approval/approval-rules.js";
import { siteGrantHost } from "../approval/site-grants.js";
import type { StdinLineQueue } from "./stdin-line-queue.js";

/**
 * The approval prompt of `atomic-agent run` over stdin: the text it
 * shows, which lines count as an answer, and reading the answer from the
 * run's one stdin queue. Moved out of `run-agent.ts` unchanged.
 */

export interface CliApprovalAnswer {
  approved: boolean;
  grant?: ApprovalGrantScope;
}

/**
 * The text `promptApproval` writes before reading the answer: what is
 * asked, the grant options this request allows, and (when the category
 * can never be granted for the session) a note naming that category.
 */
export function formatCliApprovalPrompt(request: ApprovalRequest): string {
  const grantCategory = canGrantCategory(request);
  const grantShape = canGrantShape(request);
  const lines = [
    "",
    `» approval required for tool: ${request.tool}`,
    `  kind: ${formatApprovalCategory(request.category)}`,
    `  reason: ${request.reason}`,
  ];
  if (request.preview) lines.push(`  preview: ${request.preview}`);
  if (request.affectedResources?.length) {
    lines.push(`  affects: ${request.affectedResources.join(", ")}`);
  }
  const options = ["y = approve once"];
  if (grantCategory) {
    options.push(
      siteGrantHost(request) !== null
        ? `s = allow ${describeCategoryGrant(request)} this session`
        : describeMcpToolGrant(request) !== null
          ? `s = allow ${describeMcpToolGrant(request)} this session`
        : request.grantKey !== undefined
          ? `s = allow this kind to ${request.grantKey} this session`
        : "s = allow this kind this session",
    );
  }
  if (grantShape) {
    options.push(`a = allow all ${request.commandShape} this session`);
  }
  // Saved, unlike the two above (ATO-1142).
  if (canGrantAlways(request)) {
    options.push(`w = ${describeAlwaysRule(request)}`);
  }
  options.push("N = deny");
  if (!grantCategory) {
    lines.push(`  (${formatNeverGrantedNote(request.category)})`);
  }
  lines.push(`  approve? [${options.join(", ")}] `);
  return lines.join("\n");
}

/**
 * Whether a stdin line answers an approval prompt: one of the offered
 * keys (`y`, `s`, `a`, `w`, `n`), `yes` / `no`, or an empty line (Enter,
 * the default `N`), in any case. Anything else is a message for the
 * agent, not an answer.
 */
export function isApprovalAnswer(line: string): boolean {
  return /^(y|yes|n|no|s|a|w|)$/.test(line.trim().toLowerCase());
}

/**
 * Interactive approval over stdin. We ask the operator to confirm each
 * dangerous action; `y`/`yes` approves this call, `s` also grants the
 * category for the session, `a` grants this shell command shape, `w`
 * saves an "always allow" rule for this project (`canGrantAlways`).
 * Any other answer (`n`, `no`, Enter, a grant key this request does not
 * offer) is a refusal. The grant options mirror the TUI prompt;
 * they are offered here too because a CLI operator has the same physical
 * access to the machine. A category that is never grantable
 * (`isGrantableCategory`: trust config, e-mail, fusion fan-out) only
 * ever shows `y/N`.
 *
 * The answer is the next line of the same stdin queue the chat loop
 * reads (ATO-802), so a piped "y" written together with the next
 * message answers this prompt and the message stays queued for the
 * next turn. Only a line shaped like an answer (`isApprovalAnswer`) is
 * taken: any other line is a refusal and stays queued as the next
 * message, so a driver that pipes "task\ncontinue" without answering
 * loses nothing to the prompt. EOF before an answer is a refusal.
 */
export async function promptApproval(
  request: ApprovalRequest,
  lines: StdinLineQueue,
): Promise<CliApprovalAnswer> {
  const grantCategory = canGrantCategory(request);
  const grantShape = canGrantShape(request);
  process.stderr.write(formatCliApprovalPrompt(request));
  const head = await lines.peek();
  if (head === null) return { approved: false };
  if (!isApprovalAnswer(head)) {
    process.stderr.write(
      "\n  denied: the next input line is not an answer, kept as the next message\n",
    );
    return { approved: false };
  }
  await lines.next();
  const answer = head.trim().toLowerCase();
  if (answer === "s" && grantCategory) {
    process.stderr.write(
      `\n  granted: ${formatApprovalCategory(request.category)} for this session\n`,
    );
    return { approved: true, grant: "category" };
  }
  if (answer === "a" && grantShape) {
    process.stderr.write(
      `\n  granted: ${request.commandShape} commands for this session\n`,
    );
    return { approved: true, grant: "shape" };
  }
  if (answer === "w" && canGrantAlways(request)) {
    process.stderr.write(
      `\n  saved: ${describeAlwaysRule(request)} (approval-rules.json in the agent's state folder)\n`,
    );
    return { approved: true, grant: "always" };
  }
  return { approved: /^(y|yes)$/.test(answer) };
}
