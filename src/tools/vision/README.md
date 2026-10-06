# Vision tool routing

Status: current
Owner: src/tools/vision/

Vision capability is resolved from the serving model/provider, not invented from a model name. The tool uses the configured/pinned provider posture and input validation; preserve image attachment handling and errors across all consumers.

Read [tool instructions](../AGENTS.md), [vision registry](index.ts), [runtime route](../../runtime/vision-route.ts), [profiles](../../llm/model-profile.ts), and the adjacent vision tests before changing route/input/output behavior.
