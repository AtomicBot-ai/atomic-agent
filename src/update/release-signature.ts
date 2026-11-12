import { createPublicKey, verify, type KeyObject } from "node:crypto";

/**
 * Public half of the release signing key, as an SPKI PEM
 * (`openssl pkey -in key.pem -pubout`). Empty until the key exists: every
 * check below is then skipped and an update relies on the per-asset
 * `.sha256` alone, as before. Keep it equal to `RELEASE_SIGNING_PUBLIC_KEY`
 * in scripts/install.sh. Setup and rotation: scripts/docs/bundling.md,
 * "Release signature".
 */
export const RELEASE_SIGNING_PUBLIC_KEY = "";

/** Digest list of every release asset, `sha256sum` format. */
export const RELEASE_SUMS_ASSET = "SHA256SUMS";
/** Detached raw Ed25519 signature (64 bytes) over {@link RELEASE_SUMS_ASSET}. */
export const RELEASE_SIGNATURE_ASSET = "SHA256SUMS.sig";

const ED25519_SIGNATURE_BYTES = 64;
const FETCH_TIMEOUT_MS = 15_000;

export type SumsVerification =
  | { status: "verified"; sums: Map<string, string> }
  | { status: "skipped"; reason: "no-key" | "no-signature" }
  | { status: "invalid"; reason: string };

export class ReleaseSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseSignatureError";
  }
}

/**
 * `sha256sum` output to a file → lowercase hex map. Accepts the binary-mode
 * `*name` marker and a leading `./`. Lines that are not a digest are ignored.
 */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(raw.trim());
    if (!match) continue;
    const name = match[2]!.replace(/^\.\//, "");
    sums.set(name, match[1]!.toLowerCase());
  }
  return sums;
}

function loadEd25519Key(pem: string): KeyObject | string {
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519") {
      return `embedded key is ${key.asymmetricKeyType ?? "unknown"}, not ed25519`;
    }
    return key;
  } catch (err) {
    return `embedded key does not parse: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Check a raw Ed25519 detached signature over the release's SHA256SUMS.
 * Pure. Skipped (not failed) when no key is embedded or the release ships no
 * signature, so releases cut before the key existed still update.
 */
export function verifySha256Sums(input: {
  sums: Uint8Array;
  signature: Uint8Array | null;
  publicKeyPem: string;
}): SumsVerification {
  if (input.publicKeyPem.trim() === "") {
    return { status: "skipped", reason: "no-key" };
  }
  if (input.signature === null) {
    return { status: "skipped", reason: "no-signature" };
  }
  const key = loadEd25519Key(input.publicKeyPem);
  if (typeof key === "string") return { status: "invalid", reason: key };
  if (input.signature.length !== ED25519_SIGNATURE_BYTES) {
    return {
      status: "invalid",
      reason: `signature is ${input.signature.length} bytes, expected ${ED25519_SIGNATURE_BYTES}`,
    };
  }
  let ok = false;
  try {
    ok = verify(null, input.sums, key, input.signature);
  } catch {
    ok = false;
  }
  if (!ok) {
    return {
      status: "invalid",
      reason: `${RELEASE_SIGNATURE_ASSET} does not match ${RELEASE_SUMS_ASSET}`,
    };
  }
  const text = Buffer.from(input.sums).toString("utf-8");
  return { status: "verified", sums: parseSha256Sums(text) };
}

/**
 * The archive install.sh / install.ps1 download for this host, or `null`
 * when the release has none. Mirrors their slug logic: Windows always takes
 * the x64 zip (ARM64 runs it under emulation).
 */
export function releaseArchiveName(
  platform: NodeJS.Platform,
  arch: string,
): string | null {
  if (platform === "win32") return "atomic-agent-win32-x64.zip";
  if (platform !== "darwin" && platform !== "linux") return null;
  if (arch !== "arm64" && arch !== "x64") return null;
  return `atomic-agent-${platform}-${arch}.tar.gz`;
}

export function releaseDownloadBase(repo: string, version?: string): string {
  return version
    ? `https://github.com/${repo}/releases/download/${version}`
    : `https://github.com/${repo}/releases/latest/download`;
}

export interface ResolveSignedSha256Options {
  repo: string;
  version?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Defaults to {@link RELEASE_SIGNING_PUBLIC_KEY}; injectable for tests. */
  publicKeyPem?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onDebug?: (line: string) => void;
}

async function fetchAsset(
  url: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<Uint8Array | null> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await fetchImpl(url, {
    headers: { "User-Agent": "atomic-agent/self-update" },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new ReleaseSignatureError(`could not fetch ${url}: HTTP ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * The SHA-256 the release's signed SHA256SUMS gives for this host's archive,
 * for the installer to compare against (`ATOMIC_AGENT_EXPECTED_SHA256`).
 * `null` when the check is skipped: no embedded key (no network at all), no
 * archive for this host, or a release without a signature. Throws
 * {@link ReleaseSignatureError} when a signature is there and does not hold,
 * or the signed list does not name the archive.
 */
export async function resolveSignedArchiveSha256(
  opts: ResolveSignedSha256Options,
): Promise<string | null> {
  const debug = opts.onDebug ?? (() => {});
  const publicKeyPem = opts.publicKeyPem ?? RELEASE_SIGNING_PUBLIC_KEY;
  if (publicKeyPem.trim() === "") {
    debug("release signature: no public key embedded; skipping");
    return null;
  }
  const archive = releaseArchiveName(
    opts.platform ?? process.platform,
    opts.arch ?? process.arch,
  );
  if (!archive) {
    debug("release signature: no release archive for this host; skipping");
    return null;
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = releaseDownloadBase(opts.repo, opts.version);
  const signature = await fetchAsset(
    `${base}/${RELEASE_SIGNATURE_ASSET}`,
    fetchImpl,
    opts.signal,
  );
  if (signature === null) {
    debug(`release signature: release ships no ${RELEASE_SIGNATURE_ASSET}; skipping`);
    return null;
  }
  const sums = await fetchAsset(`${base}/${RELEASE_SUMS_ASSET}`, fetchImpl, opts.signal);
  if (sums === null) {
    throw new ReleaseSignatureError(
      `release has ${RELEASE_SIGNATURE_ASSET} but no ${RELEASE_SUMS_ASSET}`,
    );
  }
  const result = verifySha256Sums({ sums, signature, publicKeyPem });
  if (result.status === "skipped") return null;
  if (result.status === "invalid") {
    throw new ReleaseSignatureError(`release signature check failed: ${result.reason}`);
  }
  const sha = result.sums.get(archive);
  if (!sha) {
    throw new ReleaseSignatureError(`signed ${RELEASE_SUMS_ASSET} does not list ${archive}`);
  }
  debug(`release signature: verified; ${archive} must hash to ${sha}`);
  return sha;
}
