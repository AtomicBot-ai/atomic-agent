/**
 * The deck a model asks `os.fs.write_pptx` for, validated. Everything
 * the builder needs is decided here — limits, theme name, bullet levels
 * — so `pptx-build.ts` only renders and never has to refuse.
 */

export const PPTX_THEMES = ["light", "dark", "blue", "warm"] as const;
export type PptxThemeName = (typeof PPTX_THEMES)[number];

export const MAX_SLIDES = 200;
export const MAX_BULLETS_PER_SLIDE = 40;
export const MAX_TEXT_CHARS = 2_000;
export const MAX_NOTES_CHARS = 20_000;
/** Deepest bullet level PowerPoint shows by default styles (0-based). */
export const MAX_BULLET_LEVEL = 4;

export interface PptxBullet {
  text: string;
  /** 0 = top level. Two leading spaces per level in the model's string. */
  level: number;
}

export interface PptxSlideSpec {
  title: string;
  subtitle?: string;
  bullets: PptxBullet[];
  /** Path as the model wrote it; resolved against the working dir by the tool. */
  image?: string;
  notes?: string;
}

export interface PptxDeckSpec {
  path: string;
  slides: PptxSlideSpec[];
  title?: string;
  author?: string;
  theme: PptxThemeName;
  /** Six hex digits, upper case, no `#`. */
  accentColor?: string;
  font?: string;
  overwrite: boolean;
}

const TOOL = "os.fs.write_pptx";

/**
 * `null` and `""` count as absent: a strict native-tools provider sends
 * every unused optional field, as null or as an empty string.
 */
function optionalString(
  raw: Record<string, unknown>,
  key: string,
  where: string,
  max = MAX_TEXT_CHARS,
): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new Error(`${TOOL}: ${where}${key} must be a string`);
  }
  if (value.length > max) {
    throw new Error(`${TOOL}: ${where}${key} is longer than ${max} characters`);
  }
  return value;
}

/** "  sub point" → level 1. A leading "- " or "• " is dropped too. */
export function parseBullet(line: string): PptxBullet {
  const expanded = line.replace(/\t/g, "  ");
  const indent = expanded.length - expanded.trimStart().length;
  const level = Math.min(Math.floor(indent / 2), MAX_BULLET_LEVEL);
  const text = expanded.trimStart().replace(/^[-*•]\s+/, "").trimEnd();
  return { text, level };
}

function parseSlide(entry: unknown, index: number): PptxSlideSpec {
  const where = `slides[${index}].`;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`${TOOL}: slides[${index}] must be an object with a title`);
  }
  const raw = entry as Record<string, unknown>;
  const title = optionalString(raw, "title", where);
  if (title === undefined || title.trim().length === 0) {
    throw new Error(`${TOOL}: ${where}title must be a non-empty string`);
  }
  const bullets: PptxBullet[] = [];
  const rawBullets = raw.bullets;
  if (rawBullets !== undefined && rawBullets !== null) {
    if (!Array.isArray(rawBullets)) {
      throw new Error(`${TOOL}: ${where}bullets must be an array of strings`);
    }
    if (rawBullets.length > MAX_BULLETS_PER_SLIDE) {
      throw new Error(
        `${TOOL}: ${where}bullets has ${rawBullets.length} items; at most ${MAX_BULLETS_PER_SLIDE} per slide — split it over more slides`,
      );
    }
    rawBullets.forEach((item: unknown, n: number) => {
      if (typeof item !== "string") {
        throw new Error(`${TOOL}: ${where}bullets[${n}] must be a string`);
      }
      if (item.length > MAX_TEXT_CHARS) {
        throw new Error(
          `${TOOL}: ${where}bullets[${n}] is longer than ${MAX_TEXT_CHARS} characters`,
        );
      }
      const bullet = parseBullet(item);
      if (bullet.text.length > 0) bullets.push(bullet);
    });
  }
  const subtitle = optionalString(raw, "subtitle", where);
  const image = optionalString(raw, "image", where);
  const notes = optionalString(raw, "notes", where, MAX_NOTES_CHARS);
  return {
    title: title.trim(),
    bullets,
    ...(subtitle === undefined ? {} : { subtitle }),
    ...(image === undefined ? {} : { image }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export function parseAccentColor(value: string): string {
  const hex = value.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return hex
      .split("")
      .map((c) => c + c)
      .join("")
      .toUpperCase();
  }
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(
      `${TOOL}: accentColor must be a hex colour like 2F6FEB (got "${value}")`,
    );
  }
  return hex.toUpperCase();
}

export function parseDeckSpec(raw: Record<string, unknown>): PptxDeckSpec {
  const path = optionalString(raw, "path", "", 4_096);
  if (path === undefined || path.trim().length === 0) {
    throw new Error(`${TOOL}: path must be a non-empty string`);
  }
  if (!/\.pptx$/i.test(path.trim())) {
    throw new Error(`${TOOL}: path must end in .pptx (got "${path}")`);
  }
  const rawSlides = raw.slides;
  if (!Array.isArray(rawSlides) || rawSlides.length === 0) {
    throw new Error(`${TOOL}: slides must be a non-empty array of { title, … }`);
  }
  if (rawSlides.length > MAX_SLIDES) {
    throw new Error(
      `${TOOL}: at most ${MAX_SLIDES} slides per deck (got ${rawSlides.length})`,
    );
  }
  const slides = rawSlides.map(parseSlide);
  const themeRaw = optionalString(raw, "theme", "");
  const theme = (themeRaw ?? "light").toLowerCase();
  if (!(PPTX_THEMES as readonly string[]).includes(theme)) {
    throw new Error(
      `${TOOL}: theme must be one of ${PPTX_THEMES.join(", ")} (got "${themeRaw}")`,
    );
  }
  const accentRaw = optionalString(raw, "accentColor", "");
  const font = optionalString(raw, "font", "", 64);
  const title = optionalString(raw, "title", "");
  const author = optionalString(raw, "author", "", 256);
  return {
    path: path.trim(),
    slides,
    theme: theme as PptxThemeName,
    overwrite: raw.overwrite === true,
    ...(title === undefined ? {} : { title }),
    ...(author === undefined ? {} : { author }),
    ...(accentRaw === undefined ? {} : { accentColor: parseAccentColor(accentRaw) }),
    ...(font === undefined ? {} : { font: font.trim() }),
  };
}
