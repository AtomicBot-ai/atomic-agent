import type { ReactElement } from "react";
import { pressEnter } from "../mouse/mouse-list-row.js";
import { widestLine } from "../onboarding/centre-onboarding-block.js";
import { handleOnboardingStepKey } from "../onboarding/onboarding-step-keys.js";
import type { OnboardingHuggingFaceRepo } from "../onboarding/onboarding-state.js";
import {
  hfChoiceLine,
  HF_MMPROJ_LINE,
  HF_PICK_WINDOW,
  HfPickList,
  windowHfChoices,
} from "./hf-pick-list.js";

export { HF_PICK_WINDOW };

/**
 * Widest of the deterministic lines this step draws, for the block that
 * centres it. The RAM warning and the error line are left out: both are
 * transient, and a block that re-centres itself when one appears would
 * jump under the cursor.
 */
export function measureOnboardingHfPickStep(
  repo: OnboardingHuggingFaceRepo | null,
  cursor: number,
): number {
  if (!repo) return 0;
  const { visible, below } = windowHfChoices(repo, cursor);
  const lines = [repo.repoId, ...visible.map((choice) => hfChoiceLine(choice, true))];
  if (below > 0) lines.push(`   ↓ ${below} more`);
  if (repo.hidden) lines.push(`   ${repo.hidden}`);
  if (repo.mmproj) lines.push(HF_MMPROJ_LINE);
  return widestLine(lines);
}

/**
 * The first-run flow's quantisation picker: `HfPickList` wired to the
 * onboarding slice's cursor and to the flow's own key table, so a click
 * and the Enter key land on exactly the same catalog write. The Models
 * pane mounts the same list against its own state.
 */
export function OnboardingHuggingFacePickStep(props: {
  repo: OnboardingHuggingFaceRepo;
  cursor: number;
  ramGb: number;
  error: string | null;
}): ReactElement {
  return (
    <HfPickList
      repo={props.repo}
      cursor={props.cursor}
      ramGb={props.ramGb}
      error={props.error}
      onSelect={(cursor, mouse) =>
        mouse.dispatch({ type: "onboarding_cursor_set", cursor })
      }
      onActivate={pressEnter(handleOnboardingStepKey)}
    />
  );
}
