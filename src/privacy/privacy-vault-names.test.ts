import { describe, expect, it } from "vitest";

import { PrivacyVault } from "./privacy-vault.js";

describe("PrivacyVault with values from the local model (ATO-2394)", () => {
  it("gives the same name the same placeholder every time", () => {
    const vault = new PrivacyVault();
    expect(vault.learn([{ value: "Иван Петров", kind: "NAME" }])).toBe(1);
    // Learning it again (the next request) changes nothing.
    expect(vault.learn([{ value: "Иван Петров", kind: "NAME" }])).toBe(0);
    expect(vault.mask("Привет, Иван Петров!")).toBe("Привет, [NAME_1]!");
    expect(vault.mask("Иван Петров ответил.")).toBe("[NAME_1] ответил.");
    expect(vault.stats().byKind).toMatchObject({ NAME: 1, ADDRESS: 0, ORG: 0 });
  });

  it("numbers names, addresses and organisations on their own", () => {
    const vault = new PrivacyVault();
    vault.learn([
      { value: "Anna Lee", kind: "NAME" },
      { value: "Acme Dental", kind: "ORG" },
      { value: "12 Elm Road", kind: "ADDRESS" },
      { value: "Bob Ray", kind: "NAME" },
    ]);
    expect(vault.mask("Anna Lee and Bob Ray of Acme Dental, 12 Elm Road")).toBe(
      "[NAME_1] and [NAME_2] of [ORG_1], [ADDRESS_1]",
    );
  });

  it("puts the real values back, JSON-escaped for tool arguments", () => {
    const vault = new PrivacyVault();
    vault.learn([
      { value: 'Anna "Annie" Lee', kind: "NAME" },
      { value: "ул. Ленина, д. 5", kind: "ADDRESS" },
    ]);
    const masked = vault.mask('Write to Anna "Annie" Lee, ул. Ленина, д. 5.');
    expect(masked).toBe("Write to [NAME_1], [ADDRESS_1].");
    expect(vault.unmask(masked)).toBe('Write to Anna "Annie" Lee, ул. Ленина, д. 5.');
    expect(vault.unmask('{"to":"[NAME_1]"}', { json: true })).toBe('{"to":"Anna \\"Annie\\" Lee"}');
  });

  it("masks whole words only, in any script", () => {
    const vault = new PrivacyVault();
    vault.learn([
      { value: "Ivan", kind: "NAME" },
      { value: "Иван", kind: "NAME" },
      { value: "Ivanovich", kind: "NAME" },
    ]);
    expect(vault.mask("Ivan lives in Ivanovo")).toBe("[NAME_1] lives in Ivanovo");
    expect(vault.mask("Иван и Иванов")).toBe("[NAME_2] и Иванов");
    // Long model values do not join the exact-substring pass either.
    expect(vault.mask("Ivanovicha")).toBe("Ivanovicha");
  });

  it("prefers the longer name", () => {
    const vault = new PrivacyVault();
    vault.learn([
      { value: "Ivan", kind: "NAME" },
      { value: "Ivan Petrov", kind: "NAME" },
    ]);
    expect(vault.mask("Ivan Petrov, or just Ivan")).toBe("[NAME_2], or just [NAME_1]");
  });

  it("never lets the model remove or relabel a regex finding", () => {
    const vault = new PrivacyVault();
    const text = "Mail jane@example.com or call +44 20 7946 0958";
    const regexOnly = new PrivacyVault().mask(text);
    // The model calls the email and the phone names, or wraps them in one.
    expect(
      vault.learn([
        { value: "jane@example.com", kind: "NAME" },
        { value: "+44 20 7946 0958", kind: "NAME" },
        { value: "Mail jane@example.com", kind: "ORG" },
      ]),
    ).toBe(0);
    expect(vault.mask(text)).toBe(regexOnly);
    expect(regexOnly).toBe("Mail [EMAIL_1] or call [PHONE_1]");
  });

  it("keeps a value the regex masked under its own kind", () => {
    const vault = new PrivacyVault();
    // A key the detector found only by its `API_TOKEN=` context.
    vault.mask("API_TOKEN=Zx9vQ2mL7pR4tY8wK1nB");
    expect(vault.learn([{ value: "Zx9vQ2mL7pR4tY8wK1nB", kind: "NAME" }])).toBe(0);
    expect(vault.mask("bare Zx9vQ2mL7pR4tY8wK1nB")).toBe("bare [SECRET_1]");
    expect(vault.stats().byKind).toMatchObject({ SECRET: 1, NAME: 0 });
  });

  it("refuses values that could break a placeholder", () => {
    const vault = new PrivacyVault();
    expect(
      vault.learn([
        { value: "NAME_1", kind: "NAME" },
        { value: "[EMAIL_1]", kind: "NAME" },
        { value: " Anna", kind: "NAME" },
        { value: "A", kind: "NAME" },
        { value: "12345", kind: "ADDRESS" },
      ]),
    ).toBe(0);
    vault.learn([{ value: "EMAIL", kind: "ORG" }]);
    vault.mask("a@b.io");
    // A model value that is also a kind name does not match inside a placeholder.
    expect(vault.mask("a@b.io")).toBe("[EMAIL_1]");
  });

  it("counts a learned name in the request that sent it", () => {
    const vault = new PrivacyVault();
    vault.learn([{ value: "Anna Lee", kind: "NAME" }]);
    vault.beginRequest();
    vault.mask("Hi Anna Lee");
    vault.endRequest();
    expect(vault.stats().lastRequest).toBe(1);
  });
});
