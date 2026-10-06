# Using the terminal interface

Status: current
Owner: src/tui/

Launch `atomic-agent tui --cwd /path/to/work`. The TUI presents multi-turn chats, approvals, models, tools, memory, tasks and integration controls. Use `/help` to discover the installed command set instead of relying on a historical shortcut list.

A selected chat and an actively running turn can be different sessions. Observe their status before cancelling or deleting work. Provider/model changes affect live runtime resolution; managed local downloads/server lifecycle have their own status.

The keyboard and mouse share the same UI transitions. Terminal size/capabilities affect layout and modified keys. The runtime restores terminal modes when the interface exits.

For engineering work read [TUI ownership/input](../../src/tui/README.md) and [interface contracts](../../src/tui/docs/interface.md). The previous onboarding QA campaign is [historical](../archive/2026-10-06/TESTING.md), not a current development checklist.
