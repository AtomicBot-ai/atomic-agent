import { describe, it, expect } from "vitest";

import {
  CAMPAIGN_PROFILE_NAMES,
  CAMPAIGN_PROFILE_LABELS,
  buildCampaignConfig,
  type CampaignProfileName,
} from "./campaign-profiles.js";

const LLAMA_URL = "http://127.0.0.1:18991";

describe("buildCampaignConfig", () => {
  it("provides labels for every named profile", () => {
    for (const name of CAMPAIGN_PROFILE_NAMES) {
      expect(CAMPAIGN_PROFILE_LABELS[name]).toBeTruthy();
    }
  });

  describe("none — full lobotomy", () => {
    it("disables every memory surface", () => {
      const cfg = buildCampaignConfig("none", { llamaUrl: LLAMA_URL });
      expect(cfg.memory.profile.enabled).toBe(false);
      expect(cfg.memory.notes.enabled).toBe(false);
      expect(cfg.memory.reflection.enabled).toBe(false);
      expect(cfg.memory.recallInjection.enabled).toBe(false);
      expect(cfg.memory.index.enabled).toBe(false);
      expect(cfg.memory.embeddings.enabled).toBe(false);
      expect(cfg.memory.links.enabled).toBe(false);
      expect(cfg.memory.evolution.enabled).toBe(false);
      expect(cfg.memory.lessons.enabled).toBe(false);
      expect(cfg.memory.consolidation.enabled).toBe(false);
    });
  });

  describe("fts5_only — v1 memory baseline", () => {
    it("keeps profile / notes / reflection on, v2 features off", () => {
      const cfg = buildCampaignConfig("fts5_only", { llamaUrl: LLAMA_URL });
      expect(cfg.memory.profile.enabled).toBe(true);
      expect(cfg.memory.notes.enabled).toBe(true);
      expect(cfg.memory.reflection.enabled).toBe(true);
      expect(cfg.memory.embeddings.enabled).toBe(false);
      expect(cfg.memory.links.enabled).toBe(false);
      expect(cfg.memory.evolution.enabled).toBe(false);
      expect(cfg.memory.lessons.enabled).toBe(false);
      expect(cfg.memory.consolidation.enabled).toBe(false);
    });
  });

  describe("vector_only — cosine-only recall", () => {
    it("enables embeddings with FTS5 weight zeroed", () => {
      const cfg = buildCampaignConfig("vector_only", { llamaUrl: LLAMA_URL });
      expect(cfg.memory.embeddings.enabled).toBe(true);
      expect(cfg.memory.embeddings.fts5Weight).toBe(0);
      expect(cfg.memory.embeddings.vectorWeight).toBe(1);
    });
  });

  describe("hybrid — base v2 recall", () => {
    it("enables FTS5 + embeddings, leaves reactive layers off", () => {
      const cfg = buildCampaignConfig("hybrid", { llamaUrl: LLAMA_URL });
      expect(cfg.memory.embeddings.enabled).toBe(true);
      expect(cfg.memory.embeddings.fts5Weight).toBeGreaterThan(0);
      expect(cfg.memory.embeddings.vectorWeight).toBeGreaterThan(0);
      expect(cfg.memory.links.enabled).toBe(false);
      expect(cfg.memory.evolution.enabled).toBe(false);
      expect(cfg.memory.lessons.enabled).toBe(false);
      expect(cfg.memory.consolidation.enabled).toBe(false);
    });
  });

  describe("hybrid_plus_graph — adds the link graph", () => {
    it("enables links + autoGenerate, keeps lessons + consolidation off", () => {
      const cfg = buildCampaignConfig("hybrid_plus_graph", {
        llamaUrl: LLAMA_URL,
      });
      expect(cfg.memory.links.enabled).toBe(true);
      expect(cfg.memory.links.autoGenerate).toBe(true);
      expect(cfg.memory.lessons.enabled).toBe(false);
      expect(cfg.memory.consolidation.enabled).toBe(false);
      expect(cfg.memory.evolution.enabled).toBe(false);
    });
  });

  describe("hybrid_plus_lessons — adds the consolidator", () => {
    it("enables lessons + consolidation + evolution", () => {
      const cfg = buildCampaignConfig("hybrid_plus_lessons", {
        llamaUrl: LLAMA_URL,
      });
      expect(cfg.memory.links.enabled).toBe(true);
      expect(cfg.memory.lessons.enabled).toBe(true);
      expect(cfg.memory.consolidation.enabled).toBe(true);
      expect(cfg.memory.evolution.enabled).toBe(true);
    });
  });

  describe("full_v2 — everything on", () => {
    it("enables procedures + voting + v2.5 additions", () => {
      const cfg = buildCampaignConfig("full_v2", { llamaUrl: LLAMA_URL });
      expect(cfg.memory.lessons.enabled).toBe(true);
      expect(cfg.memory.consolidation.enabled).toBe(true);
      expect(cfg.memory.procedures.enabled).toBe(true);
      expect(cfg.memory.voting.enabled).toBe(true);
      expect(cfg.memory.retrieve.rewriter.enabled).toBe(true);
      expect(cfg.memory.reflection.segmentation.enabled).toBe(true);
      expect(cfg.memory.reflection.typedNotes.enabled).toBe(true);
    });
  });

  describe("llama wiring", () => {
    it("threads the provided URL into every profile", () => {
      for (const name of CAMPAIGN_PROFILE_NAMES) {
        const cfg = buildCampaignConfig(name as CampaignProfileName, {
          llamaUrl: LLAMA_URL,
        });
        expect(cfg.localModels.url).toBe(LLAMA_URL);
      }
    });
  });

  describe("byte-stable across calls", () => {
    it("two builds with the same inputs produce equal JSON", () => {
      for (const name of CAMPAIGN_PROFILE_NAMES) {
        const a = buildCampaignConfig(name as CampaignProfileName, {
          llamaUrl: LLAMA_URL,
        });
        const b = buildCampaignConfig(name as CampaignProfileName, {
          llamaUrl: LLAMA_URL,
        });
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      }
    });
  });
});
