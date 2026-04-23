import type { EvalCase } from "../harness/case-schema.js";

export const skillViewPing: EvalCase = {
  id: "skill-view-ping",
  name: "Load the eval-ping skill body and follow it",
  category: "skill",
  prompt: "ping",
  expectations: [
    { kind: "tool_invoked", tool: "skill.view", mustSucceed: true },
    { kind: "reply_contains", pattern: /pong-eval-ok/ },
  ],
};
