import type { ApprovalGate, ApprovalGrantScope, ApprovalRequest } from "../../approval/index.js";
import { canGrantCategory, canGrantShape, formatApprovalCategory } from "../../approval/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";

import type { TelegramApi } from "./outbound-sender.js";

/**
 * Default auto-deny window for an approval delivered to Telegram.
 * The design memo (`atomic-telegram.md` §6) calls out 8 minutes as
 * the only away-from-keyboard policy. Tests inject a smaller value
 * via `ApprovalBridgeDeps.timeoutMs` to keep wall-clock cheap.
 */
const APPROVAL_TIMEOUT_MS_DEFAULT = 8 * 60 * 1000;

/**
 * Inline-keyboard `callback_data` prefix. Keeps the wire format
 * compact (Telegram caps `callback_data` at 64 bytes) and
 * unambiguous: any data string that does not start with this prefix
 * belongs to a different feature and is dropped on receipt.
 */
const CALLBACK_PREFIX = "appr:";

/**
 * Longest `commandShape` rendered into a button label or a toast. Real
 * shapes are argv[0] basenames (`git`, `npm`), but nothing upstream
 * bounds the field. An oversize `reply_markup` is rejected by Telegram,
 * and `dispatch` turns a send failure into an auto-deny — so an
 * unbounded label could deny an approval the operator never saw.
 */
const SHAPE_LABEL_MAX = 32;

/** The four button kinds encoded in `callback_data`. */
type CallbackKind = "y" | "n" | "s" | "a";

/**
 * Narrow shape of a `callback_query` update consumed by the bridge.
 * The grammy adapter projects the real grammy `Context` onto this
 * shape; tests fabricate updates directly so they never need to
 * import grammy's type tree.
 */
export interface InboundCallbackUpdate {
  /** Telegram's id for the callback_query — passed back to `answerCallbackQuery`. */
  id: string;
  /** Sender. Used for the owner check. */
  from?: { id: number };
  /** Original message that hosted the inline keyboard. */
  message?: { chat: { id: number }; message_id: number };
  /** Verbatim `callback_data` payload from the inline button. */
  data?: string;
}

export interface ApprovalBridgeDeps {
  api: TelegramApi;
  /**
   * The bridge only ever resolves the gate; it never requests a new
   * approval. `Pick<ApprovalGate, "resolve">` makes that explicit and
   * keeps the test-time mock surface small.
   */
  approvals: Pick<ApprovalGate, "resolve">;
  /**
   * Owner check applied to every callback_query. `null` is a fail-
   * closed configuration: every callback is dropped silently. This
   * mirrors the inbound text owner check.
   */
  ownerUserId: number | null;
  logger: StructuredLogger;
  /** Test seam — replaces `setTimeout` with a controllable scheduler. */
  schedule?: (cb: () => void, ms: number) => () => void;
  /** Test seam — override the default 8-minute auto-deny window. */
  timeoutMs?: number;
}

interface PendingState {
  chatId: number;
  messageId: number;
  /**
   * The request the keyboard was built from. Retained so a decision is
   * checked and described against the real request instead of the
   * operator-supplied `callback_data` — see invariant 5.
   */
  request: ApprovalRequest;
  cancelTimer: () => void;
}

