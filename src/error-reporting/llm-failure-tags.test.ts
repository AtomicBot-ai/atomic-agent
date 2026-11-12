import { describe, expect, it } from "vitest";

import { TransportError } from "../llm/index.js";
import { scrubError } from "./error-scrubber.js";
import {
  bucketRefusedWait,
  classifyPortClass,
  classifyRequestRoute,
  sanitizeLlmFailureTags,
} from "./llm-failure-tags.js";
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

  it("sends the managed engine's fault as a fixed word, never anything else (ATO-1279)", () => {
    expect(sanitizeLlmFailureTags({ localEngine: "llama-server", localFault: "out_of_memory" })).toEqual({
      local_engine: "llama-server",
      local_fault: "out_of_memory",
    });
    expect(sanitizeLlmFailureTags({ localFault: "server_crashed" })).toEqual({ local_fault: "server_crashed" });
    expect(sanitizeLlmFailureTags({ localFault: "GGML_ASSERT in /Users/me/src" })).toEqual({ local_fault: "unknown" });
    expect(sanitizeLlmFailureTags({ localEngine: "external", localFault: "none" })).toEqual({ local_engine: "external" });
  });

  it("returns undefined when there is nothing to tag", () => {
    expect(sanitizeLlmFailureTags(undefined)).toBeUndefined();
    expect(sanitizeLlmFailureTags({})).toBeUndefined();
  });
});

describe("request_route and port_class (ATO-872)", () => {
  it("classifies the request path into a fixed word", () => {
    expect(classifyRequestRoute("http://127.0.0.1:8080/v1/chat/completions")).toBe("chat_completions");
    expect(classifyRequestRoute("http://127.0.0.1:8080/chat/completions/")).toBe("chat_completions");
    expect(classifyRequestRoute("http://127.0.0.1:8080/completion")).toBe("completion");
    expect(classifyRequestRoute("http://127.0.0.1:8080/v1/completions")).toBe("completion");
    expect(classifyRequestRoute("http://127.0.0.1:8080/v1/embeddings")).toBe("other");
    expect(classifyRequestRoute("http://127.0.0.1:8080/secret/team/path")).toBe("other");
    expect(classifyRequestRoute("not a url")).toBe("unknown");
  });

  it("classifies the port into a fixed word", () => {
    expect(classifyPortClass("http://127.0.0.1:19091/v1/chat/completions", [19091])).toBe("managed");
    expect(classifyPortClass("http://127.0.0.1:8080/completion")).toBe("legacy_8080");
    expect(classifyPortClass("http://127.0.0.1:9931/completion")).toBe("default_9931");
    expect(classifyPortClass("http://127.0.0.1:1337/v1/chat/completions")).toBe("atomic_chat_1337");
    expect(classifyPortClass("http://localhost:11434/v1/chat/completions")).toBe("ollama_11434");
    expect(classifyPortClass("http://127.0.0.1:5005/v1/chat/completions")).toBe("other");
    expect(classifyPortClass("https://api.example.com/v1/chat/completions")).toBe("other");
    expect(classifyPortClass("not a url")).toBe("unknown");
  });

  it("a managed port wins over a well-known number", () => {
    expect(classifyPortClass("http://127.0.0.1:8080/completion", [8080])).toBe("managed");
  });

  it("tags route and port class, never the address, host or port number", () => {
    const tags = sanitizeLlmFailureTags({
      requestUrl: "http://gpu-box.internal:5005/team-a/v1/chat/completions",
      managedPorts: [19091],
    });
    expect(tags).toEqual({ request_route: "chat_completions", port_class: "other" });
    const text = JSON.stringify(tags);
    expect(text).not.toContain("gpu-box");
    expect(text).not.toContain("5005");
    expect(text).not.toContain("team-a");
  });

  it("adds no route tags when the request URL is unknown", () => {
    expect(sanitizeLlmFailureTags({ providerId: "local-llama" })).toEqual({ provider_id: "local-llama" });
  });
});

