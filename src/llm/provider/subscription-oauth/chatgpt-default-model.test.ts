import { describe, expect, it } from "vitest";

import {
  CHATGPT_FALLBACK_DEFAULT_MODEL,
  codexDefaultModel,
  pickCodexDefaultModel,
  type ModelsFetch,
} from "./chatgpt-default-model.js";

function jwt(payload: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(payload)}.sig`;
}

const tokens = {
  accessToken: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }),
  refreshToken: "r",
  idToken: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }),
};

describe("pickCodexDefaultModel (Codex's own rule)", () => {
  it("takes the lowest priority among picker-visible models", () => {
    expect(
      pickCodexDefaultModel([
        { slug: "b", priority: 2, visibility: "list" },
        { slug: "hidden", priority: 0, visibility: "hide" },
        { slug: "a", priority: 1, visibility: "list" },
      ]),
    ).toBe("a");
  });

  it("falls back to the first model when none is picker-visible", () => {
    expect(pickCodexDefaultModel([{ slug: "y", priority: 5 }, { slug: "x", priority: 3 }])).toBe("x");
  });

  it("gives null for an empty list", () => {
    expect(pickCodexDefaultModel([])).toBeNull();
  });
});

describe("codexDefaultModel", () => {
  it("asks the Codex catalog endpoint with the sign-in headers", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetch: ModelsFetch = async (url, init) => {
      calls.push({ url, headers: init.headers });
      return { ok: true, status: 200, text: async () => JSON.stringify({ models: [{ slug: "m1", priority: 1, visibility: "list" }] }) };
    };
    await expect(codexDefaultModel({ tokens, fetch })).resolves.toEqual({ model: "m1", source: "backend" });
    expect(calls[0]?.url).toMatch(/^https:\/\/chatgpt\.com\/backend-api\/codex\/models\?client_version=/);
    expect(calls[0]?.headers["chatgpt-account-id"]).toBe("acct-1");
    expect(calls[0]?.headers.originator).toBe("atomic_agent");
  });

  it("uses Codex's bundled default when the backend fails or answers oddly", async () => {
    const down: ModelsFetch = async () => { throw new Error("offline"); };
    const refused: ModelsFetch = async () => ({ ok: false, status: 403, text: async () => "" });
    const odd: ModelsFetch = async () => ({ ok: true, status: 200, text: async () => "{\"data\":[]}" });
    for (const fetch of [down, refused, odd]) {
      await expect(codexDefaultModel({ tokens, fetch })).resolves.toEqual({
        model: CHATGPT_FALLBACK_DEFAULT_MODEL,
        source: "fallback",
      });
    }
  });
});
