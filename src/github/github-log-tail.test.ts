import { describe, expect, it } from "vitest";
import { extractLogTail, readBodyTail } from "./github-log-tail.js";

describe("extractLogTail", () => {
  it("strips timestamps and ANSI codes and keeps short logs whole", () => {
    const raw = [
      "2026-11-27T10:00:00.1234567Z \x1b[36mRun npm run lint\x1b[0m",
      "2026-11-27T10:00:01.0000000Z src/a.ts:3:1 error no-unused-vars",
      "",
    ].join("\n");
    const tail = extractLogTail(raw);
    expect(tail.text).toBe("Run npm run lint\nsrc/a.ts:3:1 error no-unused-vars");
    expect(tail.truncated).toBe(false);
    expect(tail.totalLines).toBe(2);
  });

  it("keeps only the last lines and says it cut", () => {
    const raw = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const tail = extractLogTail(raw, { maxLines: 10 });
    const lines = tail.text.split("\n");
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe("line 490");
    expect(lines[9]).toBe("line 499");
    expect(tail.truncated).toBe(true);
  });

  it("bounds characters too, starting on a whole line", () => {
    const raw = Array.from({ length: 50 }, (_, i) => `${i}:${"x".repeat(98)}`).join("\n");
    const tail = extractLogTail(raw, { maxLines: 1_000, maxChars: 1_000 });
    expect(tail.text.length).toBeLessThanOrEqual(1_000);
    expect(tail.text.split("\n")[0]).toMatch(/^\d+:x+$/);
    expect(tail.text.endsWith(`49:${"x".repeat(98)}`)).toBe(true);
    expect(tail.truncated).toBe(true);
  });

  it("pulls ##[error] lines forward even when they are above the tail", () => {
    const raw = [
      "##[error]src/a.ts(3,1): error TS2304: Cannot find name 'foo'.",
      ...Array.from({ length: 200 }, (_, i) => `noise ${i}`),
    ].join("\n");
    const tail = extractLogTail(raw, { maxLines: 5 });
    expect(tail.errorLines).toEqual([
      "##[error]src/a.ts(3,1): error TS2304: Cannot find name 'foo'.",
    ]);
    expect(tail.text).not.toContain("##[error]");
  });

  it("masks a token that leaked into the log", () => {
    const token = `ghp_${"A".repeat(36)}`;
    expect(extractLogTail(`auth ${token}`).text).toBe("auth <token>");
  });
});

describe("readBodyTail", () => {
  function streamOf(chunks: string[]): Response {
    const enc = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(enc.encode(c));
          controller.close();
        },
      }),
    );
  }

  it("returns a small body whole", async () => {
    const res = await readBodyTail(streamOf(["a\n", "b\n"]), 1_024);
    expect(res).toEqual({ text: "a\nb\n", truncated: false });
  });

  it("keeps only the last bytes of a large body, from a line start", async () => {
    const chunks = Array.from({ length: 100 }, (_, i) => `row ${String(i).padStart(3, "0")}\n`);
    const res = await readBodyTail(streamOf(chunks), 40);
    expect(res.truncated).toBe(true);
    expect(res.text.length).toBeLessThanOrEqual(40);
    expect(res.text.startsWith("row ")).toBe(true);
    expect(res.text.endsWith("row 099\n")).toBe(true);
  });
});
