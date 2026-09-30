/**
 * Regenerates the Windows and Linux icons from build/icon.icns, which stays
 * the single source of truth for the app icon.
 *
 *   build/icon.png          1024x1024, the generic fallback electron-builder uses
 *   build/icons/NxN.png     16..1024, the Linux icon set (AppImage, deb hicolor)
 *   build/icon.ico          16..256, the Windows exe + NSIS installer icon
 *
 * macOS only (iconutil + sips ship with the OS); the outputs are committed,
 * so CI and other platforms never run this. Re-run it by hand after the
 * .icns changes:  node scripts/make-icons.mjs
 *
 * The .ico is written directly: every entry is a PNG, which Windows Vista
 * and later read natively, so no image library is needed.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.error("make-icons needs macOS (iconutil + sips). The generated icons are committed; nothing to do.");
  process.exit(1);
}

const BUILD = join(dirname(fileURLToPath(import.meta.url)), "..", "build");
const work = mkdtempSync(join(tmpdir(), "atag-icons-"));

try {
  const iconset = join(work, "icon.iconset");
  execFileSync("iconutil", ["-c", "iconset", join(BUILD, "icon.icns"), "-o", iconset]);
  const master = join(iconset, "icon_512x512@2x.png"); // 1024x1024

  const png = (size) => {
    const out = join(work, `${size}.png`);
    execFileSync("sips", ["-z", String(size), String(size), master, "--out", out], { stdio: "ignore" });
    return out;
  };

  copyFileSync(master, join(BUILD, "icon.png"));

  const linuxDir = join(BUILD, "icons");
  rmSync(linuxDir, { recursive: true, force: true });
  mkdirSync(linuxDir);
  for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
    copyFileSync(size === 1024 ? master : png(size), join(linuxDir, `${size}x${size}.png`));
  }

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const images = icoSizes.map((size) => readFileSync(png(size)));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = header.length + dir.length;
  images.forEach((data, i) => {
    const size = icoSizes[i];
    const e = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, e); // 0 means 256
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1);
    dir.writeUInt8(0, e + 2); // palette
    dir.writeUInt8(0, e + 3); // reserved
    dir.writeUInt16LE(1, e + 4); // colour planes
    dir.writeUInt16LE(32, e + 6); // bits per pixel
    dir.writeUInt32LE(data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  writeFileSync(join(BUILD, "icon.ico"), Buffer.concat([header, dir, ...images]));
  console.log(`icons → ${BUILD} (icon.png, icons/, icon.ico with ${icoSizes.join("/")})`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
