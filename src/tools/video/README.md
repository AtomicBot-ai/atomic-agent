# Video generation tool

Status: current
Owner: src/tools/video/

`video.generate` makes a short clip through Atomic Chat Core's video jobs (`src/local-llm/core/core-video.ts`: `POST /diffusion/video/jobs`, polled, cancelled on abort) on OpenRouter with the user's key (registered with Core per call by `registerOpenRouterMedia`, never through Core's environment), and copies the file into the session's working folder as `video-<timestamp>.mp4`; the agent shows it with `reply.attachments`. The default model is Core's catalog default (`google/veo-3.1-fast`). The tool never switches models on its own (owner decision: prices differ): when the model is busy upstream (429/502, "busy"/"overloaded", nothing billed) the call ends with an error naming up to three catalog models that can take the clip, and the agent asks the user; only a `model` the user names changes it. `image.generate` keeps its one-step fallback. The default length is 4 seconds, because OpenRouter bills video by the second. `image` (a first frame for image-to-video) is read-scoped like any read and checked to be a picture before asking.

It always asks below approval level 3 (`paid_generation`), and the question says that stopping does not cancel the charge: OpenRouter has no cancel for a video, so Esc only stops the waiting. The prompt offers the tool only while an OpenRouter key is configured (`GATED_TOOLS.video`). Progress reaches the tool card as `tool_progress` events, at most one every 20 seconds. Analytics: `video_generated` with model, clip length and outcome only.

Read [tool instructions](../AGENTS.md), [the image tool](../image/README.md) it is modelled on and the adjacent tests before changing arguments, approval or where files are saved.
