import { useEffect, useRef, useState } from "react";
import {
  ATOM_STEP_MS,
  createAtomField,
  stepAtoms,
  type AtomBounds,
  type AtomFieldState,
} from "../onboarding/atom-field.js";

/**
 * React hook: run the atom field while `active`, and stop dead when it
 * goes false or the component unmounts.
 *
 * Modelled on `use-typewriter.ts`. **One interval for the whole run.**
 * Bounds move with the terminal, and listing them in the effect's
 * dependencies would tear the timer down and arm a fresh one on every
 * resize; they are read through a ref inside the tick instead, so the
 * effect's only dependencies are the two things that should restart it.
 *
 * One `setState` per step, at one step per `stepMs` — the field must
 * never be the reason the download screen repaints.
 */
export function useAtomField(options: {
  active: boolean;
  columns: number;
  rows: number;
  count: number;
  seed: number;
  stepMs?: number;
}): AtomFieldState {
  const { active, columns, rows, count, seed } = options;
  const stepMs = options.stepMs ?? ATOM_STEP_MS;
  const boundsRef = useRef<AtomBounds>({ columns, rows });
  const [field, setField] = useState<AtomFieldState>(() =>
    createAtomField({ bounds: { columns, rows }, count, seed }),
  );

  useEffect(() => {
    boundsRef.current = { columns, rows };
  }, [columns, rows]);

  useEffect(() => {
    if (!active) return;
    const handle = setInterval(() => {
      setField((previous) => stepAtoms(previous, boundsRef.current));
    }, stepMs);
    return () => clearInterval(handle);
  }, [active, stepMs]);

  return field;
}
