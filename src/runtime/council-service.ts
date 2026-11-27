import type { AtomicAgentConfig } from "../config/index.js";
import type { LlmProvider } from "../llm/provider/llm-provider.js";
import { resolveLlmConfig } from "../llm/provider/registry/provider-types.js";
import {
  buildSpecProviders,
  closeSpecProviders,
  councilOverBudget,
  describeCouncilCost,
  forecastCouncilCost,
  parseCouncilSeats,
  parseModelSpecs,
  runCouncil,
  seatSpecs,
  type BuiltSpecs,
  type CouncilComplete,
  type CouncilCostForecast,
  type CouncilProgress,
  type CouncilReport,
} from "../llm/toolcall-bench/index.js";
import { councilPriceLookup } from "./council-pricing.js";
import {
  PLAIN_COMPLETE_MAX_PROMPT_CHARS,
  PLAIN_COMPLETE_MAX_TIMEOUT_MS,
  type PlainCompleteInput,
  type PlainCompleteResult,
} from "./plain-complete.js";

/**
 * The model council for the runtime's own clients (ATO-2432): the TUI's
 * `/council` and `POST /api/council` (the desktop view). Same stages as
 * `models council` (`runCouncil`); the difference is the route of a seat
 * that names the active provider with its own chat model: it goes through
 * `runtime.completePlain`, the route a chat step takes (the built-in
 * local link, Core, the fallback chain), so "this chat's model" can sit
 * on the council, including a local one that costs nothing. Every other
 * seat is built from the config like `models council` does.
 *
 * Nothing is written to any session: the council is an aside, like `/btw`.
 */

/** Longest question accepted; a council quotes it in every request. */
export const COUNCIL_MAX_QUESTION_CHARS = 4_000;

export interface CouncilRequest {
  question: string;
  /** `--models` list (`a,b*2`); absent means the active model three times (Self-MoA). */
  models?: string;
  judge?: string;
  /** `null` skips the chairman. */
  chairman?: string | null;
  rank?: boolean;
  /** Stop before any request when the forecast is over this. */
  maxUsd?: number;
  /** Only say what it would cost; send nothing. */
  forecastOnly?: boolean;
  signal?: AbortSignal;
  /** Called once with the forecast, before anything is sent. */
  onForecast?: (costLine: string, forecast: CouncilCostForecast) => void;
  onProgress?: (event: CouncilProgress) => void;
}

export type CouncilServiceResult =
  | { ok: true; report?: CouncilReport; forecast: CouncilCostForecast; costLine: string; skipped: string[] }
  | { ok: false; reason: string; forecast?: CouncilCostForecast; costLine?: string; skipped?: string[] };

export interface CouncilServiceDeps {
  config: AtomicAgentConfig;
  completePlain?: (input: PlainCompleteInput) => Promise<PlainCompleteResult>;
  build?: (config: AtomicAgentConfig, specs: ReturnType<typeof parseModelSpecs>) => Promise<BuiltSpecs>;
}

/** The spec of "this chat's model": the active provider with no model named. */
function routesThroughChat(spec: string, active: string, activeModel: string | undefined): boolean {
  const parsed = parseModelSpecs(spec, active)[0];
  if (!parsed || parsed.providerId !== active) return false;
  return parsed.model === undefined || parsed.model === activeModel;
}

export async function runRuntimeCouncil(
  request: CouncilRequest,
  deps: CouncilServiceDeps,
): Promise<CouncilServiceResult> {
  const question = request.question.trim();
  if (question === "") return { ok: false, reason: "nothing to ask" };
  if (question.length > COUNCIL_MAX_QUESTION_CHARS) {
    return { ok: false, reason: `the question is too long (over ${COUNCIL_MAX_QUESTION_CHARS} characters)` };
  }
  const resolved = resolveLlmConfig(deps.config);
  const active = resolved.activeTextProvider;
  const activeEntry = resolved.providers.find((p) => p.id === active);
  const activeModel = activeEntry?.defaultChatModel ?? activeEntry?.model;
  const seated = parseCouncilSeats(request.models, active);
  if (!seated.ok) return { ok: false, reason: seated.reason };
  const seats = seated.seats;
  const judge = request.judge?.trim() || seats[0]!.spec;
  const chairman = request.chairman === null ? null : (request.chairman?.trim() || judge);
  const rank = request.rank !== false;
  const forecast = forecastCouncilCost({
    question,
    seats,
    judge,
    chairman,
    rank,
    priceOf: councilPriceLookup(deps.config),
  });
  const costLine = describeCouncilCost(forecast);
  request.onForecast?.(costLine, forecast);
  const over = councilOverBudget(forecast, request.maxUsd);
  if (over) return { ok: false, reason: over, forecast, costLine };
  if (request.forecastOnly) return { ok: true, forecast, costLine, skipped: [] };

  const specs = [...new Set([...seatSpecs(seats), judge, ...(chairman ? [chairman] : [])])];
  const viaChat = new Set(
    deps.completePlain ? specs.filter((s) => routesThroughChat(s, active, activeModel)) : [],
  );
  const buildNames = specs.filter((s) => !viaChat.has(s));
  // parseModelSpecs falls back to the active provider on an empty list, so only call it with names.
  const toBuild = buildNames.length === 0 ? [] : parseModelSpecs(buildNames.join(","), active);
  const built: BuiltSpecs = toBuild.length === 0
    ? { providers: new Map<string, LlmProvider>(), refused: [] }
    : await (deps.build ?? buildSpecProviders)(deps.config, toBuild);
  const skipped = built.refused.map((r) => `${r.spec}: ${r.reason}`);
  try {
    const usable = (spec: string) => viaChat.has(spec) || built.providers.has(spec);
    const seatsLeft = seats.filter((s) => usable(s.spec));
    if (seatsLeft.length === 0) return { ok: false, reason: "no council seat could be used", forecast, costLine, skipped };
    const judgeSpec = usable(judge) ? judge : seatsLeft[0]!.spec;
    const chairmanSpec = chairman === null ? null : usable(chairman) ? chairman : judgeSpec;
    const complete: CouncilComplete = async (call) => {
      if (viaChat.has(call.spec)) {
        const result = await deps.completePlain!({
          prompt: call.prompt,
          maxTokens: call.maxTokens,
          timeoutMs: PLAIN_COMPLETE_MAX_TIMEOUT_MS,
          ...(call.temperature !== undefined ? { temperature: call.temperature } : {}),
          ...(call.signal ? { signal: call.signal } : {}),
        });
        if (!result.ok) throw new Error(result.reason);
        return result.text;
      }
      const provider = built.providers.get(call.spec);
      if (!provider) throw new Error(`no provider built for ${call.spec}`);
      const result = await provider.complete({
        prompt: call.prompt,
        maxTokens: call.maxTokens,
        ...(call.temperature !== undefined ? { temperature: call.temperature } : {}),
        ...(call.signal ? { signal: call.signal } : {}),
      });
      return result.content;
    };
    const report = await runCouncil({
      question,
      seats: seatsLeft,
      judge: judgeSpec,
      chairman: chairmanSpec,
      rank,
      complete,
      ...(viaChat.size > 0 ? { maxPromptChars: PLAIN_COMPLETE_MAX_PROMPT_CHARS } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.onProgress ? { onProgress: request.onProgress } : {}),
    });
    return { ok: true, report, forecast, costLine, skipped };
  } finally {
    await closeSpecProviders(built.providers);
  }
}
