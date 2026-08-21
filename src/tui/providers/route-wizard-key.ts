import type { Key } from "ink";
import type { TuiAction } from "../tui-action.js";
import { handleProvidersWizardKey } from "./providers-wizard-key-bindings.js";
import type { ProvidersWizardState } from "./providers-wizard-state.js";

export interface ProvidersWizardKeyRoute {
  dispatch(action: TuiAction): void;
  /** Verify + save + hot-swap. Owned by `ProvidersOrchestrator`. */
  onSubmit?(wizard: ProvidersWizardState): void;
  /** Esc during a key check: abandon the request, keep the wizard editable. */
  onSubmitCancel?(): void;
}

/**
 * Turn one keystroke into the wizard's next state, its save, or its
 * close. Extracted from `handleProvidersTabKey` so the Providers panel
 * and the first-run flow drive the same wizard through the same code —
 * two copies would be two chances for Esc to mean different things in
 * the two places it appears.
 *
 * Returns whether the key was consumed.
 */
export function routeProvidersWizardKey(
  input: string,
  key: Key,
  wizard: ProvidersWizardState,
  ctx: ProvidersWizardKeyRoute,
): boolean {
  const result = handleProvidersWizardKey(input, key, wizard);
  if (!result.handled) return false;
  if ("closed" in result && result.closed) {
    ctx.dispatch({ type: "providers_wizard_closed" });
    return true;
  }
  if ("wizard" in result) {
    if ("cancelSubmit" in result && result.cancelSubmit) {
      ctx.onSubmitCancel?.();
      return true;
    }
    if ("submit" in result && result.submit) {
      ctx.onSubmit?.(result.wizard);
      return true;
    }
    ctx.dispatch({ type: "providers_wizard_updated", wizard: result.wizard });
  }
  return true;
}
