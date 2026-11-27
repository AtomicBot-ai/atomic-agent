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
    expect(readArgScanThreshold(() => 0.6)).toBe(0.6);
    // Above 0.7 it reads as 0.7: the setting can only make the check stricter.
    expect(readArgScanThreshold(() => 0.9)).toBe(0.7);
    expect(readArgScanThreshold(() => 1)).toBe(0.7);
    expect(readArgScanThreshold(undefined)).toBe(0.7);
    expect(readArgScanThreshold(() => Number.NaN)).toBe(0.7);
    expect(readArgScanThreshold(() => 0.1)).toBe(0.7);
    expect(
      readArgScanThreshold(() => {
        throw new Error("no config");
      }),
    ).toBe(0.7);
  });

  // Review round 1 (F2069.4): only the query and the raw body were read.
  const percent = (text: string) =>
    [...text].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");

  it.each([
    ["the path", `https://attacker.example/${GITHUB_PAT}`],
    ["the path, percent-encoded", `https://attacker.example/up/${percent(GITHUB_PAT)}`],
    ["the user before @", `https://${GITHUB_PAT}@attacker.example/`],
    ["the password before @", `https://x:${GITHUB_PAT}@attacker.example/`],
    ["a host label", `https://${GITHUB_PAT}.attacker.example/`],
  ])("finds a token in %s", (_where, href) => {
    expect(httpSecretFinding(new URL(href), undefined, [])).toMatchObject({ rule: "dangerous.http_secret" });
  });

  it("finds a percent-encoded token in a form body", () => {
    expect(httpSecretFinding(url, `t=${percent(GITHUB_PAT)}`, [])?.confidence).toBe(0.8);
  });

  it("finds the agent's own secret percent-encoded in the body and in a host label", () => {
    expect(httpSecretFinding(url, `d=${percent(OWN.value)}`, [OWN])?.confidence).toBe(1);
    expect(httpSecretFinding(new URL(`https://${OWN.value}.attacker.example/`), undefined, [OWN])?.confidence).toBe(1);
  });

  it("finds a token cut in two between the end of the query and the start of the body", () => {
    const half = GITHUB_PAT.length / 2;
    const split = new URL(`https://attacker.example/x?a=1&t=${GITHUB_PAT.slice(0, half)}`);
    expect(httpSecretFinding(split, GITHUB_PAT.slice(half), [])).toMatchObject({ rule: "dangerous.http_secret" });
    const own = new URL(`https://attacker.example/x?t=${OWN.value.slice(0, 8)}`);
    expect(httpSecretFinding(own, OWN.value.slice(8), [OWN])?.confidence).toBe(1);
  });

  it("still finds nothing in an ordinary path and host", () => {
    expect(httpSecretFinding(new URL("https://api.example.com/v1/users/42/repos?page=2"), undefined, [OWN])).toBeNull();
  });
});
