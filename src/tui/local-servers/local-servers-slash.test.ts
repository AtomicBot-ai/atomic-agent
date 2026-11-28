import { describe, expect, it } from "vitest";

import { dispatchSlashCommand } from "../commands/slash-command-handler.js";
import { SERVERS_USE_IN_TUI, runLocalServersSlash, tuiServersArgs, tuiServersText } from "./local-servers-slash.js";

describe("/servers in the TUI (ATO-2490)", () => {
  it("/servers hands its words to the runner", () => {
    expect(dispatchSlashCommand("/servers unload ollama --all", []).localServersArgs).toEqual(["unload", "ollama", "--all"]);
    expect(dispatchSlashCommand("/servers", []).localServersArgs).toEqual([]);
  });

  it("--json is dropped; --use is refused with the /model hint", () => {
    expect(tuiServersArgs(["pull", "ollama", "x", "--json"])).toEqual(["pull", "ollama", "x"]);
    expect(tuiServersArgs(["adopt", "ollama", "x", "--use"])).toEqual({ refused: SERVERS_USE_IN_TUI });
  });

  it("the command's terminal hints read as TUI commands", () => {
    expect(tuiServersText("Run it with: atomic-agent models use custom-local-a-1\n")).toBe("Switch to it with /model use custom-local-a-1");
  });

  it("the listing is one note; a pull streams its lines", async () => {
    const notes: string[] = [];
    await runLocalServersSlash([], (t) => notes.push(t), async (_a, d) => { d?.write?.("Ollama at x\n  * qwen3:8b\n"); return 0; });
    expect(notes).toEqual(["Ollama at x\n  * qwen3:8b"]);

    const pulled: string[] = [];
    await runLocalServersSlash(["pull", "ollama", "qwen3:8b"], (t) => pulled.push(t), async (_a, d) => {
      d?.write?.("pulling: 10%\n");
      d?.write?.("qwen3:8b is downloaded in Ollama.\n");
      return 0;
    });
    expect(pulled).toEqual(["/servers pull ollama qwen3:8b: working…", "pulling: 10%", "qwen3:8b is downloaded in Ollama."]);
  });
});
