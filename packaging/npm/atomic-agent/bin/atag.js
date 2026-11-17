#!/usr/bin/env node
// Launcher of the npm package `atomic-agent`: finds the platform package npm
// installed beside it (an optionalDependency, so npm fetches only the one
// matching this os/cpu) and runs its binary with this process's arguments,
// terminal and exit status. The binary is the same Node SEA build the GitHub
// release ships; the files around it (grammars, vendor/rg, node_modules) are
// resolved next to it, which is why it is run in place and never copied.
import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { executableName, platformPackageName, slugFor } from "../lib/platform.js";

const require = createRequire(import.meta.url);

function fail(message) {
  process.stderr.write(`atomic-agent: ${message}\n`);
  process.exit(1);
}

const slug = slugFor(process.platform, process.arch);
if (!slug) {
  fail(
    `no build for ${process.platform}-${process.arch}. ` +
      "See https://github.com/AtomicBot-ai/atomic-agent#install for other ways to install.",
  );
}

const pkg = platformPackageName(slug);
let pkgDir;
try {
  pkgDir = dirname(require.resolve(`${pkg}/package.json`));
} catch {
  fail(
    `the package ${pkg} is missing. It is an optional dependency, so an install ` +
      "with --no-optional (or --omit=optional) skips it. Reinstall with:\n" +
      "  npm install -g atomic-agent",
  );
}

const binary = join(pkgDir, executableName(process.platform));
if (process.platform !== "win32") {
  // npm keeps the mode bits of the tarball, but a copy that went through a
  // cache or a mirror that drops them would fail with EACCES; restore them.
  // vendor/ holds the bundled tools the binary runs (rg and friends).
  try {
    accessSync(binary, constants.X_OK);
  } catch {
    const vendor = join(pkgDir, "vendor");
    let tools = [];
    try {
      tools = readdirSync(vendor).map((name) => join(vendor, name));
    } catch {
      // No vendor/ directory.
    }
    for (const file of [binary, ...tools]) {
      try {
        chmodSync(file, 0o755);
      } catch {
        // Not ours to change (a root-owned global prefix); spawn reports it.
      }
    }
  }
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });

// The terminal sends Ctrl-C to the whole process group, so the binary gets
// its own SIGINT; this process only has to stay alive until it is done.
// Signals sent to this process alone (kill <pid>) are passed on.
const forwarded = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];
for (const signal of forwarded) {
  try {
    process.on(signal, () => {
      if (signal !== "SIGINT" && child.exitCode === null) child.kill(signal);
    });
  } catch {
    // Not every signal exists on Windows.
  }
}

child.on("error", (error) => {
  fail(`could not start ${binary}: ${error.message}`);
});

child.on("exit", (code, signal) => {
  if (signal) {
    // Die the same way, so a shell sees what the binary saw.
    for (const s of forwarded) process.removeAllListeners(s);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
