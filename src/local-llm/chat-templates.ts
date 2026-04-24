import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { LocalModelDef } from "./models-catalog.js";

/**
 * Resolve bundled jinja asset path. Works from both `src/local-llm/` (tsx)
 * and `dist/local-llm/` (compiled): parent-of-parent is project root.
 */
export function resolveChatTemplatePath(model: LocalModelDef): string | null {
  if (!model.chatTemplateAsset) return null;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, "..", "..", "assets", "ai-models", model.chatTemplateAsset);
  return existsSync(candidate) ? candidate : null;
}
