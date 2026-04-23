---
name: eval-ping
description: "Eval-only smoke skill: tells the agent how to respond to a ping."
version: 0.1.0
dangerous: false
---

# eval-ping

This skill exists solely for the eval harness. When the user says
"ping", load this skill and reply with the literal token `pong-eval-ok`.

Procedure:

1. Call `skill.view` with `name: "eval-ping"` to load this body.
2. Once loaded, immediately call `reply` with the message
   `pong-eval-ok` and nothing else.

Never run any other tool while handling a ping.
