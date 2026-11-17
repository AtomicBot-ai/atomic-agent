import { describe, expect, it } from "vitest";

import { findPrivateSpans, findSecretSpans } from "./detect-private-data.js";

const kinds = (text: string) => findPrivateSpans(text).map((s) => [s.kind, s.value]);

describe("findPrivateSpans (ATO-599)", () => {
  it("finds emails", () => {
    expect(kinds("write to jane.doe+work@example.co.uk today")).toEqual([
      ["EMAIL", "jane.doe+work@example.co.uk"],
    ]);
  });

  it("finds card numbers that pass Luhn, grouped or not", () => {
    expect(kinds("card 4111 1111 1111 1111 exp 12/29")).toEqual([["CARD", "4111 1111 1111 1111"]]);
    expect(kinds("card 5555-5555-5555-4444.")).toEqual([["CARD", "5555-5555-5555-4444"]]);
    expect(kinds("amex 378282246310005")).toEqual([["CARD", "378282246310005"]]);
  });

  it("leaves digit runs that are not cards alone", () => {
    // Fails Luhn.
    expect(kinds("order 4111 1111 1111 1112")).toEqual([]);
    // A millisecond timestamp, a version, a git-ish id.
    expect(kinds("at 1731916800000 v1.2.3 id 4532015112830366abc")).toEqual([]);
  });

  it("finds IBANs that pass mod 97", () => {
    expect(kinds("IBAN DE89 3704 0044 0532 0130 00 please")).toEqual([
      ["IBAN", "DE89 3704 0044 0532 0130 00"],
    ]);
    expect(kinds("to GB82WEST12345698765432")).toEqual([["IBAN", "GB82WEST12345698765432"]]);
    expect(kinds("DE89 3704 0044 0532 0130 01")).toEqual([]);
  });

  it("finds international and bracketed phone numbers, not bare digits", () => {
    expect(kinds("call +1 (555) 123-4567 now")).toEqual([["PHONE", "+1 (555) 123-4567"]]);
    expect(kinds("тел. +7 912 345-67-89")).toEqual([["PHONE", "+7 912 345-67-89"]]);
    expect(kinds("or 8 (912) 345-67-89")).toEqual([["PHONE", "8 (912) 345-67-89"]]);
    expect(kinds("office (555) 123-4567")).toEqual([["PHONE", "(555) 123-4567"]]);
    expect(kinds("port 5551234567 and 2026-11-18")).toEqual([]);
    expect(kinds("1+2 = 3")).toEqual([]);
  });

  it("finds keys through the shared secret detector", () => {
    const key = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd";
    const spans = findPrivateSpans(`use ${key} for this`);
    expect(spans).toEqual([{ kind: "SECRET", value: key, start: 4, end: 4 + key.length }]);
    expect(kinds("export API_TOKEN=Zx9vQ2mL7pR4tY8wK1nB")).toEqual([["SECRET", "Zx9vQ2mL7pR4tY8wK1nB"]]);
    expect(kinds("postgres://app:hunter2secret@db:5432/x")).toEqual([["SECRET", "hunter2secret"]]);
  });

  it("finds an exact known value with no recognisable shape", () => {
    const spans = findPrivateSpans("the key is Qm9vYXJ0aG9sb21ldzEy ok", [
      { label: "MY_SERVICE_KEY", value: "Qm9vYXJ0aG9sb21ldzEy" },
    ]);
    expect(spans.map((s) => s.value)).toEqual(["Qm9vYXJ0aG9sb21ldzEy"]);
  });

  it("gives an overlap to the stronger kind and returns spans in order", () => {
    const text = "mail a@b.io, key ghp_abcdefghijklmnopqrstuvwxyz0123456789, card 4111111111111111";
    expect(findPrivateSpans(text).map((s) => s.kind)).toEqual(["EMAIL", "SECRET", "CARD"]);
    for (const span of findPrivateSpans(text)) expect(text.slice(span.start, span.end)).toBe(span.value);
  });

  it("returns nothing for ordinary text", () => {
    expect(kinds("Refactor the parser and run the tests in src/llm.")).toEqual([]);
    expect(kinds("[EMAIL_1] and [CARD_2] are placeholders")).toEqual([]);
  });
});

describe("findSecretSpans", () => {
  it("splits two secrets that sit next to each other in one text", () => {
    const a = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const b = "xoxb-1234567890-abcdefghij";
    const text = `a=${a} b=${b}`;
    expect(findSecretSpans(text).map((s) => s.value)).toEqual([a, b]);
  });

  it("does not take a marker already in the text for a secret", () => {
    expect(findSecretSpans("key [redacted:openai-key] was hidden")).toEqual([]);
  });
});
