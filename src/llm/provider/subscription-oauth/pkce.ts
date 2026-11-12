import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

/** RFC 7636 verifier (43 chars of base64url from 32 random bytes) with S256. */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}

/** Unguessable `state` value bound to one login attempt. */
export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

/** Constant-time comparison so `state` cannot be probed byte by byte. */
export function statesMatch(expected: string, received: string | null): boolean {
  if (received === null) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
