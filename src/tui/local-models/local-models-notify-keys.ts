import type { Key } from "ink";
import type { TuiAppCallbacks } from "../tui-app.js";

/**
 * Keys of the "tell me when it lands?" modal, shared by the Models tab
 * and the LLM tab's modal layer. `t`/`d`/`e` pick a channel, `n` remembers
 * "no", Esc closes without an answer. Everything else is swallowed.
 */
export function handleNotifyPromptKey(
  input: string,
  key: Key,
  callbacks: TuiAppCallbacks,
): boolean {
  const lower = input.toLowerCase();
  if (lower === "t") {
    callbacks.onLocalModelsNotifyChoice?.("telegram");
    return true;
  }
  if (lower === "d") {
    callbacks.onLocalModelsNotifyChoice?.("discord");
    return true;
  }
  if (lower === "e") {
    callbacks.onLocalModelsNotifyChoice?.("email");
    return true;
  }
  if (lower === "n") {
    callbacks.onLocalModelsNotifyChoice?.("off");
    return true;
  }
  if (key.escape) {
    callbacks.onLocalModelsNotifyDismissed?.();
    return true;
  }
  return true;
}

