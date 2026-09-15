import { describe, expect, it } from "vitest";
import {
  looksLikeZoomRecordingNotice,
  meetingRecordId,
  normalizeNoticeBody,
  parseNoticeDate,
  parseZoomRecordingNotice,
  topicFromSubject,
} from "./zoom-email.js";

// Zoom's plain-text notice, as the host receives it before any forwarding.
const PLAIN = `Hi Andrew,

Your cloud recording is now available.

Topic: Jinesis Weekly Lab Meeting
Date: Aug 12, 2026 10:00 AM Eastern Time (US and Canada)
Meeting ID: 812 3456 7890

Share recording with viewers:
https://us02web.zoom.us/rec/share/abc123DEFtoken

Passcode: k7$Rm2pQ
`;

describe("parseZoomRecordingNotice", () => {
  it("reads every field out of the notice Zoom sends", () => {
    const notice = parseZoomRecordingNotice({
      subject: "Cloud Recording - Jinesis Weekly Lab Meeting is now available",
      body: PLAIN,
    });
    expect(notice).toEqual({
      topic: "Jinesis Weekly Lab Meeting",
      startedAtText: "Aug 12, 2026 10:00 AM Eastern Time (US and Canada)",
      // August is EDT (UTC-4), so 10:00 in Toronto is 14:00Z.
      startedAt: "2026-08-12T14:00:00.000Z",
      shareUrl: "https://us02web.zoom.us/rec/share/abc123DEFtoken",
      passcode: "k7$Rm2pQ",
      meetingId: "81234567890",
    });
  });

  // The reason nothing in this module keys on the envelope: Gmail's forward rewrites the sender
  // and quotes the body, so the only thing that survives intact is the URL.
  it("survives a Gmail forward that quotes the body", () => {
    const forwarded = PLAIN.split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    const notice = parseZoomRecordingNotice({
      subject: "Fwd: Cloud Recording - Jinesis Weekly Lab Meeting is now available",
      body: `---------- Forwarded message ---------\n${forwarded}`,
    });
    expect(notice?.shareUrl).toBe("https://us02web.zoom.us/rec/share/abc123DEFtoken");
    expect(notice?.topic).toBe("Jinesis Weekly Lab Meeting");
    expect(notice?.passcode).toBe("k7$Rm2pQ");
  });

  it("reads the HTML alternative when that is what arrives", () => {
    const notice = parseZoomRecordingNotice({
      subject: "Cloud Recording - Reading Group is now available",
      body:
        "<div><p>Topic: Reading Group &amp; Journal Club</p>" +
        "<p>Date: Aug 12, 2026 10:00 AM Eastern Time (US and Canada)</p>" +
        '<p><a href="https://us02web.zoom.us/rec/share/xyz">https://us02web.zoom.us/rec/share/xyz</a></p>' +
        "<p>Passcode: Ab3%kk21</p></div>",
    });
    expect(notice?.topic).toBe("Reading Group & Journal Club");
    expect(notice?.shareUrl).toBe("https://us02web.zoom.us/rec/share/xyz");
    expect(notice?.passcode).toBe("Ab3%kk21");
  });

  it("falls back to the subject for the topic and still files the recording", () => {
    const notice = parseZoomRecordingNotice({
      subject: "Cloud Recording - Thursday Sync is now available",
      body: "Your recording:\nhttps://us02web.zoom.us/rec/share/tok\n",
    });
    expect(notice?.topic).toBe("Thursday Sync");
    expect(notice?.startedAt).toBeUndefined();
  });

  it("is not a notice without a recording link", () => {
    expect(
      parseZoomRecordingNotice({ subject: "lab meeting notes", body: "see you at 10" }),
    ).toBeUndefined();
  });

  // A label pattern will happily match a sentence; a passcode with a space in it would be shown
  // to every member who opens the link, and none of them would get in.
  it("rejects a passcode that is really a sentence", () => {
    const notice = parseZoomRecordingNotice({
      subject: "Cloud Recording - Sync is now available",
      body: "https://us02web.zoom.us/rec/share/tok\nPasscode: this recording is protected\n",
    });
    expect(notice?.passcode).toBeUndefined();
  });
});

describe("looksLikeZoomRecordingNotice", () => {
  it("gates on the recording URL, in either the body or the subject", () => {
    expect(looksLikeZoomRecordingNotice("anything", PLAIN)).toBe(true);
    expect(
      looksLikeZoomRecordingNotice("re: https://us02web.zoom.us/rec/play/tok", "no body"),
    ).toBe(true);
    // A live meeting invite is not a recording notice -- /j/ is a join link, not /rec/.
    expect(
      looksLikeZoomRecordingNotice("Invitation", "join https://us02web.zoom.us/j/8123456789"),
    ).toBe(false);
  });
});

describe("parseNoticeDate", () => {
  it("resolves the zone the line names, not the lab default", () => {
    expect(parseNoticeDate("Aug 12, 2026 10:00 AM Pacific Time (US and Canada)")).toBe(
      "2026-08-12T17:00:00.000Z",
    );
  });

  it("falls back to the lab zone when the label is unrecognized", () => {
    expect(parseNoticeDate("Aug 12, 2026 10:00 AM")).toBe("2026-08-12T14:00:00.000Z");
  });

  it("handles midnight and noon, where a naive 12-hour conversion breaks", () => {
    expect(parseNoticeDate("Jan 5, 2026 12:00 AM")).toBe("2026-01-05T05:00:00.000Z");
    expect(parseNoticeDate("Jan 5, 2026 12:30 PM")).toBe("2026-01-05T17:30:00.000Z");
  });

  it("accepts an ISO-shaped line too", () => {
    expect(parseNoticeDate("2026-08-12 10:00 Eastern Time (US and Canada)")).toBe(
      "2026-08-12T14:00:00.000Z",
    );
  });
});

