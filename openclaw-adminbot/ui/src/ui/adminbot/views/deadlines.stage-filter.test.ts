import { describe, it, expect } from "vitest";
import { chooseStage, stageKey, stageFilterOptions } from "./deadlines.stage-filter.ts";
describe("stage selection", () => {
  it("chooses the next or latest matching occurrence without falling through to another stage", () => {
    const stages = [
      { key: "notification", instant: 1 },
      { key: "submission", instant: 3 },
      { key: "notification", instant: 5 },
      { key: "notification", instant: 8 },
    ];
    expect(chooseStage(stages.toReversed(), "notification", 4, "upcoming")?.instant).toBe(5);
    expect(chooseStage(stages, "notification", 8, "past")?.instant).toBe(8);
    expect(chooseStage(stages, "camera_ready", 4, "upcoming")).toBeUndefined();
  });
  it("normalizes stage keys and never offers a shared notification policy", () => {
    expect(stageKey("full_paper")).toBe("submission");
    expect(stageKey("rebuttal")).toBe("author_response");
    expect(
      stageFilterOptions([
        { key: "notification", label: "Accept/reject" },
        { key: "notification_by", label: "Notify by" },
      ]),
    ).toEqual([{ value: "notification", label: "Decisions" }]);
  });
});
