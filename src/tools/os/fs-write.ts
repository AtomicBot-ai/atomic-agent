import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { compressToolResult } from "../../compressor/result-compressor.js";
import { resolveUserPath } from "./expand-home.js";
import type { ToolDefinition } from "../tool-registry.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../approval/dangerous-tool.js";

export function buildOsFsWriteTool(
  options: DangerousToolOptions,
): ToolDefinition {
  return {
    name: "os.fs.write",
    description:
      "Write text content to a file (creating parents). Dangerous — always requires approval.",
    readonly: false,
    async run(rawArgs, ctx) {
      const path = rawArgs.path;
      const content = rawArgs.content;
      if (typeof path !== "string" || path.length === 0) {
        throw new Error("os.fs.write: `path` must be a non-empty string");
      }
      if (typeof content !== "string") {
        throw new Error("os.fs.write: `content` must be a string");
      }
      const mode =
        typeof rawArgs.mode === "string" && rawArgs.mode === "append"
          ? "append"
          : "replace";
      const absolute = resolveUserPath(path, ctx.workingDir);

      const preview = content.length > 400 ? `${content.slice(0, 400)}…` : content;
      await requireApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: "os.fs.write",
          reason: `${mode} ${content.length} bytes into ${absolute}`,
          preview,
          affectedResources: [absolute],
        },
        ctx.signal,
      );

      await mkdir(dirname(absolute), { recursive: true });
      if (mode === "append") {
        const { appendFile } = await import("node:fs/promises");
        await appendFile(absolute, content, "utf8");
      } else {
        await writeFile(absolute, content, "utf8");
      }
      return compressToolResult({
        tool: "os.fs.write",
        status: "ok",
        output: `wrote ${content.length} bytes to ${absolute} (${mode})`,
        details: { path: absolute, bytes: content.length, mode },
      });
    },
  };
}
