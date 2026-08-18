/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MeetingRecord } from "../auth/session.ts";
import { renderAdminBotMeetings, type AdminBotMeetingsProps } from "./meetings.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

const MEETING: MeetingRecord = {
  id: "zoom-812-2026-08-12",
  topic: "Weekly Lab Meeting",
  started_at: "2026-08-12T14:00:00.000Z",
  duration_minutes: 58,
  recording: { share_url: "https://us02web.zoom.us/rec/share/tok", passcode: "k7$Rm2pQ" },
  summary: {
    overview: "The group reviewed the EMNLP timeline.",
    decisions: ["Submit to EMNLP rather than ARR"],
    action_items: [{ text: "Rerun the ablations", owner_name: "Priya Raman" }],
    generated_at: "2026-08-12T18:00:00.000Z",
    model: "nvidia/Qwen3.5-122B-A10B-NVFP4",
  },
  source: "zoom_email",
};

function renderView(overrides: Partial<AdminBotMeetingsProps> = {}): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderAdminBotMeetings({
      meetings: [MEETING],
      loading: false,
      saving: false,
      error: null,
      viewerIsAdmin: false,
      viewerMemberId: "m-ada",
      members: [],
      onToggleAttendance: vi.fn(),
      onFileMeeting: vi.fn(),
      ...overrides,
    }),
    container,
  );
  return container;
}

describe("renderAdminBotMeetings", () => {
  it("leads with the recording and the summary", () => {
    const view = renderView();
    const link = view.querySelector<HTMLAnchorElement>('a[href^="https://us02web.zoom.us"]');
    expect(link?.href).toBe("https://us02web.zoom.us/rec/share/tok");
    // Opening a recording must not navigate the Control UI away from itself.
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toContain("noopener");
    expect(view.textContent).toContain("The group reviewed the EMNLP timeline.");
    expect(view.textContent).toContain("Submit to EMNLP rather than ARR");
    expect(view.textContent).toContain("k7$Rm2pQ");
  });

  // A reader who does not know the summary is machine-written will read a transcription error as
  // something a colleague said.
  it("says which model wrote the summary", () => {
    expect(renderView().textContent).toContain("nvidia/Qwen3.5-122B-A10B-NVFP4");
  });

  it("shows a member their own attendance and a headcount, with no roster editor", () => {
    const view = renderView({
      meetings: [
        {
          ...MEETING,
          attendees: [
            { member_id: "m-ada", display_name: "Ada", source: "participant_report", present: true },
          ],
          attendee_count: 7,
        },
      ],
    });
    expect(view.textContent).toContain("You attended.");
    expect(view.textContent).toContain("7 present");
    expect(view.querySelector("input[type=checkbox]")).toBeNull();
    // The recovery form is an admin affordance and must not render for a member.
    expect(view.querySelector(".meetings__file")).toBeNull();
  });

  // The whole point of the editor: the person who was there and whom no import detected has to be
  // tickable, so every member is listed rather than only the detected ones.
  it("lists every member in the admin editor, not only detected attendees", () => {
    const view = renderView({
      viewerIsAdmin: true,
      members: [
        { id: "m-ada", name: "Ada Attendee" },
        { id: "m-bo", name: "Bo Quiet" },
      ],
      meetings: [
        {
          ...MEETING,
          attendees: [
            { member_id: "m-ada", display_name: "Ada Attendee", source: "transcript", present: true },
          ],
        },
      ],
    });
    const ticks = view.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    expect(ticks).toHaveLength(2);
    expect(ticks[0]?.checked).toBe(true);
    expect(ticks[1]?.checked).toBe(false);
    expect(view.textContent).toContain("spoke on the transcript");
  });

  it("sends a correction for the member whose box was clicked", () => {
    const onToggleAttendance = vi.fn();
    const view = renderView({
      viewerIsAdmin: true,
      members: [{ id: "m-bo", name: "Bo Quiet" }],
      onToggleAttendance,
    });
    view.querySelector<HTMLInputElement>("input[type=checkbox]")?.click();
    expect(onToggleAttendance).toHaveBeenCalledWith("zoom-812-2026-08-12", {
      member_id: "m-bo",
      display_name: "Bo Quiet",
      source: "manual",
      present: true,
    });
  });

  it("distinguishes an empty lab from one that is still loading", () => {
    expect(renderView({ meetings: [], loading: true }).textContent).toContain("Loading meetings");
    expect(renderView({ meetings: [], loading: false }).textContent).toContain(
      "No meeting recordings yet",
    );
  });

  it("explains a meeting with no transcript rather than showing an empty summary", () => {
    const view = renderView({
      meetings: [{ ...MEETING, summary: undefined, transcript: undefined }],
    });
    expect(view.textContent).toContain("No transcript has been attached");
  });

  it("files a meeting from the admin recovery form", () => {
    const onFileMeeting = vi.fn();
    const view = renderView({ viewerIsAdmin: true, onFileMeeting });
    const form = view.querySelector("form");
    const field = (name: string) => form?.querySelector<HTMLInputElement>(`[name=${name}]`);
    field("topic")!.value = "Reading Group";
    field("started_at")!.value = "2026-08-14T11:00";
    field("share_url")!.value = "https://us02web.zoom.us/rec/share/other";
    form?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    expect(onFileMeeting).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "Reading Group",
        share_url: "https://us02web.zoom.us/rec/share/other",
        // The field is wall-clock in the reader's zone; the record stores an instant.
        started_at: new Date("2026-08-14T11:00").toISOString(),
      }),
    );
  });

  it("does not file an incomplete form", () => {
    const onFileMeeting = vi.fn();
    const view = renderView({ viewerIsAdmin: true, onFileMeeting });
    view
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    expect(onFileMeeting).not.toHaveBeenCalled();
  });
});
