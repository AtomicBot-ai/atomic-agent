import type { ReactElement } from "react";
import {
  renderPickList as renderSharedPickList,
  type PickListProps,
} from "../components/pick-list.js";
import { pasteIntoProvidersWizard } from "./providers-wizard-paste.js";
import type { ProvidersWizardState } from "./providers-wizard-state.js";
import {
  storeWizardMouseRoute,
  type WizardMouseRoute,
} from "./route-wizard-key.js";

export { pickListHints } from "../components/pick-list.js";

/** Bind clicks to the wizard this frame drew, including non-store mounts. */
export function renderPickList(
  props: Omit<PickListProps, "onSelect" | "onActivate" | "onPasteText"> & {
    wizard: ProvidersWizardState;
    route?: WizardMouseRoute;
  },
): ReactElement {
  const route = props.route ?? storeWizardMouseRoute;
  return renderSharedPickList({
    ...props,
    onSelect: (mouse, cursor) => route.select(mouse, props.wizard, cursor),
    onActivate: (mouse) => route.activate(mouse, props.wizard),
    onPasteText: pasteIntoProvidersWizard,
  });
}
