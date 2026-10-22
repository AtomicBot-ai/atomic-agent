import { PassThrough, Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createStdinLineQueue } from "./stdin-line-queue.js";

function queueOver(input: NodeJS.ReadableStream) {
  return createStdinLineQueue({
    input,
    output: new PassThrough(),
    terminal: false,
  });
}

describe("createStdinLineQueue", () => {
  it("hands out lines written in one chunk in order, then null at EOF", async () => {
    const queue = queueOver(Readable.from(["task\ny\nnext message\n"]));
    expect(await queue.next("you> ")).toBe("task");
    expect(await queue.next()).toBe("y");
    expect(await queue.next("you> ")).toBe("next message");
    expect(await queue.next("you> ")).toBeNull();
    expect(await queue.next()).toBeNull();
  });

  it("keeps lines that arrive while nobody is reading", async () => {
    const input = new PassThrough();
    const queue = queueOver(input);
    input.write("first\nsecond\n");
    await new Promise((resolveTick) => setImmediate(resolveTick));
    input.end("third\n");
    expect(await queue.next()).toBe("first");
    expect(await queue.next()).toBe("second");
    expect(await queue.next()).toBe("third");
    expect(await queue.next()).toBeNull();
  });

  it("serves waiting readers first come, first served", async () => {
    const input = new PassThrough();
    const queue = queueOver(input);
    const first = queue.next();
    const second = queue.next();
    input.end("a\nb\n");
    expect(await first).toBe("a");
    expect(await second).toBe("b");
  });

  it("resolves a pending reader with null on close", async () => {
    const queue = queueOver(new PassThrough());
    const pending = queue.next("you> ");
    queue.close();
    expect(await pending).toBeNull();
  });

  it("peek shows the head line without taking it, and waits for one when empty", async () => {
    const input = new PassThrough();
    const queue = queueOver(input);
    const peeked = queue.peek();
    input.write("answer\n");
    expect(await peeked).toBe("answer");
    expect(await queue.peek()).toBe("answer");
    expect(await queue.next()).toBe("answer");
    input.end();
    expect(await queue.peek()).toBeNull();
  });
});
