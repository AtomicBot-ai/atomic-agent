import { createHash, randomBytes, randomInt } from "node:crypto";

import { getConfig, type AtomicAgentConfig } from "../config/index.js";
import type { DownloadJob } from "../local-llm/index.js";
import {
  ATOMIC_MAIL_DOMAIN,
  AtomicMailClient,
  AtomicMailError,
  type AtomicMailClientOptions,
  type AtomicMailSession,
  type InboxMessage,
} from "./atomic-mail-client.js";
import {
  persistAtomicMailConfig,
  readAtomicMailApiKey,
  readCachedSession,
  writeAtomicMailApiKey,
  writeCachedSession,
} from "./atomic-mail-store.js";
import { renderAccessCodeMail } from "./templates/access-code-mail.js";
import { renderDownloadMail } from "./templates/download-mail.js";

/**
 * The agent's inbox as one object: register it, prove the owner's
 * address, send the mails this program sends, read what came in. Every
 * caller — the hub, the download worker, the agent's tools — goes
 * through here, so the session cache and the "is the owner verified?"
 * rule live in exactly one place.
 */

export const CODE_TTL_MINUTES = 10;
/** Wrong guesses before the code is thrown away. */
export const CODE_MAX_ATTEMPTS = 5;

export interface AtomicMailServiceOptions extends AtomicMailClientOptions {
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  config?: () => Pick<AtomicAgentConfig, "atomicMail" | "paths">;
  /** Test seam for the six digits. */
  makeCode?: () => string;
}

