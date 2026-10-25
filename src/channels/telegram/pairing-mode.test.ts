import { describe, expect, it } from "vitest";

import {
  DEFAULT_PAIRING_TIMEOUT_MS,
  DefaultPairingMode,
  generatePairingCode,
  pairingCodeIn,
  type PairingModeOptions,
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
  username?: string,
): InboundTextUpdate {
  return {
    from: { id: fromId, ...(username === undefined ? {} : { username }) },
    chat: { id: chatId, type: "private" },
    text,
    message_id: 1,
  };
}

const CODE = "482913";

/** A pairing mode whose windows all use `CODE`. */
function withCode(opts: PairingModeOptions = {}): DefaultPairingMode {
  return new DefaultPairingMode({ generateCode: () => CODE, ...opts });
}

describe("pairing code helpers", () => {
  it("generates six digits, zero-padded", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generatePairingCode()).toMatch(/^\d{6}$/);
    }
  });

  it("reads the code only from an exact /start <code>", () => {
    expect(pairingCodeIn("/start 012345")).toBe("012345");
    expect(pairingCodeIn("  /start   012345 ")).toBe("012345");
    expect(pairingCodeIn("/start@my_bot 012345")).toBe("012345");
    expect(pairingCodeIn("/start")).toBeNull();
    expect(pairingCodeIn("012345")).toBeNull();
    expect(pairingCodeIn("/start 12345")).toBeNull();
    expect(pairingCodeIn("/start 1234567")).toBeNull();
    expect(pairingCodeIn("/start 012345 please")).toBeNull();
    expect(pairingCodeIn("/pair 012345")).toBeNull();
  });
});

