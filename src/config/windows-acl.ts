import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";

/** I/O seams, injectable for tests. Production callers omit them. */
export interface WindowsAclDeps {
  platform: NodeJS.Platform;
  username: () => string;
  /** Run `icacls` with the given args; throws on failure. */
  runIcacls: (args: string[]) => void;
  /** Throws when the file cannot be read by the current process. */
  probeRead: (path: string) => void;
}

function defaultDeps(): WindowsAclDeps {
  return {
    platform: process.platform,
    username: () => userInfo().username,
    runIcacls: (args) => {
      execFileSync("icacls", args, {
        stdio: "ignore",
        timeout: 5_000,
        windowsHide: true,
      });
    },
    probeRead: (path) => {
      readFileSync(path);
    },
  };
}

/**
 * On Windows `chmod 0600` does not map to NTFS ACLs (Node only toggles the
 * read-only bit), so a secret file would stay readable by other local
 * users. Best-effort tighten the ACL to the current user only via `icacls`
 * (`/inheritance:r` drops inherited grants).
 *
 * The tightened ACL is then **verified with a probe read**. `icacls`
 * resolves the account name on its own (local vs domain vs Microsoft
 * accounts), and a grant that resolves to a different principal than the
 * one running the agent would leave the file readable by nobody after
 * `/inheritance:r` — the loader would then hit EPERM on every startup.
 * That is one plausible cause of the symptom reported in #59, not a
 * confirmed root cause; the probe closes it off either way. When the
 * probe fails, the ACL is rolled back with `icacls /reset` (restore
 * inherited grants): a secret file with the default user-profile ACL is
 * strictly better than one the agent itself can no longer read.
 *
 * All failures are swallowed — if `icacls` is unavailable the file keeps
 * the default (inherited) ACL, which is weaker; this is the documented
 * Windows limitation.
 */
export function restrictWindowsAcl(
  path: string,
  deps: WindowsAclDeps = defaultDeps(),
): void {
  if (deps.platform !== "win32") return;
  let username: string;
  try {
    username = deps.username();
  } catch {
    return;
  }
  if (!username) return;
  try {
    deps.runIcacls([path, "/inheritance:r", "/grant:r", `${username}:F`]);
  } catch {
    // Best-effort: leave the default ACL in place if icacls is missing or
    // rejects (e.g. domain account name mismatch). The probe below still
    // runs — icacls may have applied a partial change before failing.
  }
  try {
    deps.probeRead(path);
    return;
  } catch {
    // The file is no longer readable by this very process. Roll back.
  }
  try {
    deps.runIcacls([path, "/reset"]);
  } catch {
    // Best-effort: nothing else we can safely do here. The startup
    // loader will surface the unreadable file loudly (#59).
  }
}
