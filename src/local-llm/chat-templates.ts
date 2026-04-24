import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { LocalModelDef } from "./models-catalog.js";

/**
 * Resolve bundled jinja asset path.
 * - Redistributable SEA layout: `<dirname(process.execPath)>/assets/ai-models/<file>`.
 * - Dev / npm: `src` or `dist` tree under project root (parent-of-parent of this file).
 */
export function resolveChatTemplatePath(model: LocalModelDef): string | null {
  if (!model.chatTemplateAsset) return null;

  const nextToBinary = join(
    dirname(process.execPath),
    "assets",
    "ai-models",
    model.chatTemplateAsset,
  );
  if (existsSync(nextToBinary)) {
    return nextToBinary;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, "..", "..", "assets", "ai-models", model.chatTemplateAsset);
  return existsSync(candidate) ? candidate : null;
}
