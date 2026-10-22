import { describe, expect, it } from "vitest";

import { TransportError } from "../llm/index.js";
import { scrubError } from "./error-scrubber.js";
import { sanitizeLlmFailureTags } from "./llm-failure-tags.js";
import { parseSentryDsn } from "./sentry-config.js";
import { buildEnvelope } from "./sentry-envelope.js";

const DSN = parseSentryDsn("https://pub@o1.ingest.sentry.io/7")!;
const META = { installId: "install-1", release: "1.2.3", platform: "darwin" };

function payloadOf(body: string): { tags: Record<string, string>; fingerprint: string[] } {
  return JSON.parse(body.trim().split("\n")[2]!);
}

describe("sanitizeLlmFailureTags", () => {
  it("passes fixed words and counts through", () => {
    expect(sanitizeLlmFailureTags({
      providerId: "local-llama",
      localEngine: "atomic-core",
      outageWaitedMs: 62_000,
      outageAttempts: 5,
      daemonState: "dead",
    })).toEqual({
      provider_id: "local-llama",
      local_engine: "atomic-core",
      outage_waited_ms: "62000",
      outage_attempts: "5",
      daemon_state: "dead",
    });
  });

  it("turns anything outside its vocabulary into unknown, never the value", () => {
    const tags = sanitizeLlmFailureTags({
      providerId: "acme-internal-gpu-box",
      localEngine: "/Users/someone/llama-server",
      outageWaitedMs: Number.NaN,
      outageAttempts: -1,
      daemonState: "pid 4242 on :8080",
    });
    expect(tags).toEqual({
      provider_id: "unknown",
      local_engine: "unknown",
      outage_waited_ms: "unknown",
      outage_attempts: "unknown",
      daemon_state: "unknown",
    });
  });

  it("keeps preset provider ids", () => {
    expect(sanitizeLlmFailureTags({ providerId: "groq" })).toEqual({ provider_id: "groq" });
  });

  it("drops daemon_state for an external engine", () => {
    expect(sanitizeLlmFailureTags({ localEngine: "external", daemonState: "dead" })).toEqual({
      local_engine: "external",
    });
  });

  it("returns undefined when there is nothing to tag", () => {
    expect(sanitizeLlmFailureTags(undefined)).toBeUndefined();
    expect(sanitizeLlmFailureTags({})).toBeUndefined();
  });
});

describe("llm_failure context through scrubber and envelope", () => {
  const refused = () => new TransportError("fetch failed", null, "http://127.0.0.1:8080/v1");

  it("a refused local-llama turn on a dead pid carries engine, daemon and wait tags", () => {
    const ev = scrubError(refused(), {
      source: "llm_failure",
      category: "transport",
      llmFailure: {
        providerId: "local-llama",
        localEngine: "llama-server",
        outageWaitedMs: 300_000,
        outageAttempts: 12,
        daemonState: "dead",
      },
    });
    const { tags } = payloadOf(buildEnvelope(DSN, ev, META).body);
    expect(tags).toMatchObject({
      transport_host: "localhost",
      provider_id: "local-llama",
      local_engine: "llama-server",
      outage_waited_ms: "300000",
      outage_attempts: "12",
      daemon_state: "dead",
    });
    expect(JSON.stringify(tags)).not.toContain("8080");
  });

  it("the new tags never change the fingerprint", () => {
    const bare = scrubError(refused(), { source: "llm_failure", category: "transport" });
    const tagged = scrubError(refused(), {
      source: "llm_failure",
      category: "transport",
      llmFailure: { providerId: "local-llama", localEngine: "atomic-core", daemonState: "no_pid" },
    });
    expect(payloadOf(buildEnvelope(DSN, tagged, META).body).fingerprint).toEqual(
      payloadOf(buildEnvelope(DSN, bare, META).body).fingerprint,
    );
    expect(payloadOf(buildEnvelope(DSN, bare, META).body).tags.local_engine).toBeUndefined();
  });
});