describe("DefaultPairingMode", () => {
  it("is inactive by default", () => {
    const pairing = withCode();
    expect(pairing.isActive()).toBe(false);
    expect(pairing.expiresAt()).toBeNull();
    expect(pairing.currentCode()).toBeNull();
    expect(pairing.tryClaim(privateUpdate(`/start ${CODE}`))).toBe("ignored");
  });

  it("opens a five-minute window with a one-time code", () => {
    const sched = makeFakeScheduler();
    const pairing = withCode({ scheduleTimeout: sched.schedule, now: () => 1_000_000 });
    void pairing.start();
    expect(DEFAULT_PAIRING_TIMEOUT_MS).toBe(5 * 60_000);
    expect(pairing.expiresAt()).toBe(1_000_000 + DEFAULT_PAIRING_TIMEOUT_MS);
    expect(pairing.currentCode()).toBe(CODE);
  });

  it("claims a private DM /start <code> and resolves with the user, chat and @username", async () => {
    const sched = makeFakeScheduler();
    const pairing = withCode({ scheduleTimeout: sched.schedule });

    const promise = pairing.start();
    expect(pairing.tryClaim(privateUpdate(`/start ${CODE}`, 42, 200, "owner"))).toBe(
      "claimed",
    );

    await expect(promise).resolves.toEqual({ userId: 42, chatId: 200, username: "owner" });
    expect(pairing.isActive()).toBe(false);
    expect(pairing.currentCode()).toBeNull();
    expect(sched.pendingCount()).toBe(0);
  });

  it("claims nothing with any other DM, and swallows a wrong code without closing", async () => {
    const sched = makeFakeScheduler();
    const pairing = withCode({ scheduleTimeout: sched.schedule });
    const promise = pairing.start();

    for (const text of ["hi", "/start", CODE, `/start ${CODE} now`, "   "]) {
      expect(pairing.tryClaim(privateUpdate(text, 666))).toBe("ignored");
    }
    expect(pairing.tryClaim(privateUpdate("/start 000000", 666))).toBe("wrong_code");
    expect(pairing.isActive()).toBe(true);

    expect(pairing.tryClaim(privateUpdate(`/start ${CODE}`, 7, 8))).toBe("claimed");
    await expect(promise).resolves.toEqual({ userId: 7, chatId: 8, username: null });
  });

  it("ignores group-chat updates and updates without from.id, even with the code", async () => {
    const sched = makeFakeScheduler();
    const pairing = withCode({ scheduleTimeout: sched.schedule });
    const promise = pairing.start();

    expect(
      pairing.tryClaim({
        from: { id: 7 },
        chat: { id: 1, type: "group" },
        text: `/start ${CODE}`,
        message_id: 1,
      }),
    ).toBe("ignored");
    expect(
      pairing.tryClaim({
        chat: { id: 1, type: "private" },
        text: `/start ${CODE}`,
        message_id: 1,
      }),
    ).toBe("ignored");
    expect(pairing.isActive()).toBe(true);

    expect(pairing.tryClaim(privateUpdate(`/start ${CODE}`, 99, 5))).toBe("claimed");
    await expect(promise).resolves.toEqual({ userId: 99, chatId: 5, username: null });
  });

  it("gives every window its own code", async () => {
    const codes = ["111111", "222222"];
    const sched = makeFakeScheduler();
    const pairing = new DefaultPairingMode({
      scheduleTimeout: sched.schedule,
      generateCode: () => codes.shift()!,
    });
    const first = pairing.start();
    expect(pairing.currentCode()).toBe("111111");
    const second = pairing.start();
    await expect(first).resolves.toBeNull();
    expect(pairing.currentCode()).toBe("222222");
    // The old window's code is dead.
    expect(pairing.tryClaim(privateUpdate("/start 111111"))).toBe("wrong_code");
    expect(pairing.tryClaim(privateUpdate("/start 222222", 7, 8))).toBe("claimed");
    await expect(second).resolves.toEqual({ userId: 7, chatId: 8, username: null });
  });

  it("resolves with null when the timeout fires before any claim", async () => {
    const sched = makeFakeScheduler();
    const pairing = withCode({ scheduleTimeout: sched.schedule });

    const promise = pairing.start(60_000);
    sched.fireAll();

    await expect(promise).resolves.toBeNull();
    expect(pairing.isActive()).toBe(false);
    expect(pairing.tryClaim(privateUpdate(`/start ${CODE}`))).toBe("ignored");
  });

  it("resolves with null when cancel() is called", async () => {
    const sched = makeFakeScheduler();
    const pairing = withCode({ scheduleTimeout: sched.schedule });

    const promise = pairing.start();
    pairing.cancel();
    await expect(promise).resolves.toBeNull();
    expect(pairing.isActive()).toBe(false);
    expect(sched.pendingCount()).toBe(0);
  });

  it("a second claim after a successful one is ignored", async () => {
    const sched = makeFakeScheduler();
    const pairing = withCode({ scheduleTimeout: sched.schedule });

    const promise = pairing.start();
    expect(pairing.tryClaim(privateUpdate(`/start ${CODE}`, 1, 2))).toBe("claimed");
    expect(pairing.tryClaim(privateUpdate(`/start ${CODE}`, 9, 9))).toBe("ignored");
    await expect(promise).resolves.toEqual({ userId: 1, chatId: 2, username: null });
  });

  it("returns null immediately when timeoutMs is non-positive", async () => {
    const pairing = withCode();
    await expect(pairing.start(0)).resolves.toBeNull();
    expect(pairing.isActive()).toBe(false);
    expect(pairing.currentCode()).toBeNull();
  });

  it("cancel() is a no-op when inactive", () => {
    const pairing = withCode();
    expect(() => pairing.cancel()).not.toThrow();
    expect(pairing.isActive()).toBe(false);
  });

  it("clears the timer when a claim arrives so timeout never fires after resolution", async () => {
    const sched = makeFakeScheduler();
    const pairing = withCode({ scheduleTimeout: sched.schedule });

    const promise = pairing.start();
    pairing.tryClaim(privateUpdate(`/start ${CODE}`, 1, 2));
    expect(sched.pendingCount()).toBe(0);

    sched.fireAll();
    await expect(promise).resolves.toEqual({ userId: 1, chatId: 2, username: null });
  });
});
