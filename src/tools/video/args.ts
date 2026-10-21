/**
 * `video.generate` arguments: parsed before anything is asked or paid.
 * The plain JSON schema (`default-tool-args-schemas.ts`) only says the
 * types; the bounds and vocabularies live here.
 */

const PROMPT_MAX_CHARS = 4_000;
/** Longest clip any OpenRouter video model in Core's catalog offers. */
export const VIDEO_DURATION_MAX = 15;
/** Shortest Veo clip; the default, because OpenRouter bills video by the second. */
export const VIDEO_DEFAULT_DURATION = 4;
export const VIDEO_ASPECTS = ["16:9", "9:16"] as const;
export type VideoAspect = (typeof VIDEO_ASPECTS)[number];
const ASPECT_WORDS: Readonly<Record<string, VideoAspect>> = {
  landscape: "16:9", wide: "16:9", horizontal: "16:9", portrait: "9:16", tall: "9:16", vertical: "9:16",
};
export const VIDEO_RESOLUTIONS = ["480p", "720p", "1080p", "2K", "4K"] as const;

export interface VideoArgs {
  prompt: string;
  /** A first frame: a path as the agent wrote it, resolved against the working folder later. */
  image?: string;
  /** Seconds; `durationGiven` says whether the user chose it. */
  duration: number;
  durationGiven: boolean;
  aspect: VideoAspect;
  resolution?: string;
  audio?: boolean;
  seed?: number;
  model?: string;
  local: boolean;
}

/** Throws an `Error` whose message is the sentence the agent sees. */
export function parseVideoArgs(raw: Record<string, unknown>): VideoArgs {
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  if (prompt.length === 0) throw new Error("`prompt` must be a non-empty string describing the clip");
  if (prompt.length > PROMPT_MAX_CHARS) throw new Error(`\`prompt\` is longer than ${PROMPT_MAX_CHARS} characters; shorten it`);

  let image: string | undefined;
  if (raw.image !== undefined && raw.image !== null && raw.image !== "") {
    if (typeof raw.image !== "string" || raw.image.trim().length === 0) throw new Error("`image` must be the path of an image file in the working folder");
    image = raw.image.trim();
  }

  let duration = VIDEO_DEFAULT_DURATION;
  let durationGiven = false;
  if (raw.duration !== undefined && raw.duration !== null) {
    if (typeof raw.duration !== "number" || !Number.isInteger(raw.duration) || raw.duration < 1 || raw.duration > VIDEO_DURATION_MAX) {
      throw new Error(`\`duration\` must be a whole number of seconds from 1 to ${VIDEO_DURATION_MAX} (the default model takes 4, 6 or 8)`);
    }
    duration = raw.duration;
    durationGiven = true;
  }

  let aspect: VideoAspect = "16:9";
  if (raw.aspect !== undefined && raw.aspect !== null && raw.aspect !== "") {
    if (typeof raw.aspect !== "string") throw new Error("`aspect` must be \"16:9\" (landscape) or \"9:16\" (portrait)");
    const word = raw.aspect.trim().toLowerCase();
    const value = ASPECT_WORDS[word] ?? word;
    if (!(VIDEO_ASPECTS as readonly string[]).includes(value)) throw new Error(`\`aspect\` "${raw.aspect}" is not supported; use 16:9 (landscape) or 9:16 (portrait)`);
    aspect = value as VideoAspect;
  }

  let resolution: string | undefined;
  if (raw.resolution !== undefined && raw.resolution !== null && raw.resolution !== "") {
    const value = typeof raw.resolution === "string" ? raw.resolution.trim() : "";
    const match = VIDEO_RESOLUTIONS.find(r => r.toLowerCase() === value.toLowerCase());
    if (!match) throw new Error(`\`resolution\` must be one of ${VIDEO_RESOLUTIONS.join(", ")}`);
    resolution = match;
  }

  let audio: boolean | undefined;
  if (raw.audio !== undefined && raw.audio !== null) {
    if (typeof raw.audio !== "boolean") throw new Error("`audio` must be true or false");
    audio = raw.audio;
  }

  let seed: number | undefined;
  if (raw.seed !== undefined && raw.seed !== null) {
    if (typeof raw.seed !== "number" || !Number.isSafeInteger(raw.seed) || raw.seed < 0 || raw.seed > 0xffff_ffff) {
      throw new Error("`seed` must be a whole number from 0 to 4294967295");
    }
    seed = raw.seed;
  }

  let model: string | undefined;
  let local = false;
  if (typeof raw.model === "string" && raw.model.trim().length > 0) {
    const name = raw.model.trim();
    if (name.toLowerCase() === "local") local = true;
    else if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(name)) throw new Error(`\`model\` "${name}" is not a model id such as google/veo-3.1-fast`);
    else model = name;
  } else if (raw.model !== undefined && raw.model !== null && raw.model !== "") {
    throw new Error("`model` must be a string");
  }

  return {
    prompt, duration, durationGiven, aspect, local,
    ...(image !== undefined ? { image } : {}),
    ...(resolution !== undefined ? { resolution } : {}),
    ...(audio !== undefined ? { audio } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}
