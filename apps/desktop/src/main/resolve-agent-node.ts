import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MIN_NODE_MAJOR = 25;

interface RepoVoltaPin {
  volta?: { node?: string };
}

/**
 * Resolve a Node.js binary compatible with the agent runtime (Node >= 25).
 * Electron embeds Node 22 — never use process.execPath or PATH-resolved `tsx`
 * wrappers here, or native modules like better-sqlite3 ABI-mismatch.
 */
export function resolveAgentNodeBinary(repoRoot: string): string {
  const override = process.env.ATOMIC_AGENT_NODE?.trim();
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`ATOMIC_AGENT_NODE points to missing file: ${override}`);
    }
    assertNodeVersion(override);
    return override;
  }

  const voltaPinned = resolveVoltaPinnedNode(repoRoot);
  if (voltaPinned) {
    assertNodeVersion(voltaPinned);
    return voltaPinned;
  }

  const voltaBin =
    process.env.VOLTA_BIN?.trim() ??
    join(homedir(), ".volta", "bin", "volta");
  if (existsSync(voltaBin)) {
    try {
      const resolved = execFileSync(voltaBin, ["which", "node"], {
        cwd: repoRoot,
        encoding: "utf8",
        env: buildVoltaEnv(),
      }).trim();
      if (resolved && existsSync(resolved)) {
        assertNodeVersion(resolved);
        return resolved;
      }
    } catch {
      // fall through
    }
  }

  const candidates = [
    process.env.npm_node_execpath,
    process.env.NODE_BINARY,
  ].filter((value): value is string => Boolean(value?.trim()));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      assertNodeVersion(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }

  throw new Error(
    [
      "Could not find Node.js >= 25 for the atomic-agent sidecar.",
      "Electron ships Node 22; the sidecar must run on the repo's Node 25 runtime.",
      "Fix: install Volta (repo pins 25.7.0), or set ATOMIC_AGENT_NODE=/path/to/node25.",
    ].join(" "),
  );
}

/** Volta image path — works even when Electron strips PATH. */
function resolveVoltaPinnedNode(repoRoot: string): string | null {
  let pin: string | undefined;
  try {
    const raw = readFileSync(join(repoRoot, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as RepoVoltaPin;
    pin = pkg.volta?.node;
  } catch {
    return null;
  }
  if (!pin) return null;

  const imageNode = join(
    homedir(),
    ".volta",
    "tools",
    "image",
    "node",
    pin,
    "bin",
    process.platform === "win32" ? "node.exe" : "node",
  );
  return existsSync(imageNode) ? imageNode : null;
}

export function buildSidecarChildEnv(): NodeJS.ProcessEnv {
  return buildVoltaEnv();
}

function buildVoltaEnv(): NodeJS.ProcessEnv {
  const home = homedir();
  const voltaHome = process.env.VOLTA_HOME ?? join(home, ".volta");
  const voltaBin = join(voltaHome, "bin");
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const currentPath = process.env[pathKey] ?? "";
  return {
    ...process.env,
    VOLTA_HOME: voltaHome,
    [pathKey]: `${voltaBin}${process.platform === "win32" ? ";" : ":"}${currentPath}`,
  };
}

function assertNodeVersion(nodeBin: string): void {
  const versionOutput = execFileSync(nodeBin, ["-p", "process.versions.node"], {
    encoding: "utf8",
    env: buildVoltaEnv(),
  }).trim();
  const major = Number.parseInt(versionOutput.split(".")[0] ?? "", 10);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    throw new Error(
      `${nodeBin} is Node ${versionOutput}; atomic-agent requires >= ${MIN_NODE_MAJOR}`,
    );
  }
}
