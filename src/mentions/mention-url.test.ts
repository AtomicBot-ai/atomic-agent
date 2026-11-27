import { afterEach, describe, expect, it } from "vitest";
import { resetOfflineNetworkForTests, setOfflineNetwork } from "../llm/offline-network.js";
import { isLocalHost } from "./mention-hosts.js";
import { htmlToText } from "./mention-html.js";
import { UrlSkip, createFetchUrl } from "./mention-url.js";

const page = (body: string, type = "text/html; charset=utf-8", status = 200): typeof fetch =>
  (async () => new Response(body, { status, headers: { "content-type": type } })) as typeof fetch;

afterEach(() => resetOfflineNetworkForTests());

describe("createFetchUrl", () => {
  it("returns an HTML page as its words", async () => {
    const got = await createFetchUrl(page("<html><head><style>x{}</style></head><body><h1>Hi &amp; bye</h1><script>evil()</script><p>Two</p></body></html>"))("https://example.com/");
    expect(got).toEqual({ text: "Hi & bye\nTwo", cut: false });
  });

  it("refuses an error status, a binary answer and a non-http link with a plain reason", async () => {
    await expect(createFetchUrl(page("nope", "text/plain", 404))("https://x.example/")).rejects.toThrow("page not found");
    await expect(createFetchUrl(page("PNG", "image/png"))("https://x.example/a.png")).rejects.toThrow(/not a text page/);
    await expect(createFetchUrl(page("x"))("file:///etc/hosts")).rejects.toBeInstanceOf(UrlSkip);
  });

  it("refuses a public link that lands on a local address", async () => {
    const landed = (async () => ({
      ok: true, status: 200, url: "http://169.254.169.254/latest/",
      headers: new Headers({ "content-type": "text/plain" }), body: new Response("inside").body,
    })) as unknown as typeof fetch;
    await expect(createFetchUrl(landed)("https://public.example/go")).rejects.toThrow("redirected to a local address");
  });

  it("says offline mode is on instead of asking the network", async () => {
    setOfflineNetwork(true);
    let called = false;
    const spy = (async () => { called = true; return new Response("x"); }) as typeof fetch;
    await expect(createFetchUrl(spy)("https://example.com/")).rejects.toThrow("offline mode is on");
    expect(called).toBe(false);
  });
});

describe("mention hosts and html", () => {
  it("tells local hosts from public ones by their text", () => {
    for (const host of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.1.1", "[::1]", "printer.local"]) expect(isLocalHost(host), host).toBe(true);
    for (const host of ["example.com", "8.8.8.8", "localhost.example.com"]) expect(isLocalHost(host), host).toBe(false);
  });

  it("reduces hostile markup in linear time", () => {
    const started = performance.now();
    htmlToText("<!--".repeat(128 * 1024));
    expect(performance.now() - started).toBeLessThan(500);
  });
});
