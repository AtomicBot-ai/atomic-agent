import { describe, expect, it } from "vitest";

import { sanitizeLlmFailureTags } from "./llm-failure-tags.js";

/**
 * ATO-2418: a taken managed port (`port_holder: other_process`) sends the
 * same engine words as a refusal, and both say whether the managed port
 * is the shipped one.
 */
describe("sanitizeLlmFailureTags: a taken managed port (ATO-2418)", () => {
  it("sends the engine liveness, its lock, the exit reason and the port source", () => {
    expect(sanitizeLlmFailureTags({
      providerId: "local-llama",
      localEngine: "atomic-core",
      daemonState: "no_pid",
      portHeldByOther: true,
      engineLiveness: "no_pid",
      engineLivenessReason: "no_pid_file",
      engineLock: "free",
      engineExitReason: "port_in_use",
      managedPortCustom: false,
    })).toEqual({
      provider_id: "local-llama",
      local_engine: "atomic-core",
      daemon_state: "no_pid",
      port_holder: "other_process",
      engine_liveness: "no_pid",
      engine_liveness_reason: "no_pid_file",
      engine_lock: "free",
      engine_exit_reason: "port_in_use",
      managed_port: "default",
    });
  });

  it("adds no refusal-only tags", () => {
    const tags = sanitizeLlmFailureTags({ localEngine: "atomic-core", portHeldByOther: true, engineLiveness: "dead" });
    expect(tags?.local_engine_alive).toBeUndefined();
    expect(tags?.refused_wait_ms).toBeUndefined();
  });

  it("sends custom for a moved or pinned port, on a refusal too", () => {
    expect(sanitizeLlmFailureTags({ localEngine: "llama-server", connectionRefused: true, managedPortCustom: true })?.managed_port).toBe("custom");
  });

  it("keeps the vocabulary: any other word is unknown", () => {
    const tags = sanitizeLlmFailureTags({
      localEngine: "atomic-core",
      portHeldByOther: true,
      engineLiveness: "pid 4242",
      engineExitReason: "bind /Users/someone/x",
    });
    expect(tags).toMatchObject({ engine_liveness: "unknown", engine_exit_reason: "unknown" });
    expect(JSON.stringify(tags)).not.toContain("someone");
  });

  it("sends nothing of the engine without a refusal or a taken port, or for an external engine", () => {
    const plain = sanitizeLlmFailureTags({ localEngine: "atomic-core", engineLiveness: "dead", managedPortCustom: true });
    expect(plain?.engine_liveness).toBeUndefined();
    expect(plain?.managed_port).toBeUndefined();
    const external = sanitizeLlmFailureTags({ localEngine: "external", portHeldByOther: true, engineLiveness: "dead", managedPortCustom: true });
    expect(external?.engine_liveness).toBeUndefined();
    expect(external?.managed_port).toBeUndefined();
  });
});
