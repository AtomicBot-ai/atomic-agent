/**
 * On-disk store for the OAuth sign-in of remote MCP servers.
 *
 * One JSON file per server under `<stateDir>/mcp-oauth/<name>.json`,
 * written atomically (temp file + rename) with mode 0600 inside a 0700
 * folder. A record remembers the server URL it was made for: when the
 * configured URL changes, `load` returns an empty record and the next
 * `save` replaces the old one, so credentials never follow a server to a
 * new address.
 *
 * What a record holds: the dynamic client registration result, the
 * redirect URI it was registered with, the tokens, the PKCE code
 * verifier and the authorization URL of a sign-in in progress. None of
 * it is ever logged; callers only ask "is there a token".
 *
 * No SDK import here: the shapes are kept as plain JSON objects and the
 * provider (`mcp-oauth-provider.ts`) hands them to the SDK as-is.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { MCP_SERVER_NAME_RE } from "./mcp-types.js";

/** Folder under the state dir. */
export const MCP_OAUTH_DIR = "mcp-oauth";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Everything kept for one server. Unknown fields are dropped on load. */
export interface McpOAuthRecord {
  /** Server URL this record belongs to. */
  url: string;
  /** Redirect URI the client below was registered with. */
  redirectUri?: string;
  /** Dynamic client registration result (`client_id`, ...). */
  clientInformation?: Record<string, unknown>;
  /** Token response (`access_token`, `refresh_token`, ...). */
  tokens?: Record<string, unknown>;
  /** Wall clock (ms) of the last token save. */
  tokensSavedAt?: number;
  /** PKCE verifier of the sign-in in progress. */
  codeVerifier?: string;
  /** Authorization URL of the sign-in in progress. */
  pendingAuthUrl?: string;
}

export interface McpOAuthStore {
  /** The record for `server` at `url`, or an empty one. Never throws. */
  load(server: string, url: string): McpOAuthRecord;
  /** Merge `patch` into the record and write it. `undefined` fields are removed. */
  update(server: string, url: string, patch: Partial<McpOAuthRecord>): McpOAuthRecord;
  /** Delete everything kept for `server` (sign out). */
  clear(server: string): void;
  /** True when the record for `server` at `url` holds an access token. */
  hasTokens(server: string, url: string): boolean;
}

/** Path of one server's file. Throws on a name that is not a valid server name. */
export function mcpOAuthFilePath(stateDir: string, server: string): string {
  if (!MCP_SERVER_NAME_RE.test(server)) {
    throw new Error(`invalid MCP server name: ${JSON.stringify(server)}`);
  }
  return join(stateDir, MCP_OAUTH_DIR, `${server}.json`);
}

export function createMcpOAuthStore(stateDir: string): McpOAuthStore {
  const dir = join(stateDir, MCP_OAUTH_DIR);

  const readRaw = (server: string): McpOAuthRecord | null => {
    const file = mcpOAuthFilePath(stateDir, server);
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      return sanitize(parsed);
    } catch {
      // A torn or hand-edited file reads as "not signed in".
      return null;
    }
  };

  const write = (server: string, record: McpOAuthRecord): void => {
    const file = mcpOAuthFilePath(stateDir, server);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: FILE_MODE,
    });
    try {
      // `mode` on writeFileSync is masked by the umask; set it outright.
      chmodSync(tmp, FILE_MODE);
    } catch {
      // Windows has no POSIX modes; the profile folder is private there.
    }
    renameSync(tmp, file);
  };

  const load = (server: string, url: string): McpOAuthRecord => {
    const rec = readRaw(server);
    if (!rec || rec.url !== url) return { url };
    return rec;
  };

  return {
    load,
    update(server, url, patch) {
      const next: McpOAuthRecord = { ...load(server, url), ...patch, url };
      for (const key of Object.keys(next) as Array<keyof McpOAuthRecord>) {
        if (next[key] === undefined) delete next[key];
      }
      write(server, next);
      return next;
    },
    clear(server) {
      rmSync(mcpOAuthFilePath(stateDir, server), { force: true });
    },
    hasTokens(server, url) {
      const tokens = load(server, url).tokens;
      return typeof tokens?.access_token === "string" && tokens.access_token.length > 0;
    },
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sanitize(raw: unknown): McpOAuthRecord | null {
  if (!isObject(raw) || typeof raw.url !== "string") return null;
  const out: McpOAuthRecord = { url: raw.url };
  if (typeof raw.redirectUri === "string") out.redirectUri = raw.redirectUri;
  if (isObject(raw.clientInformation)) out.clientInformation = raw.clientInformation;
  if (isObject(raw.tokens)) out.tokens = raw.tokens;
  if (typeof raw.tokensSavedAt === "number") out.tokensSavedAt = raw.tokensSavedAt;
  if (typeof raw.codeVerifier === "string") out.codeVerifier = raw.codeVerifier;
  if (typeof raw.pendingAuthUrl === "string") out.pendingAuthUrl = raw.pendingAuthUrl;
  return out;
}
