import { describe, expect, it } from "vitest";
import { reviewableRequest, summariseFalseBlocks, type ReviewedCall } from "./guard-false-blocks.js";

const tools = new Set(["os.shell.run", "os.http.request", "os.fs.write"]);

describe("guard false-block measurement (ATO-2529)", () => {
  it("builds the request the reviewer sees for covered tools only", () => {
    expect(reviewableRequest({ tool: "os.shell.run", status: "ok", args: '{"cmd":"npm","args":["test"]}' }, tools, "1")).toMatchObject({
      category: "shell",
      preview: "npm test",
    });
    expect(
      reviewableRequest({ tool: "os.http.request", status: "ok", args: '{"url":"https://x.io","method":"post","body":"a"}' }, tools, "2"),
    ).toMatchObject({ category: "http_write", reason: "POST https://x.io" });
    expect(reviewableRequest({ tool: "os.fs.read", status: "ok", args: "{}" }, tools, "3")).toBeNull();
    expect(reviewableRequest({ tool: "os.shell.run", status: "ok" }, tools, "4")).toBeNull();
  });

  it("counts blocks over answered calls against the 2% target", () => {
    const call = (outcome: ReviewedCall["outcome"]): ReviewedCall => ({ trace: "t", tool: "os.shell.run", preview: "ls", outcome });
    const calls = [...Array.from({ length: 98 }, () => call("allow")), call("block"), call("no-answer")];
    expect(summariseFalseBlocks(3, calls)).toMatchObject({ reviewed: 100, blocked: 1, noAnswer: 1, pass: true });
    expect(summariseFalseBlocks(1, [call("block"), call("allow")]).pass).toBe(false);
    expect(summariseFalseBlocks(1, [call("no-answer")]).pass).toBe(false);
  });
});