/**
 * Per-channel bridge that turns an `ApprovalRequest` into an
 * inline-keyboard message and routes the operator's reply back to
 * `ApprovalGate.resolve`. The bridge owns:
 *
 *  - one outbound message per pending approval (sent via `dispatch`);
 *  - one auto-deny timer per pending approval (default 8 min);
 *  - the `callback_query` parser that decodes `appr:<id>:y|n|s|a`.
 *
 * Locked invariants — pinned by the colocated test file:
 *
 * 1. **Owner-only callbacks.** Non-owner `callback_query` updates are
 *    dropped silently — no `answerCallbackQuery`, no `resolve`. This
 *    avoids leaking pairing-shaped signals to a stranger who clicked
 *    a forwarded button.
 * 2. **Single resolution per approvalId.** Whichever path completes
 *    first (button vs timeout) cancels the other before calling
 *    `resolve`. A late-arriving stale button is acknowledged ("Already
 *    resolved.") but never resolves a second time.
 * 3. **Send failure auto-denies immediately.** If `sendMessage`
 *    rejects, the operator cannot reply; the bridge resolves with
 *    `approved: false, reason: "telegram delivery failed"` so the
 *    gated turn does not block forever.
 * 4. **`cancelAll()` does not resolve the gate.** Channel shutdown
 *    cancels every timer and clears local state — gate resolution for
 *    in-flight approvals comes from the caller's own abort signal
 *    (`runtime.shutdown()` aborts every in-flight turn, which aborts
 *    the gate via `ApprovalGate`'s `signal` parameter).
 * 5. **A grant is re-checked, and the toast never overstates it.** The
 *    `s`/`a` rows only appear when `canGrantCategory` / `canGrantShape`
 *    allow them, but `callback_data` arrives from the operator's client
 *    and a keyboard can outlive the state it was built from — so the
 *    scope is checked again against the retained request before it
 *    reaches the gate, exactly as the TUI and CLI prompts do. A scope
 *    that no longer applies degrades to a plain approval: the gate
 *    would drop it anyway (`recordGrant` refuses `trust_config` and a
 *    shapeless shell request), and the toast, built from the request's
 *    own category/shape, then says "Approved" rather than announcing a
 *    standing exception that does not exist.
 *
 * Known UX gap (non-functional, deferred to slice 3):
 *
 *   When a turn is aborted *externally* while an approval is pending
 *   — the canonical case is `/cancel` typed by the operator, which
 *   triggers the per-turn `AbortController` — the gate clears its own
 *   `pending` entry via its `signal` listener and rejects the request
 *   promise. The agent loop unwinds normally. **The bridge, however,
 *   never sees the abort**: it has no back-channel from the gate. So
 *   the `pending` entry on this bridge stays alive, the 8-min timer
 *   keeps running, and the inline-keyboard message lingers in the
 *   chat until the timer naturally fires. When it does, `gate.resolve`
 *   returns `false` (gate already cleared), `editFinal` is skipped on
 *   purpose, and bridge state is cleaned up. So the lingering keyboard
 *   is a UX wart — *not* a leak (timer eventually fires, frees state),
 *   *not* a double-resolve (gate dedupes), *not* a state desync (bridge
 *   tears itself down on fire). If the operator clicks a stale button
 *   in that window, the spinner toast says "Approved" / "Denied" even
 *   though the action did not run — also a UX wart.
 *
 *   Fixing it requires a back-channel from `ApprovalGate` to its
 *   per-session handlers (an "external resolve" subscriber list) or
 *   per-dispatch abort signals plumbed into the bridge. ~30 LOC,
 *   non-invasive, scheduled for slice 3 alongside the live-control
 *   surface that is already going to touch this file.
 */
export class ApprovalBridge {
  private readonly deps: ApprovalBridgeDeps;
  private readonly pending = new Map<string, PendingState>();
  private readonly timeoutMs: number;

  constructor(deps: ApprovalBridgeDeps) {
    this.deps = deps;
    this.timeoutMs = deps.timeoutMs ?? APPROVAL_TIMEOUT_MS_DEFAULT;
  }

