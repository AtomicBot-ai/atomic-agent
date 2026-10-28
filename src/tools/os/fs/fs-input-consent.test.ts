import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import {
  REQUEST_FOLLOW_UP_MARKER,
  workerRequestRecord,
} from "../../../prompt/request-section.js";
import { renderWorkerBrief } from "../../fusion/worker-prompt.js";
import type { ToolContext } from "../../tool-registry.js";
import {
  answersReplaceQuestion,
  isPlainYes,
  latestUserMessage,
  questionSentences,
  replyAsksToReplace,
} from "./fs-input-consent.js";
import { FileRestoreStore } from "./fs-restore-store.js";
import { buildOsFsWriteTool } from "./fs-write.js";

/**
 * ATO-860. A plain "yes" to the agent's "Replace sales.csv?" replaces
 * sales.csv, and only it; a pointer ("replace it") counts only as an
 * answer to such a question; a worker brief without an ORIGINAL REQUEST
 * block agrees to nothing.
 */
const followUp = (request: string, latest: string): string =>
  `${request}\n\n${REQUEST_FOLLOW_UP_MARKER}\n${latest}`;

describe("answer rules (ATO-860)", () => {
  it("knows a plain yes, in English and Russian, and nothing longer", () => {
    for (const yes of ["yes", "Yes.", "y", "ok", "OK, go ahead", "sure, do it", "yes please", "go ahead", "да", "Да!", "давай", "ок, давай"]) {
      expect(isPlainYes(yes), yes).toBe(true);
    }
    for (const no of ["no", "нет", "yes, but not now", "не надо", "replace that line", "write it to clean.csv", "", "ok ok ok ok ok ok ok ok ok"]) {
      expect(isPlainYes(no), no).toBe(false);
    }
  });

  it("reads the user's latest message out of a merged follow-up", () => {
    expect(latestUserMessage(followUp("Clean sales.csv", "yes")).trim()).toBe("yes");
    expect(latestUserMessage("Clean sales.csv")).toBe("Clean sales.csv");
  });

  it("finds question sentences without splitting on a file name's dot", () => {
    expect(questionSentences("Done with sales.csv. Replace sales.csv? Or keep it.")).toEqual([
      ["Replace", "sales.csv?"],
    ]);
    expect(questionSentences("**Overwrite `sales.csv`?**")).toEqual([["**Overwrite", "`sales.csv`?**"]]);
    expect(questionSentences("I wrote clean.csv.")).toEqual([]);
  });

  it("sees a question about replacing a named file, and only that file", () => {
    expect(replyAsksToReplace("Replace sales.csv?", "sales.csv")).toBe(true);
    expect(replyAsksToReplace("Should I overwrite data/sales.csv with the cleaned rows?", "sales.csv")).toBe(true);
    expect(replyAsksToReplace("Перезаписать sales.csv?", "sales.csv")).toBe(true);
    expect(replyAsksToReplace("Replace sales.csv?", "costs.csv")).toBe(false);
    // A statement, a negated verb, or a question with no replace verb.
    expect(replyAsksToReplace("I will overwrite sales.csv.", "sales.csv")).toBe(false);
    expect(replyAsksToReplace("Should I not overwrite sales.csv?", "sales.csv")).toBe(false);
    expect(replyAsksToReplace("Should I read sales.csv again?", "sales.csv")).toBe(false);
  });

  it("agrees only when the question named the file and the answer is a yes or a pointer", () => {
    const question = "Replace sales.csv?";
    const request = "Clean sales.csv and costs.csv";
    expect(answersReplaceQuestion(followUp(request, "yes"), question, "sales.csv")).toBe(true);
    expect(answersReplaceQuestion(followUp(request, "yes, replace it"), question, "sales.csv")).toBe(true);
    expect(answersReplaceQuestion(followUp(request, "да"), question, "sales.csv")).toBe(true);
    expect(answersReplaceQuestion(followUp(request, "yes"), question, "costs.csv")).toBe(false);
    expect(answersReplaceQuestion(followUp(request, "no"), question, "sales.csv")).toBe(false);
    expect(answersReplaceQuestion(followUp(request, "replace that line"), question, "sales.csv")).toBe(false);
    expect(answersReplaceQuestion(followUp(request, "yes"), undefined, "sales.csv")).toBe(false);
    expect(answersReplaceQuestion("", question, "sales.csv")).toBe(false);
  });
});

