import { statSync } from "node:fs";
import { basename } from "node:path";
import {
  compressToolResult,
  type CompressedToolResult,
} from "../../compressor/result-compressor.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../approval/dangerous-tool.js";
import type { ToolContext, ToolDefinition } from "../tool-registry.js";
import { resolveUserPath } from "../os/expand-home.js";
import type { BrowserBackend, PageActionInput } from "./browser-backend.js";
import {
  blockedDomainMessage,
  checkBrowserHost,
  EMPTY_DOMAIN_POLICY,
  webHostOf,
  type BrowserDomainPolicy,
} from "./browser-domain-policy.js";
import { gateBrowserAction } from "./gate-browser-action.js";
import { recheckLandedPage } from "./gate-browser-url.js";
import { keyCommits, parsePageAction } from "./page-action-args.js";

const TOOL = "browser.act";
type Ctx = Pick<ToolContext, "sessionId" | "signal" | "workingDir">;

/**
 * `browser.act` (ATO-957): the page actions click / type do not cover,
 * in one tool so the tool list and a local model's grammar stay small.
 *
 * Gates, before the backend acts:
 *  - every action on a blocked host is refused (`blocked_domain`);
 *  - `upload` sends local files to the site: asks as `browser_secret`
 *    every time, with the file names in the preview;
 *  - `key` Enter / Space may send or press what is focused: with a `ref`
 *    it goes through the click / type gate, without one it asks as
 *    `browser_commit` (the focused element cannot be inspected);
 *  - `dialog` accept may confirm a delete or a payment: asks as
 *    `browser_commit`; dismissing does not ask;
 *  - in the user's own Chrome every `browser_commit` asks as `browser_secret`.
 * select, hover, back, forward and wait do not ask. After select, key,
 * back and forward the landed page is re-checked against the block list.
 */
export function buildBrowserActTool(
  backend: BrowserBackend,
  dangerous: DangerousToolOptions,
  policy: BrowserDomainPolicy = EMPTY_DOMAIN_POLICY,
): ToolDefinition {
  return {
    name: TOOL,
    description:
      "More page actions: select (option values or labels in a <select>), upload (local files into a file input), back, forward, key (press a key, e.g. Enter, Escape, Tab, ArrowDown), hover, dialog (answer the next alert / confirm / prompt: call it BEFORE the click that opens one), wait (for text to appear or go, for a ref, or a pause in ms).",
    readonly: false,
    async run(rawArgs, ctx) {
      const input = parsePageAction(rawArgs);
      const files = input.action === "upload" ? resolveUploadFiles(input.paths, ctx.workingDir) : [];
      await backend.ensureReady();
      if (backend.act === undefined) {
        return errorResult(`${TOOL} is not supported by this browser backend`, { reason: "unsupported" });
      }
      const ref = "ref" in input ? input.ref : undefined;
      if (ref !== undefined && !(await backend.hasRef(ref))) {
        return errorResult(
          `ref '${ref}' is not present on the current page — refs are invalidated by any navigation or search; call browser.read_aria to get fresh refs`,
          { ref, reason: "stale_ref" },
        );
      }
      const refused = await gateAct(backend, dangerous, policy, input, files, ctx);
      if (refused) return refused;
      const payload: PageActionInput =
        input.action === "upload" ? { ...input, paths: files.map((file) => file.path) } : input;
      const result = await backend.act(payload);
      if (navigates(input)) {
        const landed = await recheckLandedPage(backend, policy, TOOL);
        if (landed) return landed;
      }
      return compressToolResult({
        tool: TOOL,
        status: result.done ? "ok" : "error",
        output: result.note,
        details: { action: input.action, ...(ref !== undefined ? { ref } : {}), done: result.done },
      });
    },
  };
}

interface UploadFile {
  path: string;
  bytes: number;
}