describe("local refusal tags (ATO-421, ATO-769)", () => {
  it("a refused managed turn on a dead process says the engine was not alive and how long it waited", () => {
    expect(sanitizeLlmFailureTags({
      providerId: "local-llama",
      localEngine: "atomic-core",
      outageWaitedMs: 8_000,
      connectionRefused: true,
      engineLiveness: "dead",
    })).toMatchObject({
      local_engine: "atomic-core",
      local_engine_alive: "no",
      refused_wait_ms: "8s_to_30s",
    });
  });

  it("maps every liveness to yes, no or unknown, never the raw value", () => {
    const alive = (engineLiveness: string | undefined) =>
      sanitizeLlmFailureTags({ localEngine: "llama-server", connectionRefused: true, ...(engineLiveness === undefined ? {} : { engineLiveness }) })?.local_engine_alive;
    expect(alive("alive")).toBe("yes");
    expect(alive("dead")).toBe("no");
    expect(alive("no_pid")).toBe("no");
    expect(alive("unknown")).toBe("unknown");
    expect(alive("pid 4242 at /Users/someone")).toBe("unknown");
    expect(alive(undefined)).toBe("unknown");
  });

  it("says why the managed engine was judged as it was, in fixed words only (ATO-1275)", () => {
    expect(sanitizeLlmFailureTags({
      localEngine: "atomic-core",
      connectionRefused: true,
      engineLiveness: "unknown",
      engineLivenessReason: "lock_held",
      engineLock: "held",
    })).toMatchObject({ engine_liveness: "unknown", engine_liveness_reason: "lock_held", engine_lock: "held" });
    const odd = sanitizeLlmFailureTags({
      localEngine: "atomic-core",
      connectionRefused: true,
      engineLiveness: "pid 4242",
      engineLivenessReason: "EACCES /Users/someone/.atomic-agent",
      engineLock: "/tmp/lock",
    });
    expect(odd).toMatchObject({ engine_liveness: "unknown", engine_liveness_reason: "unknown", engine_lock: "unknown" });
    expect(JSON.stringify(odd)).not.toContain("someone");
  });

  it("an external engine carries no liveness reason tags", () => {
    const tags = sanitizeLlmFailureTags({
      localEngine: "external",
      connectionRefused: true,
      engineLiveness: "dead",
      engineLivenessReason: "pid_dead",
      engineLock: "free",
    });
    expect(tags?.engine_liveness).toBeUndefined();
    expect(tags?.engine_liveness_reason).toBeUndefined();
    expect(tags?.engine_lock).toBeUndefined();
  });

  it("an external engine is never judged alive or dead", () => {
    expect(sanitizeLlmFailureTags({ localEngine: "external", connectionRefused: true, engineLiveness: "alive" })).toEqual({
      local_engine: "external",
      local_engine_alive: "unknown",
      refused_wait_ms: "0",
    });
  });

  it("a refusal on a link with no known engine reports local_engine unknown", () => {
    expect(sanitizeLlmFailureTags({ providerId: "groq", connectionRefused: true })).toEqual({
      provider_id: "groq",
      local_engine: "unknown",
      local_engine_alive: "unknown",
      refused_wait_ms: "0",
    });
  });

  it("adds no refusal tags when the connection was not refused", () => {
    const tags = sanitizeLlmFailureTags({ localEngine: "atomic-core", engineLiveness: "dead", outageWaitedMs: 1_000 });
    expect(tags?.local_engine_alive).toBeUndefined();
    expect(tags?.refused_wait_ms).toBeUndefined();
  });

  it("buckets the wait on the edges the turn loop acts on", () => {
    expect(bucketRefusedWait(0)).toBe("0");
    expect(bucketRefusedWait(1)).toBe("under_8s");
    expect(bucketRefusedWait(7_999)).toBe("under_8s");
    expect(bucketRefusedWait(8_000)).toBe("8s_to_30s");
    expect(bucketRefusedWait(30_000)).toBe("30s_to_2m");
    expect(bucketRefusedWait(120_000)).toBe("2m_to_5m");
    expect(bucketRefusedWait(300_000)).toBe("5m_plus");
    expect(bucketRefusedWait(Number.NaN)).toBe("unknown");
    expect(bucketRefusedWait(-5)).toBe("unknown");
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

  it("a llama 404 on 8080 carries request_route and port_class and no address", () => {
    const ev = scrubError(new TransportError("llama-server returned http 404", 404, "http://127.0.0.1:8080/v1/chat/completions"), {
      source: "llm_failure",
      category: "transport",
      llmFailure: {
        providerId: "local-llama",
        localEngine: "external",
        requestUrl: "http://127.0.0.1:8080/v1/chat/completions",
        managedPorts: [19091],
      },
    });
    const { tags } = payloadOf(buildEnvelope(DSN, ev, META).body);
    expect(tags).toMatchObject({ request_route: "chat_completions", port_class: "legacy_8080" });
    expect(JSON.stringify(tags)).not.toContain("8080/");
    expect(JSON.stringify(tags)).not.toContain(":8080");
  });

  it("a refused turn carries the refusal tags and no address, port or path", () => {
    const ev = scrubError(refused(), {
      source: "llm_failure",
      category: "transport",
      llmFailure: {
        providerId: "local-llama",
        localEngine: "llama-server",
        outageWaitedMs: 9_500,
        daemonState: "no_pid",
        connectionRefused: true,
        engineLiveness: "no_pid",
        requestUrl: "http://127.0.0.1:8080/v1/chat/completions",
      },
    });
    const { tags } = payloadOf(buildEnvelope(DSN, ev, META).body);
    expect(tags).toMatchObject({ local_engine: "llama-server", local_engine_alive: "no", refused_wait_ms: "8s_to_30s" });
    const serialized = JSON.stringify(tags);
    expect(serialized).not.toContain("127.0.0.1");
    expect(serialized).not.toContain(":8080");
    expect(serialized).not.toContain("/v1");
  });

  it("the new tags never change the fingerprint", () => {
    const bare = scrubError(refused(), { source: "llm_failure", category: "transport" });
    const tagged = scrubError(refused(), {
      source: "llm_failure",
      category: "transport",
      llmFailure: {
        providerId: "local-llama",
        localEngine: "atomic-core",
        daemonState: "no_pid",
        requestUrl: "http://127.0.0.1:8080/v1/chat/completions",
        connectionRefused: true,
        engineLiveness: "no_pid",
        outageWaitedMs: 8_000,
      },
    });
    expect(payloadOf(buildEnvelope(DSN, tagged, META).body).fingerprint).toEqual(
      payloadOf(buildEnvelope(DSN, bare, META).body).fingerprint,
    );
    expect(payloadOf(buildEnvelope(DSN, bare, META).body).tags.local_engine).toBeUndefined();
  });
});

describe("port_holder (ATO-1277)", () => {
  it("says other_process for a 401 on the managed port with our engine gone", () => {
    expect(sanitizeLlmFailureTags({ providerId: "local-llama", daemonState: "no_pid", portHeldByOther: true })).toEqual({
      provider_id: "local-llama",
      daemon_state: "no_pid",
      port_holder: "other_process",
    });
  });

  it("is absent otherwise", () => {
    expect(sanitizeLlmFailureTags({ providerId: "local-llama", daemonState: "alive" })?.port_holder).toBeUndefined();
    expect(sanitizeLlmFailureTags({ providerId: "local-llama", portHeldByOther: false })?.port_holder).toBeUndefined();
  });
});
