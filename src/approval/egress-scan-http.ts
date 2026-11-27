/**
 * curl and wget for the egress scan (ATO-2116). A call sends data out
 * (outbound) when it carries a body or a file (`-d`, `--data*`, `-F`,
 * `--form`, `-T`, `--upload-file`, `--json`, wget's `--post-*` /
 * `--body-*`) or names a method that does (`-X POST|PUT|PATCH`). Any
 * other call only fetches (inbound). Ported from the patterns of Goose's
 * egress inspector (Apache-2.0, see egress-scan.ts), read per argument
 * here instead of by regex over the whole line.
 *
 * Where the bytes really go is not always the URL operand. When a call
 * sends, a proxy or address override (`-x`, `--proxy`, `--socks5`,
 * `--connect-to`, `--resolve`, a proxy variable) and an operand whose
 * host cannot be read (a decimal IP, `$URL`) each add a destination with
 * `host: null`. A config file (`curl -K`, `wget -e`) can add both a body
 * and a URL, so it always adds one, as outbound.
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
  /** Short letters that send the bytes somewhere other than the URL (`-x proxy`). */
  shortRoute: ReadonlySet<string>;
  /** Short letters that read options from a file or a line (`-K file`). */
  shortConfig: ReadonlySet<string>;
  /** Long options that take a value. */
  longValue: ReadonlySet<string>;
  /** Long options whose use means a body is sent. */
  longSend: ReadonlySet<string>;
  /** Long options naming the method. */
  longMethod: ReadonlySet<string>;
  /** Long options whose value is a URL (`--url`). */
  longUrl: ReadonlySet<string>;
  /** Long options that send the bytes somewhere other than the URL. */
  longRoute: ReadonlySet<string>;
  /** Long options that read options from a file or a line. */
  longConfig: ReadonlySet<string>;
}

const CURL_ROUTE = [
  "--proxy", "--preproxy", "--proxy1.0", "--socks4", "--socks4a", "--socks5",
  "--socks5-hostname", "--connect-to", "--resolve", "--doh-url",
];

const CURL: ClientSpec = {
  kind: "url",
  shortValue: new Set([..."dFTXHouAebcxmwKErzYyCPQt"]),
  shortSend: new Set(["d", "F", "T"]),
  shortMethod: "X",
  shortRoute: new Set(["x"]),
  shortConfig: new Set(["K"]),
  longValue: new Set([
    "--data", "--data-ascii", "--data-binary", "--data-raw", "--data-urlencode",
    "--json", "--form", "--form-string", "--upload-file", "--request", "--header",
    "--output", "--user", "--user-agent", "--referer", "--cookie", "--cookie-jar",
    "--max-time", "--connect-timeout", "--write-out", "--config",
    "--cacert", "--cert", "--key", "--range", "--time-cond",
    "--retry", "--limit-rate", "--url", "--continue-at", "--interface",
    "--proxy-user", "--oauth2-bearer", "--variable", "--expand-url",
    ...CURL_ROUTE,
  ]),
  longSend: new Set([
    "--data", "--data-ascii", "--data-binary", "--data-raw", "--data-urlencode",
    "--json", "--form", "--form-string", "--upload-file",
  ]),
  longMethod: new Set(["--request"]),
  longUrl: new Set(["--url", "--expand-url"]),
  longRoute: new Set(CURL_ROUTE),
  longConfig: new Set(["--config"]),
};

const WGET: ClientSpec = {
  kind: "url",
  shortValue: new Set([..."OoaUPtTeiBQwl"]),
  shortSend: new Set(),
  shortRoute: new Set(["i"]),
  shortConfig: new Set(["e"]),
  longValue: new Set([
    "--output-document", "--output-file", "--append-output", "--user-agent",
    "--header", "--directory-prefix", "--tries", "--timeout", "--execute",
    "--input-file", "--base", "--post-data", "--post-file", "--body-data",
    "--body-file", "--method", "--user", "--password", "--http-user",
    "--http-password", "--quota", "--wait", "--level", "--config",
  ]),
  longSend: new Set(["--post-data", "--post-file", "--body-data", "--body-file"]),
  longMethod: new Set(["--method"]),
  longUrl: new Set(),
  longRoute: new Set(["--input-file"]),
  longConfig: new Set(["--execute", "--config"]),
};

export interface HttpScanOptions {
  /** A proxy variable or a config location was set for this call (`egress-scan.ts`). */
  rerouted?: boolean;
}

/** `POST`, `PUT` and `PATCH` carry a body; `GET`, `HEAD`, `DELETE` do not. */
function isSendMethod(value: string | undefined): boolean {
  return value !== undefined && /^(post|put|patch)$/i.test(value.trim());
}

/** A bare `example.com/path` or `api.example.com:8080` operand curl and wget read as a URL. */
function looksLikeBareHost(word: string): boolean {
  return /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+(?::\d+)?(?:[/?#].*)?$/.test(word) ||
    /^localhost(?::\d+)?(?:[/?#].*)?$/i.test(word);
}

/** The host of one URL operand: a host, `null` for one built at run time, or `undefined` for none read. */
function operandHost(word: string): string | null | undefined {
  if (hasUrlScheme(word)) return hostOfUrl(word);
  if (looksLikeBareHost(word)) return hostOfUrl(`http://${word}`);
  // `$URL`, `"${API}/x"`: an address, but not one that can be read here.
  if (/[$`]/.test(word)) return null;
  return undefined;
}

function unknownEntry(spec: ClientSpec, label: string): EgressDestination {
  return { kind: spec.kind, host: null, direction: "outbound", label };
}

function scanClient(
  args: readonly string[],
  spec: ClientSpec,
  program: string,
  options: HttpScanOptions,
): EgressDestination[] {
  let sends = false;
  let routed = options.rerouted === true;
  let configured = false;
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
      if (spec.longRoute.has(name)) routed = true;
      if (spec.longConfig.has(name)) configured = true;
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
        if (spec.shortRoute.has(letter)) routed = true;
        if (spec.shortConfig.has(letter)) configured = true;
        if (rest.length === 0) i += 1;
        break;
      }
      continue;
    }
    operands.push(arg);
  }
  // A config file can carry a body (`data = @.env`) the line does not show.
  if (configured) sends = true;
  const direction = sends ? "outbound" : "inbound";
  const found: EgressDestination[] = [];
  for (const operand of operands) {
    const host = operandHost(operand);
    // An unreadable address only matters when data goes to it.
    if (host === null || host === undefined) {
      if (!sends) continue;
      found.push(
        unknownEntry(
          spec,
          host === null ? `an address ${program} builds when it runs` : `an address ${program} cannot read here`,
        ),
      );
      continue;
    }
    found.push({ kind: spec.kind, host, direction, label: host });
  }
  if (sends && routed) found.push(unknownEntry(spec, `a proxy or address override (${program})`));
  if (configured) found.push(unknownEntry(spec, `an address in a ${program} config file or option line`));
  if (sends && found.length === 0) found.push(unknownEntry(spec, `an address ${program} builds when it runs`));
  return found;
}

export function scanCurl(args: readonly string[], options: HttpScanOptions = {}): EgressDestination[] {
  return scanClient(args, CURL, "curl", options);
}

export function scanWget(args: readonly string[], options: HttpScanOptions = {}): EgressDestination[] {
  return scanClient(args, WGET, "wget", options);
}
