import { describe, expect, it, vi } from "vitest";

import { AnalyticsClient, createAnalyticsClient } from "./analytics-client.js";
import { CI_ENV_VARS, isCiEnvironment } from "./read-ci-environment.js";

describe("isCiEnvironment (ATO-272)", () => {
  it("is off with no CI variable", () => {
    expect(isCiEnvironment({})).toBe(false);
    expect(isCiEnvironment({ HOME: "/home/x", PATH: "/usr/bin" })).toBe(false);
  });

  it("is on for every known CI variable", () => {
    for (const name of CI_ENV_VARS) {
      expect(isCiEnvironment({ [name]: "true" })).toBe(true);
    }
    expect(isCiEnvironment({ CI: "1" })).toBe(true);
    expect(isCiEnvironment({ JENKINS_URL: "http://ci.example/" })).toBe(true);
  });

  it("is off when the variable is explicitly false or empty", () => {
    for (const v of ["", "0", "false", "FALSE", " no ", "off"]) {
      expect(isCiEnvironment({ CI: v })).toBe(false);
    }
  });
});

describe("AnalyticsClient automation tag (ATO-272)", () => {
  const posthog = () => ({ capture: vi.fn(), shutdown: vi.fn().mockResolvedValue(undefined) });

  it("still sends the event on CI, tagged on the event and the person", () => {
    const ph = posthog();
    const client = new AnalyticsClient({ installId: "x", platform: "linux", version: "1.0.0", automation: true, posthog: ph });
    client.capture("message_sent", { provider: "p" });
    expect(ph.capture).toHaveBeenCalledTimes(1);
    const props = ph.capture.mock.calls[0]![0]!.properties;
    expect(props.automation).toBe(true);
    expect(props.$set).toEqual({ automation: true });
    expect(props).not.toHaveProperty("test_run");
    expect(props.provider).toBe("p");
  });

  it("keeps both person tags on a team run on CI", () => {
    const ph = posthog();
    const client = new AnalyticsClient({ installId: "x", platform: "linux", version: "1.0.0", team: true, automation: true, posthog: ph });
    client.capture("message_sent");
    const props = ph.capture.mock.calls[0]![0]!.properties;
    expect(props.test_run).toBe(true);
    expect(props.automation).toBe(true);
    expect(props.$set).toEqual({ atomic_team: true, automation: true });
  });

  it("reads the CI variables from the env given to createAnalyticsClient", () => {
    const base = { enabled: true, installId: "x", platform: "linux", version: "1.0.0", team: false };
    const onCi = posthog();
    createAnalyticsClient({ ...base, posthog: onCi, env: { GITHUB_ACTIONS: "true" } })!.capture("app_opened");
    expect(onCi.capture.mock.calls[0]![0]!.properties.automation).toBe(true);

    const offCi = posthog();
    createAnalyticsClient({ ...base, posthog: offCi, env: {} })!.capture("app_opened");
    expect(offCi.capture.mock.calls[0]![0]!.properties).not.toHaveProperty("automation");
  });

  it("the kill switch still wins over the CI tag", () => {
    const client = createAnalyticsClient({
      enabled: true, installId: "x", platform: "linux", version: "1.0.0",
      posthog: posthog(), env: { CI: "true", ATOMIC_AGENT_ANALYTICS: "off" },
    });
    expect(client).toBeNull();
  });
});
