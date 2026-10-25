/**
 * Probe-run bookkeeping for the wandering detector (issue #458).
 *
 * The distinct-args spread alone cannot tell a research fan-out from
 * query churn: both are N different arguments on one tool. What separates
 * them is what the turn does BETWEEN the probes. A model that searches,
 * runs a command, searches again is converging on an answer; a model that
 * fires 35 re-phrased queries and touches nothing else is burning the
 * step budget.
 *
 * So the spread the detector acts on is scoped to the current *run*: the
 * distinct signatures a wandering-prone tool has accumulated since the
 * turn last completed a successful call that settles it.
 *
 * Deliberately NOT a judgement about the probe's own result. A search
 * that returns `status: "ok"` proves a SERP came back, not that it was
 * usable, so "the probe succeeded" is not progress here. "The turn
 * completed other work" is a fact about the call sequence, and that is
 * the only thing this module reads.
 */

/**
 * The family a wandering-prone tool belongs to, or `null` for a tool that
 * cannot wander. Families are what settling is keyed on, because two
 * tools of one family are two moves of the same probe: `browser.click`
 * followed by `browser.read_aria` is one step of clicking around, and
 * `os.http.request` is `os.web.fetch` by another name. Letting those
 * settle each other would leave an alternating pair unbounded — which is
 * exactly the "clicking around" the browser redirect names.
 *
 * Across families the call IS the progress: a fetch opens a result the
 * search found, and a search hands the fetch loop real URLs instead of
 * guesses. Bulk reads over distinct files (`os.fs.read`) have no family —
 * scanning many files is legitimate work, not a loop.
 */
export function probeFamily(tool: string): string | null {
  if (tool === "os.web.search") return "search";
  if (tool === "os.web.fetch" || tool === "os.http.request") return "fetch";
  if (tool.startsWith("browser.")) return "browser";
  return null;
}

/**
 * Distinct probe signatures per wandering-prone tool since that tool's
 * run was last settled, each tagged with the ROUND it was made in. One
 * instance per turn, owned by the `ToolLoopTracker`.
 *
 * A round is one model step (ATO-999, #828). The distinct-signature
 * count is what the messages quote, but what decides is how many rounds
 * of probing the run spans: four URLs fetched side by side in one step
 * are one decision by the model, a fan-out, not four attempts at the
 * same thing. Churn of one probe per step still counts one round per
 * step, so that shape stops at the same call as before; k probes per
 * step now take k times as many calls to reach the run cap and are
 * bounded by the window ceiling instead. A probe recorded without a
 * round (no step was noted) is a round of its own, which is the
 * per-call behaviour every caller had before rounds existed.
 */
export class ProbeRuns {
  private readonly runs = new Map<string, Map<string, string>>();
  private nextSoloRound = 0;
  /**
   * Tools that have completed successfully since the last read. Settling
   * is applied lazily, at the next read, so a run boundary does not
   * depend on the order a parallel batch happens to resolve in: a batch's
   * outcomes all land before the next gate reads, and `os.fs.grep`
   * beating seven `os.web.fetch` calls home is a property of the network,
   * not of the model's behaviour.
   */
  private readonly progress = new Set<string>();

  /**
   * Fold a completed call into the runs. `ok` is the call's status;
   * `round` the step it was made in. A vetoed call never reaches here --
   * it did not run, so it is neither a probe nor progress.
   */
  record(tool: string, argsHash: string, ok: boolean, round?: number): void {
    if (ok) this.progress.add(tool);
    if (probeFamily(tool) === null) return;
    const roundKey =
      round === undefined ? `solo:${this.nextSoloRound++}` : `step:${round}`;
    const run = this.runs.get(tool);
    if (run === undefined) {
      this.runs.set(tool, new Map([[argsHash, roundKey]]));
      return;
    }
    if (!run.has(argsHash)) run.set(argsHash, roundKey);
  }

  /**
   * The run spread for a prospective `(tool, argsHash)` -- the distinct
   * signatures already in the run, plus one when this call introduces a
   * new one. Mirrors the window spread: the current call is not recorded
   * yet when the gate asks.
   */
  spread(tool: string, argsHash: string): number {
    this.applyProgress();
    const run = this.runs.get(tool);
    if (run === undefined) return 1;
    return run.has(argsHash) ? run.size : run.size + 1;
  }

  /**
   * How many rounds the run spans once the prospective call joins it: the
   * distinct rounds already in the run, plus one when the call is a new
   * signature made in a round the run has not seen yet. Without a
   * `round` the call is a round of its own. Never above `spread`.
   */
  rounds(tool: string, argsHash: string, round?: number): number {
    this.applyProgress();
    const run = this.runs.get(tool);
    if (run === undefined) return 1;
    const seen = new Set(run.values());
    if (run.has(argsHash)) return seen.size;
    if (round !== undefined && seen.has(`step:${round}`)) return seen.size;
    return seen.size + 1;
  }

  /**
   * Drop every run that something outside its family has settled since
   * the last read.
   */
  private applyProgress(): void {
    if (this.progress.size === 0) return;
    for (const probe of [...this.runs.keys()]) {
      const family = probeFamily(probe);
      for (const done of this.progress) {
        if (probeFamily(done) !== family) {
          this.runs.delete(probe);
          break;
        }
      }
    }
    this.progress.clear();
  }
}
