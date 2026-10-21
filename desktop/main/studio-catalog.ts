/**
 * Studio: the model list the Images and Video forms are built from, in one
 * shape for cloud and local models. Pure; no I/O.
 *
 * Cloud models come from Core's `GET /atomic/v1/media/providers/:p/models
 * ?kind=image|video` (atomic-chat-core v0.18.6 src/server/control/routes/
 * media.ts; shapes in src/contracts/media.ts `MediaProviderModels`,
 * `ImageModelDescriptor`, `VideoModelDescriptor`): the conf catalog's
 * models with the provider's live listing merged in. A key the descriptor
 * lacks is a control the form hides.
 *
 * Local models come from the conf `models/diffusion.json` families (the
 * file Atomic Chat reads, web-app/src/services/diffusion-catalog-registry.ts).
 * Neither catalog carries an adult-content or commercial-use flag, so they
 * are derived here from the license id and the family's name, and left
 * `null` (unknown) for cloud models rather than guessed.
 */

export type StudioKind = "image" | "video";
export type StudioProvider = "openrouter" | "local";

export interface StudioChoice { values: string[]; default: string | null }
export interface StudioRange { min: number; max: number; default: number | null; step: number | null }

export interface StudioModel {
  id: string;
  name: string;
  description: string | null;
  provider: StudioProvider;
  kind: StudioKind;
  /** `catalog`: the conf catalog names it; `live`: only the provider's listing does; `local`: a diffusion family. */
  source: "catalog" | "live" | "local";
  default: boolean;
  /** Image: create|edit|reference|transform|inpaint|extend|upscale. Video: create|image-to-video. */
  modes: string[];
  aspectRatios: StudioChoice | null;
  resolutions: StudioChoice | null;
  /** Image: `{kind:'enum', values}` of `WxH`/`auto`, or a pixel range on a grid. Video: a list of `WxH`. */
  sizes: { kind: "enum"; values: string[]; default: string | null } | { kind: "range"; min: number; max: number; multiple: number; defaultWidth: number | null; defaultHeight: number | null } | null;
  /** Video only: clip length in seconds, a list or a range. */
  durations: { values: number[] | null; min: number | null; max: number | null; default: number | null } | null;
  audio: boolean;
  lastFrame: boolean;
  seed: boolean;
  negativePrompt: boolean;
  /** Images per request (`n`); 1 when the model says nothing. */
  maxCount: number;
  /** Input images (source + references); null when the model says nothing. */
  maxInputImages: number | null;
  quality: StudioChoice | null;
  background: StudioChoice | null;
  outputFormat: StudioChoice | null;
  steps: StudioRange | null;
  cfg: StudioRange | null;
  guidance: StudioRange | null;
  strength: StudioRange | null;
  license: string | null;
  /** True: the license forbids commercial use. Null: nobody says. */
  nonCommercial: boolean | null;
  /** True: an uncensored / NSFW model (label it 18+). Null: nobody says. */
  adult: boolean | null;
  /** Local families only. */
  local: { family: string; developer: string | null; loaded: boolean } | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function choice(v: unknown): StudioChoice | null {
  const o = obj(v);
  if (!o) return null;
  const values = strings(o.values);
  return values.length ? { values, default: str(o.default) } : null;
}

function range(v: unknown): StudioRange | null {
  const o = obj(v);
  const min = num(o?.min);
  const max = num(o?.max);
  return o && min !== null && max !== null ? { min, max, default: num(o.default), step: num(o.step) } : null;
}

const NON_COMMERCIAL = /non[-_ ]?commercial|research[-_ ]only|-nc\b/i;
const ADULT = /nsfw|uncensored|abliterated|\b18\+|adult/i;

/** What a license id and a model's names say; `null` when there is nothing to read. */
export function contentFlags(license: string | null, ...names: Array<string | null | undefined>): { nonCommercial: boolean | null; adult: boolean | null } {
  const named = names.filter((n): n is string => typeof n === "string" && n.length > 0);
  return {
    nonCommercial: license ? NON_COMMERCIAL.test(license) : null,
    adult: named.some((n) => ADULT.test(n)) ? true : named.length ? false : null,
  };
}

/** One Core media descriptor as the form's model. Null for an entry without an id or of another kind. */
export function normalizeCloudModel(raw: unknown, kind: StudioKind, provider: StudioProvider = "openrouter"): StudioModel | null {
  const m = obj(raw);
  const id = str(m?.id);
  if (!m || !id) return null;
  if (m.kind !== undefined && m.kind !== kind) return null;
  const p = obj(m.params) ?? {};
  const size = obj(p.size);
  let sizes: StudioModel["sizes"] = null;
  if (kind === "image" && size?.kind === "enum") {
    const values = strings(size.values);
    if (values.length) sizes = { kind: "enum", values, default: str(size.default) };
  } else if (kind === "image" && size?.kind === "range" && num(size.min) !== null && num(size.max) !== null) {
    sizes = { kind: "range", min: num(size.min)!, max: num(size.max)!, multiple: num(size.multiple) ?? 1, defaultWidth: num(size.default_width), defaultHeight: num(size.default_height) };
  } else if (kind === "video") {
    const listed = choice(p.sizes);
    if (listed) sizes = { kind: "enum", ...listed };
  }
  const d = obj(p.durations);
  const durations = kind === "video" && d
    ? { values: Array.isArray(d.values) ? d.values.filter((x): x is number => typeof x === "number") : null, min: num(d.min), max: num(d.max), default: num(d.default) }
    : null;
  const name = str(m.name) ?? id;
  const flags = contentFlags(null, id, name);
  return {
    id,
    name,
    description: str(m.description),
    provider,
    kind,
    source: m.source === "live" ? "live" : "catalog",
    default: m.default === true,
    modes: strings(m.workflows).length ? strings(m.workflows) : ["create"],
    aspectRatios: choice(p.aspect_ratios),
    resolutions: choice(p.resolutions),
    sizes,
    durations,
    audio: p.audio === true,
    lastFrame: p.last_frame === true,
    seed: p.seed === true,
    negativePrompt: p.negative_prompt === true,
    maxCount: Math.max(1, num(obj(p.n)?.max) ?? 1),
    maxInputImages: num(p.max_input_images),
    quality: choice(p.quality),
    background: choice(p.background),
    outputFormat: choice(p.output_format),
    steps: range(p.steps),
    cfg: range(p.cfg),
    guidance: range(p.guidance),
    strength: range(p.strength),
    license: null,
    // A cloud catalog says nothing about licenses; a name that says "uncensored" still counts.
    nonCommercial: null,
    adult: flags.adult ? true : null,
    local: null,
  };
}

export interface StudioCatalogSection {
  provider: StudioProvider;
  kind: StudioKind;
  models: StudioModel[];
  /** Whether the provider's live listing answered (cloud); always false for local. */
  live: boolean;
  /** Why the live listing (cloud) or the family list (local) could not be read; the rest is still listed. */
  error: { code: string; message: string } | null;
}

/** Core's `MediaProviderModels` answer as a section; defaults first, each id once. */
export function normalizeProviderModels(answer: unknown, kind: StudioKind, provider: StudioProvider = "openrouter"): StudioCatalogSection {
  const a = obj(answer) ?? {};
  const seen = new Set<string>();
  const models: StudioModel[] = [];
  for (const raw of Array.isArray(a.models) ? a.models : []) {
    const m = normalizeCloudModel(raw, kind, provider);
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    models.push(m);
  }
  models.sort((x, y) => Number(y.default) - Number(x.default));
  const e = obj(a.error);
  return {
    provider,
    kind,
    models,
    live: a.live === true,
    error: e ? { code: str(e.code) ?? "UNKNOWN", message: str(e.message) ?? "" } : null,
  };
}

/** The conf `diffusion.json` families of one kind, flagged; `loadedModelId` marks the one Core holds. */
export function normalizeLocalFamilies(doc: unknown, kind: StudioKind, loadedModelId: string | null = null): StudioModel[] {
  const families = obj(doc)?.families;
  if (!Array.isArray(families)) return [];
  const out: StudioModel[] = [];
  for (const raw of families) {
    const f = obj(raw);
    const id = str(f?.id);
    if (!f || !id || (f.modality ?? "image") !== kind) continue;
    const name = str(f.name) ?? id;
    const license = str(f.license);
    const caps = obj(f.capabilities) ?? {};
    const ranges = obj(f.ranges) ?? {};
    const steps = Array.isArray(ranges.steps) ? ranges.steps : null;
    const dims = Array.isArray(ranges.dims) ? ranges.dims : null;
    const defaults = obj(f.defaults) ?? {};
    const flags = contentFlags(license, id, name);
    out.push({
      id,
      name,
      description: str(f.description),
      provider: "local",
      kind,
      source: "local",
      default: false,
      modes: strings(caps.workflows).length ? strings(caps.workflows) : ["create"],
      aspectRatios: null,
      resolutions: null,
      sizes: dims && typeof dims[0] === "number" && typeof dims[1] === "number"
        ? { kind: "range", min: dims[0], max: dims[1], multiple: num(ranges.dim_multiple) ?? 16, defaultWidth: num(defaults.width), defaultHeight: num(defaults.height) }
        : null,
      durations: null,
      audio: caps.audio === true,
      lastFrame: false,
      seed: true,
      negativePrompt: caps.negative_prompt === true || caps.supports_negative_prompt === true,
      maxCount: Math.max(1, num(caps.max_batch) ?? 1),
      maxInputImages: null,
      quality: null,
      background: null,
      outputFormat: null,
      steps: steps && typeof steps[0] === "number" && typeof steps[1] === "number" ? { min: steps[0], max: steps[1], default: num(defaults.steps), step: 1 } : null,
      cfg: null,
      // Guidance and CFG ranges come from Core's `GET /diffusion/capabilities` once the model is loaded.
      guidance: null,
      strength: null,
      license,
      nonCommercial: flags.nonCommercial,
      adult: flags.adult,
      local: { family: id, developer: str(f.developer), loaded: !!loadedModelId && loadedModelId.split(":")[0] === id },
    });
  }
  return out;
}
