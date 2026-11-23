import { describe, expect, it, vi } from "vitest";

import { ImportFactsConsentError } from "./import-facts-engine.js";
import {
  extractFactCandidates,
  isSensitive,
  type FactChunk,
  type ImportFactsComplete,
} from "./extract-fact-candidates.js";

const CHUNKS: FactChunk[] = [
  {
    index: 0,
    messages: [
      { chatId: "chat-a", text: "I'm a designer from Berlin, help me with my portfolio" },
      { chatId: "chat-b", text: "Why does [redacted:openrouter-key] fail with 401?" },
    ],
  },
  {
    index: 1,
    messages: [{ chatId: "chat-c", text: "I always want short answers in bullet points" }],
  },
];

function scripted(outputs: string[]): ImportFactsComplete & ReturnType<typeof vi.fn> {
  let i = 0;
  return vi.fn(async () => outputs[i++] ?? "NONE") as never;
}

describe("extractFactCandidates (ATO-1623)", () => {
  it("returns grounded candidates with the backing quote and chat", async () => {
    const complete = scripted([
      "SET job=designer\nSET city=Berlin\n",
      "SET answer_style=short bullet points\n",
    ]);
    const res = await extractFactCandidates({ chunks: CHUNKS, engine: { kind: "local" }, complete });
    expect(res.chunksDone).toBe(2);
    expect(res.stopped).toBe(false);
    const job = res.candidates.find((c) => c.key === "job");
    expect(job).toMatchObject({ kind: "profile", value: "designer", chatId: "chat-a" });
    expect(job?.quote).toContain("designer from Berlin");
    expect(res.candidates.find((c) => c.key === "city")?.value).toBe("Berlin");
    expect(res.candidates.find((c) => c.key === "answer_style")?.chatId).toBe("chat-c");
    expect(new Set(res.candidates.map((c) => c.id)).size).toBe(res.candidates.length);
  });

  it("never offers a key, even if the model echoes one", async () => {
    const complete = scripted([
      "SET openrouter_api_key=sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nNOTE The person's key is [redacted:openrouter-key]\nSET job=designer\n",
    ]);
    const res = await extractFactCandidates({ chunks: [CHUNKS[0]!], engine: { kind: "local" }, complete });
    const all = JSON.stringify(res.candidates);
    expect(all).not.toContain("sk-or-v1");
    expect(all).not.toContain("redacted");
    // The grounding filter may catch one first; either way both are gone.
    expect(res.dropped.sensitive + res.dropped.ungrounded).toBeGreaterThanOrEqual(2);
    expect(res.candidates.map((c) => c.key)).toEqual(["job"]);
  });

  it("refuses a cloud model without consent and sends nothing", async () => {
    const complete = scripted(["SET job=designer\n"]);
    await expect(
      extractFactCandidates({
        chunks: CHUNKS,
        engine: { kind: "cloud", provider: "openrouter", cloudConsent: false },
        complete,
      }),
    ).rejects.toBeInstanceOf(ImportFactsConsentError);
    expect(complete).not.toHaveBeenCalled();
  });

  it("runs a cloud model when the person consented", async () => {
    const complete = scripted(["SET job=designer\n"]);
    const res = await extractFactCandidates({
      chunks: [CHUNKS[0]!],
      engine: { kind: "cloud", provider: "openrouter", cloudConsent: true },
      complete,
    });
    expect(res.candidates).toHaveLength(1);
  });

  it("stops between chunks and keeps what it found", async () => {
    const ctl = new AbortController();
    const progress: number[] = [];
    const complete = vi.fn(async () => {
      ctl.abort();
      return "SET job=designer\n";
    });
    const res = await extractFactCandidates({
      chunks: CHUNKS,
      engine: { kind: "local" },
      complete,
      signal: ctl.signal,
      onProgress: (p) => progress.push(p.chunksDone),
    });
    expect(res.stopped).toBe(true);
    expect(res.chunksDone).toBe(1);
    expect(res.candidates.map((c) => c.key)).toEqual(["job"]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(progress).toEqual([1]);
  });

  it("goes on past a failed chunk", async () => {
    let call = 0;
    const complete = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error("server down");
      return "SET answer_style=short bullet points\n";
    });
    const res = await extractFactCandidates({ chunks: CHUNKS, engine: { kind: "local" }, complete });
    expect(res.failedChunks).toBe(1);
    expect(res.chunksDone).toBe(2);
    expect(res.candidates).toHaveLength(1);
  });

  it("drops a duplicate across chunks", async () => {
    const complete = scripted(["SET job=designer\n", "SET job=Designer.\n"]);
    const res = await extractFactCandidates({ chunks: CHUNKS, engine: { kind: "local" }, complete });
    expect(res.candidates.filter((c) => c.key === "job")).toHaveLength(1);
    expect(res.dropped.duplicate).toBe(1);
  });

  it("drops an invented name", async () => {
    const complete = scripted(["SET name=Anna\nSET job=designer\n"]);
    const res = await extractFactCandidates({ chunks: [CHUNKS[0]!], engine: { kind: "local" }, complete });
    expect(res.candidates.some((c) => c.key === "name")).toBe(false);
    expect(res.dropped.ungrounded).toBeGreaterThanOrEqual(1);
  });

  it("never puts message text in progress events", async () => {
    const events: unknown[] = [];
    await extractFactCandidates({
      chunks: CHUNKS,
      engine: { kind: "local" },
      complete: scripted(["NONE", "NONE"]),
      onProgress: (p) => events.push(p),
    });
    expect(JSON.stringify(events)).not.toContain("Berlin");
  });
});

describe("isSensitive", () => {
  it.each([
    ["password", "hunter2"],
    ["wifi_pin", "1234"],
    ["contact", "me@example.com"],
    ["note", "card 4111 1111 1111 1111"],
    ["phone_note", "call me"],
    ["contact", "+49 151 23456789"],
  ])("%s=%s is sensitive", (k, v) => {
    expect(isSensitive(k, v)).toBe(true);
  });
  it.each([
    ["job", "designer"],
    ["pinned_topic", "gardening"],
    ["career", "worked at Acme 2019-2023"],
    ["favorite_card_game", "Magic"],
  ])("%s=%s is fine", (k, v) => {
    expect(isSensitive(k, v)).toBe(false);
  });
});