export type AtomicMailReadiness =
  | { level: "no_inbox" }
  | { level: "no_owner"; address: string }
  | { level: "unverified"; address: string; ownerEmail: string; pendingUntil: string | null }
  | { level: "ready"; address: string; ownerEmail: string };

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export class AtomicMailService {
  private readonly client: AtomicMailClient;
  private readonly env: NodeJS.ProcessEnv;
  private readonly config: () => Pick<AtomicAgentConfig, "atomicMail" | "paths">;
  private readonly makeCode: () => string;
  private readonly stateDirOverride: string | undefined;

  constructor(opts: AtomicMailServiceOptions = {}) {
    this.client = new AtomicMailClient(opts);
    this.env = opts.env ?? process.env;
    this.config = opts.config ?? (() => getConfig());
    this.makeCode = opts.makeCode ?? (() => String(randomInt(0, 1_000_000)).padStart(6, "0"));
    this.stateDirOverride = opts.stateDir;
  }

  private stateDir(): string {
    return this.stateDirOverride ?? this.config().paths.stateDir;
  }

  readiness(): AtomicMailReadiness {
    const cfg = this.config().atomicMail;
    const address = cfg.address;
    if (!readAtomicMailApiKey(this.env) || !address) return { level: "no_inbox" };
    if (!cfg.ownerEmail) return { level: "no_owner", address };
    if (!cfg.ownerVerifiedAt) {
      return {
        level: "unverified",
        address,
        ownerEmail: cfg.ownerEmail,
        pendingUntil: cfg.pendingVerification?.expiresAt ?? null,
      };
    }
    return { level: "ready", address, ownerEmail: cfg.ownerEmail };
  }

  /** A usable session: the cached one inside its hour, else a fresh login (one proof-of-work). */
  private async session(force = false): Promise<AtomicMailSession> {
    const apiKey = readAtomicMailApiKey(this.env);
    if (!apiKey) throw new AtomicMailError("no Atomic Mail inbox yet — press r in Integrations → Atomic Mail", 0);
    const cached = force ? null : readCachedSession(this.stateDir());
    if (AtomicMailClient.sessionIsFresh(cached)) return cached;
    this.client.resetContext();
    const fresh = await this.client.login(apiKey);
    writeCachedSession(this.stateDir(), fresh);
    return fresh;
  }

  /**
   * Run one call on the session; a 401 means the cached token is dead
   * (revoked, key rotated, clock skew) however fresh its expiry looks —
   * log in again once and retry, rather than fail for the rest of the hour.
   */
  private async withSession<T>(fn: (session: AtomicMailSession) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.session());
    } catch (err) {
      if (!(err instanceof AtomicMailError) || err.status !== 401) throw err;
      return fn(await this.session(true));
    }
  }

  /**
   * Create the inbox. `username` defaults to `atag-<6 hex>`; the API key
   * goes to `.env`, the address to config, the session to its cache.
   */
  async register(
    username: string = `atag-${randomBytes(3).toString("hex")}`,
    onProgress?: (nonce: number) => void,
  ): Promise<{ address: string }> {
    const reg = await this.client.register(username, onProgress);
    writeAtomicMailApiKey(this.stateDir(), reg.apiKey);
    writeCachedSession(this.stateDir(), { sessionJwt: reg.sessionJwt, sessionExpiresAt: reg.sessionExpiresAt });
    const address = reg.address || `${username}@${ATOMIC_MAIL_DOMAIN}`;
    persistAtomicMailConfig({
      address,
      accountId: reg.accountId,
      ownerVerifiedAt: null,
      pendingVerification: null,
    });
    return { address };
  }

  /**
   * Mail a six-digit code to `email`, and only then — atomically with
   * it — make `email` the (unverified) owner. A send that fails changes
   * nothing: whoever was verified before stays verified, and no address
   * is ever recorded that has not at least been mailed.
   */
  async sendCode(email: string): Promise<{ expiresAt: string }> {
    const to = email.trim();
    const address = this.config().atomicMail.address;
    if (!address) throw new AtomicMailError("no Atomic Mail inbox yet — press r first", 0);
    const code = this.makeCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000).toISOString();
    const mail = renderAccessCodeMail({ code, expiresInMinutes: CODE_TTL_MINUTES, from: address });
    await this.withSession((s) => this.client.send(s, { to, ...mail }));
    persistAtomicMailConfig({
      ownerEmail: to,
      ownerVerifiedAt: null,
      pendingVerification: { email: to, codeHash: hashCode(code), expiresAt, attempts: 0 },
    });
    return { expiresAt };
  }

  /**
   * The digits typed back. Wrong or late leaves the address unverified;
   * five wrong guesses throw the code away. This guards against a typo
   * in the address, not against whoever can edit config.json — they
   * could set `ownerVerifiedAt` by hand, and the gate runs in their
   * process.
   */
  verifyCode(raw: string): { ok: true; email: string } | { ok: false; reason: string } {
    const pending = this.config().atomicMail.pendingVerification;
    const code = raw.replace(/\D/g, "");
    if (!pending) return { ok: false, reason: "no code has been sent — enter your e-mail first" };
    if (Date.parse(pending.expiresAt) < Date.now()) {
      persistAtomicMailConfig({ pendingVerification: null });
      return { ok: false, reason: "that code has expired — press v to get a new one" };
    }
    if (code.length !== 6 || hashCode(code) !== pending.codeHash) {
      const attempts = pending.attempts + 1;
      if (attempts >= CODE_MAX_ATTEMPTS) {
        persistAtomicMailConfig({ pendingVerification: null });
        return { ok: false, reason: "too many wrong guesses — press v to get a new code" };
      }
      persistAtomicMailConfig({ pendingVerification: { ...pending, attempts } });
      return { ok: false, reason: `that is not the code in the mail (${CODE_MAX_ATTEMPTS - attempts} tries left)` };
    }
    persistAtomicMailConfig({
      ownerEmail: pending.email,
      ownerVerifiedAt: new Date().toISOString(),
      pendingVerification: null,
    });
    return { ok: true, email: pending.email };
  }

  /**
   * The key changed under us — pasted for another inbox, or cleared.
   * Drop the cached session (it belongs to the old inbox) and, with a
   * key, discover the address it opens.
   */
  async reconnect(): Promise<{ address: string | null }> {
    writeCachedSession(this.stateDir(), null);
    this.client.resetContext();
    if (!readAtomicMailApiKey(this.env)) {
      persistAtomicMailConfig({ address: null, accountId: null, ownerVerifiedAt: null, pendingVerification: null });
      return { address: null };
    }
    const address = await this.withSession((s) => this.client.address(s));
    persistAtomicMailConfig({ address, ownerVerifiedAt: null, pendingVerification: null });
    return { address };
  }

  /** The end-of-download mail, to the verified owner only. */
  async sendDownloadMail(job: DownloadJob): Promise<void> {
    const ready = this.readiness();
    if (ready.level !== "ready") {
      throw new AtomicMailError(
        ready.level === "no_inbox"
          ? "no Atomic Mail inbox"
          : ready.level === "no_owner"
            ? "no owner e-mail"
            : "owner e-mail not verified",
        0,
      );
    }
    const mail = renderDownloadMail({ job, from: ready.address });
    await this.withSession((s) => this.client.send(s, { to: ready.ownerEmail, ...mail }));
  }

  /** Any mail from the agent — the `email.send` tool. */
  async send(
    mail: { to: string; subject: string; text: string; html?: string },
    opts?: { signal?: AbortSignal },
  ): Promise<string> {
    return this.withSession((s) => this.client.send(s, mail, opts));
  }

  async listInbox(limit = 20, opts?: { signal?: AbortSignal }): Promise<InboxMessage[]> {
    return this.withSession((s) => this.client.listInbox(s, limit, opts));
  }

  /** Drop the owner address and any pending code; the inbox stays. */
  clearOwner(): void {
    persistAtomicMailConfig({ ownerEmail: null, ownerVerifiedAt: null, pendingVerification: null });
  }

  /** Forget the inbox on this machine (the account itself stays at Atomic Mail). */
  forget(): void {
    writeAtomicMailApiKey(this.stateDir(), null);
    writeCachedSession(this.stateDir(), null);
    persistAtomicMailConfig({
      address: null,
      accountId: null,
      ownerVerifiedAt: null,
      pendingVerification: null,
    });
  }
}
