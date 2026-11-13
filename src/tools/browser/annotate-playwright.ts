import type { CDPSession, Page } from "playwright-core";
import type {
  AnnotateReadInput,
  AnnotateReadResult,
  AnnotateStartResult,
  AnnotationCrop,
} from "./browser-backend.js";
import {
  ANNOTATE_READ_SCRIPT,
  ANNOTATE_START_SCRIPT,
  ANNOTATE_STOP_SCRIPT,
  annotateVisibilityScript,
} from "./annotate-in-page.js";
import { SECRET_AUTOCOMPLETE_TOKENS } from "./redact-secret-fields.js";

/**
 * Playwright side of annotate mode (ATO-518), kept out of
 * `playwright-backend.ts` so the backend only delegates.
 *
 * The overlay runs in an isolated world of the page's main frame (CDP
 * `Page.createIsolatedWorld`): it shares the DOM with the page but not
 * its JavaScript, so the page cannot read the saved pins or forge them
 * (it can see the keys while a comment is typed). A navigation
 * or reload destroys that world, and the pins with it.
 */

const WORLD_NAME = "atomic-agent-annotate";

interface IsolatedWorld {
  session: CDPSession;
  contextId: number;
}

const worlds = new WeakMap<Page, IsolatedWorld>();

/** Secret fields are boxed over in crops, as in screenshots. */
const SECRET_FIELD_SELECTOR = [
  'input[type="password"]',
  ...SECRET_AUTOCOMPLETE_TOKENS.map((token) => `input[autocomplete~="${token}"]`),
].join(", ");

async function evaluateIn(world: IsolatedWorld, expression: string): Promise<unknown> {
  const reply = (await world.session.send("Runtime.evaluate", {
    expression,
    contextId: world.contextId,
    returnByValue: true,
    awaitPromise: true,
  })) as unknown as {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (reply.exceptionDetails) {
    const why = reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? "script error";
    throw new Error(`annotate overlay: ${why.split("\n")[0]}`);
  }
  return reply.result?.value;
}

async function dropWorld(page: Page): Promise<void> {
  const world = worlds.get(page);
  worlds.delete(page);
  await world?.session.detach().catch(() => undefined);
}

/**
 * The page's annotate world: the cached one while it is alive, else a new
 * one when `create`, else `null`.
 */
async function worldOf(page: Page, create: boolean): Promise<IsolatedWorld | null> {
  const cached = worlds.get(page);
  if (cached) {
    const alive = await evaluateIn(cached, "true").then(() => true, () => false);
    if (alive) return cached;
    await dropWorld(page);
  }
  if (!create) return null;
  const session = await page.context().newCDPSession(page);
  try {
    const tree = (await session.send("Page.getFrameTree")) as unknown as { frameTree: { frame: { id: string } } };
    const created = (await session.send("Page.createIsolatedWorld", {
      frameId: tree.frameTree.frame.id,
      worldName: WORLD_NAME,
      // (sic) the CDP parameter name.
      grantUniveralAccess: false,
    })) as unknown as { executionContextId: number };
    const world = { session, contextId: created.executionContextId };
    worlds.set(page, world);
    return world;
  } catch (error) {
    await session.detach().catch(() => undefined);
    throw error;
  }
}

function frameUrlsOf(page: Page): string[] {
  return page.frames().map((frame) => frame.url());
}

export async function startAnnotateOnPage(page: Page): Promise<AnnotateStartResult> {
  const world = await worldOf(page, true);
  if (!world) throw new Error("annotate overlay: could not open the page");
  const raw = (await evaluateIn(world, ANNOTATE_START_SCRIPT)) as { started?: unknown; pins?: unknown } | undefined;
  return {
    url: page.url(),
    started: raw?.started === true,
    pins: typeof raw?.pins === "number" ? raw.pins : 0,
  };
}

async function cropPins(
  page: Page,
  world: IsolatedWorld,
  pins: unknown[],
  input: AnnotateReadInput,
): Promise<AnnotationCrop[]> {
  const crops: AnnotationCrop[] = [];
  const targets = pins
    .filter((pin): pin is { id: number; selector: string; attached: boolean } => {
      const p = pin as { id?: unknown; selector?: unknown; attached?: unknown } | null;
      return typeof p?.id === "number" && typeof p.selector === "string" && p.selector.length > 0;
    })
    .slice(0, input.maxCrops);
  if (targets.length === 0) return crops;
  await evaluateIn(world, annotateVisibilityScript(false)).catch(() => undefined);
  try {
    for (const pin of targets) {
      if (!pin.attached) {
        crops.push({ pinId: pin.id, skipped: "not_visible" });
        continue;
      }
      try {
        const buffer = await page.locator(`css=${pin.selector}`).first().screenshot({
          type: "jpeg",
          quality: 70,
          scale: "css",
          animations: "disabled",
          timeout: 3_000,
          mask: [page.locator(SECRET_FIELD_SELECTOR)],
        });
        crops.push(
          buffer.length > input.maxCropBytes ? { pinId: pin.id, skipped: "too_large" } : { pinId: pin.id, buffer },
        );
      } catch {
        crops.push({ pinId: pin.id, skipped: "failed" });
      }
    }
  } finally {
    await evaluateIn(world, annotateVisibilityScript(true)).catch(() => undefined);
  }
  return crops;
}

export async function readAnnotationsOnPage(
  page: Page,
  input: AnnotateReadInput,
): Promise<AnnotateReadResult> {
  const framesBefore = frameUrlsOf(page);
  const world = await worldOf(page, false);
  const raw = world
    ? ((await evaluateIn(world, ANNOTATE_READ_SCRIPT).catch(() => undefined)) as
        | { active?: unknown; picking?: unknown; pins?: unknown }
        | undefined)
    : undefined;
  const pins = Array.isArray(raw?.pins) ? (raw.pins as unknown[]) : [];
  const crops = world && input.crops && pins.length > 0 ? await cropPins(page, world, pins, input) : [];
  return {
    url: page.url(),
    frameUrls: Array.from(new Set([...framesBefore, ...frameUrlsOf(page)])),
    active: raw?.active === true,
    picking: raw?.picking === true,
    pins,
    crops,
  };
}

export async function stopAnnotateOnPage(page: Page): Promise<{ url: string; removed: number }> {
  const world = await worldOf(page, false);
  let removed = 0;
  if (world) {
    const raw = await evaluateIn(world, ANNOTATE_STOP_SCRIPT).catch(() => 0);
    removed = typeof raw === "number" ? raw : 0;
    await dropWorld(page);
  }
  return { url: page.url(), removed };
}