/** Absolute, existing regular files; anything else is an argument error. */
export function resolveUploadFiles(paths: readonly string[], workingDir: string): UploadFile[] {
  return paths.map((raw) => {
    const path = resolveUserPath(raw, workingDir);
    let size: number;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) throw new Error("not a file");
      size = stat.size;
    } catch {
      throw new Error(`${TOOL}: upload: '${raw}' is not an existing file`);
    }
    return { path, bytes: size };
  });
}

function navigates(input: PageActionInput): boolean {
  return input.action === "back" || input.action === "forward" || input.action === "select" || input.action === "key";
}

function errorResult(output: string, details: Record<string, unknown>): CompressedToolResult {
  return compressToolResult({ tool: TOOL, status: "error", output, details });
}

async function pageHost(backend: BrowserBackend): Promise<string | null> {
  try {
    return webHostOf(await backend.currentUrl());
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function askCommit(
  dangerous: DangerousToolOptions,
  policy: BrowserDomainPolicy,
  host: string | null,
  reason: string,
  preview: string,
  ctx: Ctx,
): Promise<void> {
  // In the user's own Chrome a commit acts as them: every time, never granted.
  const escalate = policy.userProfile === true;
  await requireApproval(
    dangerous,
    {
      sessionId: ctx.sessionId,
      tool: TOOL,
      category: escalate ? "browser_secret" : "browser_commit",
      reason: escalate ? `in your own Chrome: ${reason}` : reason,
      preview,
      ...(host !== null ? { affectedResources: [host] } : {}),
    },
    ctx.signal,
  );
}

async function gateAct(
  backend: BrowserBackend,
  dangerous: DangerousToolOptions,
  policy: BrowserDomainPolicy,
  input: PageActionInput,
  files: readonly UploadFile[],
  ctx: Ctx,
): Promise<CompressedToolResult | null> {
  // `wait` only watches the page; back / forward land on pages this tab
  // already opened, and the landing is re-checked after.
  if (input.action === "wait" || input.action === "back" || input.action === "forward") return null;
  const host = await pageHost(backend);
  if (host !== null && checkBrowserHost(host, policy).kind === "blocked") {
    return errorResult(blockedDomainMessage(TOOL, host), { host, reason: "blocked_domain" });
  }
  const where = host !== null ? ` on ${host}` : "";
  switch (input.action) {
    case "upload": {
      const list = files.map((file) => `${basename(file.path)} (${formatBytes(file.bytes)})`).join(", ");
      await requireApproval(
        dangerous,
        {
          sessionId: ctx.sessionId,
          tool: TOOL,
          category: "browser_secret",
          reason: "uploading local files sends them to the site",
          preview: `upload ${files.length === 1 ? "1 file" : `${files.length} files`}${where}: ${list}\n${files.map((file) => file.path).join("\n")}`,
          ...(host !== null ? { affectedResources: [host] } : {}),
        },
        ctx.signal,
      );
      return null;
    }
    case "key": {
      const commit = keyCommits(input.key);
      if (commit === null) return null;
      if (input.ref !== undefined) {
        return gateBrowserAction(
          backend,
          dangerous,
          policy,
          {
            tool: TOOL,
            kind: commit === "enter" ? "type_enter" : "click",
            ref: input.ref,
            label: `press ${input.key} on`,
          },
          ctx,
        );
      }
      await askCommit(dangerous, policy, host, `${input.key} may send or submit what is focused`, `press ${input.key}${where}`, ctx);
      return null;
    }
    case "dialog":
      if (!input.accept) return null;
      await askCommit(
        dangerous,
        policy,
        host,
        "accepting a dialog may confirm a delete, a send or a payment",
        `accept the next dialog${where}${input.text !== undefined ? `, answering ${JSON.stringify(input.text.slice(0, 120))}` : ""}`,
        ctx,
      );
      return null;
    default:
      // select, hover: no commit of their own (a select that submits on
      // change lands on a page that is re-checked after).
      return null;
  }
}
