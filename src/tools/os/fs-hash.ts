import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";

/**
 * Supported digest algorithms. Kept as a narrow union so the grammar +
 * descriptor stay tight; if callers need anything exotic, they can reach
 * for `os.shell.run openssl dgst …`.
 */
export type HashAlgorithm = "md5" | "sha1" | "sha256" | "sha512";
export type HashEncoding = "hex" | "base64";

const DEFAULT_ALGORITHM: HashAlgorithm = "sha256";
const DEFAULT_ENCODING: HashEncoding = "hex";

interface HashArgs {
  path: string;
  algorithm: HashAlgorithm;
  encoding: HashEncoding;
}

export const osFsHashTool: ToolDefinition = {
  name: "os.fs.hash",
  description:
    "Compute a cryptographic digest of a file (MD5/SHA1/SHA256/SHA512). Streams the file through the hasher, so multi-GB inputs don't blow up RAM. Read-only.",
  readonly: true,
  async run(rawArgs, ctx) {
    const args = parseArgs(rawArgs);
    const absolute = isAbsolute(args.path)
      ? args.path
      : resolve(ctx.workingDir, args.path);
    const info = await stat(absolute);
    if (!info.isFile()) {
      throw new Error(`os.fs.hash: ${absolute} is not a regular file`);
    }

    const digest = await computeDigest(absolute, args.algorithm, args.encoding);

    return compressToolResult({
      tool: "os.fs.hash",
      status: "ok",
      output: `${args.algorithm}:${digest}  ${absolute}`,
      details: {
        path: absolute,
        algorithm: args.algorithm,
        encoding: args.encoding,
        digest,
        size: info.size,
      },
    });
  },
};

function parseArgs(rawArgs: Record<string, unknown>): HashArgs {
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
  if (norm === "md5" || norm === "sha1" || norm === "sha256" || norm === "sha512") {
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

function computeDigest(
  path: string,
  algorithm: HashAlgorithm,
  encoding: HashEncoding,
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const hasher = createHash(algorithm);
    const stream = createReadStream(path);
    stream.on("error", rejectPromise);
    stream.on("data", (chunk) => hasher.update(chunk));
    stream.on("end", () => resolvePromise(hasher.digest(encoding)));
  });
}
