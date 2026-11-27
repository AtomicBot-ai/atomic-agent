import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent, fetch as undiciFetch } from "undici";
import { SsrfBlockedError, assertHostAllowed } from "../tools/os/web/web-fetch-ssrf-guard.js";
import { createFetchUrl } from "./mention-url.js";
import { pinnedLookup, type FetchLike, type VetHost } from "./mention-url-hops.js";

/**
 * ATO-2797. Two real servers on this machine: `first` answers a redirect,
 * `inside` stands for a local service and counts every request it gets.
 * `public.test` and `other.test` play public sites: the vetting stub says
 * they are public and hands back 127.0.0.1 as their checked address, so the
 * pinned connection reaches `first`. Every other host goes through the real
 * SSRF guard, which refuses 127.0.0.1 typed as a literal.
 */

let first: Server;
let inside: Server;
let insideHits = 0;
let firstPort = 0;
let insidePort = 0;
let redirectTo = "";

/**
 * F2078.2: with a proxy variable set the hops are not pinned, and plain
 * undici cannot resolve `.test` names, so the pinned test would fail for the
 * machine's settings rather than the code. Every proxy variable is cleared
 * for each test and put back after.
 */
const PROXY_VARS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY"];
let savedProxyEnv: Record<string, string | undefined> = {};

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

beforeEach(async () => {
  savedProxyEnv = Object.fromEntries(PROXY_VARS.map((k) => [k, process.env[k]]));
  for (const k of PROXY_VARS) delete process.env[k];
  insideHits = 0;
  inside = createServer((_req, res) => {
    insideHits += 1;
    res.writeHead(200, { "content-type": "text/plain" }).end("router admin page");
  });
  first = createServer((_req, res) => {
    res.writeHead(302, { location: redirectTo }).end();
  });
  insidePort = await listen(inside);
  firstPort = await listen(first);
});

afterEach(async () => {
  for (const k of PROXY_VARS) {
    const v = savedProxyEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await new Promise((r) => first.close(r));
  await new Promise((r) => inside.close(r));
});

const PUBLIC_NAMES = new Set(["public.test", "other.test"]);
const vetHost: VetHost = async (url) => (PUBLIC_NAMES.has(url.hostname) ? ["127.0.0.1"] : assertHostAllowed(url));

/**
 * Stands in for the network: a request that carries no pinned pool still
 * reaches this machine for the play names, which is what a fetch that
 * follows redirects on its own would do. With the fix every hop to a play
 * name carries its own pinned pool, so this fallback never decides where a
 * checked hop goes.
 */
const anyHostHere = new Agent({ connect: { lookup: pinnedLookup(["127.0.0.1"]) } });
afterAll(async () => { await anyHostHere.close(); });
const network: FetchLike = (url, init) => undiciFetch(url, { ...init, dispatcher: init.dispatcher ?? anyHostHere } as never) as unknown as Promise<Response>;

describe("@url redirects are checked before they connect (ATO-2797)", () => {
  it("refuses a public link that redirects to this computer without asking the local server", async () => {
    redirectTo = `http://127.0.0.1:${insidePort}/admin`;
    const read = createFetchUrl(network, { vetHost })(`http://public.test:${firstPort}/go`);
    await expect(read).rejects.toThrow("redirected to a local address");
    expect(insideHits).toBe(0);
  });

  it("refuses a redirect to a name that resolves to this computer, before connecting", async () => {
    redirectTo = `http://rebind.test:${insidePort}/admin`;
    const rebinding: VetHost = async (url) => {
      if (url.hostname === "rebind.test") throw new SsrfBlockedError("rebind.test resolves to a private/internal address (127.0.0.1)", url.hostname);
      return vetHost(url);
    };
    await expect(createFetchUrl(network, { vetHost: rebinding })(`http://public.test:${firstPort}/go`)).rejects.toThrow("redirected to a local address");
    expect(insideHits).toBe(0);
  });

  it("follows a redirect to another public site, connecting only to its checked address", async () => {
    redirectTo = `http://other.test:${insidePort}/page`;
    // Plain undici fetch, no fallback pool: `.test` names do not resolve, so
    // reaching the server at all proves each hop was pinned.
    const got = await createFetchUrl(undiciFetch as unknown as FetchLike, { vetHost })(`http://public.test:${firstPort}/go`);
    expect(got.text).toBe("router admin page");
    expect(insideHits).toBe(1);
  });

  it("still reads a local link the person typed, redirects included", async () => {
    redirectTo = `http://127.0.0.1:${insidePort}/admin`;
    const got = await createFetchUrl(network, { vetHost })(`http://127.0.0.1:${firstPort}/go`);
    expect(got.text).toBe("router admin page");
  });

  it("refuses a public name with one private address in its answer that redirects here (F2078.1)", async () => {
    redirectTo = `http://127.0.0.1:${insidePort}/admin`;
    // The real guard over a mixed answer: one public and one private address.
    // Before the fix its refusal made the link "local on purpose" and the
    // redirect was followed unchecked, so the local server was asked.
    const mixed: VetHost = async (url) => url.hostname === "mixed.test"
      ? assertHostAllowed(url, { lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }] })
      : vetHost(url);
    await expect(createFetchUrl(network, { vetHost: mixed })(`http://mixed.test:${firstPort}/go`)).rejects.toThrow("redirected to a local address");
    expect(insideHits).toBe(0);
  });

  it("does not read a public name whose lookup fails (F2078.1)", async () => {
    redirectTo = `http://127.0.0.1:${insidePort}/admin`;
    const failing: VetHost = async (url) => {
      if (url.hostname === "public.test") throw new SsrfBlockedError("DNS resolution failed for public.test: SERVFAIL", url.hostname);
      return vetHost(url);
    };
    await expect(createFetchUrl(network, { vetHost: failing })(`http://public.test:${firstPort}/go`)).rejects.toThrow("could not be fetched");
    expect(insideHits).toBe(0);
  });

  it("refuses a redirect to a host that is local by its text even when the check passes it", async () => {
    redirectTo = `http://printer.local:${insidePort}/admin`;
    const lenient: VetHost = async () => ["127.0.0.1"];
    await expect(createFetchUrl(network, { vetHost: lenient })(`http://public.test:${firstPort}/go`)).rejects.toThrow("redirected to a local address");
    expect(insideHits).toBe(0);
  });

  it("stops after five redirects", async () => {
    redirectTo = `http://public.test:${firstPort}/again`;
    await expect(createFetchUrl(network, { vetHost })(`http://public.test:${firstPort}/go`)).rejects.toThrow("too many redirects");
  });
});

describe("pinnedLookup", () => {
  it("answers only with the checked addresses, in both callback shapes", async () => {
    const lookup = pinnedLookup(["93.184.216.34", "2606:2800:220:1::1"]);
    const all = await new Promise((resolve) => lookup("x.test", { all: true }, (_e, list) => resolve(list)));
    expect(all).toEqual([{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1::1", family: 6 }]);
    const v6 = await new Promise((resolve) => lookup("x.test", { family: 6 }, (_e, address) => resolve(address)));
    expect(v6).toBe("2606:2800:220:1::1");
  });
});
