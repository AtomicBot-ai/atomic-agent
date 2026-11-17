import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEmptySessionState, type SessionState } from "../session/index.js";

import { startTestHarness, type Harness } from "./test-harness.js";

interface ExportBody {
  id: string;
  format: string;
  filename: string;
  mimeType: string;
  encoding: "utf8" | "base64";
  content: string;
}

describe("GET /api/sessions/{id}/export (ATO-1054)", () => {
  let harness: Harness;
  beforeEach(async () => { harness = await startTestHarness(); });
  afterEach(async () => { await harness.cleanup(); });

  const get = (id: string, query = "") => fetch(`${harness.baseUrl}/api/sessions/${id}/export${query}`);

  function seed(id: string): SessionState {
    const state: SessionState = {
      ...createEmptySessionState({ id, workingDir: harness.workingDir, metadata: { title: "Trip plan" } }),
      status: "completed",
      turns: [
        { kind: "user", text: "Plan a trip", at: 1 },
        { kind: "assistant_tool_call", tool: "os.fs.read", args: { path: "notes.md" }, at: 2 },
        { kind: "tool_result", tool: "os.fs.read", status: "ok", summary: "x", at: 3 },
        { kind: "assistant_reply", text: "Day 1: **Lisbon**", at: 4 },
      ],
      turnCount: 1,
      macroTurnStarts: [4],
    };
    harness.runtime.sessionStore.save(state);
    return state;
  }

  it("answers Markdown by default, with tool steps in words", async () => {
    seed("ex-1");
    const res = await get("ex-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ExportBody;
    expect(body).toMatchObject({ id: "ex-1", format: "markdown", filename: "Trip plan.md", encoding: "utf8" });
    expect(body.mimeType).toMatch(/^text\/markdown/);
    expect(body.content).toContain("# Trip plan");
    expect(body.content).toContain("Day 1: **Lisbon**");
    expect(body.content).toMatch(/\n- .+\n/);
    expect(body.content).not.toContain("- Used os.fs.read");
  });

  it("leaves tool steps out with tools=0", async () => {
    seed("ex-2");
    const body = (await (await get("ex-2", "?tools=0")).json()) as ExportBody;
    expect(body.content).not.toMatch(/\n- /);
  });

  it("answers HTML and a base64 DOCX", async () => {
    seed("ex-3");
    const html = (await (await get("ex-3", "?format=html")).json()) as ExportBody;
    expect(html.encoding).toBe("utf8");
    expect(html.content).toContain("<strong>Lisbon</strong>");
    const docx = (await (await get("ex-3", "?format=docx")).json()) as ExportBody;
    expect(docx).toMatchObject({ format: "docx", filename: "Trip plan.docx", encoding: "base64" });
    const zip = await JSZip.loadAsync(Buffer.from(docx.content, "base64"));
    expect(await zip.file("word/document.xml")!.async("string")).toContain("Lisbon");
  });

  it("refuses an unknown format and a missing session", async () => {
    seed("ex-4");
    expect((await get("ex-4", "?format=pdf")).status).toBe(400);
    expect((await get("nope")).status).toBe(404);
  });
});
