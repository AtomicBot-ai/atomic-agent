import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isLoopbackListenHost,
  lanUrls,
  parseArgs,
  serveAuthWarning,
  type ServeArgs,
} from "./serve-args.js";

function parsedOk(args: string[]): ServeArgs {
  const parsed = parseArgs(args);
  if ("help" in parsed || "error" in parsed) {
    throw new Error(`expected a parse, got ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

function parseError(args: string[]): string {
  const parsed = parseArgs(args);
  if (!("error" in parsed)) {
    throw new Error(`expected an error, got ${JSON.stringify(parsed)}`);
  }
  return parsed.error;
}

beforeEach(() => {
  // An operator's own key in the environment must not hide a missing one.
  vi.stubEnv("ATOMIC_AGENT_API_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("serve refuses a network host without an API key (ATO-760)", () => {
  it.each(["0.0.0.0", "::", "[::]", "192.168.1.20", "10.0.0.5", "my-box.lan"])(
    "--host %s without a key is an error that says how to set one",
    (host) => {
      const error = parseError(["--host", host]);
      expect(error).toContain(`--host ${host}`);
      expect(error).toContain("--api-key");
      expect(error).toContain("ATOMIC_AGENT_API_KEY");
    },
  );

  it("starts on a network host with --api-key", () => {
    const parsed = parsedOk(["--host", "0.0.0.0", "--api-key", "s3cret-0123456789ab"]);
    expect(parsed.host).toBe("0.0.0.0");
    expect(parsed.apiKey).toBe("s3cret-0123456789ab");
  });

  it("starts on a network host with ATOMIC_AGENT_API_KEY", () => {
    vi.stubEnv("ATOMIC_AGENT_API_KEY", "from-env-0123456789");
    const parsed = parsedOk(["--host", "0.0.0.0"]);
    expect(parsed.apiKey).toBe("from-env-0123456789");
  });

  it("refuses a short key on a network host, and keeps it on loopback (ATO-1126)", () => {
    expect(parseError(["--host", "0.0.0.0", "--api-key", "short"])).toContain("at least 16");
    expect(parsedOk(["--api-key", "short"]).apiKey).toBe("short");
  });

  it("rejects an empty --api-key instead of treating it as a key", () => {
    expect(parseError(["--api-key", ""])).toContain("--api-key");
  });

  it("does not ask for a key to sweep strays with --reap", () => {
    expect(parsedOk(["--host", "0.0.0.0", "--reap"]).reapOnly).toBe(true);
  });
});

describe("loopback without a key still starts, with a warning", () => {
  it.each(["127.0.0.1", "127.0.0.2", "localhost", "LOCALHOST", "::1", "[::1]"])(
    "--host %s without a key parses",
    (host) => {
      expect(parsedOk(["--host", host]).apiKey).toBeNull();
    },
  );

  it("the default host is loopback and parses without a key", () => {
    const parsed = parsedOk([]);
    expect(parsed.host).toBe("127.0.0.1");
    expect(parsed.apiKey).toBeNull();
  });

  it("warns in one line when there is no key, and not when there is one", () => {
    const warning = serveAuthWarning({ apiKey: null });
    expect(warning).not.toBeNull();
    expect(warning!.trimEnd()).not.toContain("\n");
    expect(warning).toContain("ATOMIC_AGENT_API_KEY");
    expect(serveAuthWarning({ apiKey: "s3cret" })).toBeNull();
  });
});

describe("the desktop app's launch line", () => {
  it("parses unchanged: loopback host, a per-launch key, no warning", () => {
    // desktop/main/agent-client.ts spawns exactly this shape.
    const parsed = parsedOk([
      "--host", "127.0.0.1", "--port", "51234", "--api-key", "a".repeat(48),
    ]);
    expect(parsed.host).toBe("127.0.0.1");
    expect(parsed.port).toBe(51234);
    expect(parsed.apiKey).toBe("a".repeat(48));
    expect(serveAuthWarning(parsed)).toBeNull();
  });
});

describe("isLoopbackListenHost", () => {
  it("is true only for hosts that accept local connections only", () => {
    expect(isLoopbackListenHost("127.0.0.1")).toBe(true);
    expect(isLoopbackListenHost("localhost.")).toBe(true);
    expect(isLoopbackListenHost("0.0.0.0")).toBe(false);
    expect(isLoopbackListenHost("::")).toBe(false);
    expect(isLoopbackListenHost("128.0.0.1")).toBe(false);
    expect(isLoopbackListenHost("127.evil.example")).toBe(false);
  });
});

describe("lanUrls (ATO-1126)", () => {
  const nics = {
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }, { address: "fe80::1", family: "IPv6", internal: false }],
  } as unknown as Parameters<typeof lanUrls>[2];
  it("lists this machine's LAN addresses when serve listens everywhere", () => {
    expect(lanUrls("0.0.0.0", 8787, nics)).toEqual(["http://192.168.1.20:8787"]);
    expect(lanUrls("::", 8787, nics)).toEqual(["http://192.168.1.20:8787"]);
  });
  it("lists nothing for loopback or one named host", () => {
    expect(lanUrls("127.0.0.1", 8787, nics)).toEqual([]);
    expect(lanUrls("192.168.1.20", 8787, nics)).toEqual([]);
  });
});