describe("meetingRecordId", () => {
  // The bug this prevents: a weekly meeting reuses its Zoom meeting id forever, so an id keyed on
  // the meeting alone makes every week overwrite the one before it.
  it("separates two occurrences of the same recurring meeting", () => {
    const first = meetingRecordId({
      topic: "Weekly",
      meetingId: "81234567890",
      startedAt: "2026-08-12T14:00:00.000Z",
      shareUrl: "https://us02web.zoom.us/rec/share/a",
    });
    const second = meetingRecordId({
      topic: "Weekly",
      meetingId: "81234567890",
      startedAt: "2026-08-19T14:00:00.000Z",
      shareUrl: "https://us02web.zoom.us/rec/share/b",
    });
    expect(first).toBe("zoom-81234567890-2026-08-12");
    expect(second).not.toBe(first);
  });

  it("is stable across re-reads of the same mail when the id is missing", () => {
    const notice = { topic: "Sync", shareUrl: "https://us02web.zoom.us/rec/share/tok" };
    expect(meetingRecordId(notice)).toBe(meetingRecordId(notice));
    expect(meetingRecordId(notice)).not.toContain("tok");
  });
});

// The assets template, as a utoronto account actually receives it: no Topic line, no Meeting ID,
// a Duration beside the recording and a share link that wraps across several lines.
const ASSETS = `Meeting assets for Weekly Jinesis Meeting are ready!

Recording

Duration: 00:01:38
Shareable link: https://utoronto.zoom.us/rec/share/VzjGRbnNi52i6HvK9LKLQRZgOf2S-BFHZ37JI8pj6y8jgU404WAZBq7Vsuof15W4.0mCRweMwiOvUT3ki
View in Zoom

Cloud recordings will be deleted automatically after they have been stored for 365 days.
`;

describe("the assets template a utoronto account receives", () => {
  it("reads the duration Zoom states beside the recording", () => {
    const notice = parseZoomRecordingNotice({
      subject: "FW: Meeting assets for Weekly Jinesis Meeting are ready!",
      body: ASSETS,
    });
    expect(notice?.durationSeconds).toBe(98);
    // And the topic, which this template puts only in the subject.
    expect(notice?.topic).toBe("Weekly Jinesis Meeting");
    expect(notice?.shareUrl).toContain("utoronto.zoom.us/rec/share/");
  });

  it("reads hours, which the field carries even on a short clip", () => {
    const notice = parseZoomRecordingNotice({
      subject: "Meeting assets for Long One are ready!",
      body: ASSETS.replace("00:01:38", "02:05:09"),
    });
    expect(notice?.durationSeconds).toBe(2 * 3600 + 5 * 60 + 9);
  });

  // Zoom writes 00:00:00 when the recording captured nothing. Reporting that as a length would put
  // "0m 0s" on the card, which reads as a measurement rather than as the absence of one.
  it("treats a zero duration as no duration", () => {
    const notice = parseZoomRecordingNotice({
      subject: "Meeting assets for Empty are ready!",
      body: ASSETS.replace("00:01:38", "00:00:00"),
    });
    expect(notice?.durationSeconds).toBeUndefined();
  });

  // The body is full of other colon-separated, clock-shaped text -- the date line, and a share
  // token carrying digits and dashes -- so the match is anchored on the label.
  it("does not mistake the date line or the share token for a duration", () => {
    const notice = parseZoomRecordingNotice({
      subject: "Cloud Recording - Reading Group is now available",
      body: PLAIN,
    });
    expect(notice?.durationSeconds).toBeUndefined();
  });
});

describe("normalizeNoticeBody", () => {
  it("strips quote markers so a forwarded body reads like the original", () => {
    expect(normalizeNoticeBody("> > Topic: X\n>\n> Passcode: abcd")).toBe(
      "Topic: X\n\nPasscode: abcd",
    );
  });
});

describe("topicFromSubject", () => {
  it("unwraps forward markers", () => {
    expect(topicFromSubject("Fwd: Re: Cloud Recording - Lab Meeting is now available")).toBe(
      "Lab Meeting",
    );
  });

  // The template a utoronto account sends today. It carries no "Topic:" line in the body either,
  // so before this every recording from it filed as "Untitled Zoom meeting" -- which also left
  // matchArtifactToMeeting with no tiebreaker on a day with two meetings.
  it("reads the newer assets-are-ready template, forwarded or not", () => {
    expect(topicFromSubject("Meeting assets for Weekly Jinesis Meeting are ready!")).toBe(
      "Weekly Jinesis Meeting",
    );
    expect(topicFromSubject("FW: Meeting assets for Weekly Jinesis Meeting are ready!")).toBe(
      "Weekly Jinesis Meeting",
    );
  });

  // The general pattern must not win over the specific one and hand back the prefix as the title.
  it("keeps the older template's prefix out of the topic", () => {
    expect(topicFromSubject("Cloud Recording - Reading Group is now available")).toBe(
      "Reading Group",
    );
    expect(topicFromSubject("Your recording is now available")).toBe("Your recording");
  });

  it("has nothing to say about a subject that is not a notice", () => {
    expect(topicFromSubject("Lunch?")).toBeUndefined();
  });
});
