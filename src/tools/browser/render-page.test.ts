import { describe, it, expect } from "vitest";
import type { BrowserBackend, RenderHtmlInput, RenderHtmlResult } from "./browser-backend.js";
import { buildBrowserPageRenderer } from "./render-page.js";
import { EMPTY_DOMAIN_POLICY } from "./browser-domain-policy.js";

/** Only `renderHtml` is exercised; every other method fails loudly. */
function backendRendering(
  result: Partial<RenderHtmlResult>,
): BrowserBackend & { inputs: RenderHtmlInput[] } {
  const inputs: RenderHtmlInput[] = [];
  const unused = () => {
    throw new Error("not used by the renderer");
  };
  return {
    inputs,
    ensureReady: unused,
    shutdown: unused,
    snapshot: unused,
    hasRef: unused,
    describeRef: unused,
    currentUrl: unused,
    navigate: unused,
    click: unused,
    type: unused,
    search: unused,
    tabs: unused,
    scroll: unused,
    screenshot: unused,
    async renderHtml(input) {
      inputs.push(input);
      return {
        url: input.url,
        title: "T",
        html: "<html><body>ok</body></html>",
        frameUrls: [input.url],
        ...result,
      };
    },
  } as BrowserBackend & { inputs: RenderHtmlInput[] };
}

describe("buildBrowserPageRenderer (ATO-968)", () => {
  it("renders through the backend and returns the landed page", async () => {
    const backend = backendRendering({ url: "https://site.example/final" });
    const render = buildBrowserPageRenderer(backend, EMPTY_DOMAIN_POLICY);
    const page = await render({ url: "https://site.example/a", timeoutMs: 9_000 });
    expect(page).toEqual({ finalUrl: "https://site.example/final", title: "T", html: "<html><body>ok</body></html>" });
    expect(backend.inputs[0]).toMatchObject({ url: "https://site.example/a", timeoutMs: 9_000 });
  });

  it("skips a backend without renderHtml", async () => {
    const backend = backendRendering({});
    delete (backend as Partial<BrowserBackend>).renderHtml;
    const render = buildBrowserPageRenderer(backend, EMPTY_DOMAIN_POLICY);
    expect(await render({ url: "https://site.example/a", timeoutMs: 1_000 })).toBeNull();
  });

  it("never opens a blocked host or one outside the allow-list", async () => {
    const backend = backendRendering({});
    const blocked = buildBrowserPageRenderer(backend, { blockedDomains: ["site.example"], allowedDomains: [] });
    const offsite = buildBrowserPageRenderer(backend, { blockedDomains: [], allowedDomains: ["other.example"] });
    expect(await blocked({ url: "https://www.site.example/a", timeoutMs: 1_000 })).toBeNull();
    expect(await offsite({ url: "https://site.example/a", timeoutMs: 1_000 })).toBeNull();
    expect(backend.inputs).toEqual([]);
  });

  it("discards a page that landed on or frames a blocked host", async () => {
    const policy = { blockedDomains: ["bad.example"], allowedDomains: [] };
    const landed = buildBrowserPageRenderer(backendRendering({ url: "https://bad.example/x" }), policy);
    const framed = buildBrowserPageRenderer(
      backendRendering({ frameUrls: ["https://site.example/a", "https://bad.example/frame"] }),
      policy,
    );
    expect(await landed({ url: "https://site.example/a", timeoutMs: 1_000 })).toBeNull();
    expect(await framed({ url: "https://site.example/a", timeoutMs: 1_000 })).toBeNull();
  });

  it("is never used in the user's own Chrome", async () => {
    const backend = backendRendering({});
    const render = buildBrowserPageRenderer(backend, { ...EMPTY_DOMAIN_POLICY, userProfile: true });
    expect(await render({ url: "https://site.example/a", timeoutMs: 1_000 })).toBeNull();
    expect(backend.inputs).toEqual([]);
  });
});
