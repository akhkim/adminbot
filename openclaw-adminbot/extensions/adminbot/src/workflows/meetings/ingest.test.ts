import { describe, expect, it } from "vitest";
import type { AdminBotLabMember, AdminBotMeetingRecord } from "../../contracts/actions.js";
import {
  artifactKind,
  matchArtifactToMeeting,
  noticeToMeeting,
  participantsUpdate,
  transcriptUpdate,
} from "./ingest.js";

function meeting(id: string, topic: string, startedAt: string): AdminBotMeetingRecord {
  return {
    id,
    topic,
    started_at: startedAt,
    recording: { share_url: `https://us02web.zoom.us/rec/share/${id}` },
    source: "zoom_email",
    created_at: startedAt,
    updated_at: startedAt,
  };
}

const ROSTER: AdminBotLabMember[] = [
  {
    id: "m-andrew",
    name: "Andrew Kim",
    email: "andrew@cs.toronto.edu",
    privilege_level: "member",
    access: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  },
];

describe("noticeToMeeting", () => {
  it("turns a notice into a record to file", () => {
    expect(
      noticeToMeeting({
        id: "msg-1",
        subject: "Cloud Recording - Weekly Lab Meeting is now available",
        body: "Topic: Weekly Lab Meeting\nDate: Aug 12, 2026 10:00 AM Eastern Time (US and Canada)\nMeeting ID: 812 3456 7890\nhttps://us02web.zoom.us/rec/share/tok\nPasscode: k7$Rm2pQ\n",
        receivedAt: "2026-08-12T15:04:00.000Z",
      }),
    ).toEqual({
      id: "zoom-81234567890-2026-08-12",
      topic: "Weekly Lab Meeting",
      started_at: "2026-08-12T14:00:00.000Z",
      recording: { share_url: "https://us02web.zoom.us/rec/share/tok", passcode: "k7$Rm2pQ" },
      source: "zoom_email",
    });
  });

  // A meeting filed an hour off is worth more than no meeting, but the operator has to be able to
  // see that it happened -- hence the note rather than a silent substitution.
  it("falls back to the mail's timestamp and says so on the record", () => {
    const filed = noticeToMeeting({
      id: "msg-2",
      subject: "Cloud Recording - Reading Group is now available",
      body: "https://us02web.zoom.us/rec/share/tok\nDate: sometime last Tuesday\n",
      receivedAt: "2026-08-12T15:04:00.000Z",
    });
    expect(filed?.started_at).toBe("2026-08-12T15:04:00.000Z");
    expect(filed?.notes).toContain("sometime last Tuesday");
  });

  it("is undefined for ordinary mail", () => {
    expect(
      noticeToMeeting({ id: "m", subject: "lunch?", body: "at noon", receivedAt: "2026-08-12T00:00:00.000Z" }),
    ).toBeUndefined();
  });
});

describe("matchArtifactToMeeting", () => {
  const weekly = meeting("weekly", "Weekly Lab Meeting", "2026-08-12T14:00:00.000Z");
  const reading = meeting("reading", "Reading Group", "2026-08-12T19:00:00.000Z");

  it("matches the only meeting that day", () => {
    expect(matchArtifactToMeeting("GMT20260812-100000_Recording.transcript.vtt", [weekly])).toBe(
      weekly,
    );
  });

  it("uses the topic when the day has more than one", () => {
    expect(
      matchArtifactToMeeting("GMT20260812-190000_ReadingGroup.transcript.vtt", [weekly, reading]),
    ).toBe(reading);
  });

  // Attaching one meeting's transcript to another's record is worse than attaching nothing: the
  // summary would be wrong and nobody reading it would know.
  it("gives up rather than guessing between two meetings on one day", () => {
    expect(matchArtifactToMeeting("GMT20260812-100000_Recording.vtt", [weekly, reading])).toBeUndefined();
  });

  it("tolerates a day of slack, since Zoom names files in GMT", () => {
    const evening = meeting("evening", "Evening Sync", "2026-08-13T01:00:00.000Z");
    expect(matchArtifactToMeeting("GMT20260812-210000_Recording.vtt", [evening])).toBe(evening);
  });

  it("matches a hand-renamed file with a dashed date", () => {
    expect(matchArtifactToMeeting("2026-08-12 lab meeting.csv", [weekly])).toBe(weekly);
  });

  it("is undefined for a file with no date in its name", () => {
    expect(matchArtifactToMeeting("transcript.vtt", [weekly])).toBeUndefined();
  });
});

describe("artifactKind", () => {
  it("recognizes the two files a host drops and ignores the rest", () => {
    expect(artifactKind("a.VTT")).toBe("transcript");
    expect(artifactKind("participants_812.csv")).toBe("participants");
    expect(artifactKind("recording.mp4")).toBeUndefined();
  });
});

describe("transcriptUpdate", () => {
  const weekly = meeting("weekly", "Weekly Lab Meeting", "2026-08-12T14:00:00.000Z");

  it("keeps the speakers and the length, and hands the text back separately", () => {
    const { update, transcriptText } = transcriptUpdate(
      weekly,
      `WEBVTT

1
00:00:01.000 --> 00:30:00.000
Andrew Kim: hello
`,
      ROSTER,
      "2026-08-12T18:00:00.000Z",
    );
    expect(update.transcript).toEqual({
      processed_at: "2026-08-12T18:00:00.000Z",
      speaker_names: ["Andrew Kim"],
      duration_seconds: 1800,
    });
    expect(update.duration_minutes).toBe(30);
    expect(update.attendees).toEqual([
      { display_name: "Andrew Kim", member_id: "m-andrew", source: "transcript", present: true },
    ]);
    // The text is returned, never carried on the record: it goes to the summarizer and is dropped.
    expect(transcriptText).toContain("Andrew Kim: hello");
    expect(JSON.stringify(update)).not.toContain("hello");
  });
});

describe("participantsUpdate", () => {
  it("is undefined for a CSV with no participant section, so nothing is written", () => {
    const weekly = meeting("weekly", "Weekly", "2026-08-12T14:00:00.000Z");
    expect(participantsUpdate(weekly, "Topic,Duration\nWeekly,60\n", ROSTER)).toBeUndefined();
  });

  it("resolves rows against the roster", () => {
    const weekly = meeting("weekly", "Weekly", "2026-08-12T14:00:00.000Z");
    const update = participantsUpdate(
      weekly,
      'Name (Original Name),User Email,Duration (Minutes)\n"Andrew Kim",andrew@cs.toronto.edu,60\n',
      ROSTER,
    );
    expect(update?.attendees).toEqual([
      {
        display_name: "Andrew Kim",
        member_id: "m-andrew",
        email: "andrew@cs.toronto.edu",
        minutes: 60,
        source: "participant_report",
        present: true,
      },
    ]);
  });
});
