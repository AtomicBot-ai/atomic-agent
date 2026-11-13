/**
 * Just enough of PNG / JPEG / GIF to know what a picture is and how big:
 * the slide places it aspect-correct inside its box, and a file that is
 * none of the three is refused before anything is asked or written
 * (PowerPoint would show a red "picture can't be displayed" box).
 */

export type PptxImageKind = "png" | "jpeg" | "gif";

export interface PptxImageInfo {
  kind: PptxImageKind;
  width: number;
  height: number;
}

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function sniffImage(data: Buffer): PptxImageInfo | null {
  if (
    data.length >= 24 &&
    data[0] === 0x89 &&
    data.toString("ascii", 1, 4) === "PNG" &&
    data.toString("ascii", 12, 16) === "IHDR"
  ) {
    return sized("png", data.readUInt32BE(16), data.readUInt32BE(20));
  }
  if (data.length >= 10 && data.toString("ascii", 0, 3) === "GIF") {
    return sized("gif", data.readUInt16LE(6), data.readUInt16LE(8));
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    return jpegSize(data);
  }
  return null;
}

function sized(kind: PptxImageKind, width: number, height: number): PptxImageInfo | null {
  return width > 0 && height > 0 ? { kind, width, height } : null;
}

/** Walk JPEG segments to the first start-of-frame marker. */
function jpegSize(data: Buffer): PptxImageInfo | null {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1] ?? 0;
    // Fill bytes and stand-alone markers carry no length.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = data.readUInt16BE(offset + 2);
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      return sized("jpeg", data.readUInt16BE(offset + 7), data.readUInt16BE(offset + 5));
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/** Largest box with the picture's aspect ratio inside `area`, centred. */
export function fitInto(
  info: Pick<PptxImageInfo, "width" | "height">,
  area: { x: number; y: number; cx: number; cy: number },
): { x: number; y: number; cx: number; cy: number } {
  const scale = Math.min(area.cx / info.width, area.cy / info.height);
  const cx = info.width * scale;
  const cy = info.height * scale;
  return { x: area.x + (area.cx - cx) / 2, y: area.y + (area.cy - cy) / 2, cx, cy };
}
