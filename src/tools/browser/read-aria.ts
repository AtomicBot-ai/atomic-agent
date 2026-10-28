import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { BrowserBackend } from "./browser-backend.js";
import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import {
  blockedDomainMessage,
  EMPTY_DOMAIN_POLICY,
  type BrowserDomainPolicy,
} from "./browser-domain-policy.js";
import { AriaSnapshotStore, parseAriaViewMode, readAriaView } from "./aria-view.js";

const REF_PATTERN = /^[a-zA-Z0-9]+$/;

/**
 * A page on a blocked host, or framing one, is refused: none of its
 * content reaches the model. In the user's own Chrome a site not yet
 * cleared this session asks first (`dangerous`; without it, refused;
 * `gate-page-read.ts`). `mode` picks the view (ATO-956, `aria-view.ts`): `full` (the
 * whole tree), `interactive` (controls only), `diff` (changes by ref
 * since this tab's last snapshot) or `region` (the subtree under `ref`).
 * Without `mode`, a local or small-window model gets `interactive`.
 */
export function buildBrowserReadAriaTool(
  backend: BrowserBackend,
  policy: BrowserDomainPolicy = EMPTY_DOMAIN_POLICY,
  store: AriaSnapshotStore = new AriaSnapshotStore(),
  dangerous?: DangerousToolOptions,
): ToolDefinition {
  return {
    name: "browser.read_aria",
    description:
      "Capture an ARIA snapshot of the active page with stable `ref` identifiers. `mode`: full | interactive | diff | region (with `ref`).",
    readonly: true,
    async run(rawArgs, ctx) {
      const depth =
        typeof rawArgs.depth === "number" && Number.isFinite(rawArgs.depth)
          ? Math.max(1, Math.floor(rawArgs.depth))
          : undefined;
      const mode = parseAriaViewMode(rawArgs.mode);
      if (typeof mode === "object") throw new Error(`browser.read_aria: ${mode.error}`);
      const ref = rawArgs.ref;
      if (ref !== undefined && ref !== null && (typeof ref !== "string" || !REF_PATTERN.test(ref))) {
        throw new Error("browser.read_aria: `ref` must be an alphanumeric ref from the latest snapshot");
      }
      await backend.ensureReady();
      const result = await readAriaView(
        backend,
        {
          ...(mode !== undefined ? { mode } : {}),
          ...(typeof ref === "string" ? { ref } : {}),
          ...(depth !== undefined ? { depth } : {}),
        },
        {
          ...(ctx.modelMode ? { modelMode: ctx.modelMode } : {}),
          ...(ctx.contextWindowTokens !== undefined ? { contextWindowTokens: ctx.contextWindowTokens } : {}),
          sessionId: ctx.sessionId,
        },
        policy,
        store,
        dangerous ? { dangerous, tool: "browser.read_aria", signal: ctx.signal } : undefined,
      );
      if (result.kind === "blocked") {
        return compressToolResult({
          tool: "browser.read_aria",
          status: "error",
          output: blockedDomainMessage("browser.read_aria", result.host),
          details: { host: result.host, reason: "blocked_domain" },
        });
      }
      if (result.kind === "user_site_not_cleared") {
        return compressToolResult({
          tool: "browser.read_aria",
          status: "error",
          output: `browser.read_aria: ${result.host} has not been opened in your own Chrome this session`,
          details: { host: result.host, reason: "user_site_not_cleared" },
        });
      }
      if (result.kind === "error") {
        return compressToolResult({
          tool: "browser.read_aria",
          status: "error",
          output: `browser.read_aria: ${result.message}`,
          details: { reason: "bad_view" },
        });
      }
      const { snapshot, view } = result;
      // The ARIA tree is deliberately NOT duplicated in the tool_result
      // summary: it already lands in `session.worldSnapshot` through
      // `details.worldSnapshot` and appears in the prompt's `### world`
      // section. Echoing it here would make the conversation tail fight
      // with `### world` for the model's attention and cause "I haven't
      // seen results, search again" loops.
      const output = [
        `captured ARIA snapshot`,
        `  url: ${snapshot.url}`,
        `  title: ${snapshot.title}`,
        `  view: ${view.mode}`,
        `  refs: ${view.refs.length}`,
        `  digest: ${view.digest}`,
        ...(view.note ? [`  note: ${view.note}`] : []),
        `  see ### world for the page`,
      ].join("\n");
      return compressToolResult({
        tool: "browser.read_aria",
        status: "ok",
        output,
        details: {
          url: snapshot.url,
          title: snapshot.title,
          view: view.mode,
          digest: view.digest,
          refCount: view.refs.length,
          // Surfaced to step-executor.applyStateEffects so the ARIA tree
          // lands in `session.worldSnapshot` and the next prompt's
          // `### world` section reflects the current page.
          worldSnapshot: {
            kind: "browser" as const,
            digest: view.digest,
            text: view.text,
          },
        },
      });
    },
  };
}
