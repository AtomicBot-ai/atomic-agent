/**
 * One resend after a 400 that taught a model's temperature, for the
 * calls that build their own body outside the chat path: the image and
 * audio describe calls, the key check and the contract probe (#1554).
 *
 * The chat path already does this (`OpenAiProvider.learnTemperature`).
 * These side calls used to fail on the same 400 instead: a Claude id the
 * static rule in `model-params.ts` does not know (a gateway alias, a
 * vendor prefix it does not read), or an operator `params.temperature`
 * on one it does, came back as "`temperature` is deprecated for this
 * model" and the image went undescribed or the key read as broken.
 * LiteLLM's `drop_params` is the same idea: drop the field the provider
 * refused and send again.
 *
 * The lesson is remembered for the model for the rest of the process,
 * so the next body any caller builds already carries it.
 */

import type { TemperatureLesson } from "./allowed-temperature.js";
import {
  rememberAllowedTemperature,
  rememberTemperatureForbidden,
} from "./model-params.js";

/**
 * The body to send again, or `undefined` when there is nothing to learn:
 * no lesson, or the body already obeys it (resending the same body would
 * only earn the same 400).
 */
export function bodyAfterTemperatureLesson(
  model: string,
  lesson: TemperatureLesson | undefined,
  sentBody: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (lesson === undefined) return undefined;
  if (lesson.kind === "forbidden") {
    if (!("temperature" in sentBody)) return undefined;
    rememberTemperatureForbidden(model);
    const { temperature: _dropped, ...rest } = sentBody;
    return rest;
  }
  if (sentBody.temperature === lesson.value) return undefined;
  rememberAllowedTemperature(model, lesson.value);
  return { ...sentBody, temperature: lesson.value };
}
