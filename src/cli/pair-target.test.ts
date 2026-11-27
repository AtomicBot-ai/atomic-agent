import { describe, expect, it } from "vitest";

import { normalizeBaseUrl, resolvePairTarget } from "./pair-target.js";
import type { ServeRecord } from "./serve-reaper.js";

/** ATO-2308: which address goes into the QR code of `atag pair`. */
function record(host: string, port = 8787, pid = 100, startedAt = "2026-11-27T10:00:00.000Z"): ServeRecord {
  return { pid, bootPpid: 1, daemon: true, host, port, cwd: "/tmp", startedAt };
}

const alive = () => true;
const lan = () => ["http://192.168.1.20:8787", "http://10.0.0.5:8787"];

describe("resolvePairTarget", () => {
  it("uses the LAN address of a serve on 0.0.0.0, and lists the others", () => {
    expect(resolvePairTarget({ records: [record("0.0.0.0")], remote: false, url: null, isAlive: alive, lanUrls: lan }))
      .toEqual({ ok: true, kind: "lan", baseUrl: "http://192.168.1.20:8787", others: ["http://10.0.0.5:8787"] });
  });

  it("refuses a loopback serve without --remote, saying how to fix it", () => {
    const out = resolvePairTarget({ records: [record("127.0.0.1")], remote: false, url: null, isAlive: alive, lanUrls: lan });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("--host 0.0.0.0");
  });

  it("--remote points cloudflared at serve's loopback port", () => {
    expect(resolvePairTarget({ records: [record("127.0.0.1", 9000)], remote: true, url: null, isAlive: alive }))
      .toEqual({ ok: true, kind: "remote", originUrl: "http://127.0.0.1:9000" });
    expect(resolvePairTarget({ records: [record("0.0.0.0", 9000)], remote: true, url: null, isAlive: alive }))
      .toEqual({ ok: true, kind: "remote", originUrl: "http://127.0.0.1:9000" });
  });

  it("picks the newest live serve and skips dead records", () => {
    const records = [
      record("192.168.1.9", 1111, 1, "2026-11-27T09:00:00.000Z"),
      record("192.168.1.9", 2222, 2, "2026-11-27T11:00:00.000Z"),
      record("192.168.1.9", 3333, 3, "2026-11-27T12:00:00.000Z"),
    ];
    const out = resolvePairTarget({ records, remote: false, url: null, isAlive: (pid) => pid !== 3 });
    expect(out).toMatchObject({ ok: true, baseUrl: "http://192.168.1.9:2222" });
  });

  it("says to start serve when none is running", () => {
    const out = resolvePairTarget({ records: [record("0.0.0.0")], remote: false, url: null, isAlive: () => false });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("no atag serve is running");
  });

  it("--url wins over the records, and cannot go with --remote", () => {
    expect(resolvePairTarget({ records: [], remote: false, url: "https://box.tail1234.ts.net/x", isAlive: alive }))
      .toEqual({ ok: true, kind: "lan", baseUrl: "https://box.tail1234.ts.net", others: [] });
    expect(resolvePairTarget({ records: [], remote: true, url: "https://a.example", isAlive: alive }).ok).toBe(false);
  });
});

describe("normalizeBaseUrl", () => {
  it("keeps only http(s) origins", () => {
    expect(normalizeBaseUrl("http://10.0.0.5:8787/")).toBe("http://10.0.0.5:8787");
    expect(normalizeBaseUrl("ftp://x")).toBeNull();
    expect(normalizeBaseUrl("not a url")).toBeNull();
  });
});
