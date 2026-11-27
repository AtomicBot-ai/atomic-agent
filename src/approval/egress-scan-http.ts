/**
 * curl and wget for the egress scan (ATO-2116). A call sends data out
 * (outbound) when it carries a body or a file (`-d`, `--data*`, `-F`,
 * `--form`, `-T`, `--upload-file`, `--json`, wget's `--post-*` /
 * `--body-*`) or names a method that does (`-X POST|PUT|PATCH`). Any
 * other call only fetches (inbound). Ported from the patterns of Goose's
 * egress inspector (Apache-2.0, see egress-scan.ts), read per argument
 * here instead of by regex over the whole line.
 */
import { hasUrlScheme, hostOfUrl } from "./egress-host.js";
import type { EgressDestination } from "./egress-scan.js";

interface ClientSpec {
  kind: "url";
  /** Short letters that take a value (`-o file`, `-ofile`). */
  shortValue: ReadonlySet<string>;
  /** Short letters whose use means a body is sent. */
  shortSend: ReadonlySet<string>;
  /** Short letter naming the method, if any (`-X`). */
  shortMethod?: string;
  /** Long options that take a value. */
  longValue: ReadonlySet<string>;
  /** Long options whose use means a body is sent. */
  longSend: ReadonlySet<string>;
  /** Long options naming the method. */
  longMethod: ReadonlySet<string>;
  /** Long options whose value is a URL (`--url`). */
  longUrl: ReadonlySet<string>;
}

const CURL: ClientSpec = {
  kind: "url",
  shortValue: new Set([..."dFTXHouAebcxmwKErzYyCPQt"]),
  shortSend: new Set(["d", "F", "T"]),
  shortMethod: "X",
  longValue: new Set([
    "--data", "--data-ascii", "--data-binary", "--data-raw", "--data-urlencode",
    "--json", "--form", "--form-string", "--upload-file", "--request", "--header",
    "--output", "--user", "--user-agent", "--referer", "--cookie", "--cookie-jar",
    "--proxy", "--max-time", "--connect-timeout", "--write-out", "--config",
    "--cacert", "--cert", "--key", "--range", "--time-cond", "--resolve",
    "--retry", "--limit-rate", "--url", "--continue-at", "--interface",
    "--proxy-user", "--oauth2-bearer", "--variable", "--expand-url",
  ]),
  longSend: new Set([
    "--data", "--data-ascii", "--data-binary", "--data-raw", "--data-urlencode",
    "--json", "--form", "--form-string", "--upload-file",
  ]),
  longMethod: new Set(["--request"]),
  longUrl: new Set(["--url", "--expand-url"]),
};

const WGET: ClientSpec = {
  kind: "url",
  shortValue: new Set([..."OoaUPtTeiBQwl"]),
  shortSend: new Set(),
  longValue: new Set([
    "--output-document", "--output-file", "--append-output", "--user-agent",
    "--header", "--directory-prefix", "--tries", "--timeout", "--execute",
    "--input-file", "--base", "--post-data", "--post-file", "--body-data",
    "--body-file", "--method", "--user", "--password", "--http-user",
    "--http-password", "--quota", "--wait", "--level",
  ]),
  longSend: new Set(["--post-data", "--post-file", "--body-data", "--body-file"]),
  longMethod: new Set(["--method"]),
  longUrl: new Set(),
};

/** `POST`, `PUT` and `PATCH` carry a body; `GET`, `HEAD`, `DELETE` do not. */
function isSendMethod(value: string | undefined): boolean {
  return value !== undefined && /^(post|put|patch)$/i.test(value.trim());
}

/** A bare `example.com/path` or `api.example.com:8080` operand curl and wget read as a URL. */
function looksLikeBareHost(word: string): boolean {
  return /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+(?::\d+)?(?:[/?#].*)?$/.test(word) ||
    /^localhost(?::\d+)?(?:[/?#].*)?$/i.test(word);
}

/** The host of one URL operand: a host, `null` for one built at run time, or `undefined` for none. */
function operandHost(word: string): string | null | undefined {
  if (hasUrlScheme(word)) return hostOfUrl(word);
  if (looksLikeBareHost(word)) return hostOfUrl(`http://${word}`);
  // `$URL`, `"${API}/x"`: an address, but not one that can be read here.
  if (/[$`]/.test(word)) return null;
  return undefined;
}

function scanClient(args: readonly string[], spec: ClientSpec, program: string): EgressDestination[] {
  let sends = false;
  const operands: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg : arg.slice(0, eq);
      const inline = eq === -1 ? undefined : arg.slice(eq + 1);
      const value = inline ?? args[i + 1];
      if (spec.longSend.has(name)) sends = true;
      if (spec.longMethod.has(name) && isSendMethod(value)) sends = true;
      if (spec.longUrl.has(name) && value !== undefined) operands.push(value);
      if (inline === undefined && spec.longValue.has(name)) i += 1;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      // A cluster (`-sSd`): the first value-taking letter takes the rest
      // of the word, or the next word when nothing is left.
      for (let k = 1; k < arg.length; k += 1) {
        const letter = arg[k]!;
        if (!spec.shortValue.has(letter)) continue;
        const rest = arg.slice(k + 1);
        const value = rest.length > 0 ? rest : args[i + 1];
        if (spec.shortSend.has(letter)) sends = true;
        if (letter === spec.shortMethod && isSendMethod(value)) sends = true;
        if (rest.length === 0) i += 1;
        break;
      }
      continue;
    }
    operands.push(arg);
  }
  const direction = sends ? "outbound" : "inbound";
  const found: EgressDestination[] = [];
  for (const operand of operands) {
    const host = operandHost(operand);
    if (host === undefined) continue;
    // An unreadable address only matters when data goes to it.
    if (host === null && !sends) continue;
    found.push({
      kind: spec.kind,
      host,
      direction,
      label: host ?? `an address ${program} builds when it runs`,
    });
  }
  if (sends && found.length === 0) {
    found.push({
      kind: spec.kind,
      host: null,
      direction,
      label: `an address ${program} builds when it runs`,
    });
  }
  return found;
}

export function scanCurl(args: readonly string[]): EgressDestination[] {
  return scanClient(args, CURL, "curl");
}

export function scanWget(args: readonly string[]): EgressDestination[] {
  return scanClient(args, WGET, "wget");
}
