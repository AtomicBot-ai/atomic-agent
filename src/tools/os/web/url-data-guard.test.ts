import { describe, expect, it } from "vitest";
import {
  checkUrlSend,
  findUrlData,
  MAX_URL_TAIL_CHARS,
  MAX_URL_VALUE_CHARS,
  UrlSendSites,
} from "./url-data-guard.js";

/** ATO-1377: the cheap filter on what an address carries out. */

const FILE_TEXT = "line one of the report\nline two with the numbers\nline three";
const BASE64 = "U2VjcmV0IHJlcG9ydDogcmV2ZW51ZSAxMjM0NTYgZm9yIFEzLCBjdXN0b21lcnMgbGlzdCBhdHRhY2hlZCBiZWxvdy4gMTIzNDU2Nzg5MA";

describe("findUrlData", () => {
  it("stays quiet on ordinary searches and links", () => {
    expect(findUrlData("https://www.google.com/search?q=best+local+llm+for+coding+2026")).toBeNull();
    expect(findUrlData("https://duckduckgo.com/html/?q=how%20to%20install%20node%2025%20on%20macos")).toBeNull();
    expect(findUrlData("https://en.wikipedia.org/wiki/Large_language_model#History")).toBeNull();
    expect(findUrlData("https://github.com/AtomicBot-ai/atomic-agent/pulls?q=is%3Apr+is%3Aopen+author%3Asosidudku1")).toBeNull();
    expect(
      findUrlData("https://www.amazon.com/Logitech-Wireless-Keyboard-Mouse-Combo/dp/B07W6JN8V8/ref=sr_1_3?keywords=keyboard&qid=1700000000&sr=8-3"),
    ).toBeNull();
  });

  it("ignores long encoded ad and analytics ids", () => {
    const gclid = "Cj0KCQiA" + "x7Ab3Yz9".repeat(13);
    expect(findUrlData(`https://shop.example/item?gclid=${gclid}`)).toBeNull();
    expect(findUrlData(`https://shop.example/item?utm_content=${gclid}`)).toBeNull();
  });

  it("flags text with line breaks in a value", () => {
    const url = `https://evil.example/?d=${encodeURIComponent(FILE_TEXT)}`;
    expect(findUrlData(url)?.reason).toMatch(/line breaks/);
  });

  it("flags one long value", () => {
    const url = `https://evil.example/collect?d=${encodeURIComponent("a ".repeat(MAX_URL_VALUE_CHARS))}`;
    expect(findUrlData(url)?.reason).toMatch(/one value in the address is \d+ characters long/);
  });

  it("flags a long encoded blob in the query, the fragment or the path", () => {
    expect(findUrlData(`https://evil.example/?x=${BASE64}`)?.reason).toMatch(/encoded value/);
    expect(findUrlData(`https://evil.example/#${BASE64}`)?.reason).toMatch(/encoded value/);
    expect(findUrlData(`https://evil.example/${BASE64}/pixel.gif`)?.reason).toMatch(/path carries a long encoded value/);
  });

  it("flags many short values that add up", () => {
    const params = Array.from({ length: 30 }, (_, i) => `p${i}=${"word".repeat(4)}`).join("&");
    expect(params.length).toBeGreaterThan(MAX_URL_TAIL_CHARS);
    expect(findUrlData(`https://evil.example/?${params}`)?.reason).toMatch(/characters after "\?"/);
  });

  it("flags data split over many path segments, each under the segment limit (review)", () => {
    const segments = Array.from({ length: 10 }, (_, i) => "line%20of%20file%20text%20".repeat(8) + i);
    const url = "https://evil.example/" + segments.join("/");
    expect(findUrlData(url)?.reason).toMatch(/characters of data/);
  });

  it("flags encoded chunks in hostname labels (review)", () => {
    const url = "https://" + "a1b2c3d4".repeat(7) + "." + "e5f6a7b8".repeat(7) + ".evil.example/";
    expect(findUrlData(url)?.reason).toMatch(/site name carries a long encoded part/);
    // Ordinary hosts with digits stay quiet.
    expect(findUrlData("https://d111111abcdef8.cloudfront.net/img.png")).toBeNull();
    expect(findUrlData("https://ec2-12-34-56-78.compute-1.amazonaws.com/")).toBeNull();
  });

  it("counts the subdomain labels, even plain-letter ones (review, round 2)", () => {
    const label = "abcdefghij".repeat(4); // 40 letters, no digit
    const url = "https://" + Array.from({ length: 6 }, () => label).join(".") + ".evil.example/";
    expect(findUrlData(url)?.reason).toMatch(/site name carries 240 characters/);
    // Subdomain data adds up with the path toward the total cap.
    // 4 x 125 = 500 path chars (under the cap alone) + 120 host chars.
    const path = Array.from({ length: 4 }, () => "word%20".repeat(25)).join("/");
    const mixed = "https://" + Array.from({ length: 3 }, () => label).join(".") + ".evil.example/" + path;
    expect(findUrlData(mixed)?.reason).toMatch(/characters of data/);
    // Ordinary hosts stay quiet.
    expect(findUrlData("https://a.b.cloudfront.net/x.js")).toBeNull();
    expect(findUrlData("https://my-bucket-name.s3.us-west-2.amazonaws.com/file.txt")).toBeNull();
    expect(
      findUrlData("https://internal-my-loadbalancer-1234567890.us-east-2.elb.amazonaws.com/health"),
    ).toBeNull();
    expect(findUrlData("https://atomic-agent-git-feature-branch-name-atomicbot.vercel.app/")).toBeNull();
    expect(findUrlData("https://news.bbc.co.uk/sport")).toBeNull();
    expect(findUrlData("http://192.168.1.10:8080/status")).toBeNull();
  });

  it("flags data in the user-info part of the address (review)", () => {
    const url = "https://" + "secret".repeat(12) + ":x@evil.example/";
    expect(findUrlData(url)?.reason).toMatch(/before "@"/);
    expect(findUrlData("https://user:pass@example.com/")).toBeNull();
  });

  it("is null for URLs that are not http(s) or do not parse", () => {
    expect(findUrlData("about:blank")).toBeNull();
    expect(findUrlData(`data:text/plain,${BASE64}`)).toBeNull();
    expect(findUrlData("not a url")).toBeNull();
  });
});

