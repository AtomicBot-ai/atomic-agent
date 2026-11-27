import { describe, expect, it } from "vitest";
import { httpSecretFinding, readArgScanThreshold } from "./http-body-secrets.js";

const GITHUB_PAT = "ghp_" + "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78";
const OWN = { label: "OPENROUTER_API_KEY", value: "own-secret-value-1234" };

describe("httpSecretFinding (ATO-2505)", () => {
  const url = new URL("https://collector.example/upload");

  it("finds a token shape in the body at 0.8", () => {
    expect(httpSecretFinding(url, `{"t":"${GITHUB_PAT}"}`, [])).toMatchObject({
      rule: "dangerous.http_secret",
      confidence: 0.8,
    });
  });

  it("finds a token shape in the query", () => {
    const withQuery = new URL(`https://collector.example/x?token=${GITHUB_PAT}`);
    expect(httpSecretFinding(withQuery, undefined, [])?.confidence).toBe(0.8);
  });

  it("finds the agent's own secret word for word at 1 and names it, not its value", () => {
    const finding = httpSecretFinding(url, `data=${OWN.value}`, [OWN]);
    expect(finding).toMatchObject({ confidence: 1 });
    expect(finding!.reason).toContain("OPENROUTER_API_KEY");
    expect(finding!.reason).not.toContain(OWN.value);
  });

  it("finds nothing in an ordinary body", () => {
    expect(httpSecretFinding(url, `{"name":"report","rows":3}`, [OWN])).toBeNull();
    expect(httpSecretFinding(url, undefined, [OWN])).toBeNull();
  });

  it("reads the threshold, falling back to 0.7", () => {
    expect(readArgScanThreshold(() => 0.9)).toBe(0.9);
    expect(readArgScanThreshold(undefined)).toBe(0.7);
    expect(readArgScanThreshold(() => Number.NaN)).toBe(0.7);
    expect(readArgScanThreshold(() => 0.1)).toBe(0.7);
    expect(
      readArgScanThreshold(() => {
        throw new Error("no config");
      }),
    ).toBe(0.7);
  });
});
