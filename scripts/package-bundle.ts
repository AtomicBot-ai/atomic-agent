/**
 * Packages a platform-specific redistributable for the sidecar binary
 * produced by `build-binary.ts`. A bundle contains:
 *
 *   atomic-agent-sidecar[.exe]   SEA binary (main entry point)
 *   grammars/                    GBNF grammars the agent needs at runtime
 *   assets/tree-sitter/          tree-sitter WASMs (fetched separately)
 *   prebuilds/                   Native prebuilds copied from node_modules
 *                                (better-sqlite3, sqlite-vec) for the target
 *   README.txt                   short usage note + llama-server pointer
 *
 * The bundle does NOT include llama-server: operators run it on their
 * own machine and point the agent at it via ATOMIC_AGENT_LLAMA_URL.
 *
 * Usage:
 *   npx tsx scripts/package-bundle.ts           # package for current host
 *   npx tsx scripts/package-bundle.ts darwin-arm64
 */
import { spawn } from "node:child_process";
import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createGzip } from "node:zlib";
import { join, resolve, dirname } from "node:path";
import { argv, exit, stdout, stderr } from "node:process";
import { pipeline } from "node:stream/promises";
import { BUNDLE_TARGETS, currentTarget, BundleTarget } from "./bundle-targets.js";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const BUNDLE_ROOT = join(ROOT, "bundle");

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function resolveTarget(arg: string | undefined): BundleTarget {
  if (!arg) return currentTarget();
  const match = BUNDLE_TARGETS.find((t) => t.slug === arg);
  if (!match) {
    throw new Error(
      `unknown target "${arg}". Known targets: ${BUNDLE_TARGETS.map((t) => t.slug).join(", ")}`,
    );
  }
  return match;
}

async function copyOptional(src: string, dest: string): Promise<boolean> {
  if (!(await pathExists(src))) return false;
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true });
  return true;
}

async function archiveTarGz(sourceDir: string, destFile: string): Promise<void> {
  // We shell out to `tar` because it is present on every supported host and
  // preserves file modes without us reimplementing a streaming tar writer.
  await mkdir(dirname(destFile), { recursive: true });
  const intermediate = `${destFile}.tmp.tar`;
  await new Promise<void>((resolveTar, reject) => {
    const child = spawn(
      "tar",
      ["-cf", intermediate, "-C", dirname(sourceDir), join(".", sourceDir.split("/").pop() ?? "")],
      { stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolveTar() : reject(new Error(`tar exited with code ${code}`)),
    );
  });
  await pipeline(
    createReadStream(intermediate),
    createGzip({ level: 9 }),
    createWriteStream(destFile),
  );
  await rm(intermediate, { force: true });
}

async function archiveZip(sourceDir: string, destFile: string): Promise<void> {
  await mkdir(dirname(destFile), { recursive: true });
  // On Windows we rely on powershell Compress-Archive; on other hosts we use `zip`.
  const isWindowsHost = process.platform === "win32";
  const command = isWindowsHost ? "powershell" : "zip";
  const args = isWindowsHost
    ? [
        "-NoProfile",
        "-Command",
        `Compress-Archive -Path '${sourceDir}\\*' -DestinationPath '${destFile}' -Force`,
      ]
    : ["-r", destFile, "."];
  const cwd = isWindowsHost ? ROOT : sourceDir;
  await new Promise<void>((resolveZip, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolveZip() : reject(new Error(`${command} exited with code ${code}`)),
    );
  });
}

async function main(): Promise<number> {
  const target = resolveTarget(argv[2]);
  const stageDir = join(BUNDLE_ROOT, target.slug);
  const binaryPath = join(stageDir, target.executableName);
  if (!(await pathExists(binaryPath))) {
    stderr.write(
      `sidecar binary not found at ${binaryPath}. Run build-binary.ts first.\n`,
    );
    return 2;
  }

  stdout.write(`packaging bundle for ${target.slug}\n`);

  // Grammars are required at runtime.
  await copyOptional(join(ROOT, "grammars"), join(stageDir, "grammars"));

  // better-sqlite3 is the only native module we depend on now.
  const nativeModules = ["better-sqlite3"];
  for (const mod of nativeModules) {
    await copyOptional(
      join(ROOT, "node_modules", mod, "build"),
      join(stageDir, "prebuilds", mod, "build"),
    );
    await copyOptional(
      join(ROOT, "node_modules", mod, "prebuilds"),
      join(stageDir, "prebuilds", mod, "prebuilds"),
    );
  }

  const readme = [
    `atomic-agent sidecar (${target.slug})`,
    "",
    "Requirements:",
    "  - External llama.cpp server reachable via HTTP. Start it separately:",
    "      llama-server -m <model.gguf> --port 8080 --slots 4 --cache-prompt",
    "  - Point the sidecar at the server:",
    "      ATOMIC_AGENT_LLAMA_URL=http://127.0.0.1:8080",
    "  - Install Google Chrome or Microsoft Edge (stable channel). Playwright",
    "    browsers are NOT bundled; playwright-core attaches to the system",
    "    browser via --channel=chrome|msedge.",
    target.platform === "darwin"
      ? "  - macOS: grant Accessibility + Screen Recording permissions to the"
      : "",
    target.platform === "darwin"
      ? "    sidecar binary for window-focus and reliable keyboard input."
      : "",
    target.platform === "linux"
      ? "  - Linux: install `wmctrl` for os.window.*; other OS tools degrade"
      : "",
    target.platform === "linux"
      ? "    gracefully without it."
      : "",
    "",
    "Skills live under $ATOMIC_AGENT_STATE_DIR/skills/ and",
    "./.atomic-agent/skills/. They are runtime artefacts authored by the",
    "user and are never bundled. See SKILLS.md in the source repo.",
    "",
    "Run the sidecar:",
    `  ./${target.executableName}`,
    "",
    "The sidecar speaks the NDJSON protocol over stdin/stdout; the Tauri",
    "host owns lifetime and routing.",
    "",
  ]
    .filter((line) => line !== "")
    .concat([""])
    .join("\n");
  await writeFile(join(stageDir, "README.txt"), readme, "utf8");

  const archivePath = join(
    BUNDLE_ROOT,
    `atomic-agent-${target.slug}.${target.archiveExt}`,
  );
  stdout.write(`creating archive ${archivePath}\n`);
  if (target.archiveExt === "tar.gz") {
    await archiveTarGz(stageDir, archivePath);
  } else {
    await archiveZip(stageDir, archivePath);
  }
  stdout.write(`bundle ready: ${archivePath}\n`);
  return 0;
}

main()
  .then((code) => exit(code))
  .catch((err) => {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    stderr.write(`${msg}\n`);
    exit(1);
  });
