import type {
  ApprovalGate,
  ApprovalGrantScope,
  ApprovalRequest,
} from "../../approval/index.js";
import {
  canGrantCategory,
  canGrantShape,
  excerptPreview,
  formatApprovalCategory,
  hiddenLinesNote,
  previewLines,
} from "../../approval/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";

import { withThread, type TelegramApi } from "./outbound-sender.js";

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

/** What a keyboard nobody waits on any more is edited to. */
const NO_LONGER_WAITING = "⏹ no longer waiting for an answer";

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
   * operator-supplied `callback_data` — see invariant 7.
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
 * 5. **Pending approvals outlive a reconnect.** The channel keeps one
 *    bridge across a poller it lost and the one that replaces it, and
 *    `rebind()` points it at the new bot: the keyboards are still in
 *    the chat, and their clicks now arrive through the new poller. When
 *    the channel gives up for good, `expireAll()` denies what is
 *    pending at once instead of leaving each turn to its timer.
 * 6. **A cut preview comes with the full command (ATO-876).** When the
 *    preview does not fit one message, every line of the preview is
 *    sent first, to the same chat and topic, as a `.txt` document, with
 *    the same control and bidi escaping as the prompt, and the prompt
 *    says so. If that upload fails the prompt says the full
 *    command could not be attached instead of dropping it silently.
 * 7. **A grant is re-checked, and the toast never overstates it.** The
 *    `s` row only appears for the narrow categories in
 *    `REMOTE_CATEGORY_GRANTS` (and only when `canGrantCategory` allows
 *    it); the `a` row only for a shell request whose shape is one
 *    binary that is not an interpreter (`offersShapeGrant`). But
 *    `callback_data` arrives from the operator's client and a keyboard
 *    can outlive the state it was built from, so the scope is checked
 *    again with the same two helpers against the retained request
 *    before it reaches the gate. A scope that does not apply degrades
 *    to a plain approval, and the toast, built from the request's own
 *    category/shape, then says "Approved" rather than announcing a
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
 *   in that window, `resolve` returns `false`: the toast says "Already
 *   resolved" (never "Approved" or a grant that was not recorded) and
 *   the keyboard is removed.
 *
 *   Fixing it requires a back-channel from `ApprovalGate` to its
 *   per-session handlers (an "external resolve" subscriber list) or
 *   per-dispatch abort signals plumbed into the bridge. ~30 LOC,
 *   non-invasive, scheduled for slice 3 alongside the live-control
 *   surface that is already going to touch this file.
 */
