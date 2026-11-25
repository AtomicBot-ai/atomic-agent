import { afterEach, describe, expect, it } from "vitest";
import { getGlobalDispatcher } from "undici";

import type { AtomicAgentConfig } from "../config/index.js";
import {
  agentProxyFrom,
  chromeProxyArgs,
  currentAgentProxy,
  curlProxyEnv,
  redactProxyUrl,
  resetAgentProxyForTests,
  sameAgentProxy,
} from "./agent-proxy.js";
import { installTransportDeadlines, resetTransportDeadlines } from "./transport-deadlines.js";

afterEach(() => {
  resetAgentProxyForTests();
  resetTransportDeadlines();
});

describe("agentProxyFrom (ATO-87)", () => {
  it("is off without a URL", () => {
    expect(agentProxyFrom(undefined)).toBeNull();
    expect(agentProxyFrom({ url: null, noProxy: ["a.com"] })).toBeNull();
  });

  it("keeps credentials in url, drops them from server, always bypasses this machine", () => {
    const proxy = agentProxyFrom({ url: "http://u:p@10.0.0.2:3128", noProxy: ["A.com", "localhost"] });
    expect(proxy).toEqual({
      url: "http://u:p@10.0.0.2:3128",
      server: "http://10.0.0.2:3128",
      noProxy: ["localhost", "127.0.0.1", "::1", "a.com"],
    });
  });

  it("compares by URL and list", () => {
    const a = agentProxyFrom({ url: "http://p:1", noProxy: [] });
    expect(sameAgentProxy(a, agentProxyFrom({ url: "http://p:1", noProxy: [] }))).toBe(true);
    expect(sameAgentProxy(a, agentProxyFrom({ url: "http://p:1", noProxy: ["x"] }))).toBe(false);
    expect(sameAgentProxy(a, null)).toBe(false);
    expect(sameAgentProxy(null, null)).toBe(true);
  });
});

describe("redactProxyUrl", () => {
  it("hides the password", () => {
    expect(redactProxyUrl("http://user:s3cret@p.corp:8080")).toBe("http://user:***@p.corp:8080");
    expect(redactProxyUrl("http://p.corp:8080")).toBe("http://p.corp:8080");
    expect(redactProxyUrl("nope")).toBe("(invalid proxy URL)");
  });
});

describe("curlProxyEnv", () => {
  const proxy = agentProxyFrom({ url: "http://p:1", noProxy: [] });

  it("sets curl's proxy variables", () => {
    expect(curlProxyEnv(proxy, undefined)).toMatchObject({
      http_proxy: "http://p:1",
      https_proxy: "http://p:1",
      no_proxy: "localhost,127.0.0.1,::1",
    });
  });

  it("leaves an env that already names a proxy alone", () => {
    expect(curlProxyEnv(proxy, { ALL_PROXY: "http://127.0.0.1:9" })).toEqual({});
    expect(curlProxyEnv(null, undefined)).toEqual({});
  });
});

describe("chromeProxyArgs", () => {
  it("passes the server without credentials and the bypass list with subdomains", () => {
    const proxy = agentProxyFrom({ url: "http://u:p@10.0.0.2:3128", noProxy: ["a.com", ".b.org"] });
    expect(chromeProxyArgs(proxy)).toEqual([
      "--proxy-server=http://10.0.0.2:3128",
      "--proxy-bypass-list=a.com;*.a.com;b.org;*.b.org",
    ]);
    expect(chromeProxyArgs(agentProxyFrom({ url: "http://p:1", noProxy: [] }))).toEqual([
      "--proxy-server=http://p:1",
    ]);
    expect(chromeProxyArgs(null)).toEqual([]);
  });
});

describe("installTransportDeadlines with network.proxy", () => {
  const withProxy = (url: string | null) =>
    ({ network: { offline: false, proxy: { url, noProxy: [] } } }) as unknown as AtomicAgentConfig;

  it("routes fetch through the user's proxy and drops it again", () => {
    installTransportDeadlines(withProxy("http://10.0.0.2:3128"));
    expect(currentAgentProxy()?.server).toBe("http://10.0.0.2:3128");
    const pooled = getGlobalDispatcher();
    // A changed proxy rebuilds the pool even with the same deadlines.
    installTransportDeadlines(withProxy("http://10.0.0.3:3128"));
    expect(getGlobalDispatcher()).not.toBe(pooled);
    installTransportDeadlines(withProxy(null));
    expect(currentAgentProxy()).toBeNull();
  });

  it("leaves the proxy alone on the bare floor install", () => {
    installTransportDeadlines(withProxy("http://10.0.0.2:3128"));
    installTransportDeadlines();
    expect(currentAgentProxy()?.server).toBe("http://10.0.0.2:3128");
  });
});
