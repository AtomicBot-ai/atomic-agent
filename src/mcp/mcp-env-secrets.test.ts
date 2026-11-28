import { afterEach, describe, expect, it, vi } from "vitest";

import type { ToolSecretSource } from "../config/tool-secrets.js";
import { resetResolvedSecretValues } from "../sandbox/resolved-secret-values.js";
import { McpClient } from "./mcp-client.js";
import { resolveMcpServerEnv } from "./mcp-env-secrets.js";
import { McpConnectError } from "./mcp-errors.js";
import type { McpServerConfig } from "./mcp-types.js";

// `{{secret:NAME}}` in a stdio MCP server's env, filled in at spawn (ATO-2530).

const VALUE = "Mcp2Secret3Value4Wxyz";

function source(resolved: string[] = []): ToolSecretSource {
  return {
    has: (name) => name === "GH_TOKEN",
    async resolve(name) {
      resolved.push(name);
      return VALUE;
    },
  };
}

function stdio(env: Record<string, string>, script = "process.exit(1)"): McpServerConfig {
  return {
    name: "secret-probe",
    enabled: true,
    transport: { kind: "stdio", command: process.execPath, args: ["-e", script] },
    env,
  } as McpServerConfig;
}

afterEach(() => resetResolvedSecretValues());

describe("resolveMcpServerEnv", () => {
  it("fills placeholders in env values and leaves other values alone", async () => {
    const env = await resolveMcpServerEnv(stdio({ GITHUB_TOKEN: "{{secret:GH_TOKEN}}", MODE: "fast" }), source());
    expect(env).toEqual({ GITHUB_TOKEN: VALUE, MODE: "fast" });
  });

  it("keeps the server down with the secret's name, never a value, when it cannot be filled", async () => {
    for (const value of ["{{secret:OTHER}}", "{{secret:bad-name}}"]) {
      const err = await resolveMcpServerEnv(stdio({ GITHUB_TOKEN: value }), source()).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(McpConnectError);
      expect((err as Error).message).toContain("not started");
    }
    const none = await resolveMcpServerEnv(stdio({ GITHUB_TOKEN: "{{secret:GH_TOKEN}}" }), undefined).then(() => null, (e: unknown) => e);
    expect((none as Error).message).toContain("unknown secret GH_TOKEN");
  });

  it("refuses a secret to a server the person did not add (a plugin's)", async () => {
    const resolved: string[] = [];
    const err = await resolveMcpServerEnv(stdio({ GITHUB_TOKEN: "{{secret:GH_TOKEN}}" }), source(resolved), false).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).message).toContain("installed plugin");
    expect(resolved).toEqual([]);
    // A plugin server without placeholders is unaffected.
    await expect(resolveMcpServerEnv(stdio({ MODE: "fast" }), source(), false)).resolves.toEqual({ MODE: "fast" });
  });
});

describe("McpClient stdio env with a tool secret", () => {
  it("starts the server with the value and masks it in the connect error", async () => {
    // The child checks the value, then prints it to stderr and exits.
    const report = `const v = process.env.GITHUB_TOKEN; console.error("error got=" + (v === ${JSON.stringify(VALUE)}) + " raw=" + v); process.exit(1);`;
    const client = new McpClient(stdio({ GITHUB_TOKEN: "{{secret:GH_TOKEN}}" }, report), { toolSecrets: source() });
    const err = await client.connect().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(McpConnectError);
    const message = (err as McpConnectError).message;
    expect(message).toContain("got=true");
    expect(message).not.toContain(VALUE);
  }, 20_000);

  it("never spawns a server whose secret is unknown", async () => {
    const transportFactory = vi.fn();
    const client = new McpClient(stdio({ GITHUB_TOKEN: "{{secret:OTHER}}" }), { toolSecrets: source(), transportFactory });
    await expect(client.connect()).rejects.toThrow(/unknown secret OTHER/);
    expect(transportFactory).not.toHaveBeenCalled();
  });
});
