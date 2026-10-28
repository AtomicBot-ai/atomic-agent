import type { Key } from "ink";
import type { AppKeyContext } from "../app-key-bindings.js";

type ProjectTrustKeyContext = Pick<AppKeyContext, "dispatch" | "callbacks">;

/** y trusts, n declines (remembered), Esc closes until the next start; other input passes through. */
export function handleProjectTrustKey(input: string, key: Key, ctx: ProjectTrustKeyContext): boolean {
  if (key.ctrl || key.meta) return false;
  const lower = input.toLowerCase();
  if (lower === "y" || lower === "n") {
    ctx.callbacks.onProjectTrustAnswered?.(lower === "y" ? "trust" : "decline");
    ctx.dispatch({ type: "project_trust_closed" });
    return true;
  }
  if (key.escape) {
    ctx.dispatch({ type: "project_trust_closed" });
    return true;
  }
  return false;
}
