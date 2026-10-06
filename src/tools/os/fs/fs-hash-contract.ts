const NAME = "os.fs.hash";

export const OS_FS_HASH_CONTRACT = {
  name: NAME,
  description: "Compute a cryptographic digest of a file (MD5/SHA1/SHA256/SHA512). Streams the file through the hasher, so multi-GB inputs don't blow up RAM. Read-only.",
  readonly: true,
  resourceClass: "pure_read",
  descriptor: {
    name: NAME,
    summary: "File digest (md5, sha1, sha256, sha512). Read-only, streams.",
    argsSchema: `{ path: string, algorithm?: "md5" | "sha1" | "sha256" | "sha512", encoding?: "hex" | "base64" }`,
    tier: "rare",
  },
  argsJsonSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      algorithm: {
        type: "string",
        enum: ["md5", "sha1", "sha256", "sha512"],
      },
      encoding: { type: "string", enum: ["hex", "base64"] },
    },
    required: ["path"],
    additionalProperties: false,
  },
} as const;

/**
 * Supported digest algorithms. Kept as a narrow union so the grammar +
 * descriptor stay tight; if callers need anything exotic, they can reach
 * for `os.shell.run openssl dgst …`.
 */
export type HashAlgorithm = "md5" | "sha1" | "sha256" | "sha512";

export type HashEncoding = "hex" | "base64";

const DEFAULT_ALGORITHM: HashAlgorithm = "sha256";

const DEFAULT_ENCODING: HashEncoding = "hex";

export interface HashArgs {
  path: string;
  algorithm: HashAlgorithm;
  encoding: HashEncoding;
}

export function parseHashArgs(rawArgs: Record<string, unknown>): HashArgs {
  const path = rawArgs.path;
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("os.fs.hash: `path` must be a non-empty string");
  }
  const algorithm = parseAlgorithm(rawArgs.algorithm);
  const encoding = parseEncoding(rawArgs.encoding);
  return { path, algorithm, encoding };
}

function parseAlgorithm(raw: unknown): HashAlgorithm {
  if (raw === undefined || raw === null) return DEFAULT_ALGORITHM;
  if (typeof raw !== "string") {
    throw new Error("os.fs.hash: `algorithm` must be a string");
  }
  const norm = raw.toLowerCase();
  if (
    norm === "md5" ||
    norm === "sha1" ||
    norm === "sha256" ||
    norm === "sha512"
  ) {
    return norm;
  }
  throw new Error(
    `os.fs.hash: unknown algorithm ${JSON.stringify(raw)} (supported: md5, sha1, sha256, sha512)`,
  );
}

function parseEncoding(raw: unknown): HashEncoding {
  if (raw === undefined || raw === null) return DEFAULT_ENCODING;
  if (raw === "hex" || raw === "base64") return raw;
  throw new Error("os.fs.hash: `encoding` must be 'hex' or 'base64'");
}
