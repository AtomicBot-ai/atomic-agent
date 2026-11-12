# Using the terminal interface

Status: current
Owner: src/tui/

Launch `atomic-agent tui --cwd /path/to/work`. The TUI presents multi-turn chats, approvals, models, tools, memory, tasks and integration controls. Use `/help` to discover the installed command set instead of relying on a historical shortcut list.

A selected chat and an actively running turn can be different sessions. Observe their status before cancelling or deleting work. Provider/model changes affect live runtime resolution; managed local downloads/server lifecycle have their own status.

In the composer, Local mode has the backend and model controls: Atomic Chat Core runs local models and is not a choice there. When Core cannot be installed or started, the Models tab shows what happened with one action: `R` downloads it again. The standalone llama.cpp server is a support-only fallback that the app does not offer: `/model engine llama-server` (or `atomic-agent models engine llama-server`) selects it when support asks you to, and `/model engine atomic-core` switches back. Fusion has an engine/provider and model control for each role, with the swap control between orchestrator and worker. Each model list belongs to its own role. A local seat is labelled **Local**. There is one managed local slot: use swap to move it between roles. Stop a loaded local model before changing its engine. A pending route change holds message submission until it finishes.

`/goal <criteria>` keeps a chat working until an acceptance list is met: write the items one per line or split by `;`, and add shell checks that must pass with `/goal check add <cmd>` (or a `check: <cmd>` item). After each round the checks run, then the model judges every item; open items start the next round, up to 10 rounds by default. `/goal status` shows where it stands, `/goal pause`, `/goal resume` and `/goal clear` control it. The goal is saved with the chat and survives a restart.

Personas are named instructions you add to the agent's own: define them under `agent.personas.definitions` in the config file (each has `instructions` and an optional `style`). `/persona` lists them and shows which one a new session in this folder would use, `/persona use <name>` picks one for everywhere, and `/persona bind <name>` ties one to the current folder (the closest bound folder wins over `use`). `default` in place of a name turns it off. The `ATOMIC_AGENT_PERSONA` environment variable wins over both. A chat keeps the persona it started with, so a switch applies from the next session (`/new`).

The keyboard and mouse share the same UI transitions. Terminal size/capabilities affect layout and modified keys. The runtime restores terminal modes when the interface exits.

For engineering work read [TUI ownership/input](../../src/tui/README.md) and [interface contracts](../../src/tui/docs/interface.md). The previous onboarding QA campaign is [historical](../archive/2026-10-06/TESTING.md), not a current development checklist.
