import type { CoreVideoModel, CoreVideoRequest, CoreVideoWorkflow } from "../../local-llm/core/core-video.js";
import type { VideoArgs } from "./args.js";

export type FittedVideo =
  | { ok: true; workflow: CoreVideoWorkflow; duration: number; remote: NonNullable<CoreVideoRequest["remote"]>; notes: string[] }
  | { ok: false; reason: string };

/**
 * Shape the request for one model from Core's catalog entry
 * (`VideoModelDescriptor.params`), so Core never refuses it for a value
 * the model does not offer. Core would refuse before billing anyway
 * (`checkRemoteVideoRequest`), but a refusal costs the agent a step and
 * the fallback needs to know which model can take the clip at all.
 *
 * A model Core's catalog does not list (a custom id) gets the request
 * as asked; OpenRouter decides.
 */
export function fitVideoToModel(args: VideoArgs, model: CoreVideoModel | undefined): FittedVideo {
  const workflow: CoreVideoWorkflow = args.image !== undefined ? "image-to-video" : "create";
  const name = model?.name ?? model?.id ?? args.model ?? "the model";
  const remote: NonNullable<CoreVideoRequest["remote"]> = { durationSecs: args.duration, aspectRatio: args.aspect };
  if (args.resolution !== undefined) remote.resolution = args.resolution;
  if (args.audio !== undefined) remote.generateAudio = args.audio;
  if (!model) return { ok: true, workflow, duration: args.duration, remote, notes: [] };

  const notes: string[] = [];
  if (model.workflows && model.workflows.length > 0 && !model.workflows.includes(workflow)) {
    return { ok: false, reason: `${name} cannot ${workflow === "image-to-video" ? "start a clip from an image" : "make a clip from text alone"}.` };
  }

  const params = model.params ?? {};
  let duration = args.duration;
  const durations = params.durations;
  if (durations) {
    const values = durations.values?.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
    const offered = values && values.length > 0
      ? values.includes(duration)
      : duration >= (durations.min ?? 0) && duration <= (durations.max ?? Number.POSITIVE_INFINITY);
    if (!offered) {
      const list = values && values.length > 0 ? values.join(", ") : `${durations.min ?? 1} to ${durations.max ?? "?"}`;
      if (args.durationGiven) return { ok: false, reason: `${name} cannot make a ${duration}-second clip; it takes ${list} seconds.` };
      // Not the user's choice: the shortest length the model offers at or above the default.
      duration = values && values.length > 0
        ? values.find(v => v >= duration) ?? values[values.length - 1]!
        : Math.min(Math.max(duration, durations.min ?? duration), durations.max ?? duration);
      notes.push(`${name} has no ${args.duration}-second clips, so it made ${duration} seconds.`);
    }
  }
  remote.durationSecs = duration;

  const aspects = params.aspect_ratios?.values;
  if (aspects && aspects.length > 0 && !aspects.includes(args.aspect)) {
    delete remote.aspectRatio;
    notes.push(`${name} does not offer ${args.aspect}, so it used its default shape.`);
  }
  const resolutions = params.resolutions?.values;
  if (args.resolution !== undefined && !(resolutions ?? []).includes(args.resolution)) {
    delete remote.resolution;
    notes.push(`${name} does not offer ${args.resolution}, so it used ${params.resolutions?.default ?? "its default resolution"}.`);
  }
  if (args.audio === true && !params.audio) {
    delete remote.generateAudio;
    notes.push(`${name} makes no sound.`);
  }
  return { ok: true, workflow, duration, remote, notes };
}

/** Pixel size Core's parser requires; a cloud model ignores it and follows `remote`. */
export function nominalSize(aspect: string | undefined): { width: number; height: number } {
  return aspect === "9:16" ? { width: 720, height: 1280 } : { width: 1280, height: 720 };
}
