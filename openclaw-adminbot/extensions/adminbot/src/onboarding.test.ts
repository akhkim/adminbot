import { describe, expect, it } from "vitest";
import { buildInitialOnboarding, buildOnboardingSteps } from "./onboarding.js";

describe("buildOnboardingSteps", () => {
  it("marks the calendar invite complete since it's granted automatically", () => {
    const steps = buildOnboardingSteps();
    const calendarStep = steps.find((step) => step.id === "calendar_invite");
    expect(calendarStep?.status).toBe("complete");
  });

  it("promotes the first required, non-calendar step to current and leaves the rest remaining", () => {
    const steps = buildOnboardingSteps();
    const current = steps.filter((step) => step.status === "current");
    expect(current).toHaveLength(1);
    expect(current[0]?.required).toBe(true);
    expect(current[0]?.id).not.toBe("calendar_invite");
  });

  it("has exactly one step per onboarding id, each with a non-empty category and some content", () => {
    const steps = buildOnboardingSteps();
    const ids = steps.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const step of steps) {
      expect(step.category.length).toBeGreaterThan(0);
      const hasContent =
        Boolean(step.detail?.length) ||
        Boolean(step.bullets?.length) ||
        Boolean(step.links?.length);
      expect(hasContent).toBe(true);
    }
  });

  it("no longer includes a dedicated Slack-channels step", () => {
    const steps = buildOnboardingSteps();
    expect(steps.some((step) => step.id === "slack_channels")).toBe(false);
  });

  it("gives social/reference steps clickable links instead of bare URLs in detail text", () => {
    const steps = buildOnboardingSteps();
    for (const id of ["linkedin", "twitter", "luma", "youtube", "compute_canada"]) {
      const step = steps.find((s) => s.id === id);
      expect(step?.links?.length).toBeGreaterThan(0);
    }
  });
});

describe("buildInitialOnboarding", () => {
  it("splits steps into completed/remaining and exposes the current step", () => {
    const onboarding = buildInitialOnboarding();
    expect(onboarding.completed.map((step) => step.id)).toEqual(["calendar_invite"]);
    expect(onboarding.remaining.length).toBe(onboarding.steps.length - 1);
    expect(onboarding.current_step?.status).toBe("current");
  });
});
