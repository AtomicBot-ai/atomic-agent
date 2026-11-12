import { describe, expect, it } from "vitest";

import {
  buildHttpApprovalPreview,
  isSecretParamName,
  maskBodySecrets,
  maskUrlSecrets,
} from "./http-request-preview.js";

describe("maskUrlSecrets (ATO-1471)", () => {
  it("masks secret query parameters by name and keeps the rest", () => {
    const url =
      "https://api.example.com/v1/items?q=cats&api_key=abc123&token=t0k&key=k1&access_token=at-9&sig=s1g&page=2";
    const shown = maskUrlSecrets(url);
    expect(shown).toBe(
      "https://api.example.com/v1/items?q=cats&api_key=****&token=****&key=****&access_token=****&sig=****&page=2",
    );
  });

  it("masks by encoded or camel-case names too", () => {
    expect(maskUrlSecrets("https://x.example/?apiKey=abcdef")).toBe("https://x.example/?apiKey=****");
    expect(maskUrlSecrets("https://x.example/?X-Amz-Signature=deadbeef")).toBe(
      "https://x.example/?X-Amz-Signature=****",
    );
    expect(maskUrlSecrets("https://x.example/?api%5Fkey=abcdef")).toBe("https://x.example/?api%5Fkey=****");
  });

  it("masks a value the detector flags whatever its name", () => {
    const shown = maskUrlSecrets("https://x.example/hook?u=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(shown).toBe("https://x.example/hook?u=****");
  });

  it("masks an access token in the fragment and a password in the authority", () => {
    expect(maskUrlSecrets("https://x.example/cb#access_token=abc123&state=ok")).toBe(
      "https://x.example/cb#access_token=****&state=ok",
    );
    expect(maskUrlSecrets("https://user:hunter2secret@x.example/")).not.toContain("hunter2secret");
  });

  it("leaves a URL with nothing secret as written", () => {
    const url = "https://x.example/search?q=hello+world&page=2&flag";
    expect(maskUrlSecrets(url)).toBe(url);
    expect(maskUrlSecrets("https://x.example/")).toBe("https://x.example/");
  });
});

describe("maskBodySecrets (ATO-1471)", () => {
  it("masks JSON fields by key, nested ones included", () => {
    const body = JSON.stringify({
      user: "nadia",
      password: "hunter2",
      auth: { client_secret: "cs-1", scope: "read" },
      items: [{ token: "t1", id: 3 }],
    });
    const shown = maskBodySecrets(body, "application/json");
    for (const secret of ["hunter2", "cs-1", '"t1"']) expect(shown).not.toContain(secret);
    expect(shown).toContain('"user":"nadia"');
    expect(shown).toContain('"scope":"read"');
    expect(shown).toContain('"id":3');
  });

  it("keeps a JSON body as written when nothing in it is secret", () => {
    const body = '{\n  "name": "x",\n  "count": 2\n}';
    expect(maskBodySecrets(body, "application/json")).toBe(body);
  });

  it("masks form fields by name", () => {
    expect(maskBodySecrets("grant_type=password&username=n&password=hunter2", undefined)).toBe(
      "grant_type=password&username=n&password=****",
    );
    expect(
      maskBodySecrets("a=1&client_secret=xyz", "application/x-www-form-urlencoded; charset=utf-8"),
    ).toBe("a=1&client_secret=****");
  });

  it("runs the shared detector over any other body", () => {
    const body = "please use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 for this";
    expect(maskBodySecrets(body, "text/plain")).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(maskBodySecrets("hello there", "text/plain")).toBe("hello there");
  });
});

describe("buildHttpApprovalPreview (ATO-1471)", () => {
  it("masks the URL, credential headers and the body, before cutting the body", () => {
    const long = `${"x".repeat(390)}&password=hunter2hunter2`;
    const preview = buildHttpApprovalPreview({
      method: "POST",
      url: "https://api.example.com/v1?api_key=abc123",
      headers: { Authorization: "Bearer sk-live-1", "Content-Type": "application/x-www-form-urlencoded" },
      body: `a=${long}`,
    });
    expect(preview).toContain("POST https://api.example.com/v1?api_key=****");
    expect(preview).toContain("Authorization: Bearer ****");
    expect(preview).not.toContain("abc123");
    expect(preview).not.toContain("sk-live-1");
    expect(preview).not.toContain("hunter2");
  });
});

describe("isSecretParamName", () => {
  it("takes credential names and leaves ordinary ones", () => {
    for (const name of ["api_key", "token", "key", "access_token", "sig", "signature", "password", "code"]) {
      expect(isSecretParamName(name), name).toBe(true);
    }
    for (const name of ["q", "page", "limit", "id", "sort", ""]) {
      expect(isSecretParamName(name), name).toBe(false);
    }
  });
});
