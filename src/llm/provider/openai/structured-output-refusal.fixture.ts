/**
 * Test fixture: OpenRouter's 404 when routing filters leave no endpoint.
 * `counts` are the funnel's `endpoint_count` per step, in the order
 * OpenRouter sends them.
 */
export function openRouterRoutingFunnelBody(
  counts: [number, number, number, number],
): string {
  return JSON.stringify({
    error: {
      message: "No endpoints found for z-ai/glm-5.3-flash.",
      code: 404,
      metadata: {
        routing_funnel: [
          { step: "Initial Endpoints", endpoint_count: counts[0] },
          { step: "Filter by Parameters", endpoint_count: counts[1] },
          { step: "Apply Status Sorting", endpoint_count: counts[2] },
          { step: "Filter by Fallback", endpoint_count: counts[3] },
        ],
      },
    },
  });
}

/**
 * The body OpenRouter sent live (2026-09-13) for every rewriter, link and
 * vote sub-call with `provider.order: ["z-ai"]`: the parameter step drops
 * Z.AI's endpoint (27 → 20), and the pinned order then leaves nothing.
 */
export const OPENROUTER_PARAMETER_REFUSAL_BODY = openRouterRoutingFunnelBody([
  27, 20, 20, 0,
]);
