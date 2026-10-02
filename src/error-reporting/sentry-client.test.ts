import { describe, expect, it, vi } from "vitest";

import { SentryClient, createSentryClient } from "./sentry-client.js";
import type { FetchLike } from "./sentry-client.js";
import { parseSentryDsn } from "./sentry-config.js";

const DSN = parseSentryDsn("https://pub@o1.ingest.sentry.io/7")!;

function okFetch(): FetchLike & { mock: ReturnType<typeof vi.fn> } {
  const mock = vi.fn(async () => ({ ok: true, status: 200 }));
  return mock as unknown as FetchLike & { mock: ReturnType<typeof vi.fn> };
}

describe("SentryClient", () => {
  it("POSTs a privacy-hardened envelope and never sends the raw message", async () => {
    const fetchImpl = okFetch();
    const client = new SentryClient({
      dsn: DSN,
      installId: "install-1",
      release: "1.2.3",
      platform: "darwin",
      fetchImpl,
    });

    client.capture({
      errorType: "TransportError",
      category: "transport",
      source: "llm_failure",
      httpStatus: 502,
      frames: [{ filename: "cli.mjs", lineno: 1, colno: 2 }],
    });
    await client.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(url).toBe("https://o1.ingest.sentry.io/api/7/envelope/");
    expect(init.headers["X-Sentry-Auth"]).toContain("sentry_key=pub");

    const lines = (init.body as string).trim().split("\n");
    const payload = JSON.parse(lines[2]);
    expect(payload.tags.install_id).toBe("install-1");
    expect(payload.tags.error_type).toBe("TransportError");
    expect(payload.tags.category).toBe("transport");
    expect(payload.tags.http_status).toBe("502");
    // IP opt-out and anonymous id only.
    expect(payload.user.ip_address).toBeNull();
    expect(payload.user.id).toBe("install-1");
    // Value is the type, not a message (none was allowlisted).
    expect(payload.exception.values[0].value).toBe("TransportError");
  });

  it("is fire-safe: swallows fetch rejections", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as FetchLike;
    const client = new SentryClient({
      dsn: DSN,
      installId: "x",
      release: "0",
      platform: "linux",
      fetchImpl,
    });
    expect(() =>
      client.capture({ errorType: "E", source: "s", frames: [] }),
    ).not.toThrow();
    await expect(client.flush()).resolves.toBeUndefined();
  });

  it("createSentryClient returns null when disabled", () => {
    expect(
      createSentryClient({
        enabled: false,
        installId: "x",
        release: "0",
        platform: "darwin",
        dsn: "https://pub@o1.ingest.sentry.io/7",
        fetchImpl: okFetch(),
      }),
    ).toBeNull();
  });

  it("createSentryClient returns null for the placeholder DSN", () => {
    expect(
      createSentryClient({
        enabled: true,
        installId: "x",
        release: "0",
        platform: "darwin",
        dsn: "PLACEHOLDER",
        fetchImpl: okFetch(),
      }),
    ).toBeNull();
  });

  it("createSentryClient returns null under the test runner without an injected fetch", () => {
    expect(
      createSentryClient({
        enabled: true,
        installId: "x",
        release: "0",
        platform: "darwin",
        dsn: "https://pub@o1.ingest.sentry.io/7",
      }),
    ).toBeNull();
  });
});

async function captureTags(
  dimensions?: ConstructorParameters<typeof SentryClient>[0]["dimensions"],
): Promise<Record<string, string>> {
  const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
  const client = new SentryClient({
    dsn: DSN,
    installId: "install-1",
    release: "1.2.3",
    platform: "darwin",
    ...(dimensions ? { dimensions } : {}),
    fetchImpl: fetchImpl as unknown as FetchLike,
  });
  client.capture({ errorType: "TypeError", source: "uncaught", frames: [] });
  await client.flush();
  const init = (fetchImpl.mock.calls[0] as unknown[])[1] as { body: string };
  const lines = init.body.trim().split("\n");
  return JSON.parse(lines[2]!).tags as Record<string, string>;
}

describe("Sentry dimension tags", () => {
  it("tags surface, install_channel and desktop_version when given", async () => {
    const tags = await captureTags({
      surface: "desktop",
      installChannel: "dmg",
      desktopVersion: "0.6.7",
    });
    expect(tags.surface).toBe("desktop");
    expect(tags.install_channel).toBe("dmg");
    expect(tags.desktop_version).toBe("0.6.7");
  });

  it("omits desktop_version outside the desktop app", async () => {
    const tags = await captureTags({ surface: "tui", installChannel: "curl_sh" });
    expect(tags.surface).toBe("tui");
    expect(tags.install_channel).toBe("curl_sh");
    expect(tags).not.toHaveProperty("desktop_version");
  });

  it("adds no dimension tags when none are configured", async () => {
    const tags = await captureTags();
    expect(tags).not.toHaveProperty("surface");
    expect(tags).not.toHaveProperty("install_channel");
  });
});
