import { describe, expect, it } from "vitest";

import { PrivacyVault } from "./privacy-vault.js";

describe("PrivacyVault (ATO-599)", () => {
  it("masks with stable, numbered placeholders and unmasks them back", () => {
    const vault = new PrivacyVault();
    const text = "Email jane@example.com and bob@example.org, again jane@example.com.";
    const masked = vault.mask(text);
    expect(masked).toBe("Email [EMAIL_1] and [EMAIL_2], again [EMAIL_1].");
    expect(vault.unmask(masked)).toBe(text);
    // Same value, later call: same placeholder.
    expect(vault.mask("cc jane@example.com")).toBe("cc [EMAIL_1]");
  });

  it("numbers each kind on its own", () => {
    const vault = new PrivacyVault();
    expect(vault.mask("a@b.io 4111111111111111 c@d.io")).toBe("[EMAIL_1] [CARD_1] [EMAIL_2]");
    expect(vault.stats().byKind).toMatchObject({ EMAIL: 2, CARD: 1, PHONE: 0 });
    expect(vault.stats().distinct).toBe(3);
  });

  it("keeps masking a value it has seen, even where the detector would not find it", () => {
    const vault = new PrivacyVault();
    vault.mask("API_TOKEN=Zx9vQ2mL7pR4tY8wK1nB");
    expect(vault.mask("now bare: Zx9vQ2mL7pR4tY8wK1nB")).toBe("now bare: [SECRET_1]");
  });

  it("leaves placeholders it did not mint alone", () => {
    const vault = new PrivacyVault();
    vault.mask("a@b.io");
    expect(vault.unmask("[EMAIL_1] [EMAIL_9] [FOO_1]")).toBe("a@b.io [EMAIL_9] [FOO_1]");
  });

  it("JSON-escapes restored values for tool-call arguments", () => {
    const vault = new PrivacyVault(() => [{ label: "K", value: 'pa"ss\\w0rdXYZ' }]);
    const masked = vault.mask('secret is pa"ss\\w0rdXYZ');
    expect(masked).toBe("secret is [SECRET_1]");
    const args = `{"text":"${"[SECRET_1]"}"}`;
    const restored = vault.unmask(args, { json: true });
    expect(JSON.parse(restored)).toEqual({ text: 'pa"ss\\w0rdXYZ' });
  });

  it("walks objects and arrays without mutating them", () => {
    const vault = new PrivacyVault();
    const input = { role: "user", content: [{ type: "text", text: "mail a@b.io" }], n: 1 };
    const masked = vault.maskDeep(input);
    expect(masked).toEqual({ role: "user", content: [{ type: "text", text: "mail [EMAIL_1]" }], n: 1 });
    expect(input.content[0]!.text).toBe("mail a@b.io");
    expect(vault.unmaskDeep(masked)).toEqual(input);
    // Nothing to mask: the same object back.
    const clean = { a: ["x", { b: "y" }] };
    expect(vault.maskDeep(clean)).toBe(clean);
  });

  it("counts distinct values per request and requests with something masked", () => {
    const vault = new PrivacyVault();
    vault.beginRequest();
    vault.mask("a@b.io a@b.io");
    vault.mask("c@d.io");
    vault.endRequest();
    expect(vault.stats()).toMatchObject({ distinct: 2, lastRequest: 2, maskedRequests: 1 });
    vault.beginRequest();
    vault.mask("nothing here");
    vault.endRequest();
    expect(vault.stats()).toMatchObject({ distinct: 2, lastRequest: 0, maskedRequests: 1 });
  });
});
