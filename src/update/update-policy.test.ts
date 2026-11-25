import { afterEach, describe, expect, it } from "vitest";

import { checkForAppUpdate, resetAppReleaseCache } from "./check-app-update.js";
import {
  EMPTY_UPDATE_POLICY,
  parseUpdatePolicy,
  requiredUpdateReason,
  requiredUpdateText,
} from "./update-policy.js";

const marker = (json: string): string =>
  `## Fixes\n\nSomething.\n\n<!-- atomic-agent-update-policy: ${json} -->\n`;

describe("parseUpdatePolicy (ATO-1125)", () => {
  it("is empty for release notes without the comment", () => {
    expect(parseUpdatePolicy("## Fixes\n\n- a fix\n")).toEqual(EMPTY_UPDATE_POLICY);
    expect(parseUpdatePolicy(null)).toEqual(EMPTY_UPDATE_POLICY);
    expect(parseUpdatePolicy("")).toEqual(EMPTY_UPDATE_POLICY);
  });

  it("reads minimum and broken, dropping a leading v", () => {
    expect(parseUpdatePolicy(marker('{"minimum":"v0.6.12","broken":["0.6.10","v0.6.11"]}'))).toEqual({
      minimum: "0.6.12",
      broken: ["0.6.10", "0.6.11"],
    });
  });

  it("treats broken JSON or junk values as no policy for that field", () => {
    expect(parseUpdatePolicy(marker("{not json}"))).toEqual(EMPTY_UPDATE_POLICY);
    expect(parseUpdatePolicy(marker('{"minimum":"soon","broken":["x",3,"0.6.10"]}'))).toEqual({
      minimum: null,
      broken: ["0.6.10"],
    });
  });
});

describe("requiredUpdateReason", () => {
  const policy = { minimum: "0.6.12", broken: ["0.6.13"] };

  it("requires a listed version and one below the minimum", () => {
    expect(requiredUpdateReason("0.6.13", "0.7.0", policy)).toBe("broken");
    expect(requiredUpdateReason("0.6.11", "0.7.0", policy)).toBe("below-minimum");
  });

  it("does not require anything of a version that is fine", () => {
    expect(requiredUpdateReason("0.6.12", "0.7.0", policy)).toBeNull();
    expect(requiredUpdateReason("0.6.11", "0.7.0", EMPTY_UPDATE_POLICY)).toBeNull();
  });

  it("never requires an update that is not newer, nor one to a broken release", () => {
    expect(requiredUpdateReason("0.7.0", "0.7.0", { minimum: "0.8.0", broken: ["0.7.0"] })).toBeNull();
    expect(requiredUpdateReason("0.6.11", "0.6.13", policy)).toBeNull();
  });

  it("has a line for each reason and none for null", () => {
    expect(requiredUpdateText("broken")).toMatch(/known problem/);
    expect(requiredUpdateText("below-minimum")).toMatch(/no longer supported/);
    expect(requiredUpdateText(null)).toBeNull();
  });
});

describe("checkForAppUpdate reads the policy from the latest release", () => {
  afterEach(() => resetAppReleaseCache());

  const fakeFetch = (body: unknown): typeof fetch =>
    (async () =>
      new Response(JSON.stringify({ tag_name: "v0.7.0", body }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

  it("flags a broken running version", async () => {
    const result = await checkForAppUpdate({
      currentVersion: "0.6.13",
      fetchImpl: fakeFetch(marker('{"broken":["0.6.13"]}')),
      force: true,
    });
    expect(result.updateAvailable).toBe(true);
    expect(result.updateRequired).toBe(true);
    expect(result.requiredReason).toBe("broken");
  });

  it("is a plain update when the release lists nothing", async () => {
    const result = await checkForAppUpdate({
      currentVersion: "0.6.13",
      fetchImpl: fakeFetch("## Fixes\n"),
      force: true,
    });
    expect(result.updateAvailable).toBe(true);
    expect(result.updateRequired).toBe(false);
    expect(result.requiredReason).toBeNull();
  });

  it("survives a release without a body", async () => {
    const result = await checkForAppUpdate({
      currentVersion: "0.6.13",
      fetchImpl: fakeFetch(null),
      force: true,
    });
    expect(result.updateRequired).toBe(false);
  });
});
