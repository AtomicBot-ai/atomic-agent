import { describe, expect, it, vi } from "vitest";
import type { AtomicAgentConfig } from "../../config/index.js";

vi.mock("../../runtime/append-local-question.js", () => ({
  inspectAppendLocalQuestion: vi.fn(),
  answerAppendLocalQuestion: vi.fn(),
}));

import {
  answerAppendLocalQuestion,
  inspectAppendLocalQuestion,
} from "../../runtime/append-local-question.js";
import { AppendLocalQuestionOrchestrator } from "./append-local-question-orchestrator.js";

const config = { paths: { userConfigFile: "/state/config.json", stateDir: "/state" } } as unknown as AtomicAgentConfig;

function make() {
  const emit = vi.fn();
  const refreshFallback = vi.fn();
  return { emit, refreshFallback, o: new AppendLocalQuestionOrchestrator({ config: () => config, emit, refreshFallback }) };
}

/** ATO-1461. */
describe("AppendLocalQuestionOrchestrator", () => {
  it("asks when the runtime has a question, and records Turn off once", () => {
    vi.mocked(inspectAppendLocalQuestion).mockReturnValue({ question: "Q?", detail: "D", appendLocal: true, answer: null });
    const { emit, refreshFallback, o } = make();
    o.check();
    expect(emit).toHaveBeenCalledWith({ type: "append_local_asked", prompt: { question: "Q?", detail: "D" } });
    o.answer("off");
    o.answer("off");
    expect(answerAppendLocalQuestion).toHaveBeenCalledTimes(1);
    expect(answerAppendLocalQuestion).toHaveBeenCalledWith({ userConfigFile: "/state/config.json", stateDir: "/state" }, "off");
    expect(refreshFallback).toHaveBeenCalledTimes(1);
  });

  it("asks nothing and records nothing when there is no question", () => {
    vi.mocked(inspectAppendLocalQuestion).mockReturnValue({ question: null, detail: null, appendLocal: false, answer: null });
    vi.mocked(answerAppendLocalQuestion).mockClear();
    const { emit, o } = make();
    o.check();
    o.answer("keep");
    expect(emit).not.toHaveBeenCalled();
    expect(answerAppendLocalQuestion).not.toHaveBeenCalled();
  });

  it("says so when the answer could not be saved", () => {
    vi.mocked(inspectAppendLocalQuestion).mockReturnValue({ question: "Q?", detail: "D", appendLocal: true, answer: null });
    vi.mocked(answerAppendLocalQuestion).mockImplementation(() => { throw new Error("disk full"); });
    const { emit, o } = make();
    o.check();
    o.answer("keep");
    expect(emit).toHaveBeenLastCalledWith({ type: "runtime_info", line: "[fallback] answer not saved: disk full" });
  });
});
