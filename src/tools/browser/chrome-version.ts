import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Read the major version of an installed Chromium-family browser without
 * starting it (ATO-969). The web identity uses it so the User-Agent that
 * curl and a headless launch send names the engine that is really on the
 * machine instead of a hard-coded, slowly ageing number.
 *
 * - macOS: `CFBundleShortVersionString` from the app bundle's Info.plist.
 * - Windows: the version-named folder Chrome/Edge/Brave keep next to the
 *   `.exe` (`Application\142.0.7444.60\`).
 * - Linux and the rest: `<binary> --version` ("Google Chrome 142.0.…").
 *
 * Returns `null` whenever the version cannot be read; callers fall back.
 */

export interface DetectChromeVersionSeams {
  platform?: NodeJS.Platform;
  readFile?: (file: string) => string;
  readDir?: (dir: string) => string[];
  runVersion?: (executablePath: string) => string;
}

export function detectChromeMajorVersion(
  executablePath: string,
  seams: DetectChromeVersionSeams = {},
): number | null {
  const platform = seams.platform ?? process.platform;
  try {
    if (platform === "darwin") {
      const plist = macInfoPlistPath(executablePath);
      if (!plist) return null;
      const read = seams.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"));
      const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(read(plist));
      return match ? parseMajor(match[1]!) : null;
    }
    if (platform === "win32") {
      const readDir = seams.readDir ?? ((dir: string) => fs.readdirSync(dir));
      const majors = readDir(path.win32.dirname(executablePath))
        .filter((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name))
        .map((name) => parseMajor(name))
        .filter((major): major is number => major !== null);
      return majors.length > 0 ? Math.max(...majors) : null;
    }
    const run =
      seams.runVersion ??
      ((bin: string) =>
        execFileSync(bin, ["--version"], {
          encoding: "utf8",
          timeout: 3_000,
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        }));
    return parseMajor(run(executablePath));
  } catch {
    return null;
  }
}

/** `/X.app/Contents/MacOS/Name` → `/X.app/Contents/Info.plist`. */
function macInfoPlistPath(executablePath: string): string | null {
  const macosDir = path.posix.dirname(executablePath);
  if (path.posix.basename(macosDir) !== "MacOS") return null;
  return path.posix.join(path.posix.dirname(macosDir), "Info.plist");
}

/** First dotted version in `text` → its major part, if it looks like Chrome's. */
export function parseMajor(text: string): number | null {
  const match = /(\d+)\.\d+(?:\.\d+)*/.exec(text);
  if (!match) return null;
  const major = Number(match[1]);
  // Chromium has been past 69 since 2018; anything outside this range is
  // some other number in the output, not the browser version.
  return Number.isInteger(major) && major >= 70 && major < 1000 ? major : null;
}
