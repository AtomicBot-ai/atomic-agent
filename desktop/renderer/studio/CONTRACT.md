# Studio bridge contract (Images + Video)

What the Studio pages call (`BR.studio.*`, `BR = window.atomic`) and what
they get back. Main side: `desktop/main/studio-ipc.ts` (routes),
`studio-media.ts` (Core client), `studio-catalog.ts`, `studio-requests.ts`,
`studio-pricing.ts`, `studio-paths.ts`, `studio-jobs.ts`. Preload:
`desktop/preload/preload.ts` (`studio` namespace). Keep this file and those in
step.

Core shapes are cited from **atomic-chat-core v0.18.6** (the pinned
`BUNDLED_CORE_VERSION`, `desktop/main/core-bundle.ts`):
types in `src/contracts/diffusion.ts` and `src/contracts/media.ts`, routes in
`src/server/control/routes/diffusion.ts`, `diffusion-video.ts`, `media.ts`,
`cloud.ts`, events in `src/diffusion/session.ts`, remote rules in
`src/diffusion/remote-job.ts`.

## Envelope

Every call resolves (never rejects) to

```ts
{ ok: true, data: T } | { ok: false, error: { code: string, message: string, details?: string } }
```

`message` is a sentence to show as is. `code` is for branching:

| code | meaning / what the UI does |
|---|---|
| `NO_KEY` | cloud generation without an OpenRouter key: link to Settings → Providers |
| `INVALID_REQUEST` | the form sent something Core cannot take (message says what) |
| `OUTSIDE` | a path that is not a Studio file or a picked one |
| `CORE_NOT_INSTALLED`, `CORE_START_FAILED`, `CORE_UNREACHABLE`, `CORE_TIMEOUT`, `CORE_BUSY`, `CORE_MISMATCH`, `CORE_INVALID`, `CORE_LOCK_STALE` | Atomic Core could not be used; offer Retry |
| `JOB_BUSY` | 4 cloud jobs already running (Core `MAX_REMOTE_JOBS`), or a local one |
| `GPU_BUSY`, `MODEL_NOT_LOADED`, `OUT_OF_MEMORY`, `DISK_FULL`, `QUEUE_FULL` | Core's diffusion codes (`src/contracts/errors.ts`) |
| `REMOTE_AUTH_FAILED`, `REMOTE_QUOTA`, `REMOTE_RATE_LIMITED`, `REMOTE_CONTENT_BLOCKED`, `REMOTE_REJECTED`, `REMOTE_UNSUPPORTED`, `REMOTE_UNAVAILABLE`, `REMOTE_TIMEOUT`, `REMOTE_NOT_CONFIGURED`, `UNSUPPORTED_WORKFLOW` | provider refusals, already worded |
| `JOB_NOT_FOUND` | Core lost the job (restart); only on `onJob` |
| `FAILED` | anything else |

`kind` is always `"image" | "video"`.

## Methods

