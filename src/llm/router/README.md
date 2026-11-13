# Rule-based model router

Status: current (step 1 of ATO-483)
Owner: src/llm/router/

`llm.router` holds opt-in rules that send a turn to a configured provider by what the request looks like: estimated message tokens (`minTokens`, `maxTokens`, about four characters per token), an image in the message (`hasImage`: an image file name or a `data:image/` URL), words (`contains`, any, case-insensitive), a regular expression (`matches`, case-insensitive), whether the turn offers tools (`needsTools`), and the session's working folder (`workingDir`, the folder or inside it, `~` allowed). All conditions of a rule must hold; the first matching rule wins, so order is precedence. A rule without `when` matches every turn.

```json
"router": {
  "enabled": true,
  "rules": [
    { "name": "screenshots", "when": { "hasImage": true }, "provider": "gemini" },
    { "name": "quick", "when": { "maxTokens": 60 }, "provider": "groq" }
  ]
}
```

The router runs once, before the turn starts (`executeTurn` in `runtime/composition/runtime-turn-service.ts`), and puts the chosen provider first in that session's fallback chain for the turn (`ProviderFallbackChain.setTurnPrimary`). The rest of the chain follows in its usual order: the active provider, then `llm.fallback.chain`, without a repeat of the routed one. Every step of the turn starts on the routed provider; when it fails the way a primary falls over (429, 5xx, network, a refused key), the next link answers, with the usual "switched to" notice, and the later steps of the turn stay on the link that answered. When the turn ends the head is taken off, and the next turn starts on the configured chain again. The prompt seams, compaction and the `### route` note read the same head (`standingOverrideFor`), so they describe the provider the turn really starts on. See [fallback](../docs/fallback.md).

It does nothing when it is off (the default), under the `local` run mode or Fusion, or for a turn that is already pinned (a Fusion worker, an explicit `providerId`). Under the `cloud` run mode it still routes, between cloud providers only: a rule that names a `llama-server` provider is passed over. A rule is also passed over when its provider is not configured, says `supportsTools: false` for a turn with tools, or says `supportsVision: false` for a message with an image. A matching rule that names the active provider keeps the turn where it was.

A rule chooses a provider entry, and the entry's `defaultChatModel` is the model; to route to another model of the same service, configure a second entry. A per-rule `model` and step 2 (a small classifier model) are not built.

Read [router](route-turn.ts), [tests](route-turn.test.ts), [config](../../config/llm-router-config.ts).
