import { detectChromeMajorVersion } from "./chrome-version.js";
import {
  findChromeExecutable,
  type BrowserExecutable,
} from "./find-chrome-executable.js";

/**
 * One honest, stable identity for everything the agent sends to websites
 * (ATO-969): the curl-based tools (`os.web.fetch`, `os.http.request`, web
 * search) and the browser the agent launches itself present the same
 * User-Agent and language, and both match the machine the agent runs on.
 *
 * - User-Agent: the reduced Chrome UA for this OS with the major version of
 *   the Chrome actually installed (read once, `chrome-version.ts`), or
 *   `FALLBACK_CHROME_MAJOR` when it cannot be read. Edge adds its `Edg/`
 *   token, as Edge itself does.
 * - Language: the system locale (`Intl`), turned into the Accept-Language
 *   list Chrome sends for that locale.
 * - Timezone: never overridden anywhere; Chrome and curl both use the
 *   system's own.
 * - Window size: a headed browser keeps the real window; headless gets one
 *   common laptop size instead of Chrome's 800x600 default.
 *
 * Deliberately NO rotation: the identity is computed once per process and
 * reused. Rotating fake fingerprints is what makes a client look like a
 * bot farm; a constant, true one is what a person's browser looks like.
 */

/**
 * Used only when the installed Chrome's version cannot be read. Keep it
 * near the current stable release so the fallback UA does not age.
 */
export const FALLBACK_CHROME_MAJOR = 154;

/** Window size for a headless launch (headed windows keep their own). */
export const HEADLESS_WINDOW_SIZE = { width: 1440, height: 900 } as const;

export interface WebIdentity {
  userAgent: string;
  acceptLanguage: string;
  /** BCP 47 tag such as `en-US` or `ru-RU`; also Chrome's `--lang`. */
  locale: string;
  chromeMajor: number;
  /** False when `chromeMajor` is the fallback, not the installed browser. */
  versionKnown: boolean;
}

export interface BuildWebIdentityInput {
  platform: NodeJS.Platform;
  locale: string;
  /** Installed browser major version, or null when unknown. */
  chromeMajor: number | null;
  kind?: BrowserExecutable["kind"];
}

/** The frozen OS token of Chrome's reduced User-Agent. */
export function platformToken(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "Macintosh; Intel Mac OS X 10_15_7";
  if (platform === "win32") return "Windows NT 10.0; Win64; x64";
  return "X11; Linux x86_64";
}

export function buildUserAgent(input: {
  platform: NodeJS.Platform;
  chromeMajor: number;
  kind?: BrowserExecutable["kind"];
}): string {
  const version = `${input.chromeMajor}.0.0.0`;
  const base =
    `Mozilla/5.0 (${platformToken(input.platform)}) AppleWebKit/537.36 ` +
    `(KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  return input.kind === "edge" ? `${base} Edg/${version}` : base;
}

/** `ru-RU-u-ca-gregory` → `ru-RU`; anything unusable → `en-US`. */
export function normalizeLocale(raw: string | undefined): string {
  if (!raw) return "en-US";
  try {
    const loc = new Intl.Locale(raw.replace(/_/g, "-").split(".")[0]!);
    const language = loc.language.toLowerCase();
    if (!/^[a-z]{2,3}$/.test(language) || language === "und") return "en-US";
    return loc.region ? `${language}-${loc.region.toUpperCase()}` : language;
  } catch {
    return "en-US";
  }
}

/**
 * The Accept-Language Chrome sends for a single UI locale: the locale,
 * its bare language, then English as the fallback Chrome itself appends.
 */
export function acceptLanguageFor(locale: string): string {
  const tag = normalizeLocale(locale);
  const language = tag.split("-")[0]!;
  const list = [tag, language];
  if (language !== "en") list.push("en-US", "en");
  else if (tag === "en") list.unshift("en-US");
  const unique = list.filter((item, index) => list.indexOf(item) === index);
  return unique
    .map((item, index) => (index === 0 ? item : `${item};q=${(1 - index / 10).toFixed(1)}`))
    .join(",");
}

export function systemLocale(): string {
  try {
    return normalizeLocale(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return "en-US";
  }
}

export function buildWebIdentity(input: BuildWebIdentityInput): WebIdentity {
  const versionKnown = input.chromeMajor !== null;
  const chromeMajor = input.chromeMajor ?? FALLBACK_CHROME_MAJOR;
  const locale = normalizeLocale(input.locale);
  return {
    userAgent: buildUserAgent({ platform: input.platform, chromeMajor, kind: input.kind }),
    acceptLanguage: acceptLanguageFor(locale),
    locale,
    chromeMajor,
    versionKnown,
  };
}

let current: WebIdentity | null = null;

function identityFor(executable: BrowserExecutable | null): WebIdentity {
  return buildWebIdentity({
    platform: process.platform,
    locale: systemLocale(),
    chromeMajor: executable ? detectChromeMajorVersion(executable.path) : null,
    kind: executable?.kind,
  });
}

/**
 * The process-wide identity. First use reads the default installed
 * browser (Chrome first); later calls return the same object.
 */
export function getWebIdentity(): WebIdentity {
  if (!current) {
    let executable: BrowserExecutable | null = null;
    try {
      executable = findChromeExecutable({ channel: "chrome" });
    } catch {
      executable = null;
    }
    current = identityFor(executable);
  }
  return current;
}

/**
 * Called when the agent launches its own browser: the identity follows the
 * browser that is actually running, so curl requests made after the launch
 * carry the same User-Agent as the browser's own.
 */
export function pinWebIdentityToBrowser(executable: BrowserExecutable): WebIdentity {
  current = identityFor(executable);
  return current;
}

/** Tests only: forget the cached identity. */
export function resetWebIdentityForTests(): void {
  current = null;
}
