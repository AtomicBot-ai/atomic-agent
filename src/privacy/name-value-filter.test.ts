import { describe, expect, it } from "vitest";

import { PrivacyVault } from "./privacy-vault.js";
import { refineFoundValues } from "./name-value-filter.js";

describe("refineFoundValues (ATO-2527)", () => {
  it("drops keep-list words and lower-case organisations", () => {
    expect(
      refineFoundValues([
        { value: "support", kind: "ORG" },
        { value: "Support", kind: "ORG" },
        { value: "бухгалтерия", kind: "ORG" },
        { value: "the team", kind: "ORG" },
        { value: "Claude", kind: "NAME" },
        { value: "Acme Logistics", kind: "ORG" },
        { value: "ООО Ромашка", kind: "ORG" },
        { value: "school 57", kind: "ORG" },
      ]),
    ).toEqual([
      { value: "Acme Logistics", kind: "ORG" },
      { value: "ООО Ромашка", kind: "ORG" },
      { value: "school 57", kind: "ORG" },
    ]);
  });

  it("keeps a lower-case name: people type names that way", () => {
    expect(refineFoundValues([{ value: "иван", kind: "NAME" }])).toEqual([{ value: "иван", kind: "NAME" }]);
  });

  it("adds each capitalised part of a multi-word name, after the full name, titles left out", () => {
    expect(
      refineFoundValues([
        { value: "Иван Петров", kind: "NAME" },
        { value: "Dr Anna-Maria O'Neil", kind: "NAME" },
        { value: "Петров", kind: "NAME" },
        { value: "Acme Logistics", kind: "ORG" },
      ]),
    ).toEqual([
      { value: "Иван Петров", kind: "NAME" },
      { value: "Иван", kind: "NAME" },
      { value: "Петров", kind: "NAME" },
      { value: "Dr Anna-Maria O'Neil", kind: "NAME" },
      { value: "Anna-Maria", kind: "NAME" },
      { value: "O'Neil", kind: "NAME" },
      { value: "Acme Logistics", kind: "ORG" },
    ]);
  });

  it("lets the vault mask a name split across two strings, full name first", () => {
    const vault = new PrivacyVault();
    vault.learn(refineFoundValues([{ value: "Иван Петров", kind: "NAME" }]));
    expect(vault.mask("Звонил Иван Петров")).toBe("Звонил [NAME_1]");
    expect(vault.mask("Call Иван")).toBe("Call [NAME_2]");
    expect(vault.mask(" Петров tomorrow")).toBe(" [NAME_3] tomorrow");
    expect(vault.mask("Ивановка")).toBe("Ивановка");
  });
});
