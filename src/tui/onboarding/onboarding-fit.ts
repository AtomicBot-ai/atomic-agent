/**
 * Size tiers for the first-run surface. React-free so the breakpoints
 * can be unit-tested as a table rather than through rendered frames —
 * the same reasoning as `splash-fit.ts`.
 *
 * No tier ever blocks. A terminal too small for the full treatment gets
 * a smaller mark, shorter copy and one advisory line in the footer; every
 * key still works. Ink 7 overlaps rather than clips a frame taller than
 * the terminal, so each tier states the rows it is allowed to draw.
 */
export type OnboardingTier = "full" | "reduced" | "minimal";

/** Below this the surface drops to `reduced` and advertises the fact. */
export const ONBOARDING_FULL_COLUMNS = 100;
export const ONBOARDING_FULL_ROWS = 30;
/** Below this the reduced treatment trades its mark for the XS sign. */
export const ONBOARDING_MINIMAL_COLUMNS = 72;
export const ONBOARDING_MINIMAL_ROWS = 18;

/**
 * Which mark the header draws. Never "none": the two-row XS sign is no
 * taller than the bare two-line text lockup that used to replace the
 * mark, so even the minimal tier keeps the brand for free.
 */
export type OnboardingMark = "sm" | "xs";

export interface OnboardingFit {
  tier: OnboardingTier;
  /** Which brand mark the header draws. */
  mark: OnboardingMark;
  /** Two-line explainer above the choices, dropped when rows are tight. */
  explainer: boolean;
  /** Per-row detail text next to each choice. */
  rowDetails: boolean;
  /** Append "for the best experience, widen to 100 × 30" to the footer. */
  sizeAdvice: boolean;
}

export function computeOnboardingFit(size: {
  columns: number;
  rows: number;
}): OnboardingFit {
  const minimal =
    size.columns < ONBOARDING_MINIMAL_COLUMNS || size.rows < ONBOARDING_MINIMAL_ROWS;
  if (minimal) {
    return {
      tier: "minimal",
      mark: "xs",
      explainer: false,
      rowDetails: false,
      sizeAdvice: true,
    };
  }
  const full =
    size.columns >= ONBOARDING_FULL_COLUMNS && size.rows >= ONBOARDING_FULL_ROWS;
  if (full) {
    return {
      tier: "full",
      mark: "sm",
      explainer: true,
      rowDetails: true,
      sizeAdvice: false,
    };
  }
  return {
    tier: "reduced",
    mark: "sm",
    explainer: size.rows >= 22,
    rowDetails: size.columns >= 84,
    sizeAdvice: true,
  };
}

export const ONBOARDING_SIZE_ADVICE = `for the best experience, widen to ${ONBOARDING_FULL_COLUMNS} × ${ONBOARDING_FULL_ROWS}`;
