import { describe, expect, it } from "vitest";

import { parsePersonaCommand, PERSONA_USAGE } from "./persona-command.js";
import { dispatchSlashCommand } from "./slash-command-handler.js";

describe("parsePersonaCommand", () => {
  it("lists with no arguments or `list`", () => {
    expect(parsePersonaCommand("")).toEqual({ kind: "list" });
    expect(parsePersonaCommand("  list ")).toEqual({ kind: "list" });
  });

  it("reads use and bind with one name", () => {
    expect(parsePersonaCommand("use reviewer")).toEqual({ kind: "use", name: "reviewer" });
    expect(parsePersonaCommand("USE default")).toEqual({ kind: "use", name: "default" });
    expect(parsePersonaCommand("bind writer")).toEqual({ kind: "bind", name: "writer" });
  });

  it("answers anything else with the usage line", () => {
    for (const args of ["use", "use a b", "switch a", "bind"]) {
      expect(parsePersonaCommand(args)).toEqual({ kind: "error", message: PERSONA_USAGE });
    }
  });
});

describe("/persona dispatch", () => {
  it("hands the parsed command to the submit path", () => {
    const result = dispatchSlashCommand("/persona use reviewer");
    expect(result.personaCommand).toEqual({ kind: "use", name: "reviewer" });
    expect(result.clearBuffer).toBe(true);
    expect(result.forwardAsMessage).toBe(false);
  });
});
