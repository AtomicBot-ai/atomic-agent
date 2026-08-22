import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import { ATOM_COLLISION_COLOR, OnboardingAtomField } from "./onboarding-atom-field.js";
import {
  ATOM_COLLISION_GLYPH,
  ATOM_GLYPH,
  COLLISION_STEPS,
  type Atom,
  type AtomFieldState,
} from "../onboarding/atom-field.js";
import { THEMES, THEME_NAMES } from "../theme/theme.js";

const strip = (s: string): string => s.replace(/\[[0-9;]*m/g, "");

function field(over: Partial<Atom> = {}): AtomFieldState {
  const atom: Atom = {
    id: 1,
    column: 6,
    row: 2,
    columnVelocity: 0.6,
    rowVelocity: 0.27,
    hotSteps: 0,
    lifeSteps: 30,
    dormantSteps: 0,
    ...over,
  };
  return { atoms: [atom], seed: 1, step: 0, nextId: 2 };
}

describe("OnboardingAtomField", () => {
  it("draws exactly the rows it was given, blank ones included", () => {
    const view = render(<OnboardingAtomField field={field()} columns={40} rows={6} />);
    expect(strip(view.lastFrame() ?? "").split("\n")).toHaveLength(6);
    view.unmount();
  });

  it("puts the atom on its own row and leaves the others empty", () => {
    const view = render(<OnboardingAtomField field={field()} columns={40} rows={6} />);
    const rows = strip(view.lastFrame() ?? "").split("\n");
    expect(rows[2]).toContain(ATOM_GLYPH);
    expect(rows.filter((row) => row.trim().length > 0)).toHaveLength(1);
    view.unmount();
  });

  it("shows a collision as a different glyph in the same cells", () => {
    // `ink-testing-library` renders with colour off, and so do NO_COLOR
    // terminals and monochrome ones — which is exactly why the stripped
    // frame has to carry the collision by itself. Shape changes, cells
    // do not: swapping the marker back yields the resting frame.
    const cold = render(<OnboardingAtomField field={field()} columns={40} rows={6} />);
    const hot = render(
      <OnboardingAtomField
        field={field({ hotSteps: COLLISION_STEPS })}
        columns={40}
        rows={6}
      />,
    );
    const coldFrame = strip(cold.lastFrame() ?? "");
    const hotFrame = strip(hot.lastFrame() ?? "");
    expect(coldFrame).toContain(ATOM_GLYPH);
    expect(hotFrame).toContain(ATOM_COLLISION_GLYPH);
    expect(hotFrame).not.toContain(ATOM_GLYPH);
    expect(hotFrame.replace(ATOM_COLLISION_GLYPH, ATOM_GLYPH)).toBe(coldFrame);
    cold.unmount();
    hot.unmount();
  });

  it("keeps the collision colour out of every palette, on purpose", () => {
    // The one deliberate exception to the theme tokens. If some palette
    // ever adopts this green, the collision stops reading as an event
    // and starts reading as a state.
    for (const name of THEME_NAMES) {
      expect(Object.values(THEMES[name].colors)).not.toContain(ATOM_COLLISION_COLOR);
    }
  });
});
