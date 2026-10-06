import type {
  CommandOptions,
  CommandResult,
  runCommand as RunCommand,
} from "../../sandbox/command-runner.js";

/**
 * Spawn the system `curl` for the HTTP/web tools, with the one Windows
 * adjustment they all need.
 *
 * On Windows `curl.exe` uses Schannel, which checks certificate revocation
 * (CRL/OCSP) during the handshake and, by default, fails the whole request
 * when the revocation server cannot be reached: curl exit 35 with
 * `CRYPT_E_REVOCATION_OFFLINE`. Behind corporate proxies, on VPNs and on
 * networks that filter the CAs' revocation hosts that is the normal state,
 * and it left `os.web.fetch` unable to read any https page there (ATO-243).
 *
 * `--ssl-revoke-best-effort` (curl >= 7.70) keeps the check but stops an
 * unreachable revocation server from failing the request. A certificate that
 * *is* reported revoked still fails, and certificate validation itself is
 * untouched. Older curl.exe (Windows 10 1803 shipped 7.55.1) rejects the
 * option as unknown before it opens a connection, so on that exact error the
 * run is repeated once with `--ssl-no-revoke` (>= 7.44) and the choice is
 * kept for the life of the process.
 *
 * Why not probe `curl --version` up front: it is one more spawn for a fallback
 * only very old builds need, and the unknown-option failure it would predict
 * is free — no request was sent, so even a POST body is safe to resend.
 *
 * Every other platform gets the argv byte-identical: OpenSSL / SecureTransport
 * builds do not make this check, and their behaviour must not move.
 */

export const REVOKE_BEST_EFFORT_FLAG = "--ssl-revoke-best-effort";
export const NO_REVOKE_FLAG = "--ssl-no-revoke";

type RevocationFlag = typeof REVOKE_BEST_EFFORT_FLAG | typeof NO_REVOKE_FLAG;

/** curl's "failed to initialize" exit, which an unknown option reports. */
const CURL_EXIT_FAILED_INIT = 2;

let revocationFlag: RevocationFlag = REVOKE_BEST_EFFORT_FLAG;

export interface RunCurlSeams {
  /** Platform override for deterministic tests. Defaults to process.platform. */
  platform?: NodeJS.Platform;
}

export async function runCurl(
  runCommand: typeof RunCommand,
  args: string[],
  options: CommandOptions,
  seams: RunCurlSeams = {},
): Promise<CommandResult> {
  const platform = seams.platform ?? process.platform;
  if (platform !== "win32") return runCommand("curl", args, options);

  const flag = revocationFlag;
  const result = await runCommand("curl", [flag, ...args], options);
  if (flag !== REVOKE_BEST_EFFORT_FLAG || !isUnknownOption(result, flag)) {
    return result;
  }
  revocationFlag = NO_REVOKE_FLAG;
  return runCommand("curl", [NO_REVOKE_FLAG, ...args], options);
}

/**
 * True when curl refused to start because it does not know `flag`. Pinned to
 * the option name so an unrelated exit 2 is never mistaken for an old curl.
 */
function isUnknownOption(result: CommandResult, flag: string): boolean {
  return (
    result.exitCode === CURL_EXIT_FAILED_INIT && result.stderr.includes(flag)
  );
}

const REVOCATION_FAILURE =
  /CRYPT_E_(?:REVOCATION_OFFLINE|NO_REVOCATION_CHECK)|0x8009201[23]/i;

/**
 * Turn curl's stderr into the message the model (and the user reading the
 * tool card) sees. Only the Schannel revocation failure is rewritten — its raw
 * form names a Windows API and a hex code and says nothing about the network
 * — and the original line is kept after it for diagnostics. Everything else
 * passes through unchanged.
 */
export function explainCurlStderr(stderr: string): string {
  if (!REVOCATION_FAILURE.test(stderr)) return stderr;
  return (
    "Windows could not check whether the site's certificate was revoked: " +
    "the certificate revocation server is unreachable (common behind " +
    "proxies, VPNs and filtered networks). " +
    `curl said: ${stderr}`
  );
}

export function resetCurlRevocationFlagForTests(): void {
  revocationFlag = REVOKE_BEST_EFFORT_FLAG;
}
