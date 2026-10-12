import { expect, it } from "vitest";
import { ATOMIC_CORE_EXPERIMENTAL_ENV, atomicCoreChoiceEnabled } from "./experimental.js";

it("always offers Atomic Chat, whatever the old opt-in variable says", () => {
  const config = (engine?: "llama-server" | "atomic-core") => ({ localModels: { managed: { ...(engine ? { engine } : {}) } } });
  expect(atomicCoreChoiceEnabled()).toBe(true);
  expect(atomicCoreChoiceEnabled(config("llama-server"), {})).toBe(true);
  expect(atomicCoreChoiceEnabled(config(), { [ATOMIC_CORE_EXPERIMENTAL_ENV]: "0" })).toBe(true);
  expect(atomicCoreChoiceEnabled(config("atomic-core"), {})).toBe(true);
});
