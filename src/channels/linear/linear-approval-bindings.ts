/**
 * Which Linear thread each session's approval prompts go to (ATO-2324,
 * moved out of the channel in ATO-2464). One router binding per session,
 * replaced when the same session is asked from another thread.
 */

import type { ApprovalRouter } from "../../approval/approval-router.js";
import type { LinearApprovalBridge } from "./linear-approval-bridge.js";
import type { LinearTarget } from "./linear-types.js";

export class LinearApprovalBindings {
  private readonly bindings = new Map<string, { key: string; unsubscribe: () => void }>();

  constructor(
    private readonly router: Pick<ApprovalRouter, "setForSession">,
    private readonly bridge: () => Pick<LinearApprovalBridge, "handlerFor"> | null,
  ) {}

  /** Point approval prompts for `sessionId` at `target`. Idempotent. */
  bind(sessionId: string, target: LinearTarget): void {
    const key = JSON.stringify([target.issueId, target.parentId ?? ""]);
    const existing = this.bindings.get(sessionId);
    if (existing?.key === key) return;
    existing?.unsubscribe();
    this.bindings.delete(sessionId);
    const bridge = this.bridge();
    if (!bridge) return;
    const unsubscribe = this.router.setForSession(sessionId, bridge.handlerFor(target));
    this.bindings.set(sessionId, { key, unsubscribe });
  }

  release(sessionId: string): void {
    const existing = this.bindings.get(sessionId);
    if (!existing) return;
    existing.unsubscribe();
    this.bindings.delete(sessionId);
  }

  clear(): void {
    for (const binding of this.bindings.values()) binding.unsubscribe();
    this.bindings.clear();
  }
}
