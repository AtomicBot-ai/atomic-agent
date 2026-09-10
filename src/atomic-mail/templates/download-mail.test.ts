import { describe, expect, it } from "vitest";

import type { DownloadJob } from "../../local-llm/index.js";
import { renderAccessCodeMail } from "./access-code-mail.js";
import { renderDownloadMail } from "./download-mail.js";

function job(patch: Partial<DownloadJob> = {}): DownloadJob {
  return {
    version: 1,
    id: "chat-qwen-3.8-27b-uncensored",
    kind: "chat",
    modelId: "qwen-3.8-27b-uncensored",
    mode: "with-mmproj",
    pid: 1,
    status: "done",
    phase: "gguf",
    label: "Qwen3.8 27B Uncensored Q4_K_M GGUF (gguf)",
    percent: 100,
    transferredBytes: 16_547_400_160,
    totalBytes: 16_547_400_160,
    error: null,
    waiting: null,
    resumable: false,
    startedAt: "2026-09-08T17:38:27.149Z",
    updatedAt: "2026-09-08T20:50:11.000Z",
    finishedAt: "2026-09-08T20:50:11.000Z",
    ...patch,
  };
}
const from = "atag-3f9a2c@atomicmail.ai";

describe("renderDownloadMail", () => {
  it("announces a landed model with its facts, in HTML and in plain text", () => {
    const mail = renderDownloadMail({ job: job(), from });
    expect(mail.subject).toBe("▶ MODEL READY: Qwen3.8 27B Uncensored Q4_K_M GGUF");
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("Qwen3.8 27B Uncensored Q4_K_M GGUF");
      expect(body).toContain("15.4 GB · Q4_K_M · 3 h 12 min");
      expect(body).toContain("ADDITIONAL WEIGHTS ACQUIRED");
      expect(body).toContain(from);
      expect(body).not.toContain("(gguf)");
      expect(body).not.toContain("/Users/");
    }
    // Inbox-safe: no script, no external asset, a solid ground.
    expect(mail.html).not.toMatch(/<script|<link|src="http/i);
    expect(mail.html).toContain("background-color:#05070d");
    expect(mail.html).toContain("<pre");
  });

  it("tells an outage apart from a dead file", () => {
    const paused = renderDownloadMail({
      job: job({ status: "failed", resumable: true, transferredBytes: 10_590_336_000, error: "Download gave up: no progress for 7 days (last error: fetch failed)" }),
      from,
    });
    expect(paused.subject).toMatch(/^⏸ TRANSMISSION LOST: .* \(64%\)$/);
    expect(paused.text).toContain("9.9 GB of 15.4 GB kept on disk");
    expect(paused.text).toContain("resumes by itself");
    expect(paused.html).toContain("NOT ENOUGH BANDWIDTH");

    const dead = renderDownloadMail({
      job: job({ status: "failed", resumable: false, transferredBytes: 0, error: "Download failed: HTTP 404 Not Found" }),
      from,
    });
    expect(dead.subject).toBe("✕ DOWNLOAD FAILED: Qwen3.8 27B Uncensored Q4_K_M GGUF");
    expect(dead.text).toContain("HTTP 404");
    expect(dead.text).toContain("MISSION ABORTED");
  });

  it("escapes what came from the network", () => {
    const mail = renderDownloadMail({ job: job({ status: "failed", error: "<img src=x onerror=alert(1)>" }), from });
    expect(mail.html).not.toContain("<img");
    expect(mail.html).toContain("&lt;img");
  });

  it("names a vision projector as such", () => {
    const mail = renderDownloadMail({ job: job({ phase: "mmproj", label: "Qwen3.8 27B (mmproj)" }), from });
    expect(mail.subject).toBe("▶ VISION PROJECTOR READY: Qwen3.8 27B");
  });
});

describe("renderAccessCodeMail", () => {
  it("shows the six digits, the deadline and who sent it", () => {
    const mail = renderAccessCodeMail({ code: "482913", expiresInMinutes: 10, from });
    expect(mail.subject).toBe("▶ ACCESS CODE 482913 — Atomic Agent");
    expect(mail.text).toContain("4  8  2  9  1  3");
    expect(mail.text).toContain("within 10 minutes");
    // One cell per digit in the HTML.
    expect(mail.html.match(/font-size:34px/g)).toHaveLength(6);
    expect(mail.html).toContain("IDENTIFY, COMMANDER");
  });
});
