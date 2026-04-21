/**
 * Builds a Node SEA (Single Executable Application) binary for the
 * current host platform. Cross-compilation is not supported by SEA —
 * CI runs this on each target runner (darwin-arm64, darwin-x64,
 * linux-x64, linux-arm64, win32-x64) and we stitch the results in
 * `package-bundle.ts`.
 *
 * Usage:
 *   npx tsx scripts/build-binary.ts
 *
 * Prerequisites:
 *   - Node >= 20.x (SEA requires it)
 *   - `npm run build` has produced `dist/`
 *   - `sea-config.json` at the repo root is the SEA manifest
 */
import { copyFile, mkdir, chmod, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { exit, execPath, stdout, stderr, platform } from "node:process";
import { currentTarget } from "./bundle-targets.js";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const BUNDLE_ROOT = join(ROOT, "bundle");

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

  if (!(await exists(join(ROOT, "dist", "sidecar", "main.js")))) {
    stderr.write(
      "dist/sidecar/main.js not found — run `npm run build` first.\n",
    );
    return 2;
  }

  await mkdir(outDir, { recursive: true });

  stdout.write(`[1/3] generating SEA blob -> ${blobPath}\n`);
  await run(
    execPath,
    ["--experimental-sea-config", resolve(ROOT, "sea-config.json")],
    ROOT,
  );

  stdout.write(`[2/3] copying node binary to ${binaryPath}\n`);
  await copyFile(execPath, binaryPath);
  if (platform !== "win32") {
    await chmod(binaryPath, 0o755);
  }

  stdout.write(`[3/3] injecting blob via postject\n`);
  const postjectArgs = [
    "--yes",
    "postject",
    binaryPath,
    "NODE_SEA_BLOB",
    blobPath,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ];
  if (platform === "darwin") {
    postjectArgs.push("--macho-segment-name", "NODE_SEA");
  }
  await run("npx", postjectArgs, ROOT);

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
