import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compressToolResult,
  type CompressedToolResult,
} from "../../compressor/result-compressor.js";
import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { BrowserBackend } from "./browser-backend.js";
import {
  blockedDomainMessage,
  EMPTY_DOMAIN_POLICY,
  type BrowserDomainPolicy,
} from "./browser-domain-policy.js";
import { gatePageRead, type PageReadVerdict } from "./gate-page-read.js";
import { browserShotDir } from "./screenshot.js";
import { BROWSER_SHOT_MAX_BYTES } from "./screenshot-geometry.js";
import { groupPins, renderPin, sanitizePins } from "./annotate-pins.js";

export const BROWSER_ANNOTATE_TOOL = "browser.annotate";

/** Source named on the framing of the pins: element details come from the page. */
export const ANNOTATE_SOURCE =
  "pins the user put on a web page in the browser (the comments are the user's; element text, selectors and styles come from the page)";

/** Element crops taken in one read. */
export const MAX_ANNOTATE_CROPS = 12;

export interface BrowserAnnotateDeps {
  tmpDir: () => string;
  ensureDir: (dir: string) => Promise<void>;
  writeFile: (path: string, data: Buffer) => Promise<void>;
  now: () => Date;
}

const DEFAULT_DEPS: BrowserAnnotateDeps = {
  tmpDir: tmpdir,
  ensureDir: async (dir) => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  },
  writeFile: (path, data) => writeFile(path, data, { mode: 0o600 }),
  now: () => new Date(),
};

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1");
}

function errorResult(output: string, details: Record<string, unknown>): CompressedToolResult {
  return compressToolResult({ tool: BROWSER_ANNOTATE_TOOL, status: "error", output, details });
}

function refusal(verdict: PageReadVerdict, url: string, after: boolean): CompressedToolResult | null {
  if (verdict.kind === "blocked") {
    const tail = after ? " The page showed that site, so the pins were not read." : "";
    return errorResult(`${blockedDomainMessage(BROWSER_ANNOTATE_TOOL, verdict.host)}${tail}`, {
      url,
      host: verdict.host,
      reason: "blocked_domain",
    });
  }
  if (verdict.kind === "user_site_not_cleared") {
    return errorResult(
      `${BROWSER_ANNOTATE_TOOL}: ${verdict.host} has not been opened in your own Chrome this session`,
      { url, host: verdict.host, reason: "user_site_not_cleared" },
    );
  }
  return null;
}

/**
 * `browser.annotate { action: "start" | "read" | "stop", crops? }`
 * (ATO-518): the user marks up the page in the agent's browser window.
 *
 * - `start` puts an overlay on the active page (`annotate-in-page.ts`):
 *   the user clicks an element, types what should change, and a numbered
 *   pin stays on it. A floating "Annotate" toggle on the page (badge: the
 *   pin count) turns picking off and on again. While picking, clicks on the
 *   page are swallowed (a pin never presses a button), so browser.click
 *   should wait until `read` or `stop`.
 * - `read` returns every pin: the comment, a CSS selector, the box, key
 *   computed styles and, with `crops`, a JPEG of the element saved under
 *   the temp folder (like `browser.screenshot`; secret fields boxed
 *   over). Pins are grouped by the DOM subtree they share
 *   (`annotate-pins.ts`), so each group can go to its own worker.
 * - `stop` removes the overlay and forgets the pins.
 *
 * The overlay runs in an isolated world, so the page cannot read the
 * saved pins or forge them; a navigation or reload drops them. The page
 * can see the keys while a comment is typed (see `annotate-in-page.ts`). Reading is a page read
 * (`gate-page-read.ts`): a blocked page is refused, and in the user's own
 * Chrome a site not opened this session asks first. Nothing is clicked
 * or typed on the site, so there is no other prompt.
 */
