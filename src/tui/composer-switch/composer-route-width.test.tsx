import { EventEmitter } from "node:events";
import { Box, render as inkRender } from "ink";
import { describe, expect, it } from "vitest";
import type { ComposerBackendMeta } from "./composer-backend-selectors.js";
import {
  ComposerMetaControls,
  composerRouteWidth,
} from "./composer-meta-controls.js";

/**
 * `composerRouteWidth` exists so the row planner can know the route's
 * width before Yoga lays it out. If it ever disagrees with what the
 * component paints, the bar's planned height and its real height come
 * apart — which shows up as a blank stripe over the transcript, or as a
 * row of transcript hidden behind the composer.
 *
 * So this file does not check the arithmetic against a hand-written
 * number. It renders the real component wide enough that nothing
 * truncates and compares the function against the painted cells.
 */
const SGR = new RegExp("\\u001b\\[[0-9;]*m", "g");

class WideStdout extends EventEmitter {
  _lastFrame: string | undefined;
  readonly columns = 400;
  readonly rows = 40;
  write = (frame: string): void => {
    this._lastFrame = frame;
  };
}

/** Painted columns of the route, measured off the frame. */
function paintedWidth(props: {
  backend: ComposerBackendMeta | null;
  provider: string | null;
  model: string | null;
  needsModelDownload?: boolean;
}): number {
  const stdout = new WideStdout();
  const instance = inkRender(
    <Box>
      <ComposerMetaControls {...props} />
    </Box>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  const frame = (stdout._lastFrame ?? "").replace(SGR, "");
  instance.unmount();
  return Math.max(
    0,
    ...frame.split("\n").map((line) => line.replace(/\s+$/, "").length),
  );
}

const healthy = (kind: ComposerBackendMeta["kind"]): ComposerBackendMeta =>
  ({ kind, status: "healthy" }) as ComposerBackendMeta;

const CASES: Array<{
  name: string;
  props: Parameters<typeof paintedWidth>[0];
}> = [
  {
    name: "cloud route",
    props: {
      backend: healthy("cloud"),
      provider: "anthropic",
      model: "claude-opus-5",
    },
  },
  {
    name: "local route",
    props: {
      backend: healthy("local"),
      provider: "llama.cpp",
      model: "qwen3-30b-a3b-instruct",
    },
  },
  {
    name: "custom route with an unknown probe",
    props: {
      backend: { kind: "custom", status: "unknown" } as ComposerBackendMeta,
      provider: "llama.cpp",
      model: "some-model",
    },
  },
  {
    name: "fusion route, whose backend word is a chip",
    props: {
      backend: healthy("fusion"),
      provider: "openrouter ⇄ Atomic Chat",
      model: "anthropic/claude-opus-5 ⇄ qwen3-4b-instruct",
    },
  },
  {
    name: "nothing on disk yet",
    props: {
      backend: healthy("local"),
      provider: "llama.cpp",
      model: null,
      needsModelDownload: true,
    },
  },
  {
    name: "model alone",
    props: { backend: null, provider: null, model: "solo-model" },
  },
  {
    name: "backend alone",
    props: { backend: healthy("cloud"), provider: null, model: null },
  },
  {
    name: "provider and model, no backend",
    props: { backend: null, provider: "openai", model: "gpt-5" },
  },
];

describe("composerRouteWidth agrees with what the route paints", () => {
  it.each(CASES)("$name", ({ props }) => {
    expect(composerRouteWidth(props)).toBe(paintedWidth(props));
  });

  it("is zero for an empty route, which renders nothing", () => {
    expect(
      composerRouteWidth({ backend: null, provider: null, model: null }),
    ).toBe(0);
  });
});
