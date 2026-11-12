# Image generation tool

Status: current
Owner: src/tools/image/

`image.generate` draws pictures through Atomic Chat Core's diffusion jobs (`src/local-llm/core/core-image.ts`) and copies the files into the session's working folder; the agent shows them with `reply.attachments`. The job runs in the cloud (`target: {provider: "openrouter", model}`, key registered with Core per call, never through Core's environment) and asks for approval below level 3 (`paid_generation`). Local image models come with ATO-411: until then `model: "local"` gets a plain answer without touching Core (the client already has `configureCoreDiffusion` for that path). The prompt offers the tool only while an OpenRouter key is configured (`GATED_TOOLS.image`). Analytics: `image_generated`, shape only.

One call runs at most two cloud jobs at a time (`IMAGE_PARALLEL_JOBS`); a job Core turns away as `JOB_BUSY` (refused at submit, nothing billed) waits and goes again rather than answering short. The submit is never aborted: an Esc during it waits for the job id and cancels the job, so a job Core already made cannot run on and bill unseen. Progress reaches the tool card as `tool_progress` events: the one-time Core download on the first picture (`core-download-progress.ts`, also used by `video.generate`) and each request sent. (ATO-425)

Read [tool instructions](../AGENTS.md), [Core client](../../local-llm/core/core-image.ts) and the adjacent tests before changing arguments, approval or where files are saved.
