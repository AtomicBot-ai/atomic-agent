import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AnalyticsClient } from "./analytics-client.js";
import { isTeamRun, TEAM_RUN_MARKER_FILE } from "./read-team-run-marker.js";

const homes: string[] = [];
function home(withMarker: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "team-run-"));
  homes.push(dir);
  if (withMarker) writeFileSync(join(dir, TEAM_RUN_MARKER_FILE), "");
  return dir;
}
afterEach(() => {
  for (const d of homes.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("isTeamRun (ATO-1247)", () => {
  it("is off with no flag and no marker file", () => {
    expect(isTeamRun({}, home(false))).toBe(false);
  });

  it("is on with ATOMIC_AGENT_TEAM set to a yes value", () => {
    for (const v of ["1", "true", "YES", " on "]) {
      expect(isTeamRun({ ATOMIC_AGENT_TEAM: v }, home(false))).toBe(true);
    }
    for (const v of ["0", "false", "", "off"]) {
      expect(isTeamRun({ ATOMIC_AGENT_TEAM: v }, home(false))).toBe(false);
    }
  });

  it("is on when ~/.atomic-agent-team exists", () => {
    expect(isTeamRun({}, home(true))).toBe(true);
  });
});

describe("AnalyticsClient team tag (ATO-1247)", () => {
  const posthog = () => ({ capture: vi.fn(), shutdown: vi.fn().mockResolvedValue(undefined) });

  it("tags every event of a team run and sets the person property", () => {
    const ph = posthog();
    const client = new AnalyticsClient({ installId: "x", platform: "darwin", version: "1.0.0", team: true, posthog: ph });
    client.capture("message_sent", { provider: "p" });
    const props = ph.capture.mock.calls[0][0].properties;
    expect(props.test_run).toBe(true);
    expect(props.$set).toEqual({ atomic_team: true });
    expect(props.provider).toBe("p");
  });

  it("adds nothing for everyone else", () => {
    const ph = posthog();
    const client = new AnalyticsClient({ installId: "x", platform: "darwin", version: "1.0.0", posthog: ph });
    client.capture("message_sent");
    const props = ph.capture.mock.calls[0][0].properties;
    expect(props).not.toHaveProperty("test_run");
    expect(props).not.toHaveProperty("$set");
  });
});
