import { describe, expect, it } from "vitest";
import {
  CrawlPoliteness,
  HostPacer,
  MAX_BACKOFF_MS,
  MAX_CRAWL_DELAY_MS,
  TtlCache,
  isExemptHost,
  robotsPolicyFromResponse,
} from "./crawl-politeness.js";

/** A clock that only moves when the pacer "sleeps". */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; waits: number[] } {
  let t = 1_000_000;
  const waits: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
    waits,
  };
}

const signal = new AbortController().signal;
const config = {
  minDelayMs: 1_000,
  maxPages: 50,
  maxDepth: 2,
  respectRobots: true,
  robotsExemptHosts: ["mysite.dev", "*.example.org"],
  cacheTtlMinutes: 15,
};

describe("HostPacer", () => {
  it("spaces requests to one host by the minimum delay, other hosts run free", async () => {
    const clock = fakeClock();
    const pacer = new HostPacer(1_000, clock.sleep, clock.now);
    await pacer.acquire("a.com", signal);
    await pacer.acquire("a.com", signal);
    await pacer.acquire("b.com", signal);
    await pacer.acquire("a.com", signal);
    expect(clock.waits).toEqual([1_000, 1_000]);
  });

  it("obeys a longer Crawl-delay but caps it", async () => {
    const clock = fakeClock();
    const pacer = new HostPacer(1_000, clock.sleep, clock.now);
    pacer.setHostDelay("a.com", 5_000);
    expect(pacer.hostDelay("a.com")).toBe(5_000);
    pacer.setHostDelay("b.com", 10 * 60_000);
    expect(pacer.hostDelay("b.com")).toBe(MAX_CRAWL_DELAY_MS);
    pacer.setHostDelay("c.com", 0);
    expect(pacer.hostDelay("c.com")).toBe(1_000);
  });

  it("waits out Retry-After after a 429, capped, and counts strikes", async () => {
    const clock = fakeClock();
    const pacer = new HostPacer(1_000, clock.sleep, clock.now);
    await pacer.acquire("a.com", signal);
    pacer.noteResponse("a.com", 429, 7_000);
    await pacer.acquire("a.com", signal);
    expect(clock.waits).toEqual([7_000]);
    pacer.noteResponse("a.com", 429, 10 * 60_000);
    await pacer.acquire("a.com", signal);
    expect(clock.waits[1]).toBe(MAX_BACKOFF_MS);
    expect(pacer.isThrottled("a.com")).toBe(false);
    pacer.noteResponse("a.com", 503, null);
    expect(pacer.isThrottled("a.com")).toBe(true);
    pacer.noteResponse("a.com", 200, null);
    expect(pacer.isThrottled("a.com")).toBe(false);
  });

  it("backs off exponentially when a 429 carries no Retry-After", async () => {
    const clock = fakeClock();
    const pacer = new HostPacer(1_000, clock.sleep, clock.now);
    await pacer.acquire("a.com", signal);
    pacer.noteResponse("a.com", 429, null);
    await pacer.acquire("a.com", signal);
    expect(clock.waits).toEqual([2_000]);
  });
});

describe("TtlCache", () => {
  it("expires entries and evicts the oldest past the size bound", () => {
    let t = 0;
    const cache = new TtlCache<string>(100, 2, () => t);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("c")).toBe("3");
    t = 200;
    expect(cache.get("c")).toBeUndefined();
  });

  it("stores nothing with a zero TTL", () => {
    const cache = new TtlCache<string>(0, 10);
    cache.set("a", "1");
    expect(cache.get("a")).toBeUndefined();
  });
});

describe("robots decisions", () => {
  it("maps answers per RFC 9309: 4xx allows, 5xx/429/no answer disallows", () => {
    const url = new URL("https://x.com/a");
    expect(robotsPolicyFromResponse({ status: 404, body: "" }).source).toBe("missing");
    expect(robotsPolicyFromResponse({ status: 503, body: "" }).source).toBe("unreachable");
    expect(robotsPolicyFromResponse({ status: 429, body: "" }).source).toBe("unreachable");
    expect(robotsPolicyFromResponse(null).policy.rules).toEqual([{ allow: false, pattern: "/" }]);
    const file = robotsPolicyFromResponse({ status: 200, body: "User-agent: *\nDisallow: /a" });
    expect(file.source).toBe("file");
    expect(file.policy.rules.length).toBe(1);
    expect(url.pathname).toBe("/a");
  });

  it("matches exempt hosts exactly or by *. suffix", () => {
    expect(isExemptHost("mysite.dev", config.robotsExemptHosts)).toBe(true);
    expect(isExemptHost("www.mysite.dev", config.robotsExemptHosts)).toBe(false);
    expect(isExemptHost("docs.example.org", config.robotsExemptHosts)).toBe(true);
    expect(isExemptHost("example.org", config.robotsExemptHosts)).toBe(true);
    expect(isExemptHost("badexample.org", config.robotsExemptHosts)).toBe(false);
  });

  it("fetches robots.txt once per origin, applies Crawl-delay, skips exempt hosts", async () => {
    const clock = fakeClock();
    const politeness = new CrawlPoliteness({ config, sleep: clock.sleep, now: clock.now });
    const asked: string[] = [];
    const fetchRobots = async (u: string) => {
      asked.push(u);
      return { status: 200, body: "User-agent: *\nCrawl-delay: 3\nDisallow: /secret" };
    };
    const first = await politeness.robotsFor(new URL("https://x.com/a"), fetchRobots);
    await politeness.robotsFor(new URL("https://x.com/b"), fetchRobots);
    expect(asked).toEqual(["https://x.com/robots.txt"]);
    expect(politeness.allows(first, new URL("https://x.com/secret/1"))).toBe(false);
    expect(politeness.pacer.hostDelay("x.com")).toBe(3_000);

    const exempt = await politeness.robotsFor(new URL("https://mysite.dev/secret"), fetchRobots);
    expect(exempt.source).toBe("exempt");
    expect(asked).toHaveLength(1);
  });

  it("treats a failed robots.txt fetch as unreachable", async () => {
    const clock = fakeClock();
    const politeness = new CrawlPoliteness({ config, sleep: clock.sleep, now: clock.now });
    const decision = await politeness.robotsFor(new URL("https://y.com/"), async () => {
      throw new Error("connection reset");
    });
    expect(decision.source).toBe("unreachable");
    expect(politeness.allows(decision, new URL("https://y.com/"))).toBe(false);
  });

  it("does not read robots.txt when respectRobots is off", async () => {
    const clock = fakeClock();
    const politeness = new CrawlPoliteness({
      config: { ...config, respectRobots: false },
      sleep: clock.sleep,
      now: clock.now,
    });
    const decision = await politeness.robotsFor(new URL("https://z.com/"), async () => {
      throw new Error("must not be called");
    });
    expect(decision.source).toBe("disabled");
  });
});
