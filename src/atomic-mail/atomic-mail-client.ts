import {
  ATOMIC_MAIL_API_URL,
  ATOMIC_MAIL_AUTH_URL,
  ATOMIC_MAIL_DOMAIN,
  AtomicMailError,
  CAPABILITY_SAFETY_MARGIN_MS,
  REQUEST_TIMEOUT_MS,
  SESSION_SAFETY_MARGIN_MS,
  decodeJwtPayload,
  failFrom,
  jwtExpiryMs,
  readBearer,
  solveProofOfWork,
} from "./atomic-mail-auth.js";

import { buildInboxBatch, buildSendBatch, parseInboxList, parseSendResult } from "./atomic-mail-batches.js";

export {
  ATOMIC_MAIL_API_URL,
  ATOMIC_MAIL_AUTH_URL,
  ATOMIC_MAIL_DOMAIN,
  AtomicMailError,
  decodeJwtPayload,
  solveProofOfWork,
} from "./atomic-mail-auth.js";

/**
 * A small Atomic Mail (atomicmail.ai) client — the agent's own inbox.
 *
 * The service is built for agents: an inbox is registered with a
 * proof-of-work instead of a human, and everything after that is JMAP
 * (RFC 8620/8621) over HTTPS. Three auth calls — challenge → session
 * (1 h) → capability (2 min) — then `POST` batches to the session's
 * `apiUrl`. Written against the documented HTTP flow and the shape of
 * `@atomicmail/agentic-core` 0.3.x rather than depending on it: the
 * flow is four requests and one scrypt, and a dependency on an alpha
 * SDK would move with every release.
 *
 * Nothing here touches disk or config. The credential (an API key) and
 * the cached session are handed in and out; `atomic-mail-store.ts`
 * owns where they live.
 */

export interface AtomicMailClientOptions {
  authUrl?: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  /** Test seam: replaces the scrypt proof-of-work. */
  solvePow?: (
    challenge: string,
    difficulty: number,
    onProgress?: (nonce: number) => void,
  ) => Promise<{ powHex: string; nonce: string }>;
  now?: () => number;
}

export interface AtomicMailRegistration {
  /** `name@atomicmail.ai` */
  address: string;
  accountId: string;
  apiKey: string;
}

export interface AtomicMailSession {
  sessionJwt: string;
  /** Epoch ms, from the JWT's `exp`. */
  sessionExpiresAt: number;
}

export interface SendMailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface InboxMessage {
  id: string;
  from: string;
  subject: string;
  receivedAt: string;
  preview: string;
  unread: boolean;
}

interface JmapContext {
  capabilityJwt: string;
  capabilityExpiresAt: number;
  accountId: string;
  apiUrl: string;
  address: string;
  /** RFC 8621 §7.5: a submission names the identity it goes out as. */
  identityId: string | null;
  draftsMailboxId: string | null;
}

/** The request's own timeout, plus the caller's abort when there is one. */
function requestSignal(caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return caller ? AbortSignal.any([timeout, caller]) : timeout;
}

export class AtomicMailClient {
  private readonly authUrl: string;
  private readonly apiUrl: string;
  private readonly call: typeof fetch;
  private readonly pow: NonNullable<AtomicMailClientOptions["solvePow"]>;
  private readonly now: () => number;
  private jmap: JmapContext | null = null;

  constructor(opts: AtomicMailClientOptions = {}) {
    this.authUrl = (opts.authUrl ?? ATOMIC_MAIL_AUTH_URL).replace(/\/+$/, "");
    this.apiUrl = (opts.apiUrl ?? ATOMIC_MAIL_API_URL).replace(/\/+$/, "");
    this.call = opts.fetchImpl ?? fetch;
    this.pow = opts.solvePow ?? ((c, d, p) => solveProofOfWork(c, d, p));
    this.now = opts.now ?? Date.now;
  }

