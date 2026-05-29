import type { Rule } from "../guard-types.js";

/**
 * `icalBuddy` is a read-only Calendar / Reminders reader backed by EventKit.
 * It has no write capability, so every invocation is auto-approved. Calendar
 * *writes* go through `osascript` (AppleScript), which is NOT covered by this
 * rule and stays behind the approval gate.
 */
export const icalBuddyReadOnlyRule: Rule = {
  id: "ical_buddy.read_only",
  layer: "trusted",
  match(input) {
    if (input.cmd !== "icalbuddy") return null;
    return {
      action: "allow",
      rule: "ical_buddy.read_only",
      reason: "icalBuddy read-only calendar reader",
    };
  },
};
