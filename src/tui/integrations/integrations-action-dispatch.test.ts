import { describe, expect, it, vi } from "vitest";

import type { IntegrationProbeResult } from "../../integrations/index.js";
import {
  dispatchIntegrationAction,
  type ActionDispatchDeps,
} from "./integrations-action-dispatch.js";

const TOKEN = "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz";

function deps(overrides: Partial<ActionDispatchDeps> = {}): ActionDispatchDeps {
  return {
    runtime: { discordChannel: null },
    probes: new Map<string, IntegrationProbeResult>(),
    env: {},
    ...overrides,
  };
}

function fetchAnswering(status: number, body: unknown): ActionDispatchDeps["fetchImpl"] {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  });
}

describe("dispatchIntegrationAction — github test", () => {
  it("records a successful probe and names the login", async () => {
    const d = deps({
      env: { GITHUB_TOKEN: TOKEN },
      fetchImpl: fetchAnswering(200, { login: "octocat" }),
    });
    const message = await dispatchIntegrationAction(d, "github", "test");
    expect(message).toMatch(/connected as octocat/);
    expect(d.probes.get("github")).toEqual({ ok: true, detail: "octocat" });
  });

  it("records a failed probe and surfaces the reason as the error", async () => {
    const d = deps({
      env: { GITHUB_TOKEN: TOKEN },
      fetchImpl: fetchAnswering(401, {}),
    });
    await expect(dispatchIntegrationAction(d, "github", "test")).rejects.toThrow(
      /401/,
    );
    expect(d.probes.get("github")).toMatchObject({ ok: false });
    expect(d.probes.get("github")!.detail).not.toContain(TOKEN);
  });

  it("refuses to probe without a token and forgets any earlier result", async () => {
    const d = deps({
      probes: new Map([["github", { ok: true, detail: "stale" }]]),
      fetchImpl: vi.fn(),
    });
    await expect(dispatchIntegrationAction(d, "github", "test")).rejects.toThrow(
      /no GitHub token/,
    );
    expect(d.probes.has("github")).toBe(false);
    expect(d.fetchImpl).not.toHaveBeenCalled();
  });

  it("still rejects an unknown verb", async () => {
    await expect(dispatchIntegrationAction(deps(), "github", "pair")).rejects.toThrow(
      /unknown action/,
    );
  });

  it("restarts Discord through the live channel", async () => {
    const stop = vi.fn(async () => undefined);
    const start = vi.fn(async () => undefined);
    const d = deps({
      runtime: { discordChannel: { stop, start } as never },
    });
    await expect(dispatchIntegrationAction(d, "discord", "restart")).resolves.toMatch(
      /restarted/,
    );
    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });
});
