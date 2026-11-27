import { ConfigValidationError } from "../config-validation-error.js";
import { coerceFloatLike } from "../config-primitives.js";

/**
 * `agent.security` (ATO-2505, ATO-2528): how sure an argument check must
 * be before it asks at every approval level, and the hosts a command may
 * send data to without the egress hold asking. Additive and unversioned:
 * a file without it reads the defaults.
 */
export interface AgentSecurityConfig {
  /**
   * The confidence at or above which an argument finding (a credential read, an encoded command, a secret in an HTTP body) asks at every approval level, bypass included. Range 0.5 to 1, default 0.7. Below it a finding asks as an ordinary dangerous action and goes quiet at full trust. Read live.
   */
  argScanThreshold: number;
  /**
   * Hosts a command, `os.git.push` or `os.http.request` may send data to without the egress hold asking, kept across sessions (ATO-2528), like ssh `known_hosts`. `github.com` exactly, or `*.example.com` for the domain and its subdomains. "Allow always" on a held call adds its hosts here. Unlike `http.hostAllowlist` it limits nothing. Default empty. Read live.
   */
  knownHosts: string[];
}

/** Same number as `ASK_EVERY_LEVEL_CONFIDENCE` in the shell guard. */
export const DEFAULT_ARG_SCAN_THRESHOLD = 0.7;
export const MIN_ARG_SCAN_THRESHOLD = 0.5;
export const MAX_KNOWN_HOSTS = 500;

const HOST_ENTRY_RE = /^(?:\*\.)?[a-z0-9_]([a-z0-9_.-]*[a-z0-9_])?$/;

export function createAgentSecurityDefaults(): AgentSecurityConfig {
  return { argScanThreshold: DEFAULT_ARG_SCAN_THRESHOLD, knownHosts: [] };
}

/** `GitHub.com.` → `github.com`; `null` for anything that is not a host or `*.domain`. */
export function normaliseKnownHostEntry(raw: string): string | null {
  const entry = raw.trim().toLowerCase().replace(/\.+$/, "");
  return entry.length > 0 && entry.length <= 253 && HOST_ENTRY_RE.test(entry) ? entry : null;
}

function parseThreshold(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const threshold = coerceFloatLike(value);
  if (!Number.isFinite(threshold) || threshold < MIN_ARG_SCAN_THRESHOLD || threshold > 1) {
    throw new ConfigValidationError(
      "agent.security.argScanThreshold",
      `expected number in [${MIN_ARG_SCAN_THRESHOLD}, 1], got ${JSON.stringify(value)}`,
    );
  }
  return threshold;
}

function parseKnownHosts(value: unknown, fallback: readonly string[]): string[] {
  if (value === undefined || value === null) return [...fallback];
  if (!Array.isArray(value) || value.length > MAX_KNOWN_HOSTS) {
    throw new ConfigValidationError(
      "agent.security.knownHosts",
      `expected at most ${MAX_KNOWN_HOSTS} host names, got ${JSON.stringify(value).slice(0, 80)}`,
    );
  }
  const hosts: string[] = [];
  for (const item of value) {
    const entry = typeof item === "string" ? normaliseKnownHostEntry(item) : null;
    if (entry === null) {
      throw new ConfigValidationError(
        "agent.security.knownHosts",
        `expected a host like github.com or *.example.com, got ${JSON.stringify(item)}`,
      );
    }
    if (!hosts.includes(entry)) hosts.push(entry);
  }
  return hosts;
}

/** Absent keys keep `defaults`; a threshold outside 0.5..1 or a bad host is an error. */
export function parseAgentSecurityConfig(
  raw: unknown,
  defaults: AgentSecurityConfig = createAgentSecurityDefaults(),
): AgentSecurityConfig {
  if (raw === undefined || raw === null) return { ...defaults, knownHosts: [...(defaults.knownHosts ?? [])] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError("agent.security", `expected an object, got ${JSON.stringify(raw)}`);
  }
  const block = raw as { argScanThreshold?: unknown; knownHosts?: unknown };
  return {
    argScanThreshold: parseThreshold(block.argScanThreshold, defaults.argScanThreshold),
    knownHosts: parseKnownHosts(block.knownHosts, defaults.knownHosts ?? []),
  };
}
