import { describe, expect, it } from "vitest";

import {
  DEFAULT_PAIRING_TIMEOUT_MS,
  DefaultPairingMode,
} from "./pairing-mode.js";
import type { InboundTextUpdate } from "./inbound-handler.js";

interface FakeScheduler {
  schedule: (cb: () => void, ms: number) => () => void;
  fireAll: () => void;
  pendingCount: () => number;
}

function makeFakeScheduler(): FakeScheduler {
  let nextId = 1;
  const handlers = new Map<number, () => void>();
  return {
    schedule: (cb, _ms) => {
      const id = nextId++;
      handlers.set(id, cb);
      return () => {
        handlers.delete(id);
      };
    },
    fireAll: () => {
      const entries = [...handlers.entries()];
      handlers.clear();
      for (const [, cb] of entries) cb();
    },
    pendingCount: () => handlers.size,
  };
}

function privateUpdate(
  text: string,
  fromId: number = 42,
  chatId: number = 100,
): InboundTextUpdate {
  return {
    from: { id: fromId },
    chat: { id: chatId, type: "private" },
    text,
    message_id: 1,
  };
}

describe("DefaultPairingMode", () => {
  it("is inactive by default", () => {
    const pairing = new DefaultPairingMode();
    expect(pairing.isActive()).toBe(false);
    expect(pairing.expiresAt()).toBeNull();
    expect(pairing.tryClaim(privateUpdate("hi"))).toBe(false);
  });

  it("claims the next eligible private DM and resolves with the user/chat ids", async () => {
    const sched = makeFakeScheduler();
    const pairing = new DefaultPairingMode({
      scheduleTimeout: sched.schedule,
      now: () => 1_000_000,
    });

    const promise = pairing.start();
    expect(pairing.isActive()).toBe(true);
    expect(pairing.expiresAt()).toBe(1_000_000 + DEFAULT_PAIRING_TIMEOUT_MS);

    const consumed = pairing.tryClaim(privateUpdate("/start", 42, 200));
    expect(consumed).toBe(true);

    await expect(promise).resolves.toEqual({ userId: 42, chatId: 200 });
    expect(pairing.isActive()).toBe(false);
    expect(sched.pendingCount()).toBe(0);
  });

  it("ignores group-chat updates and updates without from.id", async () => {
    const sched = makeFakeScheduler();
    const pairing = new DefaultPairingMode({ scheduleTimeout: sched.schedule });

    const promise = pairing.start();

    expect(
      pairing.tryClaim({
        from: { id: 7 },
        chat: { id: 1, type: "group" },
        text: "hi",
        message_id: 1,
      }),
    ).toBe(false);

    expect(
      pairing.tryClaim({
        chat: { id: 1, type: "private" },
        text: "hi",
        message_id: 1,
      }),
    ).toBe(false);

    expect(pairing.tryClaim(privateUpdate("   "))).toBe(false);

    expect(pairing.isActive()).toBe(true);

    expect(pairing.tryClaim(privateUpdate("/pair", 99, 5))).toBe(true);
    await expect(promise).resolves.toEqual({ userId: 99, chatId: 5 });
  });

  it("resolves with null when the timeout fires before any claim", async () => {
    const sched = makeFakeScheduler();
    const pairing = new DefaultPairingMode({ scheduleTimeout: sched.schedule });

    const promise = pairing.start(60_000);
    sched.fireAll();

    await expect(promise).resolves.toBeNull();
    expect(pairing.isActive()).toBe(false);
  });

  it("resolves with null when cancel() is called", async () => {
    const sched = makeFakeScheduler();
    const pairing = new DefaultPairingMode({ scheduleTimeout: sched.schedule });

    const promise = pairing.start();
    pairing.cancel();
    await expect(promise).resolves.toBeNull();
    expect(pairing.isActive()).toBe(false);
    expect(sched.pendingCount()).toBe(0);
  });

  it("starting a new window cancels the previous one with null", async () => {
    const sched = makeFakeScheduler();
    const pairing = new DefaultPairingMode({ scheduleTimeout: sched.schedule });

    const first = pairing.start();
    const second = pairing.start();
    expect(pairing.isActive()).toBe(true);
    await expect(first).resolves.toBeNull();

    pairing.tryClaim(privateUpdate("/pair", 7, 8));
    await expect(second).resolves.toEqual({ userId: 7, chatId: 8 });
  });

  it("a second tryClaim after a successful claim returns false", async () => {
    const sched = makeFakeScheduler();
    const pairing = new DefaultPairingMode({ scheduleTimeout: sched.schedule });

    const promise = pairing.start();
    expect(pairing.tryClaim(privateUpdate("/pair", 1, 2))).toBe(true);
    expect(pairing.tryClaim(privateUpdate("/pair", 9, 9))).toBe(false);
    await expect(promise).resolves.toEqual({ userId: 1, chatId: 2 });
  });

  it("returns null immediately when timeoutMs is non-positive", async () => {
    const pairing = new DefaultPairingMode();
    await expect(pairing.start(0)).resolves.toBeNull();
    expect(pairing.isActive()).toBe(false);
  });

  it("cancel() is a no-op when inactive", () => {
    const pairing = new DefaultPairingMode();
    expect(() => pairing.cancel()).not.toThrow();
    expect(pairing.isActive()).toBe(false);
  });

  it("clears the timer when a claim arrives so timeout never fires after resolution", async () => {
    const sched = makeFakeScheduler();
    const pairing = new DefaultPairingMode({ scheduleTimeout: sched.schedule });

    const promise = pairing.start();
    pairing.tryClaim(privateUpdate("/pair", 1, 2));
    expect(sched.pendingCount()).toBe(0);

    sched.fireAll();
    await expect(promise).resolves.toEqual({ userId: 1, chatId: 2 });
  });
});
