import { describe, expect, it } from "vitest";

import type { UserLlmRouterConfig } from "../../config/llm-router-config.js";
import {
  estimateMessageTokens,
  extractRouteFeatures,
  routeTurn,
  type RouteTurnInput,
} from "./route-turn.js";

const PROVIDERS = [
  { id: "openrouter" },
  { id: "groq" },
  { id: "gemini", supportsVision: true },
  { id: "text-only", supportsVision: false },
  { id: "no-tools", supportsTools: false },
];

function input(
  router: UserLlmRouterConfig | undefined,
  message: string,
  extra: Partial<RouteTurnInput> = {},
): RouteTurnInput {
  return {
    router,
    request: { message, workingDir: "/home/me/work/app", needsTools: true },
    runMode: { stored: null, effective: "cloud" },
    activeProviderId: "openrouter",
    providers: PROVIDERS,
    homeDir: "/home/me",
    ...extra,
  };
}

const on = (rules: UserLlmRouterConfig["rules"]): UserLlmRouterConfig => ({
  enabled: true,
  rules,
});

describe("extractRouteFeatures", () => {
  it("estimates about four characters per token", () => {
    expect(estimateMessageTokens("")).toBe(0);
    expect(estimateMessageTokens("abcd")).toBe(1);
    expect(estimateMessageTokens("abcde")).toBe(2);
  });

  it("sees an image file name, a path and a data URL, not a word like 'gift'", () => {
    expect(extractRouteFeatures("what is on ~/Desktop/shot.PNG ?").hasImage).toBe(true);
    expect(extractRouteFeatures("look at photo.jpeg").hasImage).toBe(true);
    expect(extractRouteFeatures("data:image/webp;base64,AAAA").hasImage).toBe(true);
    expect(extractRouteFeatures("buy a gift for mom").hasImage).toBe(false);
    expect(extractRouteFeatures("edit notes.gifts.md").hasImage).toBe(false);
  });
});

describe("routeTurn: off and out of the way", () => {
  it("does nothing when the block is absent, disabled, or has no rules", () => {
    const rules = [{ provider: "groq" }];
    expect(routeTurn(input(undefined, "hi"))).toEqual({ routed: false, reason: "disabled" });
    expect(routeTurn(input({ enabled: false, rules }, "hi"))).toEqual({ routed: false, reason: "disabled" });
    expect(routeTurn(input(on([]), "hi"))).toEqual({ routed: false, reason: "disabled" });
  });

  it("does nothing while Fusion is in effect", () => {
    const decision = routeTurn(
      input(on([{ provider: "groq" }]), "hi", {
        runMode: { stored: "fusion", effective: "fusion" },
      }),
    );
    expect(decision).toEqual({ routed: false, reason: "fusion" });
  });

  it("does nothing while the local run mode is set with /runmode", () => {
    const decision = routeTurn(
      input(on([{ provider: "groq" }]), "hi", {
        runMode: { stored: "local", effective: "local" },
      }),
    );
    expect(decision).toEqual({ routed: false, reason: "run-mode" });
  });

  it("routes under the stored cloud run mode, between cloud providers only", () => {
    const cloud = { runMode: { stored: "cloud" as const, effective: "cloud" as const } };
    expect(routeTurn(input(on([{ provider: "groq" }]), "hi", cloud))).toEqual({
      routed: true,
      providerId: "groq",
      rule: "rule 1",
    });
    const providers = [...PROVIDERS, { id: "local", local: true }];
    // A local rule is passed over; the next rule answers.
    expect(
      routeTurn(
        input(on([{ provider: "local" }, { provider: "groq" }]), "hi", { ...cloud, providers }),
      ),
    ).toEqual({ routed: true, providerId: "groq", rule: "rule 2" });
    // With no run mode stored, a local target is fine.
    expect(routeTurn(input(on([{ provider: "local" }]), "hi", { providers }))).toEqual({
      routed: true,
      providerId: "local",
      rule: "rule 1",
    });
  });

  it("does nothing for a turn that is already pinned", () => {
    const decision = routeTurn(
      input(on([{ provider: "groq" }]), "hi", { pinnedProviderId: "gemini" }),
    );
    expect(decision).toEqual({ routed: false, reason: "pinned" });
  });
});

