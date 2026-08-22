import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import { ATOM_COLLISION_COLOR, OnboardingAtomField } from "./onboarding-atom-field.js";
import {
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

  it("draws a collided atom in the same cells as a resting one", () => {
    // Colour is the only difference, and `ink-testing-library` renders
    // with colour off, so the frame can only say that the collision
    // changes nothing about the geometry. Which cells go hot is asserted
    // on `buildAtomRows`, where it is a value rather than an escape code.
    const cold = render(<OnboardingAtomField field={field()} columns={40} rows={6} />);
    const hot = render(
      <OnboardingAtomField
        field={field({ hotSteps: COLLISION_STEPS })}
        columns={40}
        rows={6}
      />,
    );
    expect(strip(hot.lastFrame() ?? "")).toBe(strip(cold.lastFrame() ?? ""));
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
