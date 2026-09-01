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
            {
              member_id: "m-ada",
              display_name: "Ada",
              source: "participant_report",
              present: true,
            },
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
            {
              member_id: "m-ada",
              display_name: "Ada Attendee",
              source: "transcript",
              present: true,
            },
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

describe("attendance nudge panel", () => {
  const NUDGE_PREVIEW = {
    streak: 2,
    meeting_label: "Monday meeting",
    meetings: [
      { id: "m2", topic: "Group meeting 2", started_at: "2026-08-17T13:30:00.000Z" },
      { id: "m1", topic: "Group meeting 1", started_at: "2026-08-10T13:30:00.000Z" },
    ],
    absent: [
      {
        member_id: "mei",
        name: "Mei Chen",
        missed_meeting_ids: ["m2", "m1"],
        missed_topics: ["Group meeting 2", "Group meeting 1"],
        reason: "full_member" as const,
      },
    ],
    invite_resolved: true,
    audience_size: 12,
  };

  function nudgeProps(overrides: Partial<NonNullable<AdminBotMeetingsProps["nudge"]>> = {}) {
    return {
      nudge: {
        preview: NUDGE_PREVIEW,
        result: null,
        busy: false,
        error: null,
        onPreview: vi.fn(),
        onSend: vi.fn(),
        ...overrides,
      },
    };
  }

  it("is not offered to a member", () => {
    const container = renderView({ viewerIsAdmin: false, ...nudgeProps() });
    expect(container.querySelector("[data-testid='meetings-nudge']")).toBeNull();
  });

  it("names who has been missing, and how many the button is about", () => {
    const container = renderView({ viewerIsAdmin: true, ...nudgeProps() });
    const list = container.querySelector<HTMLElement>("[data-testid='meetings-nudge-list']");
    expect(list?.textContent).toContain("Mei Chen");
    expect(list?.textContent).toContain("full member");
    // The count is on the button because what it sends names people on Slack: "Send" alone does
    // not say how many.
    expect(
      container.querySelector<HTMLElement>("[data-testid='meetings-nudge-send']")?.textContent,
    ).toContain("1");
  });

  it("loads on first open, and not again on the next toggle", () => {
    const onPreview = vi.fn();
    const container = renderView({
      viewerIsAdmin: true,
      nudge: {
        preview: null,
        result: null,
        busy: false,
        error: null,
        onPreview,
        onSend: vi.fn(),
      },
    });
    const panel = container.querySelector<HTMLDetailsElement>("[data-testid='meetings-nudge']");
    panel!.open = true;
    panel!.dispatchEvent(new Event("toggle"));
    expect(onPreview).toHaveBeenCalledTimes(1);
    panel!.open = false;
    panel!.dispatchEvent(new Event("toggle"));
    expect(onPreview).toHaveBeenCalledTimes(1);
  });

  it("warns when the calendar could not be read, so the list may be short", () => {
    const container = renderView({
      viewerIsAdmin: true,
      ...nudgeProps({ preview: { ...NUDGE_PREVIEW, invite_resolved: false } }),
    });
    expect(container.querySelector("[data-testid='meetings-nudge-no-invite']")).not.toBeNull();
  });

  it("says nothing can qualify yet when fewer than two meetings have a roster", () => {
    const container = renderView({
      viewerIsAdmin: true,
      ...nudgeProps({
        preview: { ...NUDGE_PREVIEW, meetings: [NUDGE_PREVIEW.meetings[0]!], absent: [] },
      }),
    });
    expect(container.textContent).toContain("Fewer than 2 meetings");
    expect(container.querySelector("[data-testid='meetings-nudge-send']")).toBeNull();
  });
});

describe("the recordings archive panel", () => {
  // This tab only lists meetings AdminBot has a summary for. Somebody looking for one it has no row
  // for was given no indication the videos existed anywhere.
  it("points at the share channel even when nothing is listed", () => {
    const container = renderView({ meetings: [] });
    const panel = container.querySelector('[data-testid="meetings-archive"]');
    expect(panel?.textContent).toContain("#jinesis-share");
  });

  it("links out to the unlisted playlist, in a new tab", () => {
    const container = renderView({ meetings: [] });
    const link = container.querySelector<HTMLAnchorElement>(
      '[data-testid="meetings-playlist-link"]',
    );
    expect(link?.getAttribute("href")).toBe(
      "https://www.youtube.com/playlist?list=PLtVBX_ld338VkH1UzdXs03LTKZp8-FBDL",
    );
    // It leaves the app, so it opens in a new tab and does not hand the opener over with it.
    expect(link?.getAttribute("rel")).toContain("noopener");
  });
});
