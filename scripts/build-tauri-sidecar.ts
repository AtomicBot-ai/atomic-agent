/**
 * Build a Node SEA (Single Executable Application) binary for the atomic-agent
 * **sidecar** and place it under `src-tauri/binaries/` using the Tauri
 * `externalBin` naming convention: `atomic-agent-sidecar-<rustTriple>[.exe]`.
 *
 * Mirrors `scripts/build-binary.ts` (the CLI SEA pipeline) but embeds the
 * sidecar entry (`dist-sea/sidecar.mjs`, built by `bundle:sidecar-sea`) and
 * targets the Tauri host-shell layout instead of `bundle/<slug>/`. Like the
 * CLI pipeline, SEA has no cross-compilation — CI runs this on each target
 * runner and the Rust shell picks up the matching triple.
 *
 * Usage:
 *   npx tsx scripts/build-tauri-sidecar.ts
 *
 * Prerequisites:
 *   - Node >= 25.7.0 (SEA with `mainFormat: module`)
 *   - `npm run build` has produced `dist/`
 *   - `sea-config-sidecar.json` at the repo root is the SEA manifest
 */
import { copyFile, mkdir, chmod, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  exit,
  execPath,
  stdout,
  stderr,
  platform,
  versions,
} from "node:process";
import { currentTarget } from "./bundle-targets.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TAURI_BINARIES_DIR = join(ROOT, "src-tauri", "binaries");
const SIDECAR_BASE_NAME = "atomic-agent-sidecar";

const MIN_NODE_FOR_SEA_ESM = [25, 7, 0] as const;

function parseSemver(raw: string): [number, number, number] {
  const [maj, min, pat] = raw.split(".").map((n) => Number.parseInt(n, 10));
  return [maj ?? 0, min ?? 0, pat ?? 0];
}

function isAtLeast(
  actual: readonly [number, number, number],
  required: readonly [number, number, number],
): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (actual[i] > required[i]) return true;
    if (actual[i] < required[i]) return false;
  }
  return true;
}

async function run(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  const target = currentTarget();
  const isWindows = platform === "win32";
  const suffix = isWindows ? ".exe" : "";
  // Tauri appends the target triple to the `externalBin` base name.
  const binaryName = `${SIDECAR_BASE_NAME}-${target.rustTriple}${suffix}`;
  const binaryPath = join(TAURI_BINARIES_DIR, binaryName);
  const blobPath = join(ROOT, "bundle", "sea-prep-sidecar.blob");

  const nodeVersion = parseSemver(versions.node);
  if (!isAtLeast(nodeVersion, MIN_NODE_FOR_SEA_ESM)) {
    const [maj, min, pat] = MIN_NODE_FOR_SEA_ESM;
    stderr.write(
      `node ${versions.node} is too old to build the SEA binary.\n` +
        `  SEA with \`"mainFormat": "module"\` requires Node >= ${maj}.${min}.${pat}.\n` +
        `  Install a newer Node (e.g. via \`nvm install ${maj}\`) and re-run.\n`,
    );
    return 2;
  }

  if (!(await exists(join(ROOT, "dist", "sidecar", "main.js")))) {
    stderr.write("dist/sidecar/main.js not found — run `npm run build` first.\n");
    return 2;
  }

  const seaEntry = join(ROOT, "dist-sea", "sidecar.mjs");
  if (!(await exists(seaEntry))) {
    stdout.write(
      "dist-sea/sidecar.mjs not found — running `npm run bundle:sidecar-sea` …\n",
    );
    await run("npm", ["run", "bundle:sidecar-sea"], ROOT);
  }
  if (!(await exists(seaEntry))) {
    stderr.write("dist-sea/sidecar.mjs still missing after bundle:sidecar-sea.\n");
    return 2;
  }

  await mkdir(join(ROOT, "bundle"), { recursive: true });
  await mkdir(TAURI_BINARIES_DIR, { recursive: true });

  const isDarwin = platform === "darwin";
  const steps = isDarwin ? 4 : 3;

  stdout.write(`[1/${steps}] generating SEA blob -> ${blobPath}\n`);
  await run(
    execPath,
    ["--experimental-sea-config", resolve(ROOT, "sea-config-sidecar.json")],
    ROOT,
  );

  stdout.write(`[2/${steps}] copying node binary to ${binaryPath}\n`);
  await copyFile(execPath, binaryPath);
  if (!isWindows) {
    await chmod(binaryPath, 0o755);
  }

  stdout.write(`[3/${steps}] injecting blob via postject\n`);
  const postjectArgs = [
    "--yes",
    "postject",
    binaryPath,
    "NODE_SEA_BLOB",
    blobPath,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ];
  if (isDarwin) {
    postjectArgs.push("--macho-segment-name", "NODE_SEA");
  }
  await run("npx", postjectArgs, ROOT);

  if (isDarwin) {
    // postject invalidates the ad-hoc signature; re-sign so the kernel does
    // not SIGKILL the sidecar at launch on Apple Silicon. CI replaces this
    // with a Developer ID signature before notarisation.
    stdout.write(`[4/${steps}] ad-hoc code-signing ${binaryPath}\n`);
    await run(
      "/usr/bin/codesign",
      ["--sign", "-", "--force", "--timestamp=none", binaryPath],
      ROOT,
    );
  }

  stdout.write(`built Tauri sidecar binary at ${binaryPath}\n`);
  stdout.write(
    "note: reference it in tauri.conf.json as `externalBin: [\"binaries/atomic-agent-sidecar\"]`.\n",
  );
  stdout.write(
    "note: macOS/Windows binaries should be code-signed in CI before distribution.\n",
  );
  return 0;
}

main()
  .then((code) => exit(code))
  .catch((err) => {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    stderr.write(`${message}\n`);
    exit(1);
  });