export class ApprovalBridge {
  /** Not readonly: `rebind()` swaps the bot and owner after a reconnect. */
  private deps: ApprovalBridgeDeps;
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
  async dispatch(
    request: ApprovalRequest,
    chatId: number,
    threadId?: number,
  ): Promise<void> {
    if (this.pending.has(request.approvalId)) {
      // Defensive: the gate enforces single-pending-per-session, so a
      // duplicate approvalId would be a runtime bug. Log and ignore.
      this.deps.logger.warn("telegram: duplicate approval dispatch", {
        approvalId: request.approvalId,
      });
      return;
    }
    // A cut preview: the full command goes first, as a file, so it sits
    // right above the prompt it belongs to and the prompt can say
    // whether it arrived.
    const attached = formatApprovalText(request, null).cut
      ? await this.attachFullCommand(request, chatId, threadId)
      : null;
    let messageId: number | null = null;
    try {
      const sent = await this.deps.api.sendMessage(
        chatId,
        formatApprovalText(
          request,
          attached === null
            ? null
            : attached
              ? FULL_COMMAND_ATTACHED_NOTE
              : FULL_COMMAND_MISSING_NOTE,
        ).text,
        withThread(
          { reply_markup: buildKeyboard(request) },
          threadId,
        ),
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
          automatic: true,
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
        automatic: true,
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
      // Stale button: the timer fired, the operator clicked twice, or
      // the process restarted and forgot it. Acknowledge so the spinner
      // dismisses, and take the dead buttons off the message they sit
      // on so they cannot be tapped again.
      await this.acknowledge(update.id, "Already resolved");
      if (update.message) {
        await this.editFinal(
          update.message.chat.id,
          update.message.message_id,
          NO_LONGER_WAITING,
        );
      }
      return;
    }

    pending.cancelTimer();
    this.pending.delete(approvalId);

    // Both grant buttons approve; only the scope differs, and only if
    // the retained request still supports it (invariant 7).
    const approved = kind !== "n";
    const grant = grantScope(kind, pending.request);

    const resolved = this.deps.approvals.resolve({
      approvalId,
      approved,
      grant,
      // A button carries no words of the user's, so a deny has no reason.
      ...(approved ? { reason: "telegram" } : {}),
    });

    if (!resolved) {
      // The gate no longer waits for this one (the turn was cancelled
      // or another surface answered first), so nothing ran and nothing
      // was granted. Say so, and take the dead buttons away.
      await this.acknowledge(update.id, "Already resolved");
      await this.editFinal(
        pending.chatId,
        pending.messageId,
        NO_LONGER_WAITING,
      );
      return;
    }
    await this.acknowledge(
      update.id,
      decisionToast(pending.request, approved, grant),
    );
    await this.editFinal(
      pending.chatId,
      pending.messageId,
      approved ? "✅ approved" : "❌ denied",
    );
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

  /**
   * Point the bridge at a reconnected bot. Pending approvals stay
   * pending -- their keyboards are still in the chat, and a click on
   * one now arrives through the new bot's poller, so it has to find
   * its approval here. The owner is re-read too: it may have changed
   * while the channel was down.
   */
  rebind(api: TelegramApi, ownerUserId: number | null): void {
    this.deps = { ...this.deps, api, ownerUserId };
  }

  /**
   * Deny every pending approval now, with `reason`. For a channel that
   * gave up (the token was rejected): no click can reach this bridge
   * again, so waiting out each timer would only hold the turns for
   * eight minutes. The keyboards are left as they are -- the bot that
   * could edit them is the one Telegram just refused.
   */
  expireAll(reason: string): void {
    const ids = [...this.pending.keys()];
    for (const state of this.pending.values()) state.cancelTimer();
    this.pending.clear();
    for (const approvalId of ids) {
      this.deps.approvals.resolve({ approvalId, approved: false, reason });
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Send the whole preview as a `.txt` document to the approval's own
   * chat and topic. The content is every line of `request.preview`, the
   * text the tool put up for approval, with the characters that could
   * rewrite the display (terminal controls, bidi overrides) escaped the
   * same way as in the prompt: a text viewer honours a right-to-left
   * override, so a raw copy could show the hidden lines in a different
   * order than they run. Returns whether it was delivered; a failure is
   * logged and reported in the prompt, never fatal.
   */
  private async attachFullCommand(
    request: ApprovalRequest,
    chatId: number,
    threadId?: number,
  ): Promise<boolean> {
    const preview = request.preview ?? "";
    const send = this.deps.api.sendTextDocument;
    if (!send) {
      this.deps.logger.warn("telegram: cannot attach full approval command", {
        approvalId: request.approvalId,
        error: "this bot cannot upload documents",
      });
      return false;
    }
    const visible = previewLines(preview);
    const lines = visible.length;
    try {
      await send.call(this.deps.api, chatId, {
        filename: FULL_COMMAND_FILENAME,
        content: visible.join("\n"),
        caption: `Full command (${lines} ${lines === 1 ? "line" : "lines"}), for the approval below`,
        ...(threadId === undefined ? {} : { threadId }),
      });
      return true;
    } catch (err) {
      this.deps.logger.warn("telegram: failed to attach full approval command", {
        approvalId: request.approvalId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
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
        reason: "the approval prompt timed out with no answer",
        automatic: true,
      });
      if (resolved) {
        void this.editFinal(chatId, messageId, "⏱ timed out — auto-denied");
      }
    };
    if (this.deps.schedule) return this.deps.schedule(fire, this.timeoutMs);
    const handle = setTimeout(fire, this.timeoutMs);
    // A pending approval must never be what keeps a shutting-down
    // process alive for eight minutes.
    handle.unref?.();
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
  if (kind === "s" && offersCategoryGrant(request)) return "category";
  if (kind === "a" && offersShapeGrant(request)) return "shape";
  return undefined;
}

/**
 * The only categories a remote chat may grant for the whole session.
 * Each is narrow enough that "yes for the rest of this session" means
 * one kind of thing: remote git sync, reading outside the working
 * directory, publishing. Everything else (shell, skill scripts, process
 * kill, HTTP, MCP tools under `other`, ...) is approved per request from
 * Telegram, with at most a command-shape grant for shell. The TUI, CLI
 * and desktop keep their own wider offer.
 */
const REMOTE_CATEGORY_GRANTS: ReadonlySet<ApprovalRequest["category"]> =
  new Set(["git_remote", "fs_read_outside", "publish"]);

/**
 * Interpreters whose danger lives in their arguments (`python3 -c …`,
 * `node script.js`): a shape grant on one would silence arbitrary code
 * for the rest of the session. The shell tool already withholds the
 * shape for shells and wrappers (`bash`, `env`, `sudo`, ...); this list
 * covers the script runtimes it still offers, and repeats the shells so
 * this surface does not depend on that list staying complete.
 */
const REMOTE_NO_SHAPE_GRANT: ReadonlySet<string> = new Set([
  "python",
  "python3",
  "node",
  "perl",
  "ruby",
  "bash",
  "sh",
  "zsh",
  "deno",
  "bun",
  "osascript",
  "powershell",
  "pwsh",
]);

/** Whether the keyboard offers "grant this category for the session". */
function offersCategoryGrant(request: ApprovalRequest): boolean {
  return (
    REMOTE_CATEGORY_GRANTS.has(request.category) && canGrantCategory(request)
  );
}

/**
 * Whether the keyboard offers "grant this command for the session": a
 * shell request with a shape (one binary, never a compound line), and
 * that binary is not an interpreter. `python3.12` and `node.exe` count
 * as their interpreter.
 */
function offersShapeGrant(request: ApprovalRequest): boolean {
  if (!canGrantShape(request) || !request.commandShape) return false;
  const bin = request.commandShape
    .toLowerCase()
    .replace(/\.exe$/, "")
    .replace(/[\d.]+$/, "");
  return !REMOTE_NO_SHAPE_GRANT.has(bin);
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
  if (offersCategoryGrant(request)) {
    rows.push([
      {
        text: `🔓 Grant ${formatApprovalCategory(request.category)} for session`,
        callback_data: `${CALLBACK_PREFIX}${request.approvalId}:s`,
      },
    ]);
  }
  if (offersShapeGrant(request) && request.commandShape) {
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
 * Telegram caps one `sendMessage` at 4096 UTF-16 units, and a failed
 * send auto-denies the request. The approval text stays under this,
 * with headroom, by cutting the preview (ATO-434).
 */
const APPROVAL_MESSAGE_MAX_CHARS = 4000;

/** Indent of each preview line. */
const PREVIEW_INDENT = "  ";

/** Name of the document that carries a cut preview in full (ATO-876). */
const FULL_COMMAND_FILENAME = "full-command.txt";

/** Under a cut preview whose full text was delivered as a file. */
const FULL_COMMAND_ATTACHED_NOTE = "full command: sent as a file above";

/**
 * Under a cut preview whose file failed to send: the person must know
 * the rest exists and that they have not seen it.
 */
const FULL_COMMAND_MISSING_NOTE =
  "full command: could not be attached, deny if you cannot check it";

/**
 * Render an `ApprovalRequest` as plain text. We deliberately do not
 * use Telegram's MarkdownV2 — escaping rules around backticks /
 * underscores in tool names and previews are easy to get wrong, and
 * a corrupted Markdown payload breaks the prompt. Plain text is
 * unambiguous; it just renders without a fixed-width preview block.
 *
 * Every preview line is shown while the message fits. A preview too
 * long for one message keeps whole lines from the top and ends with
 * "+N more lines", so the person approving knows the command goes on;
 * before, an oversized message simply failed and the request was denied.
 *
 * `cut` says whether any of the preview was left out. `attachNote`, when
 * given, goes under the cut preview and says whether the full command
 * was sent as a file (ATO-876).
 */
function formatApprovalText(
  req: ApprovalRequest,
  attachNote: string | null,
): { text: string; cut: boolean } {
  const head: string[] = [
    "Approval requested",
    `tool: ${req.tool}`,
    `kind: ${formatApprovalCategory(req.category)}`,
  ];
  if (req.reason) head.push(`reason: ${req.reason}`);
  const tail: string[] = [];
  if (req.affectedResources && req.affectedResources.length > 0) {
    tail.push("resources:");
    for (const r of req.affectedResources) tail.push(`- ${r}`);
  }
  const lines = [...head];
  let cut = false;
  if (req.preview) {
    lines.push("preview:");
    // What is left for the preview once everything else is counted,
    // including a newline before each line and its indent, and room
    // for the note. Never below a few lines' worth, so a very long
    // reason cannot squeeze the command out entirely.
    const fixed = [...lines, ...tail].join("\n").length;
    const roomForNote =
      40 +
      (attachNote === null ? 0 : PREVIEW_INDENT.length + attachNote.length + 1);
    const budget = Math.max(
      400,
      APPROVAL_MESSAGE_MAX_CHARS - fixed - roomForNote,
    );
    const indented = req.preview
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => `${PREVIEW_INDENT}${line}`)
      .join("\n");
    const excerpt = excerptPreview(indented, {
      maxLines: Number.POSITIVE_INFINITY,
      // `+1` for the newline that joins the preview to `preview:`.
      maxChars: budget - 1,
    });
    lines.push(...excerpt.lines);
    const note = hiddenLinesNote(excerpt.hiddenLines, excerpt.cutChars);
    if (note !== null) {
      cut = true;
      lines.push(`${PREVIEW_INDENT}${note}`);
      if (attachNote !== null) lines.push(`${PREVIEW_INDENT}${attachNote}`);
    }
  }
  lines.push(...tail);
  const text = lines.join("\n");
  // Last guard for what the preview budget cannot cover (a reason or a
  // resource list that alone is past the limit): a cut message is
  // still a prompt the person can answer; an oversized one is a denial.
  return {
    text:
      text.length <= APPROVAL_MESSAGE_MAX_CHARS
        ? text
        : `${text.slice(0, APPROVAL_MESSAGE_MAX_CHARS - 1)}…`,
    cut,
  };
}
