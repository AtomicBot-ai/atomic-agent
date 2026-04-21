import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import type {
  BrowserBackend,
  ScrollDirection,
  ScrollInput,
} from "./browser-backend.js";

const VALID_DIRECTIONS: readonly ScrollDirection[] = [
  "up",
  "down",
  "top",
  "bottom",
];

export function buildBrowserScrollTool(
  backend: BrowserBackend,
): ToolDefinition {
  return {
    name: "browser.scroll",
    description:
      "Scroll the active page up/down/top/bottom by a page, half page, or pixel amount. Does not refresh the ARIA snapshot — call browser.read_aria after to observe new content.",
    readonly: true,
    async run(rawArgs) {
      const direction = parseDirection(rawArgs.direction);
      const amount = parseAmount(rawArgs.amount);
      await backend.ensureReady();
      const payload: ScrollInput = {
        direction,
        ...(amount !== undefined ? { amount } : {}),
      };
      const result = await backend.scroll(payload);
      const remaining = Math.max(
        0,
        result.scrollHeight - result.scrollY - result.viewportHeight,
      );
      return compressToolResult({
        tool: "browser.scroll",
        status: "ok",
        output: [
          `scrolled ${direction}${amount !== undefined ? ` by ${amount}` : ""}`,
          `  position: ${result.scrollY}px / ${result.scrollHeight}px`,
          `  viewport: ${result.viewportHeight}px`,
          `  remaining below: ${remaining}px`,
        ].join("\n"),
        details: {
          direction,
          ...(amount !== undefined ? { amount } : {}),
          scrollY: result.scrollY,
          scrollHeight: result.scrollHeight,
          viewportHeight: result.viewportHeight,
        },
      });
    },
  };
}

function parseDirection(value: unknown): ScrollDirection {
  if (
    typeof value === "string" &&
    (VALID_DIRECTIONS as readonly string[]).includes(value)
  ) {
    return value as ScrollDirection;
  }
  throw new Error(
    `browser.scroll: \`direction\` must be one of ${VALID_DIRECTIONS.join("|")}`,
  );
}

function parseAmount(value: unknown): ScrollInput["amount"] | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "page" || value === "half") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  throw new Error(
    'browser.scroll: `amount` must be "page", "half", or a finite number',
  );
}