  private async post(
    url: string,
    init: { jwt?: string; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<Response> {
    return this.call(url, {
      method: "POST",
      headers: {
        ...(init.jwt ? { authorization: `Bearer ${init.jwt}` } : {}),
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: requestSignal(init.signal),
    });
  }

  /** Challenge → proof-of-work → session. `credential` is a username (signup) or an API key (login). */
  private async openSession(
    credential: { username: string } | { apiKey: string },
    onProgress?: (nonce: number) => void,
  ): Promise<{ sessionJwt: string; apiKey: string | null }> {
    const challengeRes = await this.post(`${this.authUrl}/api/v1/challenge`);
    if (!challengeRes.ok) throw await failFrom(challengeRes, "challenge");
    const challengeJwt = readBearer(challengeRes);
    const payload = decodeJwtPayload(challengeJwt);
    const challenge = String(payload.jti ?? "");
    const difficulty = Number(payload.difficulty ?? 0);
    if (!challenge) throw new AtomicMailError("challenge token carries no jti", 0);
    const solved = await this.pow(challenge, difficulty, onProgress);
    const sessionRes = await this.post(`${this.authUrl}/api/v1/session`, {
      jwt: challengeJwt,
      body: { powHex: solved.powHex, nonce: solved.nonce, ...credential },
    });
    if (!sessionRes.ok) throw await failFrom(sessionRes, "session");
    const sessionJwt = readBearer(sessionRes);
    let apiKey: string | null = null;
    try {
      const body = (await sessionRes.json()) as { apiKey?: unknown };
      if (typeof body.apiKey === "string") apiKey = body.apiKey;
    } catch {
      /* login responses carry no body */
    }
    return { sessionJwt, apiKey };
  }

  /**
   * Create the agent's inbox. `username` is 5–21 characters and becomes
   * `<username>@atomicmail.ai`. The API key comes back exactly once.
   */
  async register(
    username: string,
    onProgress?: (nonce: number) => void,
  ): Promise<AtomicMailRegistration & AtomicMailSession> {
    if (!/^[a-z0-9][a-z0-9.-]{3,19}[a-z0-9]$/.test(username)) {
      throw new AtomicMailError("username must be 5–21 characters: letters, digits, dots, dashes", 0);
    }
    const { sessionJwt, apiKey } = await this.openSession({ username }, onProgress);
    if (!apiKey) throw new AtomicMailError("registration returned no API key", 0);
    const session = { sessionJwt, sessionExpiresAt: jwtExpiryMs(sessionJwt) };
    const ctx = await this.context(session);
    return { address: ctx.address, accountId: ctx.accountId, apiKey, ...session };
  }

  /** Log in with a stored API key. Costs one proof-of-work; cache the session. */
  async login(apiKey: string): Promise<AtomicMailSession> {
    const { sessionJwt } = await this.openSession({ apiKey });
    return { sessionJwt, sessionExpiresAt: jwtExpiryMs(sessionJwt) };
  }

  static sessionIsFresh(session: AtomicMailSession | null, now: number = Date.now()): session is AtomicMailSession {
    return session !== null && now < session.sessionExpiresAt - SESSION_SAFETY_MARGIN_MS;
  }

  /** Capability token + JMAP session discovery, cached for the capability's life. */
  private async context(session: AtomicMailSession): Promise<JmapContext> {
    if (this.jmap && this.now() < this.jmap.capabilityExpiresAt - CAPABILITY_SAFETY_MARGIN_MS) {
      return this.jmap;
    }
    const capRes = await this.post(`${this.authUrl}/api/v1/capability`, { jwt: session.sessionJwt });
    if (!capRes.ok) throw await failFrom(capRes, "capability");
    const capabilityJwt = readBearer(capRes);
    const wellKnown = await this.call(`${this.apiUrl}/.well-known/jmap`, {
      headers: { authorization: `Bearer ${capabilityJwt}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!wellKnown.ok) throw await failFrom(wellKnown, "JMAP discovery");
    const s = (await wellKnown.json()) as {
      apiUrl?: string;
      primaryAccounts?: Record<string, string>;
      username?: string;
      accounts?: Record<string, { name?: string }>;
    };
    const accountId = s.primaryAccounts?.["urn:ietf:params:jmap:mail"];
    if (!s.apiUrl || !accountId) throw new AtomicMailError("JMAP session lacks apiUrl/accountId", 0);
    const raw = s.username ?? s.accounts?.[accountId]?.name ?? "";
    // The session names the local part alone; mail needs the whole address.
    const address = raw.includes("@") ? raw : `${raw}@${ATOMIC_MAIL_DOMAIN}`;
    this.jmap = {
      capabilityJwt,
      capabilityExpiresAt: jwtExpiryMs(capabilityJwt),
      accountId,
      apiUrl: s.apiUrl.startsWith("http") ? s.apiUrl : `${this.apiUrl}${s.apiUrl}`,
      address,
      // Carried over: identities and mailbox ids outlive a capability.
      identityId: this.jmap?.identityId ?? null,
      draftsMailboxId: this.jmap?.draftsMailboxId ?? null,
    };
    return this.jmap;
  }

  /** Drop every cached token; the next call re-discovers. */
  resetContext(): void {
    this.jmap = null;
  }

  /** The sending identity for `from`, looked up once per client. */
  private async identityId(session: AtomicMailSession): Promise<string | null> {
    const ctx = await this.context(session);
    if (ctx.identityId) return ctx.identityId;
    try {
      const [[, got]] = (await this.jmapCall(session, [
        ["Identity/get", { accountId: ctx.accountId }, "i"],
      ])) as [[string, { list?: Array<{ id?: string; email?: string }> }]];
      const list = got.list ?? [];
      const match = list.find((i) => i.email === ctx.address) ?? list[0];
      ctx.identityId = match?.id ?? null;
    } catch {
      // A server without Identity/get still accepted submissions live;
      // send without it rather than refuse.
      ctx.identityId = null;
    }
    return ctx.identityId;
  }

  private async jmapCall(
    session: AtomicMailSession,
    methodCalls: unknown[],
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    const ctx = await this.context(session);
    const res = await this.post(ctx.apiUrl, {
      jwt: ctx.capabilityJwt,
      ...(signal ? { signal } : {}),
      body: {
        using: [
          "urn:ietf:params:jmap:core",
          "urn:ietf:params:jmap:mail",
          "urn:ietf:params:jmap:submission",
        ],
        methodCalls,
      },
    });
    if (!res.ok) throw await failFrom(res, "JMAP request");
    const body = (await res.json()) as { methodResponses?: unknown[] };
    const responses = body.methodResponses ?? [];
    for (const r of responses) {
      const [name, args] = r as [string, Record<string, unknown>];
      if (name === "error") {
        throw new AtomicMailError(`JMAP ${String(args.type ?? "error")}`, 0, typeof args.description === "string" ? args.description : undefined);
      }
    }
    return responses;
  }

  /** The address this session belongs to. */
  async address(session: AtomicMailSession): Promise<string> {
    return (await this.context(session)).address;
  }

  private async mailboxId(session: AtomicMailSession, role: "inbox" | "drafts"): Promise<string> {
    const ctx = await this.context(session);
    const [[, q]] = (await this.jmapCall(session, [
      ["Mailbox/query", { accountId: ctx.accountId, filter: { role } }, "q"],
    ])) as [[string, { ids?: string[] }]];
    const id = q.ids?.[0];
    if (!id) throw new AtomicMailError(`no ${role} mailbox`, 0);
    return id;
  }

  /** Draft + submit in one batch. Resolves to the submission id. */
  async send(session: AtomicMailSession, mail: SendMailInput, opts?: { signal?: AbortSignal }): Promise<string> {
    const ctx = await this.context(session);
    if (!ctx.draftsMailboxId) {
      ctx.draftsMailboxId = await this.mailboxId(session, "drafts").catch(() =>
        this.mailboxId(session, "inbox"),
      );
    }
    const identityId = await this.identityId(session);
    const responses = await this.jmapCall(
      session,
      buildSendBatch(ctx.accountId, ctx.address, ctx.draftsMailboxId, mail, identityId),
      opts?.signal,
    );
    return parseSendResult(responses);
  }

  /** The newest `limit` inbox messages, newest first. */
  async listInbox(
    session: AtomicMailSession,
    limit = 20,
    opts?: { signal?: AbortSignal },
  ): Promise<InboxMessage[]> {
    const ctx = await this.context(session);
    const inbox = await this.mailboxId(session, "inbox");
    return parseInboxList(
      await this.jmapCall(session, buildInboxBatch(ctx.accountId, inbox, limit), opts?.signal),
    );
  }
}
