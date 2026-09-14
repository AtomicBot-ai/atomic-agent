/**
 * `kind: "page"` — a local HTML file or a URL in a headless browser:
 * scripted input, then `seconds` of runtime with probes sampled.
 *
 * Playwright drives whichever Chromium-family browser the host has
 * (`config.browser.channel` / `executablePath`, else the first found,
 * else a Playwright-managed Chromium if one is installed) — always
 * headless. When none launches the run fails with `no browser
 * available: …`. It never passes for want of a browser.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright-core";

import type { AtomicAgentConfig } from "../../config/index.js";
import { loadPlaywrightCore } from "../../native/load-playwright-core.js";
import { findChromeExecutable } from "../browser/find-chrome-executable.js";
import {
  MISSING_SELECTOR_GLOBAL,
  MISSING_SELECTOR_INIT_SCRIPT,
  type ProbeSample,
  sampleProbes,
} from "./page-probe-script.js";
import type { VerifyRunArgs, VerifyScriptStep } from "./verify-run-args.js";

export type BrowserLauncher = () => Promise<Browser>;

export interface PageRunOutcome {
  readonly target: string;
  readonly launched: boolean;
  readonly loaded: boolean;
  readonly error?: string;
  /** Uncaught exceptions (`pageerror`) and failed script steps. */
  readonly errors: readonly string[];
  readonly consoleErrors: readonly string[];
  readonly consoleWarnings: readonly string[];
  readonly requestFailures: readonly string[];
  readonly missingSelectors: readonly string[];
  readonly probes: Readonly<Record<string, ProbeSample[]>>;
  readonly durationMs: number;
}

const LIST_CAP = 50;
const STEP_TIMEOUT_MS = 5_000;
const LOAD_TIMEOUT_MS = 30_000;

/** The host's browser first, then a Playwright-managed one; else a clear error. */
export function defaultBrowserLauncher(
  config: Pick<AtomicAgentConfig, "browser">,
): BrowserLauncher {
  return async () => {
    const pw = await loadPlaywrightCore();
    const reasons: string[] = [];
    const args = config.browser.noSandbox ? ["--no-sandbox"] : [];
    let executable: string | null = null;
    try {
      executable =
        findChromeExecutable({
          executablePath: config.browser.executablePath,
          channel: config.browser.channel,
        })?.path ?? null;
    } catch (err) {
      reasons.push(err instanceof Error ? err.message : String(err));
    }
    if (executable !== null) {
      try {
        return await pw.chromium.launch({ executablePath: executable, headless: true, args });
      } catch (err) {
        reasons.push(`${executable}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      }
    } else if (reasons.length === 0) {
      reasons.push("no Chromium-family browser found (Chrome, Edge, Brave, Chromium)");
    }
    try {
      return await pw.chromium.launch({ headless: true, args });
    } catch (err) {
      reasons.push(`playwright chromium: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
    throw new Error(`no browser available: ${reasons.join("; ")}`);
  };
}

function push(list: string[], entry: string): void {
  if (list.length < LIST_CAP) list.push(entry);
}

async function runStep(page: Page, step: VerifyScriptStep): Promise<void> {
  switch (step.action) {
    case "click":
      await page.click(step.selector ?? "", { timeout: STEP_TIMEOUT_MS });
      return;
    case "key":
      await page.keyboard.press(step.key ?? "");
      return;
    case "type":
      if (step.selector !== undefined) {
        await page.locator(step.selector).pressSequentially(step.text ?? "", { timeout: STEP_TIMEOUT_MS });
      } else {
        await page.keyboard.type(step.text ?? "");
      }
      return;
    case "wait":
      await page.waitForTimeout(Math.min(step.ms ?? 0, 60_000));
      return;
  }
}

function describeStep(step: VerifyScriptStep): string {
  const detail = step.selector ?? step.key ?? step.text ?? (step.ms === undefined ? "" : `${step.ms}ms`);
  return `${step.action} ${JSON.stringify(detail)}`;
}

export async function runPageKind(
  args: VerifyRunArgs,
  ctx: { cwd: string; signal?: AbortSignal; launch: BrowserLauncher },
): Promise<PageRunOutcome> {
  const started = Date.now();
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  const consoleWarnings: string[] = [];
  const requestFailures: string[] = [];
  let missingSelectors: string[] = [];
  let probes: Record<string, ProbeSample[]> = {};
  const done = (partial: Partial<PageRunOutcome> & { target: string; launched: boolean; loaded: boolean }): PageRunOutcome => ({
    errors, consoleErrors, consoleWarnings, requestFailures, missingSelectors, probes,
    durationMs: Date.now() - started,
    ...partial,
  });

  let target: string;
  if (args.url !== undefined) {
    target = args.url;
  } else {
    const file = resolve(ctx.cwd, args.path ?? "");
    if (!existsSync(file)) {
      return done({ target: file, launched: false, loaded: false, error: `no such file: ${args.path}` });
    }
    target = pathToFileURL(file).href;
  }

  let browser: Browser;
  try {
    browser = await ctx.launch();
  } catch (err) {
    return done({ target, launched: false, loaded: false, error: err instanceof Error ? err.message : String(err) });
  }
  const deadline = setTimeout(() => {
    push(errors, `run exceeded timeoutMs (${args.timeoutMs})`);
    void browser.close().catch(() => {});
  }, args.timeoutMs);
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    if (!args.network) {
      await context.route(/^https?:\/\//, (route) => {
        push(requestFailures, `${route.request().url()} blocked (network: false)`);
        return route.abort("blockedbyclient");
      });
    }
    const page = await context.newPage();
    page.on("pageerror", (err) => {
      const message = err.message.split("\n")[0] ?? String(err);
      push(errors, err.name.length > 0 && !message.startsWith(err.name) ? `${err.name}: ${message}` : message);
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") push(consoleErrors, msg.text());
      else if (msg.type() === "warning") push(consoleWarnings, msg.text());
    });
    page.on("requestfailed", (req) => {
      const why = req.failure()?.errorText ?? "failed";
      if (!why.includes("BLOCKED_BY_CLIENT")) push(requestFailures, `${req.url()} ${why}`);
    });
    await page.addInitScript(MISSING_SELECTOR_INIT_SCRIPT);
    try {
      await page.goto(target, { waitUntil: "load", timeout: Math.min(LOAD_TIMEOUT_MS, args.timeoutMs) });
    } catch (err) {
      return done({ target, launched: true, loaded: false, error: `page load failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` });
    }
    for (const step of args.script ?? []) {
      if (ctx.signal?.aborted) break;
      try {
        await runStep(page, step);
      } catch (err) {
        push(errors, `script step ${describeStep(step)} failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      }
    }
    probes = await sampleProbes(args.probes ?? [], args.seconds, (expr) => page.evaluate(expr), ctx.signal);
    try {
      const recorded = await page.evaluate(`window[${JSON.stringify(MISSING_SELECTOR_GLOBAL)}]`);
      missingSelectors = Array.isArray(recorded) ? recorded.map(String) : [];
    } catch {
      // The page navigated away or closed; nothing to read.
    }
    return done({ target, launched: true, loaded: true });
  } catch (err) {
    return done({ target, launched: true, loaded: false, error: err instanceof Error ? err.message.split("\n")[0] : String(err) });
  } finally {
    clearTimeout(deadline);
    await browser.close().catch(() => {});
  }
}
