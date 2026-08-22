import type { MouseContextValue } from "../mouse/mouse-context.js";
import { plainKey } from "../mouse/synthetic-key.js";
import { routeProvidersWizardKey } from "./route-wizard-key.js";

/**
 * The one paste adapter for every mount of `ProvidersWizard` (Providers
 * tab, LLM tab, the first-run cloud step): clipboard text is fed to the
 * wizard as the `(text, plainKey())` burst a terminal paste would
 * deliver, through the same router every mount's keyboard uses. All
 * three keep the wizard in `state.providersPanel.wizard`, which is what
 * lets one adapter serve them.
 *
 * A text burst can only ever APPEND (the api_key / line-phase branches,
 * or the open search box), never submit, close or cancel — those need
 * Return or Esc flags a paste burst does not carry — so the router's
 * submit callbacks are safely omitted.
 */
export function pasteIntoProvidersWizard(
  text: string,
  mouse: MouseContextValue,
): void {
  const wizard = mouse.getState().providersPanel.wizard;
  if (!wizard) return;
  routeProvidersWizardKey(text, plainKey(), wizard, {
    dispatch: mouse.dispatch,
  });
}
