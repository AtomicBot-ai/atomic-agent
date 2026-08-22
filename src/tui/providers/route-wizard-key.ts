import type { Key } from "ink";
import type { MouseContextValue } from "../mouse/mouse-context.js";
import { returnKey } from "../mouse/synthetic-key.js";
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

/**
 * How a pick-list row click reaches the wizard whose frame it was drawn
 * in. The wizard is a parameter, never a read off `TuiState`: the same
 * pick list serves two kinds of owner — the store-backed mounts (the
 * Providers/LLM panels, the onboarding cloud step), whose wizard lives
 * at `providersPanel.wizard`, and `CloudProviderOnboarding`, which
 * keeps its wizard in component state. A handler that read the store
 * slice acted on a different wizard than the one the operator clicked
 * for the second kind — or on `null`, a silent no-op.
 */
export interface WizardMouseRoute {
  /** First click, on an unselected row: move the wizard's cursor there. */
  select(
    mouse: MouseContextValue,
    wizard: ProvidersWizardState,
    cursor: number,
  ): void;
  /** Second click, on the selected row: the wizard's own Enter. */
  activate(mouse: MouseContextValue, wizard: ProvidersWizardState): void;
}

/**
 * The store-backed route, shared by every mount whose wizard lives on
 * `providersPanel.wizard`. Activation goes through
 * `routeProvidersWizardKey` — the routing every keyboard site uses — so
 * a click saves or advances exactly what Enter would.
 */
export const storeWizardMouseRoute: WizardMouseRoute = {
  select: (mouse, wizard, cursor) => {
    mouse.dispatch({
      type: "providers_wizard_updated",
      wizard: { ...wizard, cursor },
    });
  },
  activate: (mouse, wizard) => {
    routeProvidersWizardKey("", returnKey(), wizard, {
      dispatch: mouse.dispatch,
      onSubmit: (w) => mouse.callbacks.onProvidersWizardSubmit?.(w),
      onSubmitCancel: () => mouse.callbacks.onProvidersWizardSubmitCancel?.(),
    });
  },
};