describe("os.fs.write after the agent asked to replace a file (ATO-860)", () => {
  let dir: string;
  let stateDir: string;
  let request: string | undefined;
  let previousReply: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-input-consent-"));
    stateDir = await mkdtemp(join(tmpdir(), "atomic-input-consent-state-"));
    await writeFile(join(dir, "sales.csv"), "id,amount\n1,10\n2,20\n", "utf8");
    await writeFile(join(dir, "costs.csv"), "id,cost\n1,5\n2,6\n", "utf8");
    request = "Clean sales.csv and costs.csv: drop the rows with an empty amount";
    previousReply = undefined;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  const ctx = (sessionId = "s-consent"): ToolContext => ({
    workingDir: dir,
    sessionId,
    stepIndex: 0,
    signal: new AbortController().signal,
  });

  function write() {
    const gate: ApprovalGate = new ApprovalGate({
      emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    return buildOsFsWriteTool({
      approvals: gate,
      approvalRequired: true,
      restore: new FileRestoreStore(join(stateDir, "restore")),
      resolveOriginalRequest: () => request,
      resolvePreviousReply: () => previousReply,
    });
  }

  it("lets a plain yes to \"Replace sales.csv?\" replace sales.csv, and not another input", async () => {
    previousReply = "I cleaned the rows in memory. Replace sales.csv?";
    request = followUp(request!, "yes");
    const tool = write();
    const sales = await tool.run({ path: "sales.csv", content: "id,amount\n1,10\n" }, ctx());
    expect(sales.status).toBe("ok");
    expect(await readFile(join(dir, "sales.csv"), "utf8")).toBe("id,amount\n1,10\n");
    const costs = await tool.run({ path: "costs.csv", content: "id,cost\n" }, ctx());
    expect(costs.status).toBe("error");
    expect(costs.summary).toContain('"Replace costs.csv?"');
    expect(await readFile(join(dir, "costs.csv"), "utf8")).toBe("id,cost\n1,5\n2,6\n");
  });

  it("does not take \"replace that line\" without a question about the file", async () => {
    request = followUp(request!, "replace that line");
    const result = await write().run({ path: "sales.csv", content: "x\n" }, ctx());
    expect(result.status).toBe("error");
    // Nor "replace it" when the agent's reply asked nothing about a file.
    previousReply = "The second row has an empty amount.";
    request = followUp("Clean sales.csv", "replace it");
    expect((await write().run({ path: "sales.csv", content: "x\n" }, ctx())).status).toBe("error");
  });

  it("lets \"replace it\" after the question replace the file the question named", async () => {
    previousReply = "Should I overwrite sales.csv with the cleaned rows?";
    request = followUp(request!, "yes, replace it");
    const tool = write();
    expect((await tool.run({ path: "sales.csv", content: "x\n" }, ctx())).status).toBe("ok");
    expect((await tool.run({ path: "costs.csv", content: "x\n" }, ctx())).status).toBe("error");
  });

  it("takes a Russian да to a Russian question", async () => {
    previousReply = "Перезаписать sales.csv?";
    request = followUp(request!, "да");
    expect((await write().run({ path: "sales.csv", content: "x\n" }, ctx())).status).toBe("ok");
  });

  it("takes no consent from a worker brief without an ORIGINAL REQUEST block", async () => {
    // The orchestrator's own words name the file and say "rewrite": they
    // still name an input, but they are not the user agreeing.
    const brief = renderWorkerBrief(
      { id: "t1", title: "Sales", instructions: "Rewrite sales.csv with the clean rows", files: ["sales.csv"] },
      { workingDir: dir },
    );
    expect(brief).not.toContain("BEGIN ORIGINAL REQUEST");
    request = workerRequestRecord(brief);
    const result = await write().run({ path: "sales.csv", content: "x\n" }, ctx("s-w-1"));
    expect(result.status).toBe("error");
    expect(result.summary).toContain("sales.csv is an input the request names");
    expect(await readFile(join(dir, "sales.csv"), "utf8")).toBe("id,amount\n1,10\n2,20\n");
  });

  it("lets a worker act on the user's yes to its parent's question", async () => {
    const brief = renderWorkerBrief(
      { id: "t1", title: "Sales", instructions: "Write the cleaned rows", files: ["sales.csv"] },
      { workingDir: dir, originalRequest: followUp("Clean sales.csv", "yes") },
    );
    request = workerRequestRecord(brief);
    previousReply = "Replace sales.csv?";
    expect((await write().run({ path: "sales.csv", content: "x\n" }, ctx("s-w-1"))).status).toBe("ok");
  });
});
