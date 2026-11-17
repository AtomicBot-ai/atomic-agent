import type { runCommand as defaultRunCommand } from "../../../sandbox/command-runner.js";
import { detectChallenge } from "./web-fetch-challenge.js";
import {
  enabledReaders,
  readWithReader,
  type ReaderName,
  type ReaderSettings,
} from "./web-fetch-readers.js";
import {
  assertHostAllowed,
  parseHttpUrl,
  type HostLookup,
} from "./web-fetch-ssrf-guard.js";

/**
 * The page-read ladder of `os.web.fetch` (ATO-968):
 *
 *  1. `curl` — curl + extraction, as always.
 *  2. `browser` — curl hit a bot wall (`web-fetch-challenge.ts`): the page
 *     is rendered in the agent's own browser (`web.fetch.renderWithBrowser`,
 *     never the user's own Chrome).
 *  3. `jina` / `firecrawl` — still walled: a reader service the user
 *     enabled or gave a key to.
 *
 * The step that read the page is reported to the model.
 */
export type ReadVia = "curl" | "browser" | ReaderName;

/**
 * Renders a page in the agent's own browser. Structurally the same as
 * `BrowserPageRenderer` in `src/tools/browser/render-page.ts`; the
 * composition root wires one into the other. Resolves `null` when the
 * browser may not be used for this URL.
 */
export type PageRenderer = (input: {
  url: string;
  timeoutMs: number;
  isStillWalled?: (html: string) => boolean;
}) => Promise<{ finalUrl: string; title: string; html: string } | null>;

export interface LadderPage {
  via: Exclude<ReadVia, "curl">;
  finalUrl: string;
  body: string;
  contentType: "text/html" | "text/markdown";
  title?: string;
}

export interface LadderOutcome {
  page: LadderPage | null;
  /** One line per step tried, for the error the model reads. */
  attempts: string[];
}

export interface LadderInput {
  url: string;
  timeoutMs: number;
  cwd: string;
  signal: AbortSignal;
  renderPage?: PageRenderer;
  renderWithBrowser: boolean;
  readers: ReaderSettings;
  runCommand?: typeof defaultRunCommand;
  lookup?: HostLookup;
  env?: NodeJS.ProcessEnv;
}

const isWalledHtml = (html: string): boolean =>
  detectChallenge({ status: 200, contentType: "text/html", body: html })
    .challenged;

/** Steps 2 and 3, run after curl got a challenge page for `input.url`. */
export async function readPastWall(input: LadderInput): Promise<LadderOutcome> {
  const attempts: string[] = [];

  if (input.renderWithBrowser && input.renderPage && !input.signal.aborted) {
    try {
      const rendered = await input.renderPage({
        url: input.url,
        timeoutMs: input.timeoutMs,
        isStillWalled: isWalledHtml,
      });
      if (rendered === null) {
        attempts.push("browser: not used for this site");
      } else if (isWalledHtml(rendered.html)) {
        attempts.push("browser: still a challenge page");
      } else {
        // The browser follows redirects on its own; the page it landed on
        // must pass the same private-address check as every curl hop.
        await assertHostAllowed(parseHttpUrl(rendered.finalUrl), {
          lookup: input.lookup,
        });
        return {
          page: {
            via: "browser",
            finalUrl: rendered.finalUrl,
            body: rendered.html,
            contentType: "text/html",
            ...(rendered.title ? { title: rendered.title } : {}),
          },
          attempts,
        };
      }
    } catch (err) {
      attempts.push(`browser: ${shortReason(err)}`);
    }
  }

  for (const reader of enabledReaders(input.readers, input.env)) {
    if (input.signal.aborted) break;
    try {
      const page = await readWithReader(
        reader,
        input.readers,
        {
          url: input.url,
          timeoutMs: input.timeoutMs,
          cwd: input.cwd,
          signal: input.signal,
          runCommand: input.runCommand,
          lookup: input.lookup,
        },
        input.env,
      );
      return {
        page: {
          via: reader,
          finalUrl: page.finalUrl,
          body: page.markdown,
          contentType: "text/markdown",
          ...(page.title ? { title: page.title } : {}),
        },
        attempts,
      };
    } catch (err) {
      attempts.push(`${reader}: ${shortReason(err)}`);
    }
  }

  return { page: null, attempts };
}

/** The line that opens a page read past step 1, so the model knows how. */
export function describeReadVia(via: Exclude<ReadVia, "curl">): string {
  const how =
    via === "browser"
      ? "rendered in the agent's own browser"
      : via === "jina"
        ? "read through Jina Reader"
        : "read through Firecrawl";
  return `[os.web.fetch: the plain fetch hit a bot-protection wall; this page was ${how}.]`;
}

function shortReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const line = message.split("\n", 1)[0] ?? "";
  return line.length > 160 ? `${line.slice(0, 157)}...` : line || "failed";
}
