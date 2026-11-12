import { describe, expect, it } from "vitest";

import { chunkText, createImsgSender, ImsgSendError, sendArgs, type ExecFileLike } from "./imsg-send.js";

function fakeExec(fail?: { stderr: string }) {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const impl: ExecFileLike = (file, args, _opts, cb) => {
    calls.push({ file, args });
    if (fail) cb(new Error("Command failed"), "", fail.stderr);
    else cb(null, "sent\n", "");
  };
  return { calls, impl };
}

describe("sendArgs", () => {
  it("passes the text as its own argv entry, never through a shell", () => {
    const text = 'done; rm -rf ~ "$(whoami)"';
    expect(sendArgs({ kind: "handle", handle: "+14155551212" }, text)).toEqual([
      "send",
      "--to",
      "+14155551212",
      "--text",
      text,
    ]);
    expect(sendArgs({ kind: "chat", chatId: 42 }, "hi")).toEqual(["send", "--chat-id", "42", "--text", "hi"]);
  });
});

describe("createImsgSender", () => {
  it("sends each chunk in order with the configured binary", async () => {
    const exec = fakeExec();
    const sender = createImsgSender({ binary: "/opt/homebrew/bin/imsg", execFileImpl: exec.impl, chunkChars: 10 });
    await sender.send({ kind: "handle", handle: "+1" }, "aaaa bbbb cccc dddd");
    expect(exec.calls.map((c) => c.file)).toEqual(["/opt/homebrew/bin/imsg", "/opt/homebrew/bin/imsg"]);
    expect(exec.calls.map((c) => c.args[4])).toEqual(["aaaa bbbb", "cccc dddd"]);
  });

  it("rejects with the child's stderr and does not retry", async () => {
    const exec = fakeExec({ stderr: "Not authorized to send Apple events (-1743)" });
    const sender = createImsgSender({ binary: "imsg", execFileImpl: exec.impl });
    const err = await sender.send({ kind: "chat", chatId: 1 }, "hi").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImsgSendError);
    expect((err as ImsgSendError).stderr).toMatch(/-1743/);
    expect(exec.calls).toHaveLength(1);
  });

  it("sends nothing for an empty reply", async () => {
    const exec = fakeExec();
    await createImsgSender({ binary: "imsg", execFileImpl: exec.impl }).send({ kind: "chat", chatId: 1 }, "  ");
    expect(exec.calls).toHaveLength(0);
  });
});

describe("chunkText", () => {
  it("keeps short text whole", () => {
    expect(chunkText("hello")).toEqual(["hello"]);
  });

  it("prefers paragraph, then line, then word breaks", () => {
    const para = `${"a".repeat(60)}\n\n${"b".repeat(30)}`;
    expect(chunkText(para, 80)).toEqual(["a".repeat(60), "b".repeat(30)]);
    expect(chunkText("one two three four", 9)).toEqual(["one two", "three", "four"]);
  });

  it("hard-cuts a word longer than the limit", () => {
    expect(chunkText("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });

  it("never produces a chunk over the limit", () => {
    const text = Array.from({ length: 500 }, (_, i) => `word${i}`).join(" ");
    for (const chunk of chunkText(text, 2000)) expect(chunk.length).toBeLessThanOrEqual(2000);
  });
});
