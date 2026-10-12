import { expect, it } from "vitest";
import { ATOMIC_CORE_EXPERIMENTAL_ENV, atomicCoreChoiceEnabled } from "./experimental.js";

const config = (engine?: string) => ({ localModels: { managed: { engine } } });

it("hides the Atomic Chat choice unless opted in", () => {
  expect(atomicCoreChoiceEnabled(config("llama-server"), {})).toBe(false);
  expect(atomicCoreChoiceEnabled(config(), {})).toBe(false);
  expect(atomicCoreChoiceEnabled(config("llama-server"), { [ATOMIC_CORE_EXPERIMENTAL_ENV]: "0" })).toBe(false);
  expect(atomicCoreChoiceEnabled(config("llama-server"), { [ATOMIC_CORE_EXPERIMENTAL_ENV]: "true" })).toBe(false);
});

it("offers it with the opt-in variable set to 1", () => {
  expect(atomicCoreChoiceEnabled(config("llama-server"), { [ATOMIC_CORE_EXPERIMENTAL_ENV]: "1" })).toBe(true);
});

it("keeps it for a saved atomic-core config without the variable", () => {
  expect(atomicCoreChoiceEnabled(config("atomic-core"), {})).toBe(true);
});
