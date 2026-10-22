import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpClient } from "./mcp-client.js";
import { McpConnectError } from "./mcp-errors.js";
import type { McpServerConfig } from "./mcp-types.js";

// ATO-346 seam test: a real stdio child reports what it was spawned with
// on stderr and exits, and the connect error carries that stderr tail.
const LEAKS = {
  OPENAI_API_KEY: "leak-marker-openai",
  EXA_API_KEY: "leak-marker-exa",
  TELEGRAM_BOT_TOKEN: "leak-marker-telegram",
};

const REPORT = `console.error("env-report " + JSON.stringify({
  openai: process.env.OPENAI_API_KEY ?? null,
  exa: process.env.EXA_API_KEY ?? null,
  telegram: process.env.TELEGRAM_BOT_TOKEN ?? null,
  hasPath: typeof (process.env.PATH ?? process.env.Path) === "string",
  own: process.env.MCP_OWN_VAR ?? null,
})); process.exit(1);`;

describe("McpClient stdio environment", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const [key, value] of Object.entries(LEAKS)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });

  afterEach(() => {
    for (const key of Object.keys(LEAKS)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("gives the server PATH and its own env, but not the agent's keys", async () => {
    const client = new McpClient({
      name: "env-probe",
      enabled: true,
      transport: { kind: "stdio", command: process.execPath, args: ["-e", REPORT] },
      env: { MCP_OWN_VAR: "own-value" },
    } as McpServerConfig);

    const err = await client.connect().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(McpConnectError);
    const message = (err as McpConnectError).message;
    expect(message).toContain("env-report");
    expect(message).toContain('"openai":null');
    expect(message).toContain('"exa":null');
    expect(message).toContain('"telegram":null');
    expect(message).toContain('"hasPath":true');
    expect(message).toContain('"own":"own-value"');
    expect(message).not.toContain("leak-marker");
  }, 20_000);
});
