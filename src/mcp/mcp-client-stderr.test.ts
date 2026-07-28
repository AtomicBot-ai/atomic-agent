import { describe, expect, it } from "vitest";

import { McpClient } from "./mcp-client.js";
import { McpConnectError } from "./mcp-errors.js";
import type { McpServerConfig } from "./mcp-types.js";

/** Spawns a real child that dies the way issue #23 describes. */
function serverThatDies(script: string): McpServerConfig {
  return {
    name: "broken",
    enabled: true,
    transport: {
      kind: "stdio",
      command: process.execPath,
      args: ["-e", script],
    },
  } as McpServerConfig;
}

describe("McpClient stdio failure diagnostics", () => {
  it("reports the child's stderr instead of a bare 'Connection closed'", async () => {
    const client = new McpClient(
      serverThatDies(
        "console.error(\"Error [ERR_REQUIRE_ESM]: require() of ES Module /srv/tool.js not supported\"); process.exit(1);",
      ),
    );

    await expect(client.connect()).rejects.toThrow(McpConnectError);
    await client.connect().catch((err: McpConnectError) => {
      expect(err.server).toBe("broken");
      expect(err.message).toContain("server stderr:");
      expect(err.message).toContain("ERR_REQUIRE_ESM");
    });
  }, 20_000);

  it("leaves the message alone when the server dies silently", async () => {
    const client = new McpClient(serverThatDies("process.exit(1);"));

    await client.connect().catch((err: McpConnectError) => {
      expect(err).toBeInstanceOf(McpConnectError);
      expect(err.message).not.toContain("server stderr:");
    });
  }, 20_000);
});
