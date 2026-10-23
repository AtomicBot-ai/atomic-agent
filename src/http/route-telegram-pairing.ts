import {
  DEFAULT_PAIRING_TIMEOUT_MS,
  OwnerAlreadyPairedError,
  pairedOwnerLine,
  pairingInstruction,
  type OpenedPairingWindow,
  type PairingOutcome,
  type TelegramChannel,
} from "../channels/telegram/index.js";
import { openaiError } from "./openai-errors.js";
import {
  readJsonBody,
  sendError,
  sendJson,
  type HandlerContext,
  type HttpHandler,
} from "./request-context.js";

/**
 * `POST`, `GET` and `DELETE /api/telegram/pairing`: Telegram pairing for
 * an HTTP client (the desktop app), the way the TUI pairs (ATO-718,
 * ATO-859).
 *
 * - `POST` opens a window through `TelegramChannel.startPairing` and
 *   answers with the one-time code. This response is the only place the
 *   code ever leaves the process: it is not logged, not stored here and
 *   not part of the `GET` snapshot. While an owner is paired the POST is
 *   refused with `409 owner_already_paired` until the caller repeats it
 *   with `{ "replaceOwner": true }`, the operator's confirmation.
 * - `GET` reads where the last window stands: `waiting`, `claimed` (with
 *   the new owner's @username and the "Paired: ..." line), `expired`,
 *   `cancelled`, `failed`, or `idle` when none was opened.
 * - `DELETE` cancels an open window.
 */
export type PairingStatus =
  | "idle"
  | "waiting"
  | "claimed"
  | "expired"
  | "cancelled"
  | "failed";

interface Tracked {
  status: PairingStatus;
  expiresAt: number | null;
  owner: { userId: number; username: string | null } | null;
  welcomeDelivered: boolean | null;
  error: string | null;
}

const IDLE: Tracked = {
  status: "idle",
  expiresAt: null,
  owner: null,
  welcomeDelivered: null,
  error: null,
};

export interface TelegramPairingHandlers {
  readonly start: HttpHandler;
  readonly status: HttpHandler;
  readonly cancel: HttpHandler;
}

function channelOf(ctx: HandlerContext): TelegramChannel | null {
  return ctx.runtime.telegramChannel ?? null;
}

function unavailable(res: Parameters<HttpHandler>[1]): void {
  sendError(
    res,
    503,
    openaiError(
      "Telegram is not available in this agent",
      "service_unavailable",
      null,
      "telegram_unavailable",
    ),
  );
}

function notRunning(
  res: Parameters<HttpHandler>[1],
  channel: TelegramChannel,
): void {
  const lastError = channel.lastError();
  sendError(
    res,
    409,
    openaiError(
      `Telegram is not running (state: ${channel.state()}${lastError ? `, ${lastError}` : ""}). Add a bot token, turn Telegram on and restart the agent, then pair.`,
      "invalid_request_error",
      null,
      "telegram_not_running",
    ),
  );
}

function ownerPaired(res: Parameters<HttpHandler>[1]): void {
  sendError(
    res,
    409,
    openaiError(
      "This bot already has an owner. Send replaceOwner: true to confirm replacing them.",
      "invalid_request_error",
      "replaceOwner",
      "owner_already_paired",
    ),
  );
}

/**
 * One closure for the three handlers: the last window's outcome is
 * per-process state, created once in `buildRouteTable` (a module-level
 * `let` would leak between servers inside one vitest worker).
 */
