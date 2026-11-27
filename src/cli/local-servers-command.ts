import {
  describeDetectedServer,
  detectLocalServers,
  type DetectedLocalServer,
} from "../llm/provider/presets/detect-local-servers.js";

/**
 * `atomic-agent local-servers [--json]` (ATO-2489): which model servers
 * already run on this computer (Ollama, LM Studio, the Llama app or any
 * llama-server on its default port), what models each one has and which
 * are loaded in memory. The same probe the setup screens use
 * (`detectLocalServers`, ATO-2013 / ATO-2168), so the terminal, the TUI
 * and the desktop app agree on what is running.
 *
 * Read-only: one GET per server on 127.0.0.1, nothing written. The desktop
 * app runs it with `--json` for its setup step and Settings › Local.
 */

export const LOCAL_SERVERS_HELP =
  [
    "atomic-agent local-servers: model servers already running on this computer",
    "",
    "Usage:",
    "  atomic-agent local-servers [--json]",
    "",
    "Checks Ollama (127.0.0.1:11434), LM Studio (127.0.0.1:1234) and the Llama app",
    "or a llama-server on its default port (127.0.0.1:9931), and prints each one",
    "that answers with its models and the ones loaded in memory.",
    "",
    "  --json   Print { servers: [{ kind, label, baseUrl, presetId, models, loaded }] }",
  ].join("\n") + "\n";

export interface LocalServersDeps {
  readonly detect?: () => Promise<DetectedLocalServer[]>;
  readonly write?: (text: string) => void;
  readonly writeErr?: (text: string) => void;
}

/** What the plain listing prints: one block per server, or one line for none. */
export function formatLocalServers(servers: readonly DetectedLocalServer[]): string {
  if (servers.length === 0) {
    return "No model server is running on this computer (checked Ollama, LM Studio and the Llama app).\n";
  }
  const lines: string[] = [];
  for (const server of servers) {
    lines.push(`${describeDetectedServer(server)} at ${server.baseUrl}`);
    for (const model of server.models) {
      lines.push(`  ${server.loaded.includes(model) ? "*" : " "} ${model}`);
    }
  }
  if (servers.some((s) => s.loaded.length > 0)) lines.push("", "* loaded in memory");
  return `${lines.join("\n")}\n`;
}

export async function localServersCommand(
  args: readonly string[],
  deps: LocalServersDeps = {},
): Promise<number> {
  const write = deps.write ?? ((t: string) => { process.stdout.write(t); });
  const writeErr = deps.writeErr ?? ((t: string) => { process.stderr.write(t); });
  if (args.includes("-h") || args.includes("--help")) {
    write(LOCAL_SERVERS_HELP);
    return 0;
  }
  const json = args.includes("--json");
  const unknown = args.find((a) => a !== "--json");
  if (unknown !== undefined) {
    writeErr(`unknown option: ${unknown}\n\n${LOCAL_SERVERS_HELP}`);
    return 2;
  }
  const servers = await (deps.detect ?? (() => detectLocalServers()))();
  write(json ? `${JSON.stringify({ servers })}\n` : formatLocalServers(servers));
  return 0;
}