describe("routeTurn: rule matching", () => {
  it("routes a short message by maxTokens and a long one by minTokens", () => {
    const router = on([
      { name: "short", when: { maxTokens: 10 }, provider: "groq" },
      { name: "long", when: { minTokens: 1000 }, provider: "gemini" },
    ]);
    expect(routeTurn(input(router, "hi there"))).toEqual({
      routed: true,
      providerId: "groq",
      rule: "short",
    });
    expect(routeTurn(input(router, "x".repeat(4000)))).toEqual({
      routed: true,
      providerId: "gemini",
      rule: "long",
    });
    expect(routeTurn(input(router, "x".repeat(400)))).toEqual({
      routed: false,
      reason: "no-match",
    });
  });

  it("routes a message with an image", () => {
    const router = on([{ when: { hasImage: true }, provider: "gemini" }]);
    expect(routeTurn(input(router, "what is in shot.png"))).toMatchObject({
      routed: true,
      providerId: "gemini",
      rule: "rule 1",
    });
    expect(routeTurn(input(router, "no picture here"))).toMatchObject({ routed: false });
  });

  it("matches contains (any word, any case) and matches (regex, any case)", () => {
    const router = on([
      { name: "words", when: { contains: ["Refactor", "rename"] }, provider: "groq" },
      { name: "regex", when: { matches: "^translate\\b" }, provider: "gemini" },
    ]);
    expect(routeTurn(input(router, "please REFACTOR this"))).toMatchObject({ rule: "words" });
    expect(routeTurn(input(router, "Translate this to French"))).toMatchObject({ rule: "regex" });
    expect(routeTurn(input(router, "do not translate"))).toMatchObject({ routed: false });
  });

  it("matches the working folder and the folders inside it, with ~ expanded", () => {
    const router = on([{ when: { workingDir: "~/work" }, provider: "groq" }]);
    expect(routeTurn(input(router, "hi"))).toMatchObject({ providerId: "groq" });
    const elsewhere = input(router, "hi");
    elsewhere.request = { ...elsewhere.request, workingDir: "/home/me/workshop" };
    expect(routeTurn(elsewhere)).toMatchObject({ routed: false, reason: "no-match" });
  });

  it("reads needsTools against the turn", () => {
    const router = on([{ when: { needsTools: false }, provider: "groq" }]);
    expect(routeTurn(input(router, "hi"))).toMatchObject({ routed: false });
    const noTools = input(router, "hi");
    noTools.request = { ...noTools.request, needsTools: false };
    expect(routeTurn(noTools)).toMatchObject({ providerId: "groq" });
  });

  it("needs every condition of a rule to hold", () => {
    const router = on([{ when: { maxTokens: 10, contains: ["deploy"] }, provider: "groq" }]);
    expect(routeTurn(input(router, "deploy"))).toMatchObject({ providerId: "groq" });
    expect(routeTurn(input(router, "hello"))).toMatchObject({ routed: false });
    expect(routeTurn(input(router, `deploy ${"x".repeat(100)}`))).toMatchObject({ routed: false });
  });
});

describe("routeTurn: precedence", () => {
  it("takes the first matching rule, in config order", () => {
    const router = on([
      { name: "first", when: { contains: ["a"] }, provider: "groq" },
      { name: "second", when: { contains: ["a"] }, provider: "gemini" },
    ]);
    expect(routeTurn(input(router, "a"))).toMatchObject({ rule: "first", providerId: "groq" });
  });

  it("lets a rule with no conditions catch everything after the specific ones", () => {
    const router = on([
      { name: "images", when: { hasImage: true }, provider: "gemini" },
      { name: "rest", provider: "groq" },
    ]);
    expect(routeTurn(input(router, "see a.png"))).toMatchObject({ rule: "images" });
    expect(routeTurn(input(router, "anything"))).toMatchObject({ rule: "rest" });
  });

  it("keeps the turn on the active provider when the first matching rule names it", () => {
    const router = on([
      { when: { contains: ["x"] }, provider: "openrouter" },
      { provider: "groq" },
    ]);
    expect(routeTurn(input(router, "x"))).toEqual({ routed: false, reason: "active" });
  });

  it("passes over a provider that is not configured", () => {
    const router = on([{ provider: "gone" }, { name: "next", provider: "groq" }]);
    expect(routeTurn(input(router, "hi"))).toMatchObject({ rule: "next" });
  });

  it("passes over a provider that cannot call tools or cannot see the image", () => {
    const router = on([
      { provider: "no-tools" },
      { when: { hasImage: true }, provider: "text-only" },
      { name: "fallback", provider: "gemini" },
    ]);
    expect(routeTurn(input(router, "see a.png"))).toMatchObject({ rule: "fallback" });
  });
});
