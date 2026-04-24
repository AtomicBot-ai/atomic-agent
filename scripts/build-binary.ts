/**
 * Builds a Node SEA (Single Executable Application) binary for the
 * current host platform. Cross-compilation is not supported by SEA —
 * CI runs this on each target runner (darwin-arm64, darwin-x64,
 * linux-x64, linux-arm64, win32-x64) and we stitch the results in
 * `package-bundle.ts`. The embedded entry is the bundled CLI (`dist-sea/cli.mjs`).
 *
 * Usage:
 *   npx tsx scripts/build-binary.ts
 *
 * Prerequisites:
 *   - Node >= 20.x (SEA requires it)
 *   - `npm run build` has produced `dist/`, and `npm run bundle:sea` has produced
 *     `dist-sea/cli.mjs` (or this script will run `bundle:sea` for you)
 *   - `sea-config.json` at the repo root is the SEA manifest
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
const BUNDLE_ROOT = join(ROOT, "bundle");

// SEA embeds the build-time Node binary into the distributable, so the
// feature set of the build-time Node (not the end user's Node) determines
// what the final executable can do. `"mainFormat": "module"` ships in
// Node >= 25.7.0 (PR #61813); on earlier Nodes SEA refuses to run our
// ESM bundle with `SyntaxError: Cannot use import statement outside a
// module`. Fail fast with a clear message instead.
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
  const outDir = join(BUNDLE_ROOT, target.slug);
  const binaryPath = join(outDir, target.executableName);
  const blobPath = join(BUNDLE_ROOT, "sea-prep.blob");

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

  if (!(await exists(join(ROOT, "dist", "cli", "index.js")))) {
    stderr.write(
      "dist/cli/index.js not found — run `npm run build` first.\n",
    );
    return 2;
  }

  const seaEntry = join(ROOT, "dist-sea", "cli.mjs");
  if (!(await exists(seaEntry))) {
    stdout.write("dist-sea/cli.mjs not found — running `npm run bundle:sea` …\n");
    await run("npm", ["run", "bundle:sea"], ROOT);
  }
  if (!(await exists(seaEntry))) {
    stderr.write("dist-sea/cli.mjs still missing after bundle:sea.\n");
    return 2;
  }

  await mkdir(outDir, { recursive: true });

  const isDarwin = platform === "darwin";
  const steps = isDarwin ? 4 : 3;

  stdout.write(`[1/${steps}] generating SEA blob -> ${blobPath}\n`);
  await run(
    execPath,
    ["--experimental-sea-config", resolve(ROOT, "sea-config.json")],
    ROOT,
  );

  stdout.write(`[2/${steps}] copying node binary to ${binaryPath}\n`);
  await copyFile(execPath, binaryPath);
  if (platform !== "win32") {
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
    // postject mutates the Mach-O so the stock Node ad-hoc signature becomes
    // invalid. On Apple Silicon the kernel then kills the process with SIGKILL
    // at launch (a bare "killed" in the shell, no Gatekeeper dialog). A fresh
    // ad-hoc signature (`codesign --sign -`) restores launchability. CI later
    // replaces it with a Developer ID signature before notarisation.
    stdout.write(`[4/${steps}] ad-hoc code-signing ${binaryPath}\n`);
    await run(
      "/usr/bin/codesign",
      ["--sign", "-", "--force", "--timestamp=none", binaryPath],
      ROOT,
    );
  }

  stdout.write(`built ${target.slug} binary at ${binaryPath}\n`);
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
