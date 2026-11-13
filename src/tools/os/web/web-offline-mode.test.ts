import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalGate } from "../../../approval/approval-gate.js";
import type { runCommand as RunCommandType } from "../../../sandbox/command-runner.js";
import type { ToolContext } from "../../tool-registry.js";
import {
  OfflineNetworkError,
  egressSnapshot,
  resetOfflineNetworkForTests,
  setOfflineNetwork,
} from "../../../llm/offline-network.js";
import { buildOsWebFetchTool } from "./web-fetch.js";
import { buildOsHttpRequestTool } from "./http-request.js";
import { runCurl } from "./run-curl.js";

function ctx(): ToolContext {
  return {
    workingDir: "/tmp",
    sessionId: "s1",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

function neverRun(): typeof RunCommandType {
  return vi.fn(async () => {
    throw new Error("curl must not be started while offline");
  }) as unknown as typeof RunCommandType;
}

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

describe("web tools in offline mode (ATO-1084)", () => {
  afterEach(() => resetOfflineNetworkForTests());

  it("os.web.fetch refuses before DNS or curl", async () => {
    setOfflineNetwork(true);
    const run = neverRun();
    const lookup = vi.fn(publicLookup);
    const tool = buildOsWebFetchTool({ runCommand: run, lookup });
    const result = await tool.run({ url: "https://example.com/page" }, ctx());
    expect(result.status).toBe("error");
    expect(result.output).toContain("offline mode: example.com blocked");
    expect(result.details.offline).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(egressSnapshot().requestsBlocked).toBe(1);
  });

  it("os.http.request refuses before approval, DNS or curl", async () => {
    setOfflineNetwork(true);
    const run = neverRun();
    const emit = vi.fn();
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: new ApprovalGate({ emit }),
      approvalRequired: true,
      config: {
        http: {
          enabled: true,
          approvalMode: "always",
          hostAllowlist: null,
          maxResponseBytes: 1_048_576,
          defaultTimeoutMs: 30_000,
        },
      },
      runCommand: run,
    });
    const result = await tool.run(
      { url: "https://api.example.com/v1", method: "POST", body: "{}" },
      ctx(),
    );
    expect(result.status).toBe("error");
    expect(result.output).toContain("offline mode: api.example.com blocked");
    expect(run).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("leaves both tools alone while offline mode is off", async () => {
    const run = vi.fn(async () => ({
      stdout: "ok\n__ATOMIC_WEBFETCH_META__200|text/plain||2|",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      truncated: false,
    })) as unknown as typeof RunCommandType;
    const tool = buildOsWebFetchTool({ runCommand: run, lookup: publicLookup });
    const result = await tool.run({ url: "https://example.com/" }, ctx());
    expect(result.output).not.toContain("offline mode");
    expect(run).toHaveBeenCalled();
  });

  it("runCurl refuses a remote URL argument as a backstop, but not a local one", async () => {
    setOfflineNetwork(true);
    const run = neverRun();
    await expect(
      runCurl(run, ["-sS", "https://example.com/"], { cwd: "/tmp" }, { platform: "darwin" }),
    ).rejects.toBeInstanceOf(OfflineNetworkError);
    const local = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      truncated: false,
    })) as unknown as typeof RunCommandType;
    await runCurl(local, ["-sS", "http://127.0.0.1:9931/health"], { cwd: "/tmp" }, { platform: "darwin" });
    expect(local).toHaveBeenCalledTimes(1);
  });
});
