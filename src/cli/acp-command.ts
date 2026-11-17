/**
 * `atomic-agent acp` (ATO-543): the agent as an Agent Client Protocol
 * server over stdio, so Zed, JetBrains IDEs, Neovim (CodeCompanion,
 * avante) and other ACP clients can use it as their coding agent.
 * The client starts this command and speaks newline-delimited JSON-RPC
 * 2.0 on its stdin/stdout; the protocol itself is in `acp-server.ts`.
 *
 * stdout carries protocol frames only. Everything else that would reach
 * it (a stray `console.log` from a dependency, the runtime's logs) is
 * sent to stderr, which editors keep as the agent's log.
 *
 * `acp --setup` is the terminal auth method `initialize` advertises: a
 * client runs it in a terminal, and it opens the TUI's first-run setup.
 */

import { isSea } from "node:sea";
import { Writable } from "node:stream";
import { getConfig } from "../config/index.js";
import { createAgentRuntime } from "../runtime/bootstrap.js";
import { getAppVersion } from "../version.js";
import { JsonRpcConnection } from "./acp-jsonrpc.js";
import { AcpServer } from "./acp-server.js";

export const ACP_HELP =
  [
    "atomic-agent acp — use Atomic Agent as the agent in Zed, JetBrains and other ACP clients",
    "",
    "Usage:",
    "  atomic-agent acp",
    "  atag acp",
    "  atomic-agent acp --setup",
    "",
    "The editor starts this command and talks Agent Client Protocol (JSON-RPC 2.0,",
    "one message per line) over stdin/stdout. Tools, memory, skills and your",
    "approval level work as in the terminal; approval prompts appear in the editor.",
    "",
    "Options:",
    "  --setup      Run first-time setup (pick a local model or connect a provider)",
    "  -h, --help   Show this help",
    "",
    "Example (Zed settings.json):",
    '  "agent_servers": { "Atomic Agent": { "type": "custom", "command": "atag", "args": ["acp"] } }',
  ].join("\n") + "\n";

export async function acpCommand(args: string[]): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(ACP_HELP);
    return 0;
  }
  if (args.includes("--setup")) {
    const { tuiCommand } = await import("../tui/index.js");
    return tuiCommand(["--onboarding"]);
  }
  const unknown = args.find((a) => a !== "--setup");
  if (unknown !== undefined) {
    process.stderr.write(`unknown option: ${unknown}\n${ACP_HELP}`);
    return 2;
  }

  const log = (message: string): void => {
    process.stderr.write(`atomic-agent acp: ${message}\n`);
  };
  const protocolOut = claimStdout();
  const config = getConfig();
  const server = new AcpServer({
    version: getAppVersion(),
    setupCommand: setupCommand(),
    log,
    createRuntime: (workingDir, handlers) =>
      createAgentRuntime({
        workingDir,
        approvalLevel: config.agent.approvalLevel,
        traceDefault: false,
        handlers: {
          onApprovalRequest: (request) => handlers.onApprovalRequest(request),
          logSinks: [
            (record) => {
              if (record.level === "warn" || record.level === "error") log(`${record.level}: ${record.message}`);
            },
          ],
        },
      }),
  });
  const connection = new JsonRpcConnection({
    input: process.stdin,
    output: protocolOut,
    onRequest: (method, params) => server.handleRequest(method, params),
    onNotification: (method, params) => server.handleNotification(method, params),
    log,
  });
  server.attach(connection);
  log(`ready (version ${getAppVersion()})`);

  const stop = (): void => process.stdin.destroy();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await connection.closed;
  await server.shutdown();
  return 0;
}

/**
 * The command line that runs `acp --setup` with this same binary, for
 * clients that start the terminal method from `_meta["terminal-auth"]`.
 */
function setupCommand(): { command: string; args: string[] } {
  if (isSea() || process.argv[1] === undefined) {
    return { command: process.execPath, args: ["acp", "--setup"] };
  }
  return { command: process.execPath, args: [process.argv[1], "acp", "--setup"] };
}

/**
 * Keep the real stdout for protocol frames and point
 * `process.stdout.write` at stderr, so nothing else can corrupt the
 * stream the editor parses.
 */
function claimStdout(): Writable {
  const stdout = process.stdout;
  const writeStdout = stdout.write.bind(stdout) as (
    chunk: string | Uint8Array,
    callback?: (err?: Error | null) => void,
  ) => boolean;
  const protocolOut = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      writeStdout(chunk, (err) => callback(err ?? null));
    },
  });
  stdout.on("error", (err) => protocolOut.destroy(err));
  stdout.on("close", () => protocolOut.destroy());
  const toStderr = process.stderr.write.bind(process.stderr);
  stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) =>
    toStderr(chunk as string, ...(rest as []))) as typeof stdout.write;
  return protocolOut;
}
