/**
 * Competitor adapter registry. Add new factories here when you wire
 * a new memory product — the campaign orchestrator iterates over
 * this list and skips any factory whose `probeAdapterRequirements`
 * is non-empty.
 */

import type { CompetitorAdapterFactory } from "./competitor-adapter.js";
import { mem0Factory } from "./mem0/mem0-adapter.js";
import { zepFactory } from "./zep/zep-adapter.js";
import { langMemFactory } from "./langmem/langmem-adapter.js";

export {
  type CompetitorAdapter,
  type CompetitorAdapterFactory,
  type CompetitorAdapterCreateOptions,
  type CompetitorAdapterRequirements,
  type CompetitorTurn,
  type CompetitorMemoryItem,
  type CompetitorRecallRequest,
  type CompetitorRecallResult,
  type CompetitorIngestResult,
  CompetitorAdapterError,
  probeAdapterRequirements,
} from "./competitor-adapter.js";

export { mem0Factory, zepFactory, langMemFactory };

export const COMPETITOR_FACTORIES: readonly CompetitorAdapterFactory[] = [
  mem0Factory,
  zepFactory,
  langMemFactory,
];
