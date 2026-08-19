import { registerCliAdapter } from "./cli-adapter-descriptor.js";
import { claudeCliAdapter } from "./claude-cli-adapter.js";

let registered = false;

/**
 * Wire the shipped CLI descriptors into the lookup. Idempotent, and
 * called from the provider factory so importing the provider class
 * alone never has a registration side effect.
 */
export function registerBuiltInCliAdapters(): void {
  if (registered) return;
  registered = true;
  registerCliAdapter(claudeCliAdapter);
}
