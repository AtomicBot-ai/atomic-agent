import { afterEach, describe, expect, it, vi } from "vitest";

import { discardResponseBody } from "./discard-response-body.js";
import { LlamaServerClient } from "./llama-server-client.js";
import { verifyGuardedEndpoint } from "./llama-server-auth-probe.js";
import type { HealthResult } from "./llama-server-health.js";
import { probeEndpoint } from "../tui/local-models/daemon-wedge-watch.js";

/** A response whose body records whether anyone let go of it. */
function trackedResponse(status = 200): {
  response: Response;
  cancelled: () => boolean;
} {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"status":"ok"}'));
      // Left open: a body nobody reads and nobody closes.
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(stream, { status }),
    cancelled: () => cancelled,
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("discardResponseBody", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("cancels a body nobody read", async () => {
    const { response, cancelled } = trackedResponse();
    discardResponseBody(response);
    await flush();
    expect(cancelled()).toBe(true);
  });

  it("leaves a consumed body alone and tolerates partial Response-likes", async () => {
    const consumed = new Response("x");
    await consumed.text();
    expect(() => discardResponseBody(consumed)).not.toThrow();
    expect(() => discardResponseBody(undefined)).not.toThrow();
    expect(() => discardResponseBody({ ok: true } as unknown as Response)).not.toThrow();
    expect(() => discardResponseBody(new Response(null, { status: 204 }))).not.toThrow();
  });

  it("probeHealth lets go of the body it does not read, and still answers", async () => {
    const { response, cancelled } = trackedResponse();
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: (async () => response) as typeof fetch,
    });
    await expect(client.probeHealth()).resolves.toBe("answered");
    await flush();
    expect(cancelled()).toBe(true);
  });

  it("verifyGuardedEndpoint lets go of the /props body it reads only the status of", async () => {
    const { response, cancelled } = trackedResponse(200);
    vi.stubGlobal("fetch", async () => response);
    const passed = { reachable: true } as unknown as HealthResult;
    await expect(
      verifyGuardedEndpoint(passed, "http://127.0.0.1:9999", 1_000, null),
    ).resolves.toBe(passed);
    await flush();
    expect(cancelled()).toBe(true);
  });

  it("the wedge watch's probe lets go of a non-OK body", async () => {
    const { response, cancelled } = trackedResponse(503);
    const answer = await probeEndpoint(
      "http://127.0.0.1:9999/slots",
      1_000,
      (async () => response) as typeof fetch,
    );
    expect(answer).toEqual({ answered: true, slots: undefined });
    await flush();
    expect(cancelled()).toBe(true);
  });
});