export function createTelegramPairingHandlers(): TelegramPairingHandlers {
  let tracked: Tracked = IDLE;
  /** Bumped per opened window, so a superseded window's late outcome is dropped. */
  let generation = 0;

  const snapshot = (channel: TelegramChannel) => {
    const live = channel.pairingState();
    // A window this route did not open (the TUI in the same process)
    // still reads as waiting; its code stays where it was shown.
    const status: PairingStatus =
      live.active && tracked.status !== "waiting" ? "waiting" : tracked.status;
    const owner = status === "claimed" ? tracked.owner : null;
    return {
      status,
      channelState: channel.state(),
      botUsername: channel.getBotIdentity()?.username ?? null,
      ownerUserId: channel.getOwnerUserId(),
      expiresAt: status === "waiting" ? (live.expiresAt ?? tracked.expiresAt) : null,
      owner,
      pairedLine: owner ? pairedOwnerLine(owner) : null,
      welcomeDelivered: status === "claimed" ? tracked.welcomeDelivered : null,
      error: status === "failed" ? tracked.error : null,
    };
  };

  const settle = (mine: number, outcome: PairingOutcome | null): void => {
    if (mine !== generation) return;
    if (outcome) {
      tracked = {
        status: "claimed",
        expiresAt: null,
        owner: {
          userId: outcome.claim.userId,
          username: outcome.claim.username,
        },
        welcomeDelivered: outcome.welcomeDelivered,
        error: null,
      };
      return;
    }
    tracked = {
      ...IDLE,
      status: tracked.status === "cancelled" ? "cancelled" : "expired",
    };
  };

  const start: HttpHandler = async (req, res, ctx) => {
    const channel = channelOf(ctx);
    if (!channel) {
      unavailable(res);
      return;
    }
    let body: { replaceOwner?: unknown };
    try {
      body = await readJsonBody<{ replaceOwner?: unknown }>(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, openaiError(`Invalid JSON: ${message}`));
      return;
    }
    if (body.replaceOwner !== undefined && typeof body.replaceOwner !== "boolean") {
      sendError(res, 400, openaiError("replaceOwner must be a boolean", "invalid_request_error", "replaceOwner"));
      return;
    }
    const replaceOwner = body.replaceOwner === true;
    if (channel.state() !== "up") {
      notRunning(res, channel);
      return;
    }
    if (channel.getOwnerUserId() !== null && !replaceOwner) {
      ownerPaired(res);
      return;
    }

    let opened: OpenedPairingWindow | null = null;
    const outcome = channel.startPairing(undefined, {
      replaceOwner,
      onOpened: (w) => {
        opened = w;
      },
    });
    // `onOpened` runs synchronously inside `startPairing` when a window
    // opens; without it the call refused (raced to down, or an owner
    // appeared), and its settled value says which.
    const openedWindow = opened as OpenedPairingWindow | null;
    if (!openedWindow) {
      try {
        await outcome;
        notRunning(res, channel);
      } catch (err) {
        if (err instanceof OwnerAlreadyPairedError) ownerPaired(res);
        else sendError(res, 500, openaiError(err instanceof Error ? err.message : String(err), "server_error"));
      }
      return;
    }

    // Counted only once a window opened: a refused POST must not orphan
    // the outcome of a window that is still open.
    const mine = ++generation;
    tracked = { ...IDLE, status: "waiting", expiresAt: openedWindow.expiresAt };
    outcome.then(
      (result) => settle(mine, result),
      (err: unknown) => {
        if (mine !== generation) return;
        tracked = {
          ...IDLE,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        };
      },
    );

    const botUsername = channel.getBotIdentity()?.username ?? null;
    // The code goes to this caller only. `no-store` keeps it out of any
    // cache between the agent and the screen that shows it.
    sendJson(
      res,
      200,
      {
        status: "waiting",
        code: openedWindow.code,
        expiresAt: openedWindow.expiresAt,
        timeoutMs: DEFAULT_PAIRING_TIMEOUT_MS,
        botUsername,
        instruction: pairingInstruction({
          code: openedWindow.code,
          botUsername,
          timeoutMs: DEFAULT_PAIRING_TIMEOUT_MS,
        }),
      },
      { "cache-control": "no-store" },
    );
  };

  const status: HttpHandler = async (_req, res, ctx) => {
    const channel = channelOf(ctx);
    if (!channel) {
      unavailable(res);
      return;
    }
    sendJson(res, 200, snapshot(channel));
  };

  const cancel: HttpHandler = async (_req, res, ctx) => {
    const channel = channelOf(ctx);
    if (!channel) {
      unavailable(res);
      return;
    }
    // Marked first: the window's `null` outcome then settles as
    // `cancelled`, not `expired`.
    if (tracked.status === "waiting") tracked = { ...IDLE, status: "cancelled" };
    channel.cancelPairing();
    sendJson(res, 200, snapshot(channel));
  };

  return { start, status, cancel };
}
