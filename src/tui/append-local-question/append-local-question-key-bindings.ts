import type { Key } from "ink";
import type { AppKeyContext } from "../app-key-bindings.js";

type AppendLocalKeyContext = Pick<AppKeyContext, "dispatch" | "callbacks">;

/**
 * ATO-1461: `y` / `k` keeps the local model as the last resort, `n` / `t`
 * turns it off (both remembered), Esc closes until the next start; other
 * input passes through.
 */
export function handleAppendLocalKey(input: string, key: Key, ctx: AppendLocalKeyContext): boolean {
  if (key.ctrl || key.meta) return false;
  const lower = input.toLowerCase();
  if (lower === "y" || lower === "k" || lower === "n" || lower === "t") {
    ctx.callbacks.onAppendLocalAnswered?.(lower === "y" || lower === "k" ? "keep" : "off");
    ctx.dispatch({ type: "append_local_closed" });
    return true;
  }
  if (key.escape) {
    ctx.dispatch({ type: "append_local_closed" });
    return true;
  }
  return false;
}
