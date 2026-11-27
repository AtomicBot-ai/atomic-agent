# Vision tool routing

Status: current
Owner: src/tools/vision/

Vision capability is resolved from the serving model/provider, not invented from a model name. The tool uses the configured/pinned provider posture and input validation; preserve image attachment handling and errors across all consumers. A turn on its own model (`ToolContext.model`, ATO-1588) gets that model's provider copy (`ProviderRegistry.modelVariant`, except on llama-server), so the image and the capability check are for the turn's model.

Read [tool instructions](../AGENTS.md), [vision registry](index.ts), [runtime route](../../runtime/vision-route.ts), [profiles](../../llm/model-profile.ts), and the adjacent vision tests before changing route/input/output behavior.
