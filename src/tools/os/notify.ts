import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";

interface NotifierApi {
  notify: (options: { title: string; message: string; sound?: boolean }) => Promise<void>;
}

let cached: NotifierApi | null = null;

async function loadNotifier(): Promise<NotifierApi> {
  if (cached) return cached;
  const mod = await import("node-notifier");
  const notifier = (mod as { default?: { notify: Function } }).default ?? mod;
  cached = {
    notify: (opts) =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        (notifier as unknown as { notify: Function }).notify(
          opts,
          (err: unknown) => {
            if (err) rejectPromise(err as Error);
            else resolvePromise();
          },
        );
      }),
  };
  return cached;
}

export const osNotifyTool: ToolDefinition = {
  name: "os.notify",
  description: "Show a system notification (title + message).",
  readonly: false,
  async run(rawArgs) {
    const title = rawArgs.title;
    const message = rawArgs.message;
    if (typeof title !== "string" || title.length === 0) {
      throw new Error("os.notify: `title` must be a non-empty string");
    }
    if (typeof message !== "string") {
      throw new Error("os.notify: `message` must be a string");
    }
    const sound = rawArgs.sound === true;
    try {
      const notifier = await loadNotifier();
      await notifier.notify({ title, message, sound });
      return compressToolResult({
        tool: "os.notify",
        status: "ok",
        output: `notified: ${title}`,
        details: { title, message, sound },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return compressToolResult({
        tool: "os.notify",
        status: "error",
        output: `notify failed: ${msg}`,
        details: { title, message, sound, error: msg },
      });
    }
  },
};
