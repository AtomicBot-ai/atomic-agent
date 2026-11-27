import { afterEach, describe, expect, it } from "vitest";

import {
  rememberResolvedSecret,
  resetResolvedSecretValues,
} from "../sandbox/resolved-secret-values.js";
import { isMaskableSecretValue, maskSecrets, maskSecretsDeep } from "./secret-detector.js";

afterEach(() => resetResolvedSecretValues());

describe("values resolved from secret references are always masked (ATO-476, ATO-2339)", () => {
  it("masks a resolved value even when the caller passes its own list", () => {
    rememberResolvedSecret("DEPLOY_TOKEN", "noShape7value8here9");
    expect(maskSecrets("got noShape7value8here9 back", [{ label: "OTHER_KEY", value: "Other1Value2Long3" }])).toBe(
      "got [redacted:DEPLOY_TOKEN] back",
    );
    expect(maskSecretsDeep({ out: ["noShape7value8here9"] })).toEqual({ out: ["[redacted:DEPLOY_TOKEN]"] });
  });

  it("keeps masking an old value after the secret rotates", () => {
    rememberResolvedSecret("DEPLOY_TOKEN", "First1Value2Here3");
    rememberResolvedSecret("DEPLOY_TOKEN", "Second4Value5Here6");
    expect(maskSecrets("First1Value2Here3 Second4Value5Here6")).toBe(
      "[redacted:DEPLOY_TOKEN] [redacted:DEPLOY_TOKEN]",
    );
  });

  it("masks the base64, base64url and URL-encoded forms of a resolved value", () => {
    const value = "Enc0ded?Secret/Value+9";
    rememberResolvedSecret("DEPLOY_TOKEN", value);
    const b64 = Buffer.from(value).toString("base64");
    const b64Line = Buffer.from(`${value}\n`).toString("base64");
    const b64url = Buffer.from(value).toString("base64url");
    const url = encodeURIComponent(value);
    for (const form of [b64, b64.replace(/=+$/, ""), b64Line, b64url, url]) {
      expect(form).not.toBe(value);
      const masked = maskSecrets(`out: ${form} end`);
      expect(masked).not.toContain(form);
      expect(masked).toContain("[redacted:DEPLOY_TOKEN]");
    }
  });

  it("says which values the exact-value layer can mask", () => {
    expect(isMaskableSecretValue("Shell5Secret6Value7")).toBe(true);
    expect(isMaskableSecretValue("short1")).toBe(false);
    expect(isMaskableSecretValue("plainlowercaseword")).toBe(false);
  });
});
