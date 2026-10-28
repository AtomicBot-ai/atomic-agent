import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import type { BrowserBackend, ScreenshotResult } from "./browser-backend.js";
import {
  blockedDomainMessage,
  EMPTY_DOMAIN_POLICY,
  type BrowserDomainPolicy,
} from "./browser-domain-policy.js";
import { gatePageRead } from "./gate-page-read.js";
import { BROWSER_SHOT_MAX_BYTES, SHOT_ATTEMPTS } from "./screenshot-geometry.js";

export const BROWSER_SCREENSHOT_TOOL = "browser.screenshot";

/** Folder under `os.tmpdir()` for browser screenshots, one subfolder per session. */
export const BROWSER_SHOT_DIR = "atomic-agent-browser-shots";

const REF_PATTERN = /^[a-zA-Z0-9]+$/;

export interface BrowserScreenshotDeps {
  tmpDir: () => string;
  ensureDir: (dir: string) => Promise<void>;
  writeFile: (path: string, data: Buffer) => Promise<void>;
  now: () => Date;
}

const DEFAULT_DEPS: BrowserScreenshotDeps = {
  tmpDir: tmpdir,
  ensureDir: async (dir) => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  },
  writeFile: (path, data) => writeFile(path, data, { mode: 0o600 }),
  now: () => new Date(),
};

/** `<tmp>/atomic-agent-browser-shots/<session>`: outside the working folder, inside the read roots. */
export function browserShotDir(tmp: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_") || "default";
  return join(tmp, BROWSER_SHOT_DIR, safe === "." || safe === ".." ? "default" : safe);
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1");
}

function errorResult(output: string, details: Record<string, unknown>) {
  return compressToolResult({ tool: BROWSER_SCREENSHOT_TOOL, status: "error", output, details });
}

function notClearedMessage(host: string | null): string {
  return `${BROWSER_SCREENSHOT_TOOL}: ${host} has not been opened in your own Chrome this session`;
}

/**
 * `browser.screenshot { ref?, fullPage? }` (ATO-515): a JPEG of the
 * active page's viewport, the whole page (cut at 8000 CSS px) or one
 * element, at most 1280 px on the long side and 900 KB. Tool results are
 * text, so the picture reaches the model the way every other image does:
 * saved under the temp folder, looked at with `vision.describe`, shown to
 * the user with `reply.attachments`.
 *
 * A page on a blocked host is never captured, and a capture is thrown
 * away (never saved) when the page or any of its frames turned out to be
 * on a blocked host by the time the pixels were taken. In the user's own
 * Chrome a site not cleared this session asks first, like `read_aria`
 * (`dangerous`; without it, refused), and a capture that landed on
 * another uncleared site is thrown away (`gate-page-read.ts`).
 */
export function buildBrowserScreenshotTool(
  backend: BrowserBackend,
  policy: BrowserDomainPolicy = EMPTY_DOMAIN_POLICY,
  deps: BrowserScreenshotDeps = DEFAULT_DEPS,
  dangerous?: DangerousToolOptions,
): ToolDefinition {
  return {
    name: BROWSER_SCREENSHOT_TOOL,
    description:
      "Take a JPEG screenshot of the active page (viewport), the whole page (`fullPage`) or one element (`ref`). Saves it in the temp folder and returns the path: look at it with vision.describe, show it with reply.attachments.",
    readonly: true,
    async run(rawArgs, ctx) {
      const ref = rawArgs.ref ?? undefined;
      if (ref !== undefined && (typeof ref !== "string" || !REF_PATTERN.test(ref))) {
        throw new Error(`${BROWSER_SCREENSHOT_TOOL}: \`ref\` must be an alphanumeric ref from the latest snapshot`);
      }
      const fullPage = rawArgs.fullPage === true;
      if (ref !== undefined && fullPage) {
        throw new Error(`${BROWSER_SCREENSHOT_TOOL}: use either \`ref\` or \`fullPage\`, not both`);
      }
      await backend.ensureReady();
      const before = await backend.currentUrl();
      const gateBefore = await gatePageRead(
        { url: before },
        policy,
        ctx.sessionId,
        dangerous ? { dangerous, tool: BROWSER_SCREENSHOT_TOOL, signal: ctx.signal } : undefined,
      );
      if (gateBefore.kind === "blocked") {
        return errorResult(blockedDomainMessage(BROWSER_SCREENSHOT_TOOL, gateBefore.host), {
          url: before,
          host: gateBefore.host,
          reason: "blocked_domain",
        });
      }
      if (gateBefore.kind === "user_site_not_cleared") {
        return errorResult(notClearedMessage(gateBefore.host), {
          url: before,
          host: gateBefore.host,
          reason: "user_site_not_cleared",
        });
      }
      if (ref !== undefined && !(await backend.hasRef(ref))) {
        return errorResult(
          `ref '${ref}' is not present on the current page — refs are invalidated by any navigation or search; call browser.read_aria to get fresh refs`,
          { ref, reason: "stale_ref" },
        );
      }
      let shot: ScreenshotResult | null = null;
      for (const attempt of SHOT_ATTEMPTS) {
        const taken = await backend.screenshot({
          ...(ref !== undefined ? { ref } : {}),
          ...(fullPage ? { fullPage } : {}),
          maxSide: attempt.maxSide,
          quality: attempt.quality,
        });
        const gate = await gatePageRead(taken, policy, ctx.sessionId);
        if (gate.kind === "blocked") {
          return errorResult(
            `${blockedDomainMessage(BROWSER_SCREENSHOT_TOOL, gate.host)} The page showed that site, so the screenshot was discarded.`,
            { url: taken.url, host: gate.host, reason: "blocked_domain" },
          );
        }
        if (gate.kind === "user_site_not_cleared") {
          return errorResult(
            `${notClearedMessage(gate.host)}; the page moved there, so the screenshot was discarded.`,
            { url: taken.url, host: gate.host, reason: "user_site_not_cleared" },
          );
        }
        if (taken.buffer.length <= BROWSER_SHOT_MAX_BYTES) {
          shot = taken;
          break;
        }
      }
      if (shot === null) {
        return errorResult(
          `the screenshot stays over ${Math.round(BROWSER_SHOT_MAX_BYTES / 1000)} KB even when made smaller; try a single element (\`ref\`) or the viewport instead`,
          { reason: "too_large" },
        );
      }
      const dir = browserShotDir(deps.tmpDir(), ctx.sessionId);
      await deps.ensureDir(dir);
      const path = join(dir, `browser-${stamp(deps.now())}.jpg`);
      await deps.writeFile(path, shot.buffer);
      const what = ref !== undefined ? `element ${ref}` : fullPage ? "the whole page" : "the visible part of the page";
      const lines = [
        `saved ${path} (${shot.width}x${shot.height} px JPEG, ${Math.round(shot.buffer.length / 1000)} KB) of ${what} on ${shot.url}.`,
        ...(shot.clipped ? ["The page is longer than the cap; only the top part is in the picture."] : []),
        `Look at it with vision.describe { "path": "${path}" }; to show it to the user, pass the path in reply.attachments.`,
      ];
      return compressToolResult(
        {
          tool: BROWSER_SCREENSHOT_TOOL,
          status: "ok",
          output: lines.join("\n"),
          details: {
            path,
            mime: shot.mime,
            imageWidth: shot.width,
            imageHeight: shot.height,
            bytes: shot.buffer.length,
            url: shot.url,
            title: shot.title,
            clipped: shot.clipped,
            ...(ref !== undefined ? { ref } : {}),
          },
        },
        { maxSummaryLength: 1_200, maxTailLines: 20 },
      );
    },
  };
}
