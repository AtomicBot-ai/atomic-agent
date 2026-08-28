/**
 * npm does not reliably run electron's postinstall in every environment
 * (a warm cache or a hardened npm config can skip it), and the failure is
 * silent: `npm install` reports success in about a second and the binary
 * is simply absent. The app then dies with "Electron failed to install
 * correctly", which says nothing about how to fix it.
 *
 * So the launch path checks for the binary itself and repairs it.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, "..", "node_modules", "electron");

if (!existsSync(electronDir)) {
  console.error("electron is not installed — run `npm install` in desktop/ first.");
  process.exit(1);
}

const pathFile = join(electronDir, "path.txt");
const recorded = existsSync(pathFile) ? readFileSync(pathFile, "utf8").trim() : "";
const binary = recorded ? join(electronDir, "dist", recorded) : "";

if (binary && existsSync(binary)) process.exit(0);

console.log("electron binary missing — downloading it now (this is a one-off)…");
execFileSync(process.execPath, [join(electronDir, "install.js")], { stdio: "inherit" });

const repaired = existsSync(pathFile) ? readFileSync(pathFile, "utf8").trim() : "";
if (!repaired || !existsSync(join(electronDir, "dist", repaired))) {
  console.error(
    "could not fetch the electron binary. Check your network, then run:\n" +
      "  node node_modules/electron/install.js",
  );
  process.exit(1);
}
console.log("electron binary ready.");
