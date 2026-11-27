import { describe, expect, it, vi } from "vitest";

import { LinearApiError } from "../channels/linear/index.js";
import { connectLinear, type ConnectLinearDeps } from "./connect-linear.js";

const VIEWER = { id: "11111111-2222-3333-4444-555555555555", name: "Nadia" };

function make(answers: string[], secrets: string[], over: Partial<ConnectLinearDeps> = {}) {
  const out: string[] = [];
  const asked: string[] = [];
  const saved: Array<[string, string | null]> = [];
  const writeConfig = vi.fn();
  const deps: ConnectLinearDeps = {
    io: {
      write: (t) => {
        out.push(t);
      },
      ask: async (q) => {
        asked.push(q);
        return answers.shift() ?? "";
      },
      askSecret: async (q) => {
        asked.push(q);
        return secrets.shift() ?? "";
      },
    },
    stateDir: "/state",
    configPath: "/state/config.json",
    makeApi: () => ({ viewer: async () => VIEWER, query: async () => ({ users: { nodes: [] } }) }),
    saveSecret: (_dir, name, value) => {
      saved.push([name, value]);
    },
    writeConfig,
    ...over,
  };
  return { deps, out, asked, saved, writeConfig };
}

describe("atag connect linear (ATO-2464)", () => {
  it("defaults to polling: saves only the API key and the key's user as owner", async () => {
    const { deps, saved, writeConfig, out } = make(["", "", ""], ["lin_api_abc"]);
    expect(await connectLinear([], deps)).toBe(0);
    expect(saved).toEqual([["LINEAR_API_KEY", "lin_api_abc"]]);
    expect(writeConfig).toHaveBeenCalledWith("/state/config.json", {
      enabled: true,
      ownerIds: [VIEWER.id],
      mode: "poll",
      mention: "agent",
    });
    expect(out.join("")).not.toContain("lin_api_abc");
    expect(out.join("")).not.toContain("cloudflared");
  });

  it("--webhook also saves the signing secret and prints the tunnel step", async () => {
    const { deps, saved, writeConfig, out } = make(["", "atomic"], ["lin_api_abc", "lin_wh_xyz"]);
    expect(await connectLinear(["--webhook"], deps)).toBe(0);
    expect(saved).toContainEqual(["LINEAR_WEBHOOK_SECRET", "lin_wh_xyz"]);
    expect(writeConfig.mock.calls[0]![1]).toMatchObject({ mode: "webhook", mention: "atomic" });
    expect(out.join("")).toContain("cloudflared tunnel --url http://127.0.0.1:3979");
  });

  it("writes nothing when Linear refuses the key", async () => {
    const { deps, saved, writeConfig, out } = make([], ["lin_api_bad"], {
      makeApi: () => ({
        viewer: async () => Promise.reject(new LinearApiError("no", "auth")),
        query: async () => ({}),
      }),
    });
    expect(await connectLinear(["--poll"], deps)).toBe(1);
    expect(saved).toEqual([]);
    expect(writeConfig).not.toHaveBeenCalled();
    expect(out.join("")).toContain("Linear refused that key");
  });

  it("--app installs through OAuth and saves the token, refresh token and client secret", async () => {
    const waitForCode = vi.fn(async () => "code-1");
    const exchange = vi.fn(async () => ({ accessToken: "lin_oauth_tok", refreshToken: "lin_oauth_ref" }));
    const owner = { id: "99999999-2222-3333-4444-555555555555", name: "Nadia" };
    const { deps, saved, writeConfig } = make(["client-1", "nadia@example.com"], ["client-secret", "lin_wh_app"], {
      waitForCode,
      exchange,
      makeApi: () => ({
        viewer: async () => ({ id: "app-user", name: "Atomic Agent" }),
        query: async () => ({ users: { nodes: [owner] } }),
      }),
    });
    expect(await connectLinear(["--app"], deps)).toBe(0);
    expect(exchange).toHaveBeenCalledWith({ clientId: "client-1", clientSecret: "client-secret", code: "code-1" });
    expect(saved).toEqual([
      ["LINEAR_API_KEY", "lin_oauth_tok"],
      ["LINEAR_WEBHOOK_SECRET", "lin_wh_app"],
      ["LINEAR_OAUTH_CLIENT_SECRET", "client-secret"],
      ["LINEAR_OAUTH_REFRESH_TOKEN", "lin_oauth_ref"],
    ]);
    expect(writeConfig.mock.calls[0]![1]).toEqual({ enabled: true, ownerIds: [owner.id], mode: "webhook", oauthClientId: "client-1" });
  });

  it("refuses a malformed --owner before asking anything", async () => {
    const { deps, asked } = make([], []);
    expect(await connectLinear(["--owner", "me"], deps)).toBe(2);
    expect(asked).toEqual([]);
  });
});
