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

The router runs once, before the turn starts (`executeTurn` in `runtime/composition/runtime-turn-service.ts`), and pins the turn to the chosen provider (`RunTurnOptions.providerId`), so every step of the turn stays on it. A pinned turn does not fall over to `llm.fallback` links: the provider the rule chose answers or the turn reports its error.

It does nothing when it is off (the default), while a run mode is set (`llm.runMode`, `/runmode`) or Fusion is in effect, or for a turn that is already pinned (a Fusion worker, an explicit `providerId`). A rule is passed over when its provider is not configured, says `supportsTools: false` for a turn with tools, or says `supportsVision: false` for a message with an image. A matching rule that names the active provider keeps the turn where it was.

A rule chooses a provider entry, and the entry's `defaultChatModel` is the model; to route to another model of the same service, configure a second entry. Step 2 (a small classifier model) is not built.

Read [router](route-turn.ts), [tests](route-turn.test.ts), [config](../../config/llm-router-config.ts).
