import type { Key } from "ink";
import type { AppKeyContext } from "../app-key-bindings.js";

type UpdateKeyContext = Pick<AppKeyContext, "dispatch" | "callbacks">;

export function handleUpdateKey(input: string, key: Key, ctx: UpdateKeyContext): boolean {
  if (key.ctrl || key.meta) return false;
  const lower = input.toLowerCase();
  if (lower === "y") {
    ctx.callbacks.onUpdateConfirmed?.();
    return true;
  }
  if (lower === "n" || key.escape) {
    ctx.dispatch({ type: "update_dismissed" });
    return true;
  }
  return false;
}
