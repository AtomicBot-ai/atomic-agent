/**
 * Which build this is (ATO-241). Every team build is 0.0.1, so the support
 * report and Settings › General › Version could not tell two builds apart.
 *
 * electron-builder.cjs stamps the commit, and on CI the workflow run, into the
 * app's package.json (`atagBuild`, through `extraMetadata`). `npm run dev`
 * packs nothing, so there the checkout's own commit is read, once; with no git
 * it is just "dev". A build that carries no stamp at all reads "local". None of
 * this can throw: a support report is the last place to fail.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface BuildStamp {
  /** The short commit (8 hex), or null when it is not known. */
  sha: string | null;
  /** The workflow's run number (the "#812" GitHub shows), CI builds only. */
  run: string | null;
  /** The workflow's run id (the number in the run's URL), CI builds only. */
  runId: string | null;
  /** Not packaged: `npm run dev` / `npm start`. */
  dev: boolean;
}

const SHA = /^[0-9a-f]{7,40}$/;
const NUM = /^\d+$/;

export function readBuildStamp(appPath: string, packaged: boolean): BuildStamp {
  let meta: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(readFileSync(join(appPath, "package.json"), "utf8")) as { atagBuild?: unknown };
    if (pkg.atagBuild && typeof pkg.atagBuild === "object") meta = pkg.atagBuild as Record<string, unknown>;
  } catch {
    meta = {};
  }
  const str = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v) ? v : null);
  let sha = str(meta.sha, SHA);
  if (!sha && !packaged) {
    try {
      const out = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], {
        cwd: appPath, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
      }).trim();
      sha = SHA.test(out) ? out : null;
    } catch {
      sha = null;
    }
  }
  return { sha: sha ? sha.slice(0, 8) : null, run: str(meta.run, NUM), runId: str(meta.runId, NUM), dev: !packaged };
}

/** "225f9470 · run 812" (CI), "225f9470 · local" (built by hand), "225f9470 · dev", or "dev" / "local" with no commit. */
export function buildStampLabel(b: BuildStamp): string {
  const where = b.dev ? "dev" : "local";
  if (!b.sha) return where;
  return b.run ? `${b.sha} · run ${b.run}` : `${b.sha} · ${where}`;
}
