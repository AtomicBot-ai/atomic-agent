import { scrypt } from "node:crypto";

/**
 * The parts of talking to Atomic Mail that are about *getting in*: the
 * fixed proof-of-work, the JWT bookkeeping, and how a refusal is read.
 * `atomic-mail-client.ts` builds the JMAP calls on top.
 */

export const ATOMIC_MAIL_AUTH_URL = "https://auth.atomicmail.ai";
export const ATOMIC_MAIL_API_URL = "https://api.atomicmail.ai";
export const ATOMIC_MAIL_DOMAIN = "atomicmail.ai";

/**
 * The fixed proof-of-work salt: the auth service passes the UTF-8 bytes
 * of this hex text — not its decoded binary — to scrypt, and every
 * client must do the same.
 */
export const POW_SALT_HEX =
  "0b980734412c292d6549110276b604ab1dea4883bd460d77d1b984adf8bca083";
const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const POW_HASH_BYTES = 64;

/** Session JWTs live an hour; stop using one this long before it lapses. */
export const SESSION_SAFETY_MARGIN_MS = 60_000;
/** Capability JWTs live two minutes. */
export const CAPABILITY_SAFETY_MARGIN_MS = 20_000;
export const REQUEST_TIMEOUT_MS = 30_000;

export class AtomicMailError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly hint?: string,
  ) {
    super(hint ? `${message} — ${hint}` : message);
    this.name = "AtomicMailError";
  }
}

export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  if (!part) throw new AtomicMailError("malformed token", 0);
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf-8")) as Record<
    string,
    unknown
  >;
}

export function jwtExpiryMs(jwt: string): number {
  const exp = decodeJwtPayload(jwt).exp;
  return typeof exp === "number" ? exp * 1000 : 0;
}

export function hasLeadingZeroBits(hash: Uint8Array, bits: number): boolean {
  if (bits > hash.length * 8) return false;
  const fullBytes = Math.floor(bits / 8);
  for (let i = 0; i < fullBytes; i += 1) if (hash[i] !== 0) return false;
  const rest = bits % 8;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return ((hash[fullBytes] ?? 0xff) & mask) === 0;
}

export function scryptHash(data: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(data, "utf-8"),
      Buffer.from(POW_SALT_HEX, "utf-8"),
      POW_HASH_BYTES,
      SCRYPT,
      (err, key) => (err ? reject(err) : resolve(new Uint8Array(key))),
    );
  });
}

/** Grind nonces until the scrypt digest starts with `difficulty` zero bits. */
export async function solveProofOfWork(
  challenge: string,
  difficulty: number,
  onProgress?: (nonce: number) => void,
): Promise<{ powHex: string; nonce: string }> {
  for (let nonce = 0; ; nonce += 1) {
    const digest = await scryptHash(`${challenge}:${nonce}`);
    if (hasLeadingZeroBits(digest, difficulty)) {
      return {
        powHex: Buffer.from(digest).toString("hex"),
        nonce: String(nonce),
      };
    }
    if (onProgress && nonce % 64 === 0) onProgress(nonce);
  }
}

export function readBearer(res: Response): string {
  const raw = res.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  if (!m)
    throw new AtomicMailError("no bearer token in the response", res.status);
  return m[1]!;
}

export async function failFrom(
  res: Response,
  what: string,
): Promise<AtomicMailError> {
  let hint: string | undefined;
  try {
    const body = (await res.json()) as {
      error?: { message?: string; hint?: string } | string;
    };
    if (typeof body.error === "string") hint = body.error;
    else hint = body.error?.hint ?? body.error?.message;
  } catch {
    /* no body */
  }
  return new AtomicMailError(
    `${what} failed: HTTP ${res.status}`,
    res.status,
    hint,
  );
}