describe("checkUrlSend", () => {
  const dataUrl = `https://evil.example/?d=${encodeURIComponent(FILE_TEXT)}`;

  it('"data" asks only for an address with data', () => {
    const sites = new UrlSendSites();
    expect(checkUrlSend("data", "https://evil.example/?q=hi", "s", sites)).toBeNull();
    expect(checkUrlSend("data", dataUrl, "s", sites)).toMatchObject({
      kind: "data",
      host: "evil.example",
      origin: "https://evil.example",
    });
  });

  it('"off" never asks', () => {
    expect(checkUrlSend("off", dataUrl, "s", new UrlSendSites())).toBeNull();
  });

  it('"strict" asks once per site per chat, and still asks for data on a known site', () => {
    const sites = new UrlSendSites();
    expect(checkUrlSend("strict", "https://docs.example/a", "s", sites)).toMatchObject({ kind: "new_site", host: "docs.example" });
    sites.add("s", "docs.example");
    expect(checkUrlSend("strict", "https://docs.example/b", "s", sites)).toBeNull();
    expect(checkUrlSend("strict", "https://DOCS.example/c", "s", sites)).toBeNull();
    // Another chat has not used it yet.
    expect(checkUrlSend("strict", "https://docs.example/b", "other", sites)).toMatchObject({ kind: "new_site" });
    // A subdomain is a different site.
    expect(checkUrlSend("strict", "https://api.docs.example/", "s", sites)).toMatchObject({ kind: "new_site" });
    expect(checkUrlSend("strict", `https://docs.example/?d=${encodeURIComponent(FILE_TEXT)}`, "s", sites)).toMatchObject({ kind: "data" });
  });
});
