import { describe, expect, it } from "vitest";
import { validateDeadlineProposalInput, type DeadlineProposalInput } from "./deadline-proposals.js";
const base: DeadlineProposalInput = {
  name: "Example",
  parentConference: "",
  parentYear: "",
  entryType: "workshop",
  deadlineDate: "2026-09-25",
  deadlineTime: "",
  timezone: "",
  homepageUrl: "https://example.org",
  cfpUrl: "",
  openReviewUrl: "",
  note: "",
  stage: { milestone: "camera_ready", label: "Camera-ready", operation: "add", venueId: "example" },
};
describe("single stage validation", () => {
  it("preserves an unknown time and zone while using the earliest planning instant", () => {
    expect(validateDeadlineProposalInput(base)).toMatchObject({
      ok: true,
      instant: "2026-09-24T10:00:00.000Z",
      value: { deadlineTime: "", timezone: "" },
    });
  });
  it("rejects nonexistent wall-clock times rather than shifting them silently", () => {
    expect(
      validateDeadlineProposalInput({
        ...base,
        deadlineDate: "2026-03-29",
        deadlineTime: "02:30",
        timezone: "Europe/Zurich",
      }),
    ).toMatchObject({ ok: false, errors: { deadlineTime: expect.any(String) } });
  });
  it.each([
    null,
    [],
    {},
    { milestone: "notification_by", label: "Notify authors by", operation: "add" },
    { milestone: "abstract", label: "Abstract", operation: "correct" },
    { milestone: "abstract", label: "", operation: "add" },
  ])("rejects malformed stage metadata %j", (stage) => {
    expect(
      validateDeadlineProposalInput({ ...base, stage } as DeadlineProposalInput),
    ).toMatchObject({ ok: false, errors: { stage: expect.any(String) } });
  });
  it("requires a source timezone when an exact time is supplied", () => {
    expect(validateDeadlineProposalInput({ ...base, deadlineTime: "15:30" })).toMatchObject({
      ok: false,
      errors: { timezone: expect.any(String) },
    });
  });
});
