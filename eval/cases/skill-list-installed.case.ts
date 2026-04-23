import type { EvalCase } from "../harness/case-schema.js";

export const skillListInstalled: EvalCase = {
  id: "skill-list-installed",
  name: "Acknowledge the installed eval-ping skill",
  category: "skill",
  prompt:
    "Look at the list of installed skills available to you and tell me whether `eval-ping` is among them. Reply yes or no.",
  expectations: [
    { kind: "reply_contains", pattern: /\byes\b/i },
  ],
};
