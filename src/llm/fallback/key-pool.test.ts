import { describe, expect, it, vi } from "vitest";

import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import {
  createKeyPool,
  createKeyPoolStore,
  KEY_COOLDOWN_MS,
  orderedUniqueKeys,
  ProviderKeyPool,
  type KeyPoolOptions,
} from "./key-pool.js";

function http(status: number | null, retryAfterMs: number | null = null): OpenAiHttpError {
  return new OpenAiHttpError(
    `openai provider ${status}: boom`,
    status,
    "https://api.example.com/v1/chat/completions",
    false,
    retryAfterMs,
    "p",
  );
}

function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function pool(keys: string[], extra: Partial<KeyPoolOptions> = {}): ProviderKeyPool {
  const made = createKeyPool({
    providerId: "groq",
    keys,
    store: createKeyPoolStore(),
    ...extra,
  });
  if (!made) throw new Error("expected a pool");
  return made;
}

describe("orderedUniqueKeys", () => {
  it("keeps the primary first, trims, and drops blanks and duplicates", () => {
    expect(orderedUniqueKeys(["k1", " k2 ", "", undefined, "k1", "k2", "k3"])).toEqual([
      "k1",
      "k2",
      "k3",
    ]);
  });
});

describe("createKeyPool", () => {
  it("makes no pool for one key, so a single-key provider is unchanged", () => {
    expect(createKeyPool({ providerId: "p", keys: ["k1"] })).toBeUndefined();
    expect(createKeyPool({ providerId: "p", keys: ["k1", "k1", " "] })).toBeUndefined();
    expect(createKeyPool({ providerId: "p", keys: [] })).toBeUndefined();
  });

  it("counts each distinct key once", () => {
    expect(pool(["k1", "k2", "k1", "k2"]).size).toBe(2);
  });
});

describe("ProviderKeyPool", () => {
  it("starts on the primary key", () => {
    expect(pool(["k1", "k2", "k3"]).current()).toBe("k1");
  });

  it("rotates in config order on a rate limit, a refused key and an empty account", () => {
    const p = pool(["k1", "k2", "k3"]);
    expect(p.rotate("k1", http(429))).toBe("k2");
    expect(p.current()).toBe("k2");
    expect(p.rotate("k2", http(401))).toBe("k3");
    expect(p.current()).toBe("k3");
    // k1 and k2 are cooling: nothing else to try.
    expect(p.rotate("k3", http(402))).toBeNull();
  });

  it("does not rotate on a failure another key would not fix", () => {
    const p = pool(["k1", "k2"]);
    for (const err of [http(500), http(null), http(400), new Error("parse")]) {
      expect(p.wouldRotate("k1", err)).toBe(false);
      expect(p.rotate("k1", err)).toBeNull();
    }
    expect(p.current()).toBe("k1");
  });

  it("stays on the key that served (sticky), even after the primary recovers", () => {
    const clock = makeClock();
    const p = pool(["k1", "k2"], { now: clock.now });
    p.rotate("k1", http(429));
    p.succeeded("k2");
    clock.advance(KEY_COOLDOWN_MS.rate_limit[0]! + 1);
    expect(p.current()).toBe("k2");
    // Only when k2 is refused does the pool go back to k1.
    expect(p.rotate("k2", http(429))).toBe("k1");
  });

  it("lets a cooled-down key be picked again once its cooldown expires", () => {
    const clock = makeClock();
    const p = pool(["k1", "k2"], { now: clock.now });
    expect(p.rotate("k1", http(429))).toBe("k2");
    expect(p.rotate("k2", http(429))).toBeNull();
    // Both cooling: the request still goes out on the one free soonest.
    expect(p.current()).toBe("k1");
    expect(p.wouldRotate("k1", http(429))).toBe(false);
    clock.advance(KEY_COOLDOWN_MS.rate_limit[0]! + 1);
    expect(p.wouldRotate("k1", http(429))).toBe(true);
  });

  it("honours a Retry-After longer than the ladder for a rate limit", () => {
    const clock = makeClock();
    const p = pool(["k1", "k2"], { now: clock.now });
    p.rotate("k1", http(429, 120_000));
    p.rotate("k2", http(500));
    clock.advance(KEY_COOLDOWN_MS.rate_limit[0]! + 1);
    // Past the 60 s ladder step, still inside the 120 s the service asked.
    expect(p.wouldRotate("k2", http(429))).toBe(false);
    clock.advance(60_000);
    expect(p.wouldRotate("k2", http(429))).toBe(true);
  });

  it("escalates a key that keeps hitting its limit", () => {
    const clock = makeClock();
    const p = pool(["k1", "k2"], { now: clock.now });
    p.rotate("k1", http(429));
    clock.advance(KEY_COOLDOWN_MS.rate_limit[0]! + 1);
    p.succeeded("k2");
    p.rotate("k2", http(429));
    // k1 is free again and is refused a second time: longer cooldown.
    p.rotate("k1", http(429));
    clock.advance(KEY_COOLDOWN_MS.rate_limit[0]! + 1);
    expect(p.wouldRotate("k2", http(429))).toBe(false);
  });

  it("forgets a key's failures once it serves", () => {
    const clock = makeClock();
    const store = createKeyPoolStore();
    const p = pool(["k1", "k2"], { now: clock.now, store });
    p.rotate("k1", http(429));
    clock.advance(KEY_COOLDOWN_MS.rate_limit[0]! + 1);
    p.succeeded("k1");
    expect(store.keys.size).toBe(0);
  });

  it("shares cooldowns between pools of the same provider (a rebuilt provider)", () => {
    const store = createKeyPoolStore();
    const a = pool(["k1", "k2"], { store });
    a.rotate("k1", http(429));
    const b = pool(["k1", "k2"], { store });
    expect(b.current()).toBe("k2");
  });

  it("never puts a key in the store's map keys or in the log", () => {
    const warn = vi.fn();
    const store = createKeyPoolStore();
    const p = pool(["sk-secret-one", "sk-secret-two"], {
      store,
      logger: { warn },
    });
    p.rotate("sk-secret-one", http(429));
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("sk-secret");
    expect(logged).toContain("key 1 of 2");
    for (const id of [...store.keys.keys(), ...store.cursor.values()]) {
      expect(id).not.toContain("sk-secret");
    }
  });
});
