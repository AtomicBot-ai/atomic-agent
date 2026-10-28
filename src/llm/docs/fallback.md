# Reliability and provider fallback

Status: current
Owner: src/llm/

## Responsibilities

Transport retry handles transient request/open failures: at most three attempts with jittered backoff, stretched to a provider's `Retry-After` up to 5 s. A cooldown longer than that is not retried in place (it would only spend requests against the same limit); the error goes up so the turn's outage wait honours the full hint within `agent.providerWait.maxWaitMs`, or the person's fallback link answers (ATO-483). A switch to a fallback link is always said in the turn: the `provider_switched` event carries the failure-catalog cause and the fallback model, and hosts show `falloverSentence` ("OpenRouter is rate-limited, answered with Gemini (gemini-2.5-flash)."; the SSE `atomic.provider_switched` frame's `notice`). Beyond that, parse recovery belongs to the step executor. Targeted credit-limit and structured-output repairs modify only their narrowly identified refusal. Do not broaden these into retries of arbitrary deterministic errors.

The fallback breaker reads live chain configuration and partitions mutable state by session. Memory runners use distinct session identities; pinned worker turns bypass fallover. An automatically appended local fallback is omitted when no model weights are available, avoiding a wait for a daemon that cannot start; [availability](../../runtime/local-link-availability.ts) owns this check. Provider selection/probing is lazy and owns no periodic timer. A changed active provider affects subsequent resolution rather than a captured boot-time value.

## Streams and transport

Opening/priming a stream can fail over before committed output. Once output is committed, restarting risks duplicating visible text or side effects. Cancellation must propagate as cancellation rather than advancing the provider chain.

Fallback completions and chunks carry servedTransport. Parsing and live reasoning detection use the actual serving link, including when a native-tools primary falls back to grammar. The primary's capabilities are not proof of what the fallback served. Cross-provider strict/parallel capability handling and grammar-primary/native-tail payload limitations remain explicit implementation constraints.

## Sources and tests

- [Breaker](../fallback/provider-fallback-chain.ts), [advance policy](../fallback/should-advance.ts), [config](../fallback/fallback-config.ts).
- [Runtime seam](../../runtime/llm-fallback-seam.ts), [stream implementation](../provider/openai/openai-provider.ts), [stream retry tests](../provider/openai/openai-stream-retry.test.ts).
- [Fallback seam tests](../../runtime/llm-fallback-seam.test.ts), [fallback integration](../fallback/fallback-e2e.integration.test.ts).
