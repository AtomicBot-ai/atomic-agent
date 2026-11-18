import { compressToolResult, type CompressedToolResult } from "../../compressor/result-compressor.js";
import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import type { ToolContext } from "../tool-registry.js";
import { BROWSER_PAGE_SOURCE, frameUntrustedText } from "../untrusted-tool-output.js";
import type { BrowserBackend } from "./browser-backend.js";
import {
  blockedDomainMessage,
  checkBrowserHost,
  webHostOf,
  type BrowserDomainPolicy,
} from "./browser-domain-policy.js";
import { readAriaView, type AriaSnapshotStore } from "./aria-view.js";
import { currentBrowserScope } from "./browser-run-scope.js";

/**
 * Take over (ATO-508): the agent hands the browser to the person for one
 * step it should not or cannot do itself (log in, enter a password or a
 * one-time code, solve a captcha), waits, and reads the page again when
 * the person hands it back. Modelled on OpenWork's browser task (the
 * agent asks to "Take over", the run pauses, the user acts and presses
 * Resume) and on the "take control" of Claude's and ChatGPT's agent modes.
 *
 * `browser.act { action: "take_over", reason }`:
 *  1. the calling session's tab is made visible: the agent's own headless
 *     Chrome is restarted with a window, the tab is brought to the front
 *     (`BrowserBackend.prepareTakeOver`); the user's own Chrome is used
 *     as it is;
 *  2. the turn blocks on a `browser_take_over` approval, so every surface
 *     that shows approvals (the TUI, the desktop app, Telegram) shows it.
 *     Allow is Continue, Deny is Stop. The category is never answered by
 *     a level (bypass included), a session grant, a saved rule or the
 *     risk reviewer (`approval-level.ts`): only a person says "done";
 *  3. Continue: the page is read again (the compact `interactive` view,
 *     into `### world`, through the same page-read check as `read_aria`)
 *     so the model sees what the person did. Stop: the model is told the
 *     person stopped and not to retry or do the step itself.
 *
 * Nobody to hand to (a fusion worker, a session whose prompts are
 * refused, a Chrome forced headless, a gate that does not ask) returns
 * at once and says so; it never pretends the person did the step.
 */

const TOOL = "browser.act";
export const TAKE_OVER_ACTION = "take_over";
export const TAKE_OVER_REASON_MAX = 300;

type Ctx = Pick<ToolContext, "sessionId" | "signal" | "modelMode" | "contextWindowTokens">;

/** What the person should do, from the model's `reason`; throws a fix the model can act on. */
export function parseTakeOverReason(args: Record<string, unknown>): string {
  const raw = args.reason ?? args.text;
  const reason = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (reason.length === 0) {
    throw new Error(
      `${TOOL}: \`take_over\` needs \`reason\`: what the user should do in the browser, e.g. "log in to example.com" or "solve the captcha"`,
    );
  }
  const clipped = reason.length > TAKE_OVER_REASON_MAX ? `${reason.slice(0, TAKE_OVER_REASON_MAX - 1)}…` : reason;
  // The prompt adds its own full stop.
  return clipped.replace(/[.!\s]+$/, "");
}

const NOBODY =
  "Nobody can take over the browser right now, so the step was not done. " +
  "Do not ask again this turn and do not do the step yourself (no typing of passwords or codes); " +
  "tell the user which step needs them in the browser and stop there.";

const STOPPED =
  "The user stopped the take-over: the step was not done. This was their decision. " +
  "Do not ask again or try to do the step yourself; tell the user it was not done and ask what they would like instead.";

function result(status: "ok" | "error", output: string, details: Record<string, unknown>): CompressedToolResult {
  return compressToolResult({ tool: TOOL, status, output, details: { action: TAKE_OVER_ACTION, ...details } });
}

/**
 * Not handed back. `approvalDenied` stops the browser calls queued after
 * this one in the same batch (`wasNotApproved`, batch-scheduler.ts): a
 * click or a type planned for "after the login" must not run.
 */
function notHandedBack(output: string, reason: string): CompressedToolResult {
  return result("error", output, { handedBack: false, approvalDenied: true, reason });
}

function nobody(why: string, reason: string): CompressedToolResult {
  return notHandedBack(`${NOBODY} (${why})`, reason);
}

