import { render } from "lit";
import { expect, it, vi } from "vitest";
import { renderDecisionBanner, type DecisionBannerProps } from "./decision-popup.ts";
import { publicationTrack, presentationFormat } from "./paper-classification.ts";

it("reads legacy tracks without guessing a presentation format", () => {
  const paper = { presentation_type: "findings" } as never;
  expect(publicationTrack(paper)).toBe("findings");
  expect(presentationFormat(paper)).toBe("");
});
it("saves Main and Oral independently and supports clearing both", () => {
  const save = vi.fn();
  const host = document.createElement("div");
  const props = {
    paper: { id: "p", title: "Synthetic", authors: [], current_step: "submission" },
    decision: "accept",
    draft: { track: "main", presentation: "oral", attending: "", nextVenue: "" },
    onSavePaper: save,
    onSetAttendance: vi.fn(),
    onDraft: vi.fn(),
    members: [],
    isEmailOwner: false,
    onToggleCollapsed: vi.fn(),
    onReset: vi.fn(),
    collapsed: false,
    saved: false,
    dirty: true,
  } as DecisionBannerProps;
  render(renderDecisionBanner(props), host);
  expect(host.textContent).toContain("Publication track");
  expect(host.textContent).toContain("Presentation format");
  expect(
    [...host.querySelectorAll('[aria-pressed="true"]')].map((b) => b.textContent?.trim()),
  ).toEqual(["Main", "Oral"]);
  host.querySelector<HTMLButtonElement>('[data-testid="decision-save-p"]')!.click();
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({ publicationTrack: "main", presentationType: "oral" }),
  );
  props.draft = { track: "", presentation: "", attending: "", nextVenue: "" };
  render(renderDecisionBanner(props), host);
  host.querySelector<HTMLButtonElement>('[data-testid="decision-save-p"]')!.click();
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({ publicationTrack: "", presentationType: "" }),
  );
});
