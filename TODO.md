# /max_steps Slash Command Implementation Plan

**Goal:** Implement a runtime `/max_steps <number>` slash command to adjust the agent's max_steps configuration without requiring a restart.

**Architecture:** 
- Add new slash command definition to SLASH_COMMANDS registry
- Implement sub-dispatcher function to handle /max_steps command
- Command will validate input, update runtime config, and persist to config.json
- Provide user feedback on success or validation errors

**Tech Stack:**
- TypeScript
- Existing slash command infrastructure
- Config persistence system

---

## Testing Plan

I will add integration tests that ensure the /max_steps slash command properly updates the agent's max_steps configuration and persists it across sessions.

I will add unit tests that verify the sub-dispatcher correctly parses arguments and returns appropriate dispatch results.

I will add manual verification tests that confirm the command works in the TUI and affects agent behavior.

NOTE: I will write *all* tests before I add any implementation behavior.

---

## Implementation Details

- Add "max_steps" entry to SLASH_COMMANDS in src/tui/commands/slash-commands.ts
- Implement dispatchMaxStepsSub function in src/tui/commands/slash-command-handler.ts
- Function should:
  * Parse numeric argument from rawArgs
  * Validate it's a positive integer
  * Update getConfig().agent.maxSteps with new value
  * Persist updated config to config.json using writeUserConfigFileSync
  * Return systemMessage confirmation
- Handle edge cases: non-numeric input, negative numbers, zero
- Follow existing patterns from dispatchThemeSub, dispatchModelsSub, etc.

**Question:** Should the command update only the runtime config or also persist to disk? Based on user request for "runtime" adjustment, I'll update both runtime and persist so the setting survives restarts.

**Question:** Should I validate against any maximum value? The config schema uses parsePositiveInt which only requires >0, so I'll follow that.

**Question:** How to provide immediate feedback? Through systemMessage in SlashDispatchResult like other commands.

---