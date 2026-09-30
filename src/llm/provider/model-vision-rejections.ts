/**
 * Models a service has refused an image for, keyed by provider id and
 * model id. Process-wide on purpose: the provider object is rebuilt on
 * every config write, and a switch away and back must not hand the
 * model a fresh chance to fail the same way. A restart clears it; an
 * explicit `supportsVision` in config outranks it (`model-vision.ts`).
 */
const rejectedImages = new Set<string>();

function rejectionKey(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

export function markModelCannotSee(providerId: string, modelId: string): void {
  rejectedImages.add(rejectionKey(providerId, modelId));
}

export function modelCannotSee(providerId: string, modelId: string): boolean {
  return rejectedImages.has(rejectionKey(providerId, modelId));
}

/** Test seam: forget every recorded rejection. */
export function resetModelVisionRejections(): void {
  rejectedImages.clear();
}

/**
 * Whether a failed describe request is the service saying this model
 * does not take images, as opposed to a transient or account failure.
 * A describe body differs from a text turn only by its `image_url`
 * parts, so a client-error status whose body talks about images,
 * modalities or content shape — or aimlapi's bare
 * `Validation failed`, which is all it says about an image sent to a
 * text-only model — is read as a verdict on the model. Auth (401/403),
 * throttling (429) and server errors (5xx) never are.
 */
export function isImageRejection(
  status: number | null,
  message: string,
): boolean {
  if (status !== 400 && status !== 404 && status !== 415 && status !== 422) {
    return false;
  }
  return IMAGE_REJECTION_PATTERN.test(message);
}

const IMAGE_REJECTION_PATTERN =
  /image|vision|multimodal|modalit|validation failed|content.{0,40}(array|string)|not support|unsupported/i;
