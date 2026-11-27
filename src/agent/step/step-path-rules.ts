import { newlyActivePathRules } from "../../prompt/path-rule-sections.js";
import type { ConversationTurn } from "../../session/conversation-turn.js";
import type { PathRule } from "../../session/workspace-context.js";
import type { StepEvent } from "../step-events.js";
import type { StepContext } from "./step-contract.js";

/**
 * Says which path-scoped project rules this step attached (ATO-2443), so
 * the TUI and the desktop can show "rule attached: <file>" under the tool
 * call that matched it, as Cursor names the rules it attached. The rules
 * the step's prompt was built with are compared before and after the
 * step's turns: a rule is reported once, on the step that first touched a
 * matching file. Reporting never fails the step.
 */
export function emitAttachedPathRules(
  ctx: Pick<StepContext, "workspace" | "localPathRules" | "stepIndex">,
  workingDir: string,
  before: readonly ConversationTurn[],
  after: readonly ConversationTurn[],
  onEvent: ((event: StepEvent) => void) | undefined,
): void {
  if (!onEvent) return;
  const rules = ctx.localPathRules ?? ctx.workspace?.pathRules ?? [];
  if (!rules.length) return;
  const roots = ctx.workspace ? [workingDir, ctx.workspace.workingDir] : [workingDir];
  let attached: readonly PathRule[];
  try {
    attached = newlyActivePathRules(rules, before, after, roots);
  } catch {
    return;
  }
  for (const rule of attached) {
    onEvent({ type: "path_rule_attached", path: rule.path, patterns: rule.patterns, stepIndex: ctx.stepIndex });
  }
}
