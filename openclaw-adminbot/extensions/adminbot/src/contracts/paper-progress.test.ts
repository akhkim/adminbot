import { describe, expect, it } from "vitest";
import { adminBotPaperSteps } from "./actions.js";
import { adminBotPaperStepPlan, paperStepProgress } from "./paper-progress.js";

describe("paperStepProgress", () => {
  it("covers every paper step, in the contract's order", () => {
    expect(adminBotPaperStepPlan.map((item) => item.step)).toEqual([...adminBotPaperSteps]);
  });

  it("reads the label, the next step and work-weighted progress off current_step", () => {
    // 11 of 16 estimated days precede the announcements: the figure the server timeline gave.
    expect(paperStepProgress({ current_step: "social_posts" })).toEqual({
      stepIndex: 5,
      stepCount: 8,
      complete: false,
      blocked: false,
      currentLabel: "Announcements",
      nextLabel: "Slides",
      progressPercent: 69,
    });
    expect(paperStepProgress({ current_step: "brainstorming_docs" }).progressPercent).toBe(0);
    expect(paperStepProgress({ current_step: "poster_making" })).toMatchObject({
      currentLabel: "Poster",
      progressPercent: 88,
    });
    expect(paperStepProgress({ current_step: "poster_making" })).not.toHaveProperty("nextLabel");
  });

  it("is finished only when the reminder says so", () => {
    const done = paperStepProgress({
      current_step: "submission",
      reminder: { status: "complete" },
    });
    expect(done).toMatchObject({ complete: true, progressPercent: 100, stepIndex: 2 });
    expect(done).not.toHaveProperty("currentLabel");
    expect(done).not.toHaveProperty("nextLabel");
  });

  it("flags a blocked paper and treats an unknown step as the first", () => {
    expect(
      paperStepProgress({ current_step: "submission", reminder: { status: "blocked" } }).blocked,
    ).toBe(true);
    expect(paperStepProgress({ current_step: "not_a_step" })).toMatchObject({
      stepIndex: 0,
      currentLabel: "Brainstorming docs",
    });
  });
});