export async function runTakeOver(
  backend: BrowserBackend,
  dangerous: DangerousToolOptions,
  policy: BrowserDomainPolicy,
  store: AriaSnapshotStore,
  rawArgs: Record<string, unknown>,
  ctx: Ctx,
): Promise<CompressedToolResult> {
  const reason = parseTakeOverReason(rawArgs);
  // A worker's prompts go nowhere, and restarting Chrome for one would
  // close the other workers' pages.
  if (currentBrowserScope()?.workerOf !== undefined) {
    return nobody("a fusion worker cannot hand the browser to the user; report the step to the orchestrator", "worker");
  }
  // The test seam that skips the gate: there is no person behind it.
  if (!dangerous.approvalRequired) return nobody("no approval prompt is wired up", "no_prompt");
  await backend.ensureReady();
  if (backend.prepareTakeOver === undefined) {
    return result("error", `${TOOL}: take_over is not supported by this browser backend`, { reason: "unsupported" });
  }
  const before = webHostOf(await backend.currentUrl().catch(() => ""));
  if (before !== null && checkBrowserHost(before, policy).kind === "blocked") {
    return result("error", blockedDomainMessage(TOOL, before), { host: before, reason: "blocked_domain" });
  }
  const target = await backend.prepareTakeOver();
  if (!target.window) {
    if (target.why === "temp_profile") {
      return nobody(
        "this chat browses in a throwaway profile in a browser without a window; opening a window restarts the browser and would lose this page. Switch to the agent profile (browser.tabs new with profile agent) and open the page again, or ask the user to do the step in their own browser",
        "temp_profile",
      );
    }
    return nobody("the browser runs without a window (browser.headless is true)", "no_window");
  }
  const host = webHostOf(target.url);
  const where = policy.userProfile === true ? "the agent's tab in your Chrome" : "the agent's browser window";
  const decision = await dangerous.approvals.request(
    {
      sessionId: ctx.sessionId,
      tool: TOOL,
      category: "browser_take_over",
      reason: `Take over: ${reason}. Do it in the browser window, then answer Continue.`,
      preview: [
        `Your turn in ${where}: ${host ?? target.url}`,
        "Continue (Allow): you are done; the agent reads the page again and goes on.",
        "Stop (Deny): the agent stops this step.",
        "The agent does not touch the page until you answer.",
      ].join("\n"),
      ...(host !== null ? { affectedResources: [host] } : {}),
    },
    { signal: ctx.signal },
  );
  if (!decision.approved) {
    if (decision.automatic === true && decision.declinedEarlier !== true) {
      const words = decision.reason?.trim();
      return nobody(words ? `refused without the user: ${words}` : "refused without the user", "nobody_to_take_over");
    }
    const words = decision.declinedEarlier === true ? "" : (decision.reason?.trim() ?? "");
    return notHandedBack(words ? `${STOPPED} The user said: ${words}` : STOPPED, "user_stopped");
  }
  return readBack(backend, policy, store, dangerous, ctx);
}

/** The page after the person handed it back, as `read_aria` would show it. */
async function readBack(
  backend: BrowserBackend,
  policy: BrowserDomainPolicy,
  store: AriaSnapshotStore,
  dangerous: DangerousToolOptions,
  ctx: Ctx,
): Promise<CompressedToolResult> {
  const done = "The user finished the take-over and handed the browser back.";
  await backend.ensureReady();
  const read = await readAriaView(
    backend,
    { mode: "interactive" },
    {
      ...(ctx.modelMode ? { modelMode: ctx.modelMode } : {}),
      ...(ctx.contextWindowTokens !== undefined ? { contextWindowTokens: ctx.contextWindowTokens } : {}),
      sessionId: ctx.sessionId,
    },
    policy,
    store,
    { dangerous, tool: TOOL, signal: ctx.signal },
  );
  if (read.kind === "blocked") {
    return result("error", `${done} ${blockedDomainMessage(TOOL, read.host)}`, {
      handedBack: true,
      host: read.host,
      reason: "blocked_domain",
    });
  }
  if (read.kind !== "ok") {
    const why = read.kind === "error" ? read.message : `${read.host ?? "this site"} has not been opened in your own Chrome this session`;
    return result("ok", `${done} The page could not be read (${why}); call browser.read_aria.`, { handedBack: true });
  }
  const { snapshot, view } = read;
  const output = [
    done,
    `  url: ${snapshot.url}`,
    `  view: ${view.mode}`,
    `  refs: ${view.refs.length}`,
    ...(view.note ? [`  note: ${view.note}`] : []),
    "  refs from before the take-over may be gone; use the ones in ### world",
    ...(snapshot.title ? ["  title:", frameUntrustedText(snapshot.title, BROWSER_PAGE_SOURCE)] : []),
  ].join("\n");
  return result("ok", output, {
    handedBack: true,
    url: snapshot.url,
    title: snapshot.title,
    view: view.mode,
    digest: view.digest,
    refCount: view.refs.length,
    // As read_aria: the tree lands in `session.worldSnapshot` / `### world`.
    worldSnapshot: { kind: "browser" as const, digest: view.digest, text: view.text },
  });
}
