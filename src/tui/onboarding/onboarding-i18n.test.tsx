import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { setUiLanguage } from "../../i18n/index.js";
import { OnboardingChooseStep, measureOnboardingChooseStep } from "./onboarding-choose-step.js";
import { onboardingFooterFor, onboardingSubtitleFor } from "./onboarding-chrome.js";
import { computeOnboardingFit } from "./onboarding-fit.js";
import { OnboardingIntroStep } from "./onboarding-intro-step.js";
import {
  createOnboardingState,
  ONBOARDING_CHOICES,
  type OnboardingStep,
} from "./onboarding-state.js";

const strip = (frame: string): string => frame.replace(/\u001B\[[0-9;]*m/gu, "");

function at(step: OnboardingStep) {
  return { ...createOnboardingState("http://127.0.0.1:8080"), step };
}

function chooseFrame(): string {
  const fit = computeOnboardingFit({ columns: 120, rows: 40 });
  const view = render(<OnboardingChooseStep cursor={0} fit={fit} />);
  const frame = strip(view.lastFrame() ?? "");
  view.unmount();
  return frame;
}

function introFrame(): string {
  const view = render(
    <OnboardingIntroStep
      columns={116}
      rows={38}
      fit={computeOnboardingFit({ columns: 120, rows: 40 })}
      skipAnimation
    />,
  );
  const frame = strip(view.lastFrame() ?? "");
  view.unmount();
  return frame;
}

afterEach(() => setUiLanguage("en"));

describe("onboarding in the interface language (ATO-571)", () => {
  it("draws English by default, as before", () => {
    const frame = chooseFrame();
    expect(frame).toContain("atomic-agent can drive models three ways.");
    expect(frame).toContain("Local models");
    expect(frame).toContain("Custom endpoint");
    expect(onboardingSubtitleFor("choose")).toBe("setup · step 1 of 2");
    expect(onboardingSubtitleFor("intro")).toBe("");
    expect(onboardingFooterFor(at("choose"), false, null)).toBe(
      "↑/↓ move   enter select   1–3 jump   esc skip   ctrl+c quit",
    );
    expect(introFrame()).toContain("[ press any key to continue ]");
  });

  it("draws the choose step, its chrome and the intro in Russian", () => {
    setUiLanguage("ru");
    const frame = chooseFrame();
    expect(frame).toContain("atomic-agent работает с моделями тремя способами.");
    expect(frame).toContain("Локальные модели");
    expect(frame).toContain("Облачные модели");
    expect(frame).toContain("Свой сервер");
    expect(frame).not.toContain("Local models");
    expect(onboardingSubtitleFor("choose")).toBe("настройка · шаг 1 из 2");
    expect(onboardingFooterFor(at("choose"), true, null)).toBe(
      "↑/↓ навигация   enter выбрать   1–3 быстрый выбор   esc пропустить   ctrl+c нажмите ещё раз, чтобы выйти",
    );
    expect(introFrame()).toContain("[ нажмите любую клавишу ]");
  });

  it("keeps the choice ids and order, and the labels within the label column", () => {
    for (const language of ["en", "ru"] as const) {
      setUiLanguage(language);
      expect(ONBOARDING_CHOICES.map((choice) => choice.id)).toEqual(["local", "cloud", "custom"]);
      for (const choice of ONBOARDING_CHOICES) {
        // LABEL_COLUMNS is 20 and the label needs a gap after it.
        expect(choice.label.length, `${language} ${choice.id}`).toBeLessThan(20);
      }
    }
  });

  it("keeps the Russian choose step no wider than a full-size terminal fits", () => {
    const fit = computeOnboardingFit({ columns: 120, rows: 40 });
    setUiLanguage("ru");
    expect(measureOnboardingChooseStep(fit)).toBeLessThanOrEqual(84);
  });
});
