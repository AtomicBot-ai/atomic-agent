import type { ResolvedRunMode } from "../../llm/run-mode/index.js";

/**
 * What the operator reads in the chat the first time a session switches
 * into Fusion.
 *
 * Fusion is the one route where the composer states two models instead
 * of one and where a control appears that was not there a moment ago,
 * and none of that explains itself: the meta bar has room for labels,
 * not for what a worker is. So the mode introduces itself once, on the
 * way in, naming the two legs it actually resolved rather than
 * describing them in the abstract.
 *
 * Deliberately not repeated when fusion is merely re-applied (picking a
 * different orchestrator, say) — see `RunModeOrchestrator.setMode`.
 */
export function describeFusionIntro(rm: ResolvedRunMode): string {
  const orchestrator = rm.orchestratorModel ?? rm.orchestratorProviderId ?? "your cloud provider";
  const worker = rm.workerModel ?? "the local model";
  const workers = rm.workers;
  return [
    "Fusion is on. Two models run this chat: a cloud one that thinks, and local ones that do the bulk.",
    "",
    `Orchestrator — ${orchestrator}. It plans, writes the instructions for each part, then reviews and merges what comes back.`,
    `Workers — ${workers} × ${worker}, on your machine, in parallel. Each takes one self-contained part (reading files, first drafts, boilerplate, tests, searches) and reports back. They cannot reach you or ask for approval; anything that needs a person comes back up to the orchestrator.`,
    "",
    "Pick both models with ctrl+r: Provider and Model set the cloud orchestrator, Workers sets the local model and how many run at once.",
    "Change the count there or with /runmode workers N (1-8). It also sets the llama-server slot count, so restart the local daemon to apply it — without the slots, extra workers just queue.",
    "",
    "/runmode status says what is resolved right now; /runmode cloud or /runmode local leaves fusion.",
  ].join("\n");
}
