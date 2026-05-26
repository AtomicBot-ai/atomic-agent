import type { CompletionRequest } from "../completion-types.js";

/**
 * Strips llama.cpp-only sampling knobs before sending a request to an
 * OpenAI-compatible cloud API.
 */
export function filterCloudCompletionRequest(
  request: CompletionRequest,
): CompletionRequest {
  const {
    topK: _topK,
    repeatPenalty: _repeatPenalty,
    repeatLastN: _repeatLastN,
    grammar: _grammar,
    slotId: _slotId,
    cachePrompt: _cachePrompt,
    imageData: _imageData,
    ...rest
  } = request;
  return rest;
}