| call | data |
|---|---|
| `catalog(kind)` | `{ cloud: CatalogSection & { keyMissing: boolean }, local: CatalogSection }` |
| `generateImage(req: ImageRequest)` | `{ jobId: string, job: StudioJob }` |
| `generateVideo(req: VideoRequest)` | `{ jobId: string, job: StudioJob }` |
| `estimateVideo(req: VideoRequest)` | `VideoEstimate \| null` (null for every cloud model) |
| `job(kind, id)` | `StudioJob \| null` |
| `activeJobs()` | `StudioJob[]` still running that this app started (after a window reload) |
| `cancel(kind, id)` | `{ cancelled: boolean, serverStopped: boolean }` |
| `gallery(kind, { offset?=0, limit?=50 (max 200), includeArchived?=false })` | `{ items: StudioItem[], hasMore: boolean, total: number }` |
| `galleryDelete(kind, ids: string[])` | `{ deleted: number }` (files are removed by Core, not to the Trash) |
| `pin(kind, id, on)` | `StudioItem \| null` |
| `outputDir(kind)` | `{ path: string, isDefault: boolean }` |
| `chooseOutputDir(kind)` | folder dialog, then as `outputDir`; `null` when cancelled |
| `setOutputDir(kind, path \| null)` | `null` = back to default. A string is accepted only if `chooseOutputDir` returned it this session |
| `price(modelId, PriceParams)` | `StudioPrice \| null` |
| `pickImages(multiple?)` | `[{ path, name }]` (≤16); these paths may then be used as inputs |
| `preview(path)` | `{ ok: true, dataUrl, mime, size, mtimeMs } \| { ok: false, reason: 'missing' \| 'too-large' \| 'outside' }` (images and thumbnails, ≤15 MB; the window's CSP allows only `data:` images) |
| `revealInFinder(path)` | `{ revealed: true }` |
| `saveAs(path)` | `{ saved: false } \| { saved: true, path }` |
| `onJob(cb)` | subscribe; returns unsubscribe. `cb(job: StudioJob)` on every change |

`gallery`, `pin`, `galleryDelete` ids: image `<jobId>-<NN>`, video the job id.

### Paths

`preview`, `revealInFinder`, `saveAs` take only a file inside Studio's output
folders (resolved through links). An input image `{path}` is accepted from
there (a gallery item) or from `pickImages`; anything else (drop, paste) goes
as `{ base64 }` (a data-URL prefix is fine; ≤48 MB per image, Core caps the
whole request at 64 MB).

## Requests

```ts
type Source = { path: string } | { base64: string }

interface ImageRequest {
  provider: 'openrouter' | 'local'
  model: string                 // StudioModel.id (local: the loaded `<family>:<quant>`)
  mode?: 'create' | 'edit' | 'reference' | 'transform' | 'inpaint' | 'extend' | 'upscale'  // default create
  prompt: string                // ≤8000; required except upscale
  negativePrompt?: string       // only when model.negativePrompt
  count?: number                // 1..model.maxCount
  seed?: number
  aspectRatio?: string          // model.aspectRatios.values
  resolution?: string           // model.resolutions.values
  size?: string                 // model.sizes (enum) value
  quality?: string; background?: string; outputFormat?: string
  width?: number; height?: number      // range-size models and local
  steps?: number; cfgScale?: number; guidance?: number; strength?: number; samplingMethod?: string
  initImage?: Source            // every mode but create
  maskImage?: Source            // inpaint / extend (white = repaint)
  referenceImages?: Source[]    // reference; total inputs ≤ model.maxInputImages
}

interface VideoRequest {
  provider: 'openrouter' | 'local'
  model: string
  mode?: 'create' | 'image-to-video'   // image-to-video: cloud only (Core refuses it locally)
  prompt: string                // may be empty for image-to-video
  negativePrompt?: string; seed?: number
  durationSecs?: number         // model.durations
  resolution?: string; aspectRatio?: string; size?: string
  audio?: boolean               // only when model.audio; absent = provider default
  firstFrame?: Source; lastFrame?: Source   // lastFrame only when model.lastFrame
  width?: number; height?: number; frames?: number; fps?: number   // local only
  steps?: number; cfgScale?: number; guidance?: number
}
```

Mapping (main/studio-requests.ts): `mode` → `workflow`, `count` →
`batchSize`, `firstFrame`/`lastFrame` → `initImage`/`endImage`; a cloud
request gets `target: {provider, model}` and `remote: {aspectRatio,
resolution, size, quality, background, outputFormat}` (image) or
`{durationSecs, resolution, aspectRatio, size, generateAudio}` (video). Core
requires width/height/steps/cfgScale on every request: cloud sends the ratio's
~1 MP size and `0/0` ("model default"); local fills them from
`GET /diffusion/capabilities` (or `/diffusion/video/capabilities`) defaults.

No confirmation dialog: the Generate button is the confirmation. Generation is
never retried by main (a provider would bill twice).

## Catalog: building the form

```ts
interface CatalogSection {
  provider: 'openrouter' | 'local'; kind
  models: StudioModel[]         // cloud: default model first
  live: boolean                 // cloud: OpenRouter's live listing answered
  error: { code, message } | null   // why part of it could not be read; models may still be listed
}

interface StudioModel {
  id; name; description: string | null
  provider; kind; source: 'catalog' | 'live' | 'local'; default: boolean
  modes: string[]               // which mode tabs are enabled for this model
  aspectRatios: { values: string[], default: string | null } | null
  resolutions:  { values: string[], default: string | null } | null   // 1K/2K/4K, 720p/1080p…
  sizes: { kind: 'enum', values, default } | { kind: 'range', min, max, multiple, defaultWidth, defaultHeight } | null
  durations: { values: number[] | null, min, max, default } | null    // video, seconds
  audio: boolean                // show the Sound switch
  lastFrame: boolean            // show the Last frame slot (image-to-video)
  seed: boolean; negativePrompt: boolean
  maxCount: number              // images per request
  maxInputImages: number | null // source + references
  quality, background, outputFormat: { values, default } | null
  steps, cfg, guidance, strength: { min, max, default, step } | null
  license: string | null
  nonCommercial: boolean | null // true → label "Non-commercial"
  adult: boolean | null         // true → label "18+"
  local: { family, developer, loaded: boolean } | null
}
```

`null` / `false` = hide that control. Sources: cloud = Core
`GET /media/providers/openrouter/models?kind=` (`MediaProviderModels`: conf
catalog + OpenRouter's live list); local = conf `models/diffusion.json`
families (fetched by main, cached 1 h) with `loaded` from
`GET /diffusion/status`. Neither catalog carries license or NSFW flags for
cloud models, so cloud `nonCommercial` is always `null` and `adult` is `true`
only when the id or name says so (uncensored, nsfw, abliterated). Both kinds
of models are listed; label, don't hide.

`keyMissing: true` → cloud models are still listed; Generate answers
`NO_KEY`.

**Local models in this foundation**: listed only. Downloading weights and
`POST /diffusion/model/load` are not wired yet, so local generation works only
when a model is already loaded in Core (otherwise `MODEL_NOT_LOADED`).

## Jobs and events

```ts
interface StudioJob {
  id; kind
  state: 'queued' | 'generating' | 'completed' | 'failed' | 'cancelled'
  cloud: boolean; model: string
  progress: {
    phase: string               // queued | encoding | sampling | decoding | postprocessing | saving
    step: number; totalSteps: number
    fraction: number            // 0..1
    etaSeconds: number | null
    batchIndex: number | null; batchSize: number | null   // image batches
    slowdown: boolean           // video: sharp slowdown (memory pressure) → suggest Stop
  } | null
  outputs: StudioItem[]         // filled when completed
  error: { code, message, details? } | null   // failed / cancelled (code CANCELLED)
  createdAtMs: number; finishedAtMs: number | null
}
```

`onJob` fires for every change of a job this app started: from Core's event
stream (`diffusion:progress`, `diffusion:job`, `diffusion:video-progress`,
`diffusion:video-job`) and a 2 s poll of `GET /diffusion/jobs/:id` /
`/diffusion/video/jobs/:id` as a safety net. The last event of a job has a
terminal `state`. Cloud jobs report a time-based `fraction` (Core
`timeFraction`), not real steps.

**Stop**: `cancel(kind, id)`. Show "Stop doesn't cancel the charge" for cloud
video (OpenRouter documents no cancel, `src/media/adapters/openrouter-videos.ts`);
there are no refunds.

`VideoEstimate` (local only, Core `POST /diffusion/video/estimate`):
`{ memory: { requiredBytes, budgetBytes, pool, verdict: 'fits'|'tight'|'exceeds' }, seconds: { low, high } | null, basis }`.

## Gallery items

```ts
interface StudioItem {
  id; kind; path
  thumbnailPath: string | null  // image: 256 px thumb; video: poster (null until one is set)
  width; height; sizeBytes; createdAtMs; pinned; archived
  durationSecs: number | null   // video
  prompt: string
  model: { id, name, provider }  // provider 'local' or e.g. 'openrouter'
  recipe: unknown                // Core's ImageRecipe / VideoRecipe, verbatim: "Restore settings"
}
```

Files live in Core's data folder `images/` and `videos/`
(`<managed data dir>/core/versions/0.18.6/data/…`) unless Settings chose
another folder. Core keeps the choice only per run, so main stores it in
`<stateDir>/studio.json` and sends it to every new Core (`PUT /diffusion/config`).

## Price

```ts
interface PriceParams { kind; count?: number; resolution?: string; durationSecs?: number; audio?: boolean; mode?: string }
interface StudioPrice { usd: number; maxUsd: number | null; basis: string }   // whole request
```

Show `~$0.20` (or `~$0.32–0.40` with `maxUsd`) on the Generate button; `null`
→ no number at all. Sources (cached 24 h): images
`openrouter.ai/api/v1/images/models/<id>/endpoints` (only `output_image` per
`image`; per-token models get null), video `openrouter.ai/api/v1/videos/models`
`pricing_skus` (per-second SKUs; `cents_per_*` are cents; token SKUs → null).
`/api/v1/models` has no per-image price and is not used.

## Not in this foundation

- Video playback: the window's CSP has no `media-src`; playing a clip needs a
  main-side protocol or CSP change (open item).
- Local model download/load, sd-cpp engine install, video posters
  (`PUT /diffusion/video/gallery/:id/poster`).