  /**
   * Send the approval prompt for `request` to `chatId`. Caller (the
   * inbound handler) is responsible for picking the correct chat —
   * the bridge does not own a chat reference itself because a future
   * Slack-style channel would resolve the same way (channel id, not
   * chat id) and the dispatch shape stays clean.
   */
  async dispatch(request: ApprovalRequest, chatId: number): Promise<void> {
    if (this.pending.has(request.approvalId)) {
      // Defensive: the gate enforces single-pending-per-session, so a
      // duplicate approvalId would be a runtime bug. Log and ignore.
      this.deps.logger.warn("telegram: duplicate approval dispatch", {
        approvalId: request.approvalId,
      });
      return;
    }
    let messageId: number | null = null;
    try {
      const sent = await this.deps.api.sendMessage(
        chatId,
        formatApprovalText(request),
        { reply_markup: buildKeyboard(request) },
      );
      const id = (sent as { message_id?: number } | null)?.message_id;
      if (typeof id !== "number") {
        this.deps.logger.warn("telegram: approval message missing message_id", {
          approvalId: request.approvalId,
        });
        this.deps.approvals.resolve({
          approvalId: request.approvalId,
          approved: false,
          reason: "telegram delivery failed",
        });
        return;
      }
      messageId = id;
    } catch (err) {
      this.deps.logger.warn("telegram: failed to send approval prompt", {
        approvalId: request.approvalId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.deps.approvals.resolve({
        approvalId: request.approvalId,
        approved: false,
        reason: "telegram delivery failed",
      });
      return;
    }
    const cancelTimer = this.scheduleTimeout(
      request.approvalId,
      chatId,
      messageId,
    );
    this.pending.set(request.approvalId, {
      chatId,
      messageId,
      request,
      cancelTimer,
    });
  }

  /**
   * Process one `callback_query` update. Validates owner, parses the
   * payload, resolves the gate and edits the original message to
   * reflect the decision. Drops malformed or unauthorised callbacks
   * silently.
   */
  async handleCallback(update: InboundCallbackUpdate): Promise<void> {
    const fromId = update.from?.id;
    if (typeof fromId !== "number") return;
    if (this.deps.ownerUserId === null || fromId !== this.deps.ownerUserId) {
      this.deps.logger.warn("telegram: dropping non-owner callback_query", {
        fromId,
      });
      return;
    }
    const data = update.data;
    if (typeof data !== "string" || !data.startsWith(CALLBACK_PREFIX)) return;
    const parts = data.slice(CALLBACK_PREFIX.length).split(":");
    if (parts.length !== 2) return;
    const [approvalId, kind] = parts;
    if (!approvalId || (kind !== "y" && kind !== "n" && kind !== "s" && kind !== "a")) return;

    const pending = this.pending.get(approvalId);
    if (!pending) {
      // Stale button — the timer fired (or the operator clicked twice
      // in quick succession). Acknowledge so the spinner dismisses.
      await this.acknowledge(update.id, "Already resolved");
      return;
    }

    pending.cancelTimer();
    this.pending.delete(approvalId);

    // Both grant buttons approve; only the scope differs, and only if
    // the retained request still supports it (invariant 5).
    const approved = kind !== "n";
    const grant = grantScope(kind, pending.request);

    const resolved = this.deps.approvals.resolve({
      approvalId,
      approved,
      grant,
      reason: "telegram",
    });

    await this.acknowledge(
      update.id,
      decisionToast(pending.request, approved, grant),
    );
    if (resolved) {
      await this.editFinal(
        pending.chatId,
        pending.messageId,
        approved ? "✅ approved" : "❌ denied",
      );
    }
  }

  /**
   * Cancel every outstanding timer and forget every pending state.
   * Does NOT call `approvals.resolve` — gate resolution for any
   * still-pending approval comes from the caller's own abort signal.
   */
  cancelAll(): void {
    for (const state of this.pending.values()) {
      state.cancelTimer();
    }
    this.pending.clear();
  }

  pendingCount(): number {
    return this.pending.size;
  }

  private scheduleTimeout(
    approvalId: string,
    chatId: number,
    messageId: number,
  ): () => void {
    const fire = (): void => {
      // Re-check pending — a button click may have run between
      // schedule and timer fire on a stalled event loop.
      if (!this.pending.has(approvalId)) return;
      this.pending.delete(approvalId);
      const resolved = this.deps.approvals.resolve({
        approvalId,
        approved: false,
        reason: "timeout",
      });
      if (resolved) {
        void this.editFinal(
          chatId,
          messageId,
          "⏱ timed out — auto-denied",
        );
      }
    };
    if (this.deps.schedule) return this.deps.schedule(fire, this.timeoutMs);
    const handle = setTimeout(fire, this.timeoutMs);
    return () => clearTimeout(handle);
  }

  private async acknowledge(
    callbackQueryId: string,
    text: string,
  ): Promise<void> {
    if (!this.deps.api.answerCallbackQuery) return;
    try {
      await this.deps.api.answerCallbackQuery(callbackQueryId, { text });
    } catch (err) {
      this.deps.logger.warn("telegram: answerCallbackQuery failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async editFinal(
    chatId: number,
    messageId: number,
    text: string,
  ): Promise<void> {
    if (!this.deps.api.editMessageText) return;
    try {
      await this.deps.api.editMessageText(chatId, messageId, text, {
        reply_markup: { inline_keyboard: [] },
      });
    } catch (err) {
      this.deps.logger.warn("telegram: editMessageText failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * The scope a callback kind asks for, or `undefined` when this request
 * cannot carry it. `y`/`n` never grant; `s`/`a` grant only what the
 * keyboard was entitled to offer.
 */
function grantScope(
  kind: CallbackKind,
  request: ApprovalRequest,
): ApprovalGrantScope | undefined {
  if (kind === "s" && canGrantCategory(request)) return "category";
  if (kind === "a" && canGrantShape(request)) return "shape";
  return undefined;
}

/**
 * Text for the button's spinner toast — the one surface that tells the
 * operator what they just authorised, so it names the grant that was
 * actually recorded and stays silent when none was.
 */
function decisionToast(
  request: ApprovalRequest,
  approved: boolean,
  grant: ApprovalGrantScope | undefined,
): string {
  if (!approved) return "Denied";
  if (!grant) return "Approved";
  const subject =
    grant === "shape" && request.commandShape
      ? `"${shapeLabel(request.commandShape)}"`
      : formatApprovalCategory(request.category);
  return `Approved (${subject} granted for session)`;
}

/** `commandShape` clipped to something a narrow client can render. */
function shapeLabel(shape: string): string {
  return shape.length <= SHAPE_LABEL_MAX
    ? shape
    : `${shape.slice(0, SHAPE_LABEL_MAX - 1)}…`;
}

function buildKeyboard(request: ApprovalRequest): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [
    [
      {
        text: "✅ Approve",
        callback_data: `${CALLBACK_PREFIX}${request.approvalId}:y`,
      },
      {
        text: "❌ Deny",
        callback_data: `${CALLBACK_PREFIX}${request.approvalId}:n`,
      },
    ],
  ];
  if (canGrantCategory(request)) {
    rows.push([
      {
        text: "🔓 Grant category for session",
        callback_data: `${CALLBACK_PREFIX}${request.approvalId}:s`,
      },
    ]);
  }
  if (canGrantShape(request) && request.commandShape) {
    rows.push([
      {
        text: `🔓 Grant "${shapeLabel(request.commandShape)}" for session`,
        callback_data: `${CALLBACK_PREFIX}${request.approvalId}:a`,
      },
    ]);
  }
  return { inline_keyboard: rows };
}

/**
 * Render an `ApprovalRequest` as plain text. We deliberately do not
 * use Telegram's MarkdownV2 — escaping rules around backticks /
 * underscores in tool names and previews are easy to get wrong, and
 * a corrupted Markdown payload breaks the prompt. Plain text is
 * unambiguous; it just renders without a fixed-width preview block.
 */
function formatApprovalText(req: ApprovalRequest): string {
  const lines: string[] = [
    "Approval requested",
    `tool: ${req.tool}`,
    `kind: ${formatApprovalCategory(req.category)}`,
  ];
  if (req.reason) lines.push(`reason: ${req.reason}`);
  if (req.preview) {
    lines.push("preview:");
    for (const previewLine of req.preview.split("\n")) {
      lines.push(`  ${previewLine}`);
    }
  }
  if (req.affectedResources && req.affectedResources.length > 0) {
    lines.push("resources:");
    for (const r of req.affectedResources) lines.push(`- ${r}`);
  }
  return lines.join("\n");
}
