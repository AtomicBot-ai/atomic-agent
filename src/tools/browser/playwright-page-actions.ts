import type { Dialog, Page } from "playwright-core";
import type { PageActionInput, PageActionResult } from "./browser-backend.js";

/**
 * Playwright side of `browser.act` (ATO-957). Thin wrappers: argument
 * checks and the approval gate already ran in `act.ts`.
 */

const NAV_TIMEOUT_MS = 15_000;
const ACTION_TIMEOUT_MS = 10_000;
/** An armed dialog answer lapses, so a later surprise confirm() is not accepted. */
export const DIALOG_ARM_MS = 60_000;

interface ArmedDialog {
  handler: (dialog: Dialog) => void;
  timer: ReturnType<typeof setTimeout>;
}

const armedDialogs = new WeakMap<Page, ArmedDialog>();

function disarm(page: Page): void {
  const armed = armedDialogs.get(page);
  if (!armed) return;
  clearTimeout(armed.timer);
  page.off("dialog", armed.handler);
  armedDialogs.delete(page);
}

/**
 * Answer the next dialog on `page`. Without a listener Playwright
 * dismisses every dialog, so the answer must be set before the click
 * that opens it; one answer covers one dialog.
 */
function armDialog(page: Page, accept: boolean, text: string | undefined): void {
  disarm(page);
  const handler = (dialog: Dialog): void => {
    disarm(page);
    const answer = accept ? dialog.accept(text) : dialog.dismiss();
    void answer.catch(() => undefined);
  };
  const timer = setTimeout(() => disarm(page), DIALOG_ARM_MS);
  if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();
  armedDialogs.set(page, { handler, timer });
  page.on("dialog", handler);
}

/** Runs in the page; typed loosely because the Node build has no DOM lib. */
function isFileInputInPage(node: unknown): boolean {
  const el = node as { tagName?: string; type?: string };
  return el.tagName === "INPUT" && el.type === "file";
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || /timeout/i.test(error.message));
}

export async function runPageAction(page: Page, input: PageActionInput): Promise<PageActionResult> {
  switch (input.action) {
    case "select": {
      const chosen = await page
        .locator(`aria-ref=${input.ref}`)
        .selectOption(input.values, { timeout: ACTION_TIMEOUT_MS });
      return { done: true, note: `selected ${chosen.length === 1 ? `"${chosen[0]}"` : `${chosen.length} options`} in ref=${input.ref}` };
    }
    case "upload": {
      const locator = page.locator(`aria-ref=${input.ref}`);
      const isFileInput = await locator
        .evaluate(isFileInputInPage, undefined, { timeout: 2_000 })
        .catch(() => false);
      if (isFileInput) {
        await locator.setInputFiles(input.paths, { timeout: ACTION_TIMEOUT_MS });
      } else {
        // A styled "Upload" button: click it and answer the file chooser.
        const [chooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: ACTION_TIMEOUT_MS }),
          locator.click({ timeout: ACTION_TIMEOUT_MS }),
        ]);
        await chooser.setFiles(input.paths);
      }
      return { done: true, note: `uploaded ${input.paths.length === 1 ? "1 file" : `${input.paths.length} files`} into ref=${input.ref}` };
    }
    case "back":
    case "forward": {
      const response = input.action === "back"
        ? await page.goBack({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS })
        : await page.goForward({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      const url = page.url();
      // `null`: no history entry that way, or a same-document move.
      if (response === null) return { done: true, note: `${input.action === "back" ? "went back" : "went forward"} (if there was a page that way); now at ${url}` };
      return { done: true, note: `${input.action === "back" ? "went back" : "went forward"} to ${url}` };
    }
    case "key": {
      if (input.ref !== undefined) {
        await page.locator(`aria-ref=${input.ref}`).press(input.key, { timeout: ACTION_TIMEOUT_MS });
      } else {
        await page.keyboard.press(input.key);
      }
      return { done: true, note: `pressed ${input.key}${input.ref !== undefined ? ` on ref=${input.ref}` : ""}` };
    }
    case "hover":
      await page.locator(`aria-ref=${input.ref}`).hover({ timeout: ACTION_TIMEOUT_MS });
      return { done: true, note: `hovering ref=${input.ref}; call browser.read_aria to see what opened` };
    case "dialog":
      armDialog(page, input.accept, input.text);
      return {
        done: true,
        note: `the next dialog on this tab will be ${input.accept ? "accepted" : "dismissed"} (for ${DIALOG_ARM_MS / 1000} s); now do the action that opens it`,
      };
    case "wait": {
      if ("ms" in input) {
        await page.waitForTimeout(input.ms);
        return { done: true, note: `waited ${input.ms} ms` };
      }
      const locator = "text" in input
        ? page.getByText(input.text).first()
        : page.locator(`aria-ref=${input.ref}`).first();
      const what = "text" in input ? JSON.stringify(input.text) : `ref=${input.ref}`;
      try {
        await locator.waitFor({ state: input.state, timeout: input.timeoutMs });
      } catch (error) {
        if (isTimeout(error)) {
          return { done: false, note: `${what} was not ${input.state} within ${input.timeoutMs} ms` };
        }
        throw error;
      }
      return { done: true, note: `${what} is ${input.state}` };
    }
  }
}
