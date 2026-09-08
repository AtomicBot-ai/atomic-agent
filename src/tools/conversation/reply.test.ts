import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPLY_ATTACHMENTS_MAX, replyTool, resolveReplyAttachments } from "./reply.js";

const ctx = {
  workingDir: "/tmp",
  sessionId: "s-1",
  stepIndex: 0,
  signal: new AbortController().signal,
};

describe("replyTool", () => {
  it("returns an ok result with the text marked terminal=turn", async () => {
    const out = await replyTool.run({ text: "hello there" }, ctx);
    expect(out.status).toBe("ok");
    expect(out.summary).toContain("hello there");
    expect(out.details).toMatchObject({
      text: "hello there",
      terminal: "turn",
    });
  });

  it("rejects missing or empty text", async () => {
    await expect(replyTool.run({}, ctx)).rejects.toThrow(/non-empty string/);
    await expect(replyTool.run({ text: "" }, ctx)).rejects.toThrow(
      /non-empty string/,
    );
  });

  it("coerces a finite number to its string form", async () => {
    const out = await replyTool.run({ text: 8421 }, ctx);
    expect(out.status).toBe("ok");
    expect(out.details).toMatchObject({ text: "8421", terminal: "turn" });
  });

  it("coerces a boolean to its string form", async () => {
    const out = await replyTool.run({ text: true }, ctx);
    expect(out.status).toBe("ok");
    expect(out.details).toMatchObject({ text: "true", terminal: "turn" });
  });

  it("rejects non-coercible values (object, array, null, NaN)", async () => {
    await expect(replyTool.run({ text: null }, ctx)).rejects.toThrow(
      /non-empty string/,
    );
    await expect(replyTool.run({ text: { a: 1 } }, ctx)).rejects.toThrow(
      /non-empty string/,
    );
    await expect(replyTool.run({ text: ["a"] }, ctx)).rejects.toThrow(
      /non-empty string/,
    );
    await expect(replyTool.run({ text: Number.NaN }, ctx)).rejects.toThrow(
      /non-empty string/,
    );
  });
});

describe("reply attachments", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-reply-attachments-"));
    writeFileSync(join(dir, "report.pdf"), "pdf");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "shot.png"), "png");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves relative paths against the working directory and reports them absolute", async () => {
    const out = await replyTool.run(
      { text: "here you go", attachments: ["report.pdf", "sub/shot.png"] },
      { ...ctx, workingDir: dir },
    );
    expect(out.status).toBe("ok");
    expect(out.details).toEqual({
      text: "here you go",
      terminal: "turn",
      attachments: [join(dir, "report.pdf"), join(dir, "sub", "shot.png")],
    });
  });

  it("omits the field entirely when there are no attachments", async () => {
    for (const attachments of [undefined, null, []]) {
      const out = await replyTool.run(
        { text: "plain", attachments },
        { ...ctx, workingDir: dir },
      );
      expect(out.details).toEqual({ text: "plain", terminal: "turn" });
    }
  });

  it("accepts a single string (a flattened one-element array) and dedupes", async () => {
    const one = await resolveReplyAttachments("report.pdf", dir);
    expect(one).toEqual([join(dir, "report.pdf")]);
    const dup = await resolveReplyAttachments(
      ["report.pdf", join(dir, "report.pdf")],
      dir,
    );
    expect(dup).toEqual([join(dir, "report.pdf")]);
  });

  it("errors — so the model can fix the path — on a missing file", async () => {
    await expect(
      replyTool.run(
        { text: "x", attachments: ["nope.txt"] },
        { ...ctx, workingDir: dir },
      ),
    ).rejects.toThrow(`reply: attachment not found: ${join(dir, "nope.txt")}`);
  });

  it("rejects a directory, an empty entry and a non-string entry", async () => {
    await expect(resolveReplyAttachments(["sub"], dir)).rejects.toThrow(
      /not a file/,
    );
    await expect(resolveReplyAttachments([""], dir)).rejects.toThrow(
      /non-empty file paths/,
    );
    await expect(resolveReplyAttachments([42], dir)).rejects.toThrow(
      /non-empty file paths/,
    );
  });

  it("caps the count", async () => {
    const many = Array.from({ length: REPLY_ATTACHMENTS_MAX + 1 }, () => "report.pdf");
    await expect(resolveReplyAttachments(many, dir)).rejects.toThrow(
      /at most 10 attachments/,
    );
  });
});
