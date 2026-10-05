import { describe, expect, it } from "vitest";

import {
  isNameProfileKey,
  isProfileFactPromptVisible,
  nameGroundingMarker,
} from "./profile-name-keys.js";

describe("isNameProfileKey", () => {
  it("recognises name-like keys and nothing else", () => {
    for (const key of ["name", "full_name", "first_name", "user_name", "nickname", "username"]) {
      expect(isNameProfileKey(key)).toBe(true);
    }
    for (const key of ["timezone", "project_name_style", "language", "deploy_command"]) {
      expect(isNameProfileKey(key)).toBe(false);
    }
  });
});

describe("isProfileFactPromptVisible", () => {
  it("shows every non-name fact whatever its grounding", () => {
    expect(isProfileFactPromptVisible({ key: "timezone", nameGrounding: null })).toBe(true);
    expect(isProfileFactPromptVisible({ key: "language" })).toBe(true);
  });

  it("shows a name only once a check vouched for it", () => {
    expect(isProfileFactPromptVisible({ key: "name", nameGrounding: "grounded" })).toBe(true);
    expect(isProfileFactPromptVisible({ key: "name", nameGrounding: "unverifiable" })).toBe(true);
    expect(isProfileFactPromptVisible({ key: "name", nameGrounding: "ungrounded" })).toBe(false);
    expect(isProfileFactPromptVisible({ key: "name", nameGrounding: null })).toBe(false);
    expect(isProfileFactPromptVisible({ key: "full_name" })).toBe(false);
  });
});

describe("nameGroundingMarker", () => {
  it("marks unconfirmed and unchecked names, nothing else", () => {
    expect(nameGroundingMarker({ key: "name", nameGrounding: "ungrounded" })).toMatch(
      /^unconfirmed/,
    );
    expect(nameGroundingMarker({ key: "name", nameGrounding: null })).toMatch(/not checked/);
    expect(nameGroundingMarker({ key: "name", nameGrounding: "grounded" })).toBeNull();
    expect(nameGroundingMarker({ key: "timezone", nameGrounding: null })).toBeNull();
  });
});
