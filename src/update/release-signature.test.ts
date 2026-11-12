import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  RELEASE_SIGNING_PUBLIC_KEY,
  ReleaseSignatureError,
  parseSha256Sums,
  releaseArchiveName,
  resolveSignedArchiveSha256,
  verifySha256Sums,
} from "./release-signature.js";

const SHA_A = "a".repeat(64);
const SHA_B = "B".repeat(64);
const SUMS_TEXT =
  `${SHA_A}  atomic-agent-linux-x64.tar.gz\n` +
  `${SHA_B} *./atomic-agent-win32-x64.zip\n` +
  "not a digest line\n";

function keypair(): { publicKeyPem: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey,
  };
}

const sums = Buffer.from(SUMS_TEXT, "utf-8");

describe("parseSha256Sums", () => {
  it("reads sha256sum lines, binary markers and ./ prefixes", () => {
    const map = parseSha256Sums(SUMS_TEXT);
    expect(map.size).toBe(2);
    expect(map.get("atomic-agent-linux-x64.tar.gz")).toBe(SHA_A);
    expect(map.get("atomic-agent-win32-x64.zip")).toBe(SHA_B.toLowerCase());
  });
});

describe("verifySha256Sums", () => {
  it("ships with no embedded key, so the check stays off", () => {
    expect(RELEASE_SIGNING_PUBLIC_KEY).toBe("");
  });

  it("verifies a good signature and returns the digests", () => {
    const { publicKeyPem, privateKey } = keypair();
    const signature = sign(null, sums, privateKey);
    const result = verifySha256Sums({ sums, signature, publicKeyPem });
    expect(result.status).toBe("verified");
    if (result.status === "verified") {
      expect(result.sums.get("atomic-agent-linux-x64.tar.gz")).toBe(SHA_A);
    }
  });

  it("rejects tampered sums", () => {
    const { publicKeyPem, privateKey } = keypair();
    const signature = sign(null, sums, privateKey);
    const tampered = Buffer.from(SUMS_TEXT.replace(SHA_A, "c".repeat(64)), "utf-8");
    expect(verifySha256Sums({ sums: tampered, signature, publicKeyPem }).status).toBe("invalid");
  });

  it("rejects a signature by another key", () => {
    const { publicKeyPem } = keypair();
    const other = keypair();
    const signature = sign(null, sums, other.privateKey);
    expect(verifySha256Sums({ sums, signature, publicKeyPem }).status).toBe("invalid");
  });

  it("rejects a signature of the wrong length", () => {
    const { publicKeyPem, privateKey } = keypair();
    const signature = sign(null, sums, privateKey).subarray(0, 32);
    const result = verifySha256Sums({ sums, signature, publicKeyPem });
    expect(result).toMatchObject({ status: "invalid" });
  });

  it("rejects an embedded key that is not ed25519", () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const result = verifySha256Sums({ sums, signature: Buffer.alloc(64), publicKeyPem });
    expect(result).toMatchObject({ status: "invalid" });
  });

  it("skips without a key, and without a signature", () => {
    const { publicKeyPem } = keypair();
    expect(verifySha256Sums({ sums, signature: Buffer.alloc(64), publicKeyPem: "" })).toEqual({
      status: "skipped",
      reason: "no-key",
    });
    expect(verifySha256Sums({ sums, signature: null, publicKeyPem })).toEqual({
      status: "skipped",
      reason: "no-signature",
    });
  });
});

describe("releaseArchiveName", () => {
  it("matches the installers' slugs", () => {
    expect(releaseArchiveName("darwin", "arm64")).toBe("atomic-agent-darwin-arm64.tar.gz");
    expect(releaseArchiveName("linux", "x64")).toBe("atomic-agent-linux-x64.tar.gz");
    expect(releaseArchiveName("win32", "arm64")).toBe("atomic-agent-win32-x64.zip");
    expect(releaseArchiveName("linux", "ia32")).toBeNull();
    expect(releaseArchiveName("freebsd", "x64")).toBeNull();
  });
});

type Assets = Record<string, Uint8Array | number>;

function fakeFetch(assets: Assets, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    const name = url.slice(url.lastIndexOf("/") + 1);
    const asset = assets[name];
    if (asset === undefined) return new Response("missing", { status: 404 });
    if (typeof asset === "number") return new Response("err", { status: asset });
    return new Response(new Uint8Array(asset), { status: 200 });
  }) as typeof fetch;
}

describe("resolveSignedArchiveSha256", () => {
  const base = { repo: "AtomicBot-ai/atomic-agent", platform: "linux" as const, arch: "x64" };

  it("does not touch the network without a key", async () => {
    const seen: string[] = [];
    const lines: string[] = [];
    const sha = await resolveSignedArchiveSha256({
      ...base,
      publicKeyPem: "",
      fetchImpl: fakeFetch({}, seen),
      onDebug: (line) => lines.push(line),
    });
    expect(sha).toBeNull();
    expect(seen).toEqual([]);
    expect(lines.join("\n")).toContain("no public key");
  });

  it("skips a release that ships no signature", async () => {
    const { publicKeyPem } = keypair();
    const sha = await resolveSignedArchiveSha256({
      ...base,
      publicKeyPem,
      fetchImpl: fakeFetch({ SHA256SUMS: sums }),
    });
    expect(sha).toBeNull();
  });

  it("returns the signed digest of this host's archive, from the pinned tag", async () => {
    const { publicKeyPem, privateKey } = keypair();
    const seen: string[] = [];
    const sha = await resolveSignedArchiveSha256({
      ...base,
      version: "v0.7.1",
      publicKeyPem,
      fetchImpl: fakeFetch(
        { SHA256SUMS: sums, "SHA256SUMS.sig": sign(null, sums, privateKey) },
        seen,
      ),
    });
    expect(sha).toBe(SHA_A);
    expect(seen.every((u) => u.includes("/releases/download/v0.7.1/"))).toBe(true);
  });

  it("throws when the signature does not hold", async () => {
    const { publicKeyPem } = keypair();
    const other = keypair();
    await expect(
      resolveSignedArchiveSha256({
        ...base,
        publicKeyPem,
        fetchImpl: fakeFetch({
          SHA256SUMS: sums,
          "SHA256SUMS.sig": sign(null, sums, other.privateKey),
        }),
      }),
    ).rejects.toBeInstanceOf(ReleaseSignatureError);
  });

  it("throws when the signed list does not name the archive", async () => {
    const { publicKeyPem, privateKey } = keypair();
    await expect(
      resolveSignedArchiveSha256({
        ...base,
        arch: "arm64",
        publicKeyPem,
        fetchImpl: fakeFetch({ SHA256SUMS: sums, "SHA256SUMS.sig": sign(null, sums, privateKey) }),
      }),
    ).rejects.toThrow("does not list atomic-agent-linux-arm64.tar.gz");
  });

  it("throws when the signature is there but SHA256SUMS is not, or a fetch fails", async () => {
    const { publicKeyPem } = keypair();
    await expect(
      resolveSignedArchiveSha256({
        ...base,
        publicKeyPem,
        fetchImpl: fakeFetch({ "SHA256SUMS.sig": Buffer.alloc(64) }),
      }),
    ).rejects.toBeInstanceOf(ReleaseSignatureError);
    await expect(
      resolveSignedArchiveSha256({
        ...base,
        publicKeyPem,
        fetchImpl: fakeFetch({ "SHA256SUMS.sig": 503 }),
      }),
    ).rejects.toThrow("HTTP 503");
  });
});
