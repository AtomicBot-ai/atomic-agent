import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { promisify } from "node:util";
import { checkGitUrl, MarketplaceError } from "./marketplace-manifest.js";

const execFileAsync = promisify(execFile);

/**
 * Everything marketplaces need from the network, behind one interface so
 * tests pass a fake and never go online. Fetching never runs code from
 * what it fetched: git hooks are switched off, nothing is built or
 * installed, submodules and LFS objects are not pulled.
 */
export interface PluginFetcher {
  /**
   * Put the files of `url` at `ref` (branch, tag or commit; default branch
   * when absent) into the empty folder `dest`, shallow. When `sha` is set
   * that exact commit is checked out instead. Returns the commit checked out.
   */
  gitCheckout(url: string, dest: string, opts?: { ref?: string; sha?: string }): Promise<{ sha: string }>;
  /** GET a small text file over https (a bare marketplace.json). */
  fetchText(url: string): Promise<string>;
}

const GIT_TIMEOUT_MS = 180_000;
const TEXT_TIMEOUT_MS = 30_000;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;

/**
 * Git config applied to every call. `core.hooksPath=/dev/null` keeps any
 * hook (global or template) from running; `core.symlinks=false` checks
 * symlinks out as small text files, so nothing in the checkout points
 * outside it; `protocol.file`/`ext` stay closed even if an entry slipped
 * past `checkGitUrl`.
 */
const SAFE_GIT_CONFIG = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.symlinks=false",
  "-c", "core.fsmonitor=false",
  "-c", "protocol.file.allow=never",
  "-c", "protocol.ext.allow=never",
  "-c", "submodule.recurse=false",
  "-c", "advice.detachedHead=false",
];

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0", // never wait on a password prompt
    GCM_INTERACTIVE: "never",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

/** Real fetcher: the `git` CLI for repos, `fetch` for JSON files. */
export function createDefaultPluginFetcher(options: { git?: string; fetchImpl?: typeof fetch } = {}): PluginFetcher {
  const gitBin = options.git ?? "git";
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const git = async (cwd: string, args: string[]): Promise<string> => {
    try {
      const { stdout } = await execFileAsync(gitBin, [...SAFE_GIT_CONFIG, ...args], {
        cwd,
        env: gitEnv(),
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      });
      return stdout.trim();
    } catch (err) {
      const e = err as { code?: string; stderr?: string; message?: string };
      if (e.code === "ENOENT") throw new MarketplaceError("git is not installed; install git to add marketplaces from a repository");
      const detail = (e.stderr || e.message || String(err)).trim().split("\n").slice(-3).join(" ");
      throw new MarketplaceError(`git ${args[0]} failed: ${detail}`);
    }
  };
  return {
    async gitCheckout(url, dest, opts = {}) {
      const safeUrl = checkGitUrl(url);
      // Servers serve a full commit id directly; a short one needs its branch fetched, then checked.
      const want = opts.sha && /^[0-9a-f]{40}$/i.test(opts.sha) ? opts.sha : opts.ref;
      if (want !== undefined && (want.startsWith("-") || /\s/.test(want))) throw new MarketplaceError(`bad git ref: ${want}`);
      mkdirSync(dest, { recursive: true });
      // init + fetch one commit works the same for a branch, a tag or a commit id.
      await git(dest, ["init", "-q"]);
      await git(dest, ["remote", "add", "origin", safeUrl]);
      await git(dest, ["fetch", "-q", "--depth", "1", "--no-tags", "--no-recurse-submodules", "origin", want ?? "HEAD"]);
      await git(dest, ["checkout", "-q", "--detach", "FETCH_HEAD"]);
      const sha = await git(dest, ["rev-parse", "HEAD"]);
      if (opts.sha && !sha.toLowerCase().startsWith(opts.sha.toLowerCase())) {
        throw new MarketplaceError(`expected commit ${opts.sha} but got ${sha}`);
      }
      return { sha };
    },
    async fetchText(url) {
      if (!/^https:\/\//i.test(url)) throw new MarketplaceError(`only https URLs are allowed: ${url}`);
      let res: Response;
      try {
        res = await fetchImpl(url, { headers: { "User-Agent": "atomic-agent" }, signal: AbortSignal.timeout(TEXT_TIMEOUT_MS) });
      } catch (err) {
        throw new MarketplaceError(`could not download ${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!res.ok) throw new MarketplaceError(`could not download ${url}: HTTP ${res.status}`);
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > MAX_TEXT_BYTES) throw new MarketplaceError(`${url} is larger than 4 MiB`);
      const text = await res.text();
      if (text.length > MAX_TEXT_BYTES) throw new MarketplaceError(`${url} is larger than 4 MiB`);
      return text;
    },
  };
}

/** `https://github.com/<owner>/<repo>.git` for a GitHub shorthand. */
export function githubUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}
