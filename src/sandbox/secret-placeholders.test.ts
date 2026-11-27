import { describe, expect, it } from "vitest";

import {
  SecretPlaceholderError,
  secretPlaceholderNames,
  substituteSecretPlaceholders,
} from "./secret-placeholders.js";

describe("secret placeholders (ATO-476)", () => {
  it("lists the names in first-use order, once each", () => {
    expect(
      secretPlaceholderNames(["curl", "-H", "Authorization: Bearer {{secret:API_TOKEN}}", "{{ secret:B_KEY }}", "{{secret:API_TOKEN}}"]),
    ).toEqual(["API_TOKEN", "B_KEY"]);
    expect(secretPlaceholderNames(["ls", "-la"])).toEqual([]);
  });

  it("refuses a malformed placeholder instead of passing it through", () => {
    expect(() => secretPlaceholderNames(["{{secret:}}"])).toThrow(SecretPlaceholderError);
    expect(() => secretPlaceholderNames(["{{secret:bad-name}}"])).toThrow(SecretPlaceholderError);
    expect(() => secretPlaceholderNames(["{{secret:OK}} and {{secret:9no}}"])).toThrow(SecretPlaceholderError);
  });

  it("substitutes only at the call, and fails on a name it has no value for", () => {
    const values = new Map([["API_TOKEN", "Tok3n-Value_42"]]);
    expect(substituteSecretPlaceholders("Bearer {{secret:API_TOKEN}}", values, { shell: false })).toBe(
      "Bearer Tok3n-Value_42",
    );
    expect(() => substituteSecretPlaceholders("{{secret:OTHER_TOKEN}}", values, { shell: false })).toThrow(
      "unknown secret OTHER_TOKEN",
    );
  });

  it("refuses, in a shell line, a value the shell would read as syntax; argv takes it as is", () => {
    const values = new Map([["PW_PASSWORD", "a$b c;rm -rf ~"]]);
    expect(substituteSecretPlaceholders("{{secret:PW_PASSWORD}}", values, { shell: false })).toBe("a$b c;rm -rf ~");
    let message = "";
    try {
      substituteSecretPlaceholders("echo {{secret:PW_PASSWORD}}", values, { shell: true });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/PW_PASSWORD holds characters a shell would read as syntax/);
    expect(message).not.toContain("rm -rf");
  });
});
