/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MeetingRecord, MeetingSeries } from "../api/meetings.ts";
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

const WEEKLY: MeetingSeries = {
  key: "weekly lab meeting",
  topic: "Weekly Lab Meeting",
  count: 1,
  latest_started_at: MEETING.started_at,
};

/**
 * Renders the tab. `meetings`, when given, is shorthand for one series holding exactly those
 * recordings, already read -- what most per-recording tests need.
 */
function renderView(
  overrides: Partial<AdminBotMeetingsProps> & { meetings?: MeetingRecord[] } = {},
): HTMLElement {
  const { meetings = [MEETING], ...props } = overrides;
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderAdminBotMeetings({
      series: meetings.length ? [{ ...WEEKLY, count: meetings.length }] : [],
      seriesPages: meetings.length
        ? { [WEEKLY.key]: { meetings, next_cursor: null, loading: false, error: null } }
        : {},
      onOpenSeries: vi.fn(),
      onShowOlder: vi.fn(),
      loading: false,
      saving: false,
      error: null,
      viewerIsAdmin: false,
      viewerMemberId: "m-ada",
      members: [],
      onToggleAttendance: vi.fn(),
      onFileMeeting: vi.fn(),
      ...props,
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
    expect(view.querySelector(".meetings__attendees")).toBeNull();
    expect(view.querySelector(".meetings__add-attendee")).toBeNull();
    // The recovery form is an admin affordance and must not render for a member.
    expect(view.querySelector(".meetings__file")).toBeNull();
  });

  const attendeeNames = (view: HTMLElement) =>
    [...view.querySelectorAll(".meetings__attendee > span:first-child")].map(
      (el) => el.textContent,
    );
  const searchOptions = (view: HTMLElement) =>
    [...view.querySelectorAll<HTMLOptionElement>(".meetings__add-attendee datalist option")].map(
      (option) => option.value,
    );

  // A checklist of the whole lab made a forty-person meeting a scroll to find the one person an
  // import missed. The editor lists who was there; everyone else is one search away.
  it("lists only the attendees, and offers everyone else in the search", () => {
    const view = renderView({
      viewerIsAdmin: true,
      members: [
        { id: "m-ada", name: "Ada Attendee" },
        { id: "m-bo", name: "Bo Quiet" },
        { id: "m-cy", name: "Cy Absent" },
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
            // Marked absent by an admin: not an attendee, and addable again.
            { member_id: "m-cy", display_name: "Cy Absent", source: "manual", present: false },
          ],
        },
      ],
    });
    expect(view.querySelector("input[type=checkbox]")).toBeNull();
    expect(attendeeNames(view)).toEqual(["Ada Attendee"]);
    expect(view.textContent).toContain("spoke on the transcript");
    expect(searchOptions(view)).toEqual(["Bo Quiet", "Cy Absent"]);
  });

  it("says so when nobody is recorded yet, and still offers the search", () => {
    const view = renderView({
      viewerIsAdmin: true,
      members: [{ id: "m-bo", name: "Bo Quiet" }],
      rosters: { "zoom-812-2026-08-12": { attendees: [] } },
    });
    expect(view.textContent).toContain("Nobody is recorded as attending yet.");
    expect(searchOptions(view)).toEqual(["Bo Quiet"]);
  });

  it("tells same-named members apart in the search", () => {
    const view = renderView({
      viewerIsAdmin: true,
      members: [
        { id: "m-yara", name: "Yara Allam" },
        { id: "m-yara-2", name: "Yara Allam" },
        { id: "m-bo", name: "Bo Quiet" },
      ],
      rosters: { "zoom-812-2026-08-12": { attendees: [] } },
    });
    expect(searchOptions(view)).toEqual([
      "Yara Allam (m-yara)",
      "Yara Allam (m-yara-2)",
      "Bo Quiet",
    ]);
  });

  it("says which names came off the gallery recording, and which model read them", () => {
    const view = renderView({
      viewerIsAdmin: true,
      members: [{ id: "m-bo", name: "Bo Quiet" }],
      meetings: [
        {
          ...MEETING,
          attendees: [
            {
              member_id: "m-bo",
              display_name: "Bo Quiet",
              source: "video_snapshot",
              present: true,
            },
          ],
          snapshots: {
            processed_at: "2026-10-19T16:20:00.000Z",
            checkpoints_seconds: [1800, 3600, 5400],
            gallery_frames: 2,
            model: "Qwen/Qwen3.5-27B",
          },
        },
      ],
    });
    expect(attendeeNames(view)).toEqual(["Bo Quiet"]);
    expect(view.textContent).toContain("seen on the gallery recording");
    expect(view.textContent).toContain(
      "Attendance read from the gallery recording by Qwen/Qwen3.5-27B: 2 of 3 sampled frames showed participant tiles.",
    );
  });

  function searchAndAdd(view: HTMLElement, typed: string) {
    const form = view.querySelector<HTMLFormElement>(".meetings__add-attendee");
    const input = form?.querySelector<HTMLInputElement>("input[name=member]");
    input!.value = typed;
    form!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    return input!;
  }

  it("adds the member the search names, whatever its case, and clears the box", () => {
    const onToggleAttendance = vi.fn();
    const view = renderView({
      viewerIsAdmin: true,
      members: [{ id: "m-bo", name: "Bo Quiet" }],
      rosters: { "zoom-812-2026-08-12": { attendees: [] } },
      onToggleAttendance,
    });
    const input = searchAndAdd(view, "  bo quiet ");
    expect(onToggleAttendance).toHaveBeenCalledWith("zoom-812-2026-08-12", {
      member_id: "m-bo",
      display_name: "Bo Quiet",
      source: "manual",
      present: true,
    });
    expect(input.value).toBe("");
  });

  it("adds nobody for a name that is no member, and says to pick one from the list", () => {
    const onToggleAttendance = vi.fn();
    const view = renderView({
      viewerIsAdmin: true,
      members: [{ id: "m-bo", name: "Bo Quiet" }],
      rosters: { "zoom-812-2026-08-12": { attendees: [] } },
      onToggleAttendance,
    });
    const input = searchAndAdd(view, "Bo");
    expect(onToggleAttendance).not.toHaveBeenCalled();
    expect(input.validationMessage).toBe("Choose a member from the list.");
  });

  it("removes an attendee as an absent manual correction", () => {
    const onToggleAttendance = vi.fn();
    const view = renderView({
      viewerIsAdmin: true,
      members: [{ id: "m-ada", name: "Ada Attendee" }],
      rosters: {
        "zoom-812-2026-08-12": {
          attendees: [
            {
              member_id: "m-ada",
              display_name: "Ada A.",
              source: "participant_report",
              present: true,
            },
          ],
        },
      },
      onToggleAttendance,
    });
    const remove = view.querySelector<HTMLButtonElement>(".meetings__attendee button");
    expect(remove?.getAttribute("aria-label")).toBe("Remove Ada Attendee from this meeting");
    remove?.click();
    expect(onToggleAttendance).toHaveBeenCalledWith("zoom-812-2026-08-12", {
      member_id: "m-ada",
      display_name: "Ada A.",
      source: "manual",
      present: false,
    });
  });

  // An admin's rows arrive without a roster. Saying "nobody is recorded" until it lands would read
  // as "nobody came", and an add on that would save a roster built from nothing.
  it("draws the admin editor from the roster read for that meeting, and nothing before it", () => {
    const members = [
      { id: "m-ada", name: "Ada Attendee" },
      { id: "m-bo", name: "Bo Quiet" },
    ];
    const before = renderView({ viewerIsAdmin: true, members, rosters: {} });
    expect(before.querySelector(".meetings__add-attendee")).toBeNull();
    expect(before.textContent).not.toContain("Nobody is recorded");
    document.body.innerHTML = "";
    const after = renderView({
      viewerIsAdmin: true,
      members,
      rosters: {
        "zoom-812-2026-08-12": {
          attendees: [{ member_id: "m-ada", display_name: "Ada", source: "manual", present: true }],
        },
      },
    });
    expect(attendeeNames(after)).toEqual(["Ada Attendee"]);
    expect(searchOptions(after)).toEqual(["Bo Quiet"]);
  });

  it("asks for an admin's roster on hover, focus and open", () => {
    const onRosterIntent = vi.fn();
    const view = renderView({ viewerIsAdmin: true, rosters: {}, onRosterIntent });
    const fold = view.querySelector<HTMLDetailsElement>("details.meetings__attendance");
    fold?.dispatchEvent(new Event("pointerenter"));
    fold?.querySelector("summary")?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    if (fold) {
      fold.open = true;
    }
    fold?.dispatchEvent(new Event("toggle"));
    expect(onRosterIntent.mock.calls).toEqual([
      ["zoom-812-2026-08-12", false],
      ["zoom-812-2026-08-12", false],
      ["zoom-812-2026-08-12", true],
    ]);
  });

  it("asks for nothing on a member's fold", () => {
    const onRosterIntent = vi.fn();
    const view = renderView({ onRosterIntent });
    const fold = view.querySelector<HTMLDetailsElement>("details.meetings__attendance");
    fold?.dispatchEvent(new Event("pointerenter"));
    if (fold) {
      fold.open = true;
    }
    fold?.dispatchEvent(new Event("toggle"));
    expect(onRosterIntent).not.toHaveBeenCalled();
  });

  it("distinguishes an empty lab from one that is still loading", () => {
    expect(renderView({ meetings: [], loading: true }).textContent).toContain("Loading meetings");
    expect(renderView({ meetings: [], loading: false }).textContent).toContain(
      "No meeting recordings yet",
    );
  });

  it("groups recordings into one dropdown per recurring meeting, the newest open", () => {
    const reading: MeetingSeries = {
      key: "reading group",
      topic: "Reading Group",
      count: 1,
      latest_started_at: "2026-08-05T15:00:00.000Z",
    };
    const older = { ...MEETING, id: "weekly-older", started_at: "2026-08-05T14:00:00.000Z" };
    const view = renderView({
      series: [{ ...WEEKLY, count: 2 }, reading],
      seriesPages: {
        [WEEKLY.key]: {
          meetings: [MEETING, older],
          next_cursor: null,
          loading: false,
          error: null,
        },
      },
    });
    const dropdowns = view.querySelectorAll<HTMLDetailsElement>("[data-testid='meetings-series']");
    expect(dropdowns).toHaveLength(2);
    // The newest series opens on arrival; every other one waits for its reader.
    expect([...dropdowns].map((dropdown) => dropdown.open)).toEqual([true, false]);
    expect(dropdowns[0]?.querySelector("summary")?.textContent).toContain("Weekly Lab Meeting");
    expect(dropdowns[0]?.querySelector("summary")?.textContent).toContain("2 recordings");
    expect(dropdowns[1]?.querySelector("summary")?.textContent).toContain("1 recording");
    // Every recording of the series, newest first, with only the newest one unfolded.
    const recordings = dropdowns[0]?.querySelectorAll("[data-testid='meetings-recording']");
    expect(recordings).toHaveLength(2);
    const folds = [...(recordings ?? [])].map(
      (recording) =>
        recording.querySelector<HTMLDetailsElement>(".meetings__recording-details")?.open,
    );
    expect(folds).toEqual([true, false]);
    // A closed, unread series says it is loading rather than claiming to be empty.
    expect(dropdowns[1]?.textContent).toContain("Loading recordings");
  });

  it("reads a series when its dropdown is opened", () => {
    const onOpenSeries = vi.fn();
    const view = renderView({
      series: [WEEKLY, { ...WEEKLY, key: "reading group", topic: "Reading Group" }],
      seriesPages: {},
      onOpenSeries,
    });
    const closed = view.querySelectorAll<HTMLDetailsElement>("[data-testid='meetings-series']")[1];
    if (closed) {
      closed.open = true;
    }
    closed?.dispatchEvent(new Event("toggle"));
    expect(onOpenSeries).toHaveBeenLastCalledWith("reading group");
  });

  it("offers a series' older recordings and disables the button while they load", () => {
    const onShowOlder = vi.fn();
    const page = {
      meetings: [MEETING],
      next_cursor: { started_at: MEETING.started_at, id: MEETING.id },
      loading: false,
      error: null,
    };
    const view = renderView({
      series: [{ ...WEEKLY, count: 14 }],
      seriesPages: { [WEEKLY.key]: page },
      onShowOlder,
    });
    const button = view.querySelector<HTMLButtonElement>("[data-testid='meetings-show-older']");
    expect(button?.textContent).toContain("13 more");
    button?.click();
    expect(onShowOlder).toHaveBeenCalledWith(WEEKLY.key);
    const loading = renderView({
      series: [{ ...WEEKLY, count: 14 }],
      seriesPages: { [WEEKLY.key]: { ...page, loading: true } },
    });
    expect(
      loading.querySelector<HTMLButtonElement>("[data-testid='meetings-show-older']")?.disabled,
    ).toBe(true);
    const complete = renderView({ meetings: [MEETING] });
    expect(complete.querySelector("[data-testid='meetings-show-older']")).toBeNull();
  });

  it("shows a series that failed to load inside its own dropdown", () => {
    const view = renderView({
      series: [WEEKLY],
      seriesPages: {
        [WEEKLY.key]: {
          meetings: [],
          next_cursor: null,
          loading: false,
          error: "Synthetic outage",
        },
      },
    });
    const dropdown = view.querySelector("[data-testid='meetings-series']");
    expect(dropdown?.querySelector(".callout.danger")?.textContent).toContain("Synthetic outage");
  });

  it("shows the request error instead of claiming that no recordings exist", () => {
    const view = renderView({ meetings: [], error: "Service unavailable" });
    expect(view.textContent).toContain("Service unavailable");
    expect(view.textContent).not.toContain("No meeting recordings yet");
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

// The card's subtitle is what identifies a recording when the topic does not -- every notice from
// the older template filed as "Untitled Zoom meeting", so the length beside the date is doing real
// work rather than decorating.
describe("how long the recording runs", () => {
  it("reports the length Zoom stated, to the second", () => {
    const view = renderView({
      meetings: [{ ...MEETING, duration_seconds: 98, duration_minutes: undefined }],
    });
    expect(view.textContent).toContain("1m 38s");
  });

  // 98 seconds rounded to minutes reads "2 min", and anything under thirty seconds rounds away to
  // nothing and vanishes from the card entirely.
  it("does not round a short clip into a minute count", () => {
    const view = renderView({ meetings: [{ ...MEETING, duration_seconds: 20 }] });
    expect(view.textContent).toContain("0m 20s");
    expect(view.textContent).not.toContain("58 min");
  });

  it("switches to hours and minutes once it runs past an hour", () => {
    const view = renderView({
      meetings: [{ ...MEETING, duration_seconds: 2 * 3600 + 5 * 60 + 9 }],
    });
    expect(view.textContent).toContain("2h 5m");
  });

  // The hand-filed meeting length is the last resort: it is the length of the *meeting*, which is
  // not the length of the recording.
  it("falls back to a hand-filed meeting length when no recording length is known", () => {
    const view = renderView({
      meetings: [{ ...MEETING, duration_seconds: undefined, duration_minutes: 58 }],
    });
    expect(view.textContent).toContain("58 min");
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
