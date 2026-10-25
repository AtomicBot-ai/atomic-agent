import type { ToolDescriptor } from "./stable-prefix.js";

/**
 * `os.screen.*` (ATO-525), spread into `DEFAULT_TOOL_DESCRIPTORS_B` after
 * the other desktop tools. Rare tier: they leave the prompt entirely
 * unless `tools.screen.enabled` is on and the host is macOS
 * (`GATED_TOOLS.screen`), and when they are on, one line each plus
 * `tool.view` is enough — capture says how its numbers feed a click.
 */
export const SCREEN_TOOL_DESCRIPTORS: readonly ToolDescriptor[] = [
  {
    name: "os.screen.capture",
    summary:
      "Screenshot of the main screen (macOS); saves a JPEG in the working folder and returns its path and the pixel-to-point scale. Look at it with vision.describe, then click with os.screen.click using that image's pixel x,y.",
    argsSchema:
      "{ region?: { x: number, y: number, width: number, height: number } /* screen points; omit for the whole main screen */ }",
    tier: "rare",
  },
  {
    name: "os.screen.click",
    summary:
      "Click at x,y given in the pixels of the last os.screen.capture image (the scale is remembered). Asks the user first.",
    argsSchema:
      '{ x: number, y: number, button?: "left"|"right", double?: boolean, scale?: number /* only to override the remembered capture */ }',
    tier: "rare",
  },
  {
    name: "os.screen.type",
    summary:
      "Type text into the focused field of the frontmost app, as keystrokes. Asks the user first.",
    argsSchema: "{ text: string /* at most 2000 chars */ }",
    tier: "rare",
  },
  {
    name: "os.screen.key",
    summary:
      'Press a key or shortcut in the frontmost app, e.g. "return", "escape", "down", "cmd+l", "cmd+shift+t". Asks the user first.',
    argsSchema: "{ keys: string }",
    tier: "rare",
  },
];
