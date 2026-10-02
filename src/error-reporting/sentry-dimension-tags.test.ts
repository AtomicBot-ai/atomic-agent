import { describe, expect, it, vi } from "vitest";

import { SentryClient } from "./sentry-client.js";
import type { FetchLike } from "./sentry-client.js";
import { parseSentryDsn } from "./sentry-config.js";

const DSN = parseSentryDsn("https://pub@o1.ingest.sentry.io/7")!;

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
