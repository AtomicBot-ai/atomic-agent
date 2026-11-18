import { existsSync } from "node:fs";
import { join } from "node:path";

import { ensureSecretKeyFile } from "../local-llm/server/managed-api-key.js";

/**
 * The API key `atomic-agent serve` requires on every authenticated route.
 *
 * Serve never runs without one, on loopback too: any program on this
 * machine (a command the agent itself runs, a script, another user's
 * process) can reach a loopback port, and without a key it could drive
 * the agent and every tool it has. When the operator passes no key
 * (`--api-key`, `ATOMIC_AGENT_API_KEY`), serve uses the one in
 * `<stateDir>/serve-api.key`, generated on the first run and reused after,
 * the way Jupyter generates its token and LM Studio its API token.
 *
 * The file is written owner-only (0600, a restricted ACL on Windows) by
 * the same code that keeps the managed llama-server key
 * (`ensureSecretKeyFile`), and it is one of the agent's state secrets
 * (`getStateSecretPaths`), so an agent tool that reads it, or a shell
 * command that names it, asks every time.
 */

export const SERVE_API_KEY_FILE = "serve-api.key";

/** Where serve keeps the key it generated. */
export function serveApiKeyPath(stateDir: string): string {
  return join(stateDir, SERVE_API_KEY_FILE);
}

export type ServeApiKey =
  /** The operator's own key: `--api-key` or `ATOMIC_AGENT_API_KEY`. */
  | { readonly key: string; readonly source: "given" }
  /** The key in the state dir; `created` when this run wrote it. */
  | { readonly key: string; readonly source: "file"; readonly path: string; readonly created: boolean };

/**
 * The key serve runs with: the one given, else the persisted one (made on
 * first use). An error when there is none and the file can be neither read
 * nor written: serve then refuses to start rather than run without a key.
 */
export function resolveServeApiKey(
  given: string | null,
  stateDir: string,
): ServeApiKey | { readonly error: string } {
  if (given !== null) return { key: given, source: "given" };
  const path = serveApiKeyPath(stateDir);
  const existed = existsSync(path);
  const key = ensureSecretKeyFile(path);
  if (key === null) {
    return {
      error:
        `no API key given, and the key file ${path} could not be read or created. ` +
        "Fix its permissions, or pass --api-key <token> (or set ATOMIC_AGENT_API_KEY)",
    };
  }
  return { key, source: "file", path, created: !existed };
}

/**
 * What serve prints about its key once it listens. A key the operator
 * gave is theirs and is not repeated. For the persisted key: where it is
 * and how to send it, and, only when `interactive` (stderr is a terminal,
 * not a log file), the panel address with the key in its fragment, the
 * way Jupyter prints its token URL. A URL fragment is never sent to the
 * server, so the key does not land in any request log.
 */
export function serveApiKeyNotice(
  key: ServeApiKey,
  baseUrl: string,
  interactive: boolean,
): string {
  if (key.source === "given") return "";
  const lines = [
    `[atomic-agent] serve API key ${key.created ? "generated" : "read"} from ${key.path}; ` +
      "send it as 'Authorization: Bearer <key>' (print it with: atomic-agent serve --print-api-key)\n",
  ];
  if (interactive) {
    lines.push(`[atomic-agent] panel: ${baseUrl}/panel#key=${encodeURIComponent(key.key)}\n`);
  }
  return lines.join("");
}
