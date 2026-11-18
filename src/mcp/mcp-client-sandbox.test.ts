import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { McpClient } from "./mcp-client.js";
import { McpConnectError } from "./mcp-errors.js";
import type { McpServerConfig } from "./mcp-types.js";

// ATO-620: with Safe Mode on, a stdio MCP server runs in the OS sandbox.
// The probe child tries to read the agent's state and write outside its
// folder, reports on stderr and exits; the connect error carries that.
const PROBE = `const fs = require("node:fs");
let read = "ok", wrote = "ok";
try { fs.readFileSync(process.argv[1] + "/.env", "utf8"); } catch (e) { read = e.code; }
try { fs.writeFileSync(process.argv[2] + "/escaped.txt", "x"); } catch (e) { wrote = e.code; }
console.error("sbx-report " + JSON.stringify({ read, wrote }));
process.exit(1);`;

async function connectError(client: McpClient): Promise<string> {
  const err = await client.connect().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(McpConnectError);
  return (err as McpConnectError).message;
}

describe.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))(
  "McpClient stdio server inside the Safe Mode sandbox",
  () => {
    let state: string;
    let outside: string;

    beforeEach(async () => {
      state = await mkdtemp(join(homedir(), ".atomic-mcp-sbx-state-"));
      outside = await mkdtemp(join(homedir(), ".atomic-mcp-sbx-out-"));
      await writeFile(join(state, ".env"), "NOTE=mcp-marker-620\n");
    });

    afterEach(async () => {
      await rm(state, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    });

    function server(extra: Partial<McpServerConfig> = {}): McpServerConfig {
      return {
        name: "sbx-probe",
        enabled: true,
        transport: {
          kind: "stdio",
          command: process.execPath,
          args: ["-e", PROBE, state, outside],
        },
        ...extra,
      } as McpServerConfig;
    }

    it("cannot read the agent's state or write outside its folder", async () => {
      const client = new McpClient(server(), {
        oauthStateDir: state,
        sandbox: () => ({ mode: "workspace", network: false }),
      });
      const message = await connectError(client);
      expect(message).toContain("sbx-report");
      expect(message).not.toContain('"read":"ok"');
      expect(message).not.toContain('"wrote":"ok"');
      expect(existsSync(join(outside, "escaped.txt"))).toBe(false);
    });

    // Review fix: a server installed under the state dir (a plugin) can
    // run its own code, but the state dir around it stays hidden.
    it("a server installed under the state dir runs, but cannot read .env", async () => {
      const root = join(state, "plugins", "installed", "p");
      await mkdir(root, { recursive: true });
      const script = join(root, "server.cjs");
      // As a file, the probe's arguments shift by one (argv[1] is the script).
      await writeFile(
        script,
        PROBE.replace("process.argv[1]", "process.argv[2]").replace(
          'process.argv[2] + "/escaped',
          'process.argv[3] + "/escaped',
        ),
      );
      const client = new McpClient(
        {
          name: "sbx-plugin",
          enabled: true,
          transport: { kind: "stdio", command: process.execPath, args: [script, state, outside] },
        } as McpServerConfig,
        { oauthStateDir: state, sandbox: () => ({ mode: "workspace", network: false }) },
      );
      const message = await connectError(client);
      expect(message).toContain("sbx-report");
      expect(message).not.toContain('"read":"ok"');
    });

    it("does not hand the ssh-agent socket to a sandboxed server", async () => {
      const saved = process.env.SSH_AUTH_SOCK;
      process.env.SSH_AUTH_SOCK = "/tmp/ato620-agent.sock";
      try {
        const client = new McpClient(
          {
            name: "sbx-sock",
            enabled: true,
            transport: {
              kind: "stdio",
              command: process.execPath,
              args: ["-e", 'console.error("sock-report " + (process.env.SSH_AUTH_SOCK ?? "none")); process.exit(1);'],
            },
          } as McpServerConfig,
          { oauthStateDir: state, sandbox: () => ({ mode: "workspace", network: false }) },
        );
        const message = await connectError(client);
        expect(message).toContain("sock-report none");
      } finally {
        if (saved === undefined) delete process.env.SSH_AUTH_SOCK;
        else process.env.SSH_AUTH_SOCK = saved;
      }
    });

    it("runs unwrapped when the server opts out", async () => {
      const client = new McpClient(server({ sandbox: false }), {
        oauthStateDir: state,
        sandbox: () => ({ mode: "workspace", network: false }),
      });
      const message = await connectError(client);
      expect(message).toContain('"read":"ok"');
      expect(message).toContain('"wrote":"ok"');
    });

    it("runs unwrapped while Safe Mode is off", async () => {
      const client = new McpClient(server(), {
        oauthStateDir: state,
        sandbox: () => ({ mode: "off", network: false }),
      });
      const message = await connectError(client);
      expect(message).toContain('"wrote":"ok"');
    });
  },
);

describe("McpClient without a sandbox on this machine", () => {
  it.skipIf(process.platform !== "win32")("does not start the server", async () => {
    const client = new McpClient(
      {
        name: "sbx-none",
        enabled: true,
        transport: { kind: "stdio", command: process.execPath, args: ["-e", "1"] },
      } as McpServerConfig,
      { sandbox: () => ({ mode: "workspace", network: false }) },
    );
    expect(await connectError(client)).toContain("sandbox");
  });
});
