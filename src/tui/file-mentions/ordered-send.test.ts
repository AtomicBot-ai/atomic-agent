import { describe, expect, it } from "vitest";
import { createOrderedSend } from "./ordered-send.js";

describe("createOrderedSend (ATO-2472)", () => {
  it("delivers a plain message at once when nothing waits", () => {
    const order = createOrderedSend();
    const out: string[] = [];
    order.send("now", (t) => out.push(t));
    expect(out).toEqual(["now"]);
    expect(order.waiting).toBe(false);
  });

  it("keeps a message typed during an expansion behind it", async () => {
    const order = createOrderedSend();
    const out: string[] = [];
    let finish!: (text: string) => void;
    order.send(new Promise<string>((done) => { finish = done; }), (t) => out.push(t));
    order.send("steer typed meanwhile", (t) => out.push(t));
    expect(out).toEqual([]);
    expect(order.waiting).toBe(true);
    finish("first, expanded");
    await new Promise((r) => setTimeout(r, 0));
    expect(out).toEqual(["first, expanded", "steer typed meanwhile"]);
    expect(order.waiting).toBe(false);
  });

  it("goes on after a delivery that throws", async () => {
    const order = createOrderedSend();
    const out: string[] = [];
    order.send(Promise.resolve("a"), () => { throw new Error("boom"); });
    order.send("b", (t) => out.push(t));
    await new Promise((r) => setTimeout(r, 0));
    expect(out).toEqual(["b"]);
  });
});