export function buildBrowserAnnotateTool(
  backend: BrowserBackend,
  policy: BrowserDomainPolicy = EMPTY_DOMAIN_POLICY,
  dangerous?: DangerousToolOptions,
  deps: BrowserAnnotateDeps = DEFAULT_DEPS,
): ToolDefinition {
  return {
    name: BROWSER_ANNOTATE_TOOL,
    description:
      "Let the user mark up the open page: `start` shows an overlay where they click elements and type what to change; `read` returns each pin's comment, CSS selector, box and styles (`crops: true` adds element pictures), grouped by page area; `stop` removes it.",
    readonly: false,
    untrustedOutput: ANNOTATE_SOURCE,
    async run(rawArgs, ctx) {
      const action = rawArgs.action;
      if (action !== "start" && action !== "read" && action !== "stop") {
        throw new Error(`${BROWSER_ANNOTATE_TOOL}: \`action\` must be one of start|read|stop`);
      }
      const { startAnnotate, readAnnotations, stopAnnotate } = backend;
      if (startAnnotate === undefined || readAnnotations === undefined || stopAnnotate === undefined) {
        return errorResult(`${BROWSER_ANNOTATE_TOOL}: this browser backend cannot annotate pages`, {
          reason: "unsupported",
        });
      }
      await backend.ensureReady();
      if (action === "stop") {
        const stopped = await stopAnnotate.call(backend);
        return compressToolResult({
          tool: BROWSER_ANNOTATE_TOOL,
          status: "ok",
          output:
            stopped.removed > 0
              ? `annotate overlay removed; ${stopped.removed} pin(s) dropped`
              : "no annotate overlay on this page",
          details: { action, url: stopped.url, removed: stopped.removed },
        });
      }
      const url = await backend.currentUrl();
      const gate = await gatePageRead(
        { url },
        policy,
        ctx.sessionId,
        dangerous ? { dangerous, tool: BROWSER_ANNOTATE_TOOL, signal: ctx.signal } : undefined,
      );
      const refused = refusal(gate, url, false);
      if (refused) return refused;

      if (action === "start") {
        const started = await startAnnotate.call(backend);
        const lines = [
          started.started
            ? `annotate overlay is on ${started.url}.`
            : `annotate overlay was already on ${started.url}; picking resumed (${started.pins} pin(s) so far).`,
          "In the browser window the user clicks an element, types what should change and saves; each pin gets a number. The Annotate button on the page (it shows the pin count) turns picking off and on.",
          "Tell the user that, then wait for them; when they say they are done, call browser.annotate { \"action\": \"read\" } (add \"crops\": true for pictures of the elements).",
          "Until then do not click or type on this page: the overlay catches clicks. Navigating away drops the pins.",
        ];
        return compressToolResult(
          {
            tool: BROWSER_ANNOTATE_TOOL,
            status: "ok",
            output: lines.join("\n"),
            details: { action, url: started.url, started: started.started, pins: started.pins },
          },
          { maxSummaryLength: 1_200, maxTailLines: 10 },
        );
      }

      const crops = rawArgs.crops === true;
      const read = await readAnnotations.call(backend, {
        crops,
        maxCrops: MAX_ANNOTATE_CROPS,
        maxCropBytes: BROWSER_SHOT_MAX_BYTES,
      });
      const after = refusal(await gatePageRead(read, policy, ctx.sessionId), read.url, true);
      if (after) return after;
      if (!read.active) {
        return errorResult(
          `${BROWSER_ANNOTATE_TOOL}: no annotate overlay on ${read.url} (it was never started here, or the page navigated or reloaded, which drops the pins); call browser.annotate { "action": "start" } to begin`,
          { url: read.url, reason: "not_active" },
        );
      }
      const pins = sanitizePins(read.pins);
      if (pins.length === 0) {
        return compressToolResult({
          tool: BROWSER_ANNOTATE_TOOL,
          status: "ok",
          output: `no pins yet on ${read.url}${read.picking ? "; the overlay is still waiting for the user" : ""}`,
          details: { action, url: read.url, pins: 0, picking: read.picking },
        });
      }
      const cropPaths = new Map<number, string>();
      const cropNotes: string[] = [];
      const pictures = read.crops.filter((crop) => crop.buffer !== undefined);
      if (pictures.length > 0) {
        const dir = browserShotDir(deps.tmpDir(), ctx.sessionId);
        await deps.ensureDir(dir);
        const prefix = `annotate-${stamp(deps.now())}`;
        for (const crop of pictures) {
          const path = join(dir, `${prefix}-pin${crop.pinId}.jpg`);
          await deps.writeFile(path, crop.buffer!);
          cropPaths.set(crop.pinId, path);
        }
      }
      for (const crop of read.crops) {
        if (crop.skipped) cropNotes.push(`pin ${crop.pinId}: ${crop.skipped}`);
      }
      const groups = groupPins(pins);
      const byId = new Map(pins.map((pin) => [pin.id, pin] as const));
      const lines = [
        `${pins.length} pin(s) on ${read.url}${read.picking ? " (the user may still add more)" : ""}, in ${groups.length} area(s) of the page.`,
        "Each comment is the user's request for that element. Pins in one area share a DOM subtree; different areas can be edited separately.",
      ];
      groups.forEach((group, index) => {
        lines.push(`Area ${index + 1}: ${group.region} (pins ${group.pinIds.join(", ")})`);
        for (const id of group.pinIds) {
          const pin = byId.get(id);
          if (pin) lines.push(...renderPin(pin, cropPaths.get(id)));
        }
      });
      if (crops) {
        lines.push(
          cropPaths.size > 0
            ? "Look at a crop with vision.describe { \"path\": \"...\" }."
            : "No element pictures could be taken.",
        );
        if (cropNotes.length > 0) lines.push(`crops skipped: ${cropNotes.join(", ")}`);
      }
      return compressToolResult(
        {
          tool: BROWSER_ANNOTATE_TOOL,
          status: "ok",
          output: lines.join("\n"),
          details: {
            action,
            url: read.url,
            picking: read.picking,
            pins: pins.map((pin) => ({ ...pin, ...(cropPaths.has(pin.id) ? { crop: cropPaths.get(pin.id) } : {}) })),
            groups,
          },
        },
        { maxSummaryLength: 16_000, maxTailLines: 600 },
      );
    },
  };
}
