import { describe, expect, it, vi } from "vitest";

import type { DownloadJob } from "../local-llm/index.js";
import {
  formatDownloadNotification,
  isDownloadNotifyChannelReady,
  notifyDownloadOutcome,
} from "./download-notifier.js";

function job(patch: Partial<DownloadJob> = {}): DownloadJob {
  return {
    version: 1,
    id: "chat-qwen-3.5-4b",
    kind: "chat",
    modelId: "qwen-3.5-4b",
    mode: "gguf-only",
    pid: 1,
    status: "done",
    phase: "gguf",
    label: "Qwen 3.5 4B (gguf)",
    percent: 100,
    transferredBytes: 4_400_000_000,
    totalBytes: 4_400_000_000,
    error: null,
    waiting: null,
    resumable: false,
    startedAt: "2026-09-08T10:00:00.000Z",
    updatedAt: "2026-09-08T12:00:00.000Z",
    finishedAt: "2026-09-08T12:00:00.000Z",
    ...patch,
  };
}

const config = {
  telegram: { enabled: true, ownerUserId: 42, parseMode: "html" as const, progressIndicator: true },
  discord: { enabled: true, ownerUserId: "123456789012345678" },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("formatDownloadNotification", () => {
  it("names the model without the worker's phase suffix, and says what to do next", () => {
    const text = formatDownloadNotification(job());
    expect(text).toContain("✅ Model ready: Qwen 3.5 4B");
    expect(text).not.toContain("(gguf)");
    expect(text).toContain("4.1 GB downloaded");
    expect(text).toContain("open Atomic Agent");
  });

  it("tells a resumable failure apart from a dead one", () => {
    const paused = formatDownloadNotification(
      job({ status: "failed", resumable: true, error: "Download gave up: no progress for 7 days", transferredBytes: 1_100_000_000 }),
    );
    expect(paused).toContain("⏸ Download paused");
    expect(paused).toContain("1.0 GB of 4.1 GB is kept");
    expect(paused).toContain("resumes by itself");

    const dead = formatDownloadNotification(
      job({ status: "failed", resumable: false, error: "Download failed: HTTP 404 Not Found" }),
    );
    expect(dead).toContain("❌ Download failed");
    expect(dead).toContain("HTTP 404");
  });
});

describe("notifyDownloadOutcome", () => {
  it("reports not_configured, never throws, when a channel has no credentials", async () => {
    const env = {};
    expect(await notifyDownloadOutcome({ channel: "telegram", job: job(), config, env })).toMatchObject({
      outcome: "not_configured",
      reason: "no bot token",
    });
    expect(
      await notifyDownloadOutcome({
        channel: "telegram",
        job: job(),
        config: { ...config, telegram: { ...config.telegram, ownerUserId: null } },
        env: { TELEGRAM_BOT_TOKEN: "t" },
      }),
    ).toMatchObject({ outcome: "not_configured", reason: "not paired" });
    expect(await notifyDownloadOutcome({ channel: "discord", job: job(), config, env })).toMatchObject({
      outcome: "not_configured",
      reason: "no bot token",
    });
    expect(await notifyDownloadOutcome({ channel: "email", job: job(), config, env })).toMatchObject({
      outcome: "not_configured",
    });
  });

  it("sends the Telegram DM to the paired owner", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ ok: true, result: { message_id: 1 } });
    }) as unknown as typeof fetch;
    const result = await notifyDownloadOutcome({
      channel: "telegram",
      job: job(),
      config,
      env: { TELEGRAM_BOT_TOKEN: "123456:ABC" },
      fetchImpl,
    });
    expect(result).toEqual({ outcome: "sent", channel: "telegram" });
    expect(bodies[0]).toMatchObject({ chat_id: 42 });
    expect(String(bodies[0].text)).toContain("Model ready");
  });

  it("opens the Discord DM channel and posts there", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, body: JSON.parse(String(init?.body ?? "{}")) });
      if (u.endsWith("/users/@me/channels")) return jsonResponse({ id: "dm-1" });
      return jsonResponse({ id: "msg-1" });
    }) as unknown as typeof fetch;
    const result = await notifyDownloadOutcome({
      channel: "discord",
      job: job(),
      config,
      env: { DISCORD_BOT_TOKEN: "abc.def.ghi" },
      fetchImpl,
      discordApiBase: "http://127.0.0.1:9",
    });
    expect(result).toEqual({ outcome: "sent", channel: "discord" });
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:9/users/@me/channels",
      "http://127.0.0.1:9/channels/dm-1/messages",
    ]);
    expect(calls[0].body).toEqual({ recipient_id: "123456789012345678" });
    expect(String(calls[1].body.content)).toContain("Model ready");
  });

  it("turns a transport failure into a failed result rather than an exception", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const result = await notifyDownloadOutcome({
      channel: "discord",
      job: job(),
      config,
      env: { DISCORD_BOT_TOKEN: "abc.def.ghi" },
      fetchImpl,
    });
    expect(result.outcome).toBe("failed");
  });

  it("knows which channels could deliver right now", () => {
    expect(isDownloadNotifyChannelReady("telegram", config, { TELEGRAM_BOT_TOKEN: "t" })).toBe(true);
    expect(isDownloadNotifyChannelReady("telegram", config, {})).toBe(false);
    expect(isDownloadNotifyChannelReady("discord", config, { DISCORD_BOT_TOKEN: "d" })).toBe(true);
    expect(
      isDownloadNotifyChannelReady("discord", { ...config, discord: { enabled: true, ownerUserId: null } }, { DISCORD_BOT_TOKEN: "d" }),
    ).toBe(false);
    expect(isDownloadNotifyChannelReady("email", config, {})).toBe(false);
  });
});
