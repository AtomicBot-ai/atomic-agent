# /servers (ATO-2490)

Status: current
Owner: src/tui/local-servers/

`/servers [action ...]` runs [`atomic-agent local-servers`](../../cli/local-servers-command.ts) inside the TUI and posts its output as notes: the list of Ollama, LM Studio and Llama app servers, or the result of `start`, `load`, `unload`, `pull`, `rm` and `adopt`. A pull's progress comes as it goes (every 10 percent). [local-servers-slash.ts](local-servers-slash.ts) drops `--json` and refuses `adopt --use`, since switching models prints to the terminal the TUI is drawing on; the note says to run `/model use <id>` instead. Wired through the slash handler's `localServersArgs` and `onLocalServersRequested` in [tui-command.ts](../tui-command.ts).
