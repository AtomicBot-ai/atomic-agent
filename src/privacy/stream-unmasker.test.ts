import { describe, expect, it } from "vitest";

import { PrivacyVault } from "./privacy-vault.js";
import { createStreamUnmasker, partialPlaceholderStart } from "./stream-unmasker.js";

function vaultWith(text: string): PrivacyVault {
  const vault = new PrivacyVault();
  vault.mask(text);
  return vault;
}

describe("partialPlaceholderStart", () => {
  it("holds a tail that could still become a placeholder", () => {
    expect(partialPlaceholderStart("hi [")).toBe(3);
    expect(partialPlaceholderStart("hi [EM")).toBe(3);
    expect(partialPlaceholderStart("hi [EMAIL_")).toBe(3);
    expect(partialPlaceholderStart("hi [EMAIL_12")).toBe(3);
  });

  it("releases a tail that cannot", () => {
    expect(partialPlaceholderStart("hi [EMAIL_1]")).toBe(12);
    expect(partialPlaceholderStart("arr[i")).toBe(5);
    expect(partialPlaceholderStart("see [link](x")).toBe(12);
    expect(partialPlaceholderStart("[NOPE")).toBe(5);
    expect(partialPlaceholderStart("no bracket")).toBe(10);
  });
});

describe("createStreamUnmasker (ATO-1081)", () => {
  it("restores a placeholder cut across chunks", () => {
    const vault = vaultWith("jane@example.com");
    const unmasker = createStreamUnmasker(vault);
    const chunks = ["Write to [EM", "AIL", "_1", "] today"];
    const shown = chunks.map((c) => unmasker.push(c)).join("") + unmasker.flush();
    expect(shown).toBe("Write to jane@example.com today");
  });

  it("restores every split position the same way", () => {
    const vault = vaultWith("a@b.io 4111111111111111");
    const reply = "Card [CARD_1] belongs to [EMAIL_1].";
    for (let cut = 1; cut < reply.length; cut += 1) {
      const unmasker = createStreamUnmasker(vault);
      const out = unmasker.push(reply.slice(0, cut)) + unmasker.push(reply.slice(cut)) + unmasker.flush();
      expect(out).toBe("Card 4111111111111111 belongs to a@b.io.");
    }
  });

  it("releases a held tail that turned out not to be a placeholder", () => {
    const vault = vaultWith("a@b.io");
    const unmasker = createStreamUnmasker(vault);
    expect(unmasker.push("x = arr[")).toBe("x = arr");
    expect(unmasker.push("0]")).toBe("[0]");
    expect(unmasker.push(" [EM")).toBe(" ");
    expect(unmasker.flush()).toBe("[EM");
  });

  it("JSON-escapes in tool-call argument streams", () => {
    const vault = new PrivacyVault(() => [{ label: "K", value: 'q"uoteValue9' }]);
    vault.mask('q"uoteValue9');
    const unmasker = createStreamUnmasker(vault, { json: true });
    const args = unmasker.push('{"v":"[SEC') + unmasker.push('RET_1]"}') + unmasker.flush();
    expect(JSON.parse(args)).toEqual({ v: 'q"uoteValue9' });
  });
});
