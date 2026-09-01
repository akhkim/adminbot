import { describe, expect, it } from "vitest";
import type { AdminBotLabMember, AdminBotPaperRecord } from "../../contracts/actions.js";
import {
  workshopConferenceOptions,
  workshopProfilesForConference,
  buildWorkshopNudgeDraft,
  matchWorkshopNudges,
  workshopNudgeInputsFromAdminBot,
  workshopProfilesFromDeadlines,
  type WorkshopMatcher,
  type WorkshopNudgePaper,
  type WorkshopProfile,
} from "./workshop-nudges.js";

function profile(
  id: string,
  parent: string,
  status: WorkshopProfile["cross_submission_status"] = "allowed",
): WorkshopProfile {
  return {
    workshop_id: id,
    name: `Workshop ${id}`,
    parent_conference_key: parent,
    parent_conference: parent.replace("-", " ").toUpperCase(),
    conference_location: "Test City",
    topics: [`topic ${id}`],
    topic_evidence: `Official topics for ${id}`,
    routes: [
      {
        deadline_id: `${id}-deadline`,
        label: "submission",
        submission_type: "direct",
        deadline_aoe: "2035-09-01 23:59:59",
        source_url: `https://example.test/${id}`,
      },
    ],
    archival_status: "non_archival",
    cross_submission_status: status,
    cross_submission_evidence: `${status} by the official call`,
    cross_submission_source_url: `https://example.test/${id}`,
    profile_extracted_at: "2035-01-01T00:00:00Z",
  };
}

function paper(id: string, memberId?: string): WorkshopNudgePaper {
  return {
    paper_id: id,
    title: `Safety paper ${id}`,
    topic_summary: "AI safety and reliable agents",
    lab_author_names: ["Ada"],
    ...(memberId ? { recipient_member_id: memberId, recipient_display_name: "Ada" } : {}),
    publication_sources: ["CV"],
  };
}

/**
 * Stands in for the model: everything fits except a paper or workshop labelled off-topic.
 *
 * `scores` lets a test set an exact fit per workshop id where the ordering is what is under test.
 */
function stubMatcher(scores: Record<string, number> = {}): WorkshopMatcher {
  return async ({ papers, workshops }) =>
    papers.flatMap((paper) =>
      workshops.flatMap((workshop) => {
        const offTopic =
          paper.paper_id.includes("off-topic") ||
          workshop.workshop_id.includes("off-topic") ||
          workshop.topics.includes("off-topic");
        const relevance = offTopic ? 0.1 : (scores[workshop.workshop_id] ?? 0.9);
        return [
          {
            workshop_id: workshop.workshop_id,
            paper_id: paper.paper_id,
            relevance,
            reason: `${workshop.name} covers ${paper.title}`,
          },
        ];
      }),
    );
}

describe("workshop nudge matching", () => {
  /** A minimal open workshop row, enough for the conference picker's arithmetic. */
  const row = (
    id: string,
    venueId: string,
    venueGroup: string,
    venueFamily: string,
    parentKey: string,
  ) => ({
    id,
    venue_id: venueId,
    name: `${id} (${venueGroup})`,
    entry_type: "workshop" as const,
    venue_group: venueGroup,
    venue_family: venueFamily,
    deadline_label: "direct submission",
    deadline_aoe: "2035-08-01 23:59:59",
    submission_type: "direct" as const,
    topic_profile: ["topic"],
    parent_conference_key: parentKey,
    conference_location: "Test City",
  });

  it("ranks across every paper per recipient and caps at three distinct workshops", async () => {
    const result = await matchWorkshopNudges({
      papers: [paper("p-1", "member-1"), paper("p-2", "member-1")],
      workshops: [
        profile("high-travel", "neurips-2026"),
        profile("low-travel", "emnlp-2026"),
        profile("third", "iclr-2027", "unclear"),
        profile("fourth", "acl-2028"),
        profile("blocked", "colm-2026", "prohibited"),
        { ...profile("off-topic", "acl-2027"), topics: ["off-topic"] },
      ],
      attendance: [
        {
          member_id: "member-1",
          parent_conference_key: "neurips-2026",
          attendance_likelihood: 90,
          source: "survey",
          last_confirmed_at: "2035-01-01",
        },
        {
          member_id: "member-1",
          parent_conference_key: "emnlp-2026",
          attendance_likelihood: 10,
          source: "survey",
          last_confirmed_at: "2035-01-01",
        },
      ],
      match: stubMatcher(),
      now: new Date("2035-01-01T00:00:00Z"),
    });

    expect(result.recipients).toHaveLength(1);
    expect(result.recipients[0]?.recommendations).toHaveLength(6);
    expect(
      new Set(result.recipients[0]?.recommendations.map((entry) => entry.workshop.workshop_id))
        .size,
    ).toBe(3);
    expect(new Set(result.recipients[0]?.recommendations.map((entry) => entry.final_rank))).toEqual(
      new Set([1, 2, 3]),
    );
    expect(
      result.recipients[0]?.recommendations.every(
        (entry) =>
          entry.topic_evidence.length <= 3 &&
          entry.topic_evidence.every((evidence) => evidence.length <= 140),
      ),
    ).toBe(true);
    expect(result.recipients[0]?.recommendations[0]?.workshop.workshop_id).toBe("high-travel");
    expect(
      result.recipients[0]?.recommendations.some((entry) => entry.paper.paper_id === "p-2"),
    ).toBe(true);
    // The cross-submission rule is evidence on the page, not a gate: a workshop whose call
    // prohibits cross-submission is still recommended, and the administrator decides.
    expect(
      result.recipients[0]?.recommendations.some(
        (entry) => entry.workshop.workshop_id === "blocked",
      ),
    ).toBe(true);
    expect(result.recipients[0]?.draft?.text).toContain("Workshop blocked");
    expect(result.recipients[0]?.draft?.text).toContain("these workshops may fit your papers");
    expect(result.recipients[0]?.draft?.text).toContain("Submission: Sep 1, 2035 · 23:59 AoE");
    expect(result.recipients[0]?.draft?.text).not.toContain("2035-09-01 23:59:59");
    expect(result.recipients[0]?.draft?.text).not.toContain("Workshop third");
    expect(result.recipients[0]?.recommendations).not.toContainEqual(
      expect.objectContaining({ workshop: expect.objectContaining({ workshop_id: "third" }) }),
    );
    expect(result.recipients[0]?.draft?.recommendations).toHaveLength(6);
    expect(result.recipients[0]?.draft?.text.match(/Workshop high-travel/gu)).toHaveLength(1);
    expect(result.recipients[0]?.draft?.text).toContain(
      "Papers: “Safety paper p-1”; “Safety paper p-2”",
    );
    expect(
      result.recipients[0]?.draft?.recommendations[0]?.workshop.cross_submission_evidence,
    ).toBe("allowed by the official call");
  });

  it("works without attendance, retains old papers, and separates unresolved recipients", async () => {
    const old = { ...paper("old"), year: 1999 };
    const result = await matchWorkshopNudges({
      papers: [old],
      workshops: [
        profile("fit", "neurips-2026"),
        profile("second", "emnlp-2026"),
        profile("third", "iclr-2027"),
        profile("fourth", "colm-2027"),
      ],
      match: stubMatcher(),
      now: new Date("2035-01-01T00:00:00Z"),
    });
    expect(result.recipients).toEqual([]);
    expect(result.unresolved_recipients).toHaveLength(1);
    expect(result.unresolved_recipients[0]?.recommendations).toHaveLength(3);
    expect(
      result.unresolved_recipients[0]?.recommendations.map((entry) => entry.final_rank),
    ).toEqual([1, 2, 3]);
    expect(result.unresolved_recipients[0]?.paper.year).toBe(1999);
    expect(result.unresolved_recipients[0]?.recommendations[0]?.rank_explanation).toContain(
      "Attendance for NEURIPS 2026 is unknown",
    );
  });

  it("keeps unsupported papers out even when attendance is known", async () => {
    const result = await matchWorkshopNudges({
      papers: [paper("off-topic", "member-1")],
      workshops: [profile("fit", "neurips-2026")],
      attendance: [
        {
          member_id: "member-1",
          parent_conference_key: "neurips-2026",
          attendance_likelihood: 100,
          source: "survey",
          last_confirmed_at: "2035-01-01",
        },
      ],
      match: stubMatcher(),
    });
    expect(result.recipients).toEqual([]);
  });

  it("is stable and never lets attendance overtake a stronger match", async () => {
    // The two baselines sit under the floor, so what is left is the pair whose order attendance
    // would flip if it were allowed to outrank fit.
    const match = stubMatcher({ strong: 0.9, attended: 0.8, baseline1: 0.3, baseline2: 0.2 });
    const params = {
      papers: [paper("p-1", "member-1")],
      workshops: [
        profile("strong", "event-strong"),
        profile("attended", "event-attended"),
        profile("baseline1", "event-1"),
        profile("baseline2", "event-2"),
      ],
      attendance: [
        {
          member_id: "member-1",
          parent_conference_key: "event-strong",
          attendance_likelihood: 0,
          source: "survey",
          last_confirmed_at: "2035-01-01",
        },
        {
          member_id: "member-1",
          parent_conference_key: "event-attended",
          attendance_likelihood: 100,
          source: "survey",
          last_confirmed_at: "2035-01-01",
        },
      ],
      match,
      now: new Date("2035-01-01T00:00:00Z"),
    };
    const first = await matchWorkshopNudges(params);
    const second = await matchWorkshopNudges(params);

    expect(first).toEqual(second);
    expect(first.recipients[0]?.recommendations.map((entry) => entry.workshop.workshop_id)).toEqual(
      ["strong", "attended"],
    );
  });

  // A row per conference the admin can narrow a pass to, counted so the picker can say how much
  // each one is worth running.
  it("offers each parent conference once, most workshops first", () => {
    const rows = [
      row("a", "EMNLP/2035/Workshop/A", "EMNLP 2035 Workshops", "EMNLP", "emnlp-2035"),
      row("b", "EMNLP/2035/Workshop/B", "EMNLP 2035 Workshops", "EMNLP", "emnlp-2035"),
      row("c", "ICLR/2035/Workshop/C", "ICLR 2035 Workshops", "ICLR", "iclr-2035"),
    ];
    const options = workshopConferenceOptions(rows, new Date("2035-01-01T00:00:00Z"));
    expect(options.map((option) => [option.key, option.workshop_count])).toEqual([
      ["emnlp-2035", 2],
      ["iclr-2035", 1],
    ]);
    expect(options[0]?.label).toBe("EMNLP 2035");
  });

  // A closed workshop is not something to narrow to, so it must not appear in the picker either.
  it("leaves a conference out once its workshops have closed", () => {
    const rows = [
      {
        ...row("old", "X/2020/Workshop/O", "X 2020 Workshops", "X", "x-2020"),
        deadline_aoe: "2020-08-01 23:59:59",
      },
    ];
    expect(workshopConferenceOptions(rows, new Date("2035-01-01T00:00:00Z"))).toEqual([]);
  });

  it("narrows profiles to the chosen conference, and leaves them alone without one", () => {
    const rows = [
      row("a", "EMNLP/2035/Workshop/A", "EMNLP 2035 Workshops", "EMNLP", "emnlp-2035"),
      row("c", "ICLR/2035/Workshop/C", "ICLR 2035 Workshops", "ICLR", "iclr-2035"),
    ];
    const profiles = workshopProfilesFromDeadlines(rows, new Date("2035-01-01T00:00:00Z"));
    expect(
      workshopProfilesForConference(profiles, "iclr-2035").map((p) => p.workshop_id),
    ).toEqual(["ICLR/2035/Workshop/C"]);
    // No pick is every open workshop, which is what the pass did before the picker existed.
    expect(workshopProfilesForConference(profiles, "")).toHaveLength(2);
    expect(workshopProfilesForConference(profiles, undefined)).toHaveLength(2);
  });

  it("builds profiles from current workshop rows and merges submission routes", () => {
    const profiles = workshopProfilesFromDeadlines(
      [
        {
          id: "mint-direct",
          venue_id: "EMNLP/2035/Workshop/MINT",
          name: "MINT (EMNLP 2035)",
          entry_type: "workshop",
          venue_group: "EMNLP 2035 Workshops",
          venue_family: "EMNLP",
          deadline_label: "direct submission",
          deadline_aoe: "2035-08-01 23:59:59",
          submission_type: "direct",
          archival_status: "non_archival",
          topic_profile: ["multimodal interaction", "Trace)"],
          parent_conference_key: "emnlp-2035",
          conference_location: "Test City",
        },
        {
          id: "mint-arr",
          venue_id: "EMNLP/2035/Workshop/MINT",
          name: "MINT ARR (EMNLP 2035)",
          entry_type: "workshop",
          venue_group: "EMNLP 2035 Workshops",
          venue_family: "EMNLP",
          deadline_label: "ARR commitment",
          deadline_aoe: "2035-08-02 23:59:59",
          submission_type: "commitment",
          topic_profile: ["multimodal interaction"],
        },
      ],
      new Date("2035-01-01T00:00:00Z"),
    );
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.routes).toHaveLength(2);
    expect(profiles[0]?.routes.map((route) => route.submission_type)).toEqual([
      "direct",
      "commitment",
    ]);
    expect(profiles[0]).toMatchObject({
      workshop_id: "EMNLP/2035/Workshop/MINT",
      parent_conference_key: "emnlp-2035",
      conference_location: "Test City",
      topics: ["multimodal interaction", "Trace"],
      archival_status: "non_archival",
    });
    expect(profiles[0]?.topics).not.toContain("Trace)");
  });

  it("normalizes native papers, author links, attendance, and incomplete coverage", () => {
    const member = (
      id: string,
      name: string,
      status: AdminBotLabMember["status"] = "active",
    ): AdminBotLabMember => ({
      id,
      name,
      email: `${id}@cs.toronto.edu`,
      privilege_level: "member",
      access: [],
      status,
      created_at: "2035-01-01T00:00:00Z",
      updated_at: "2035-01-01T00:00:00Z",
    });
    const storedPaper = (
      id: string,
      authorLinks: AdminBotPaperRecord["author_links"],
    ): AdminBotPaperRecord => ({
      id,
      title: id === "linked" ? "Meta agents" : "Unlinked paper",
      authors: authorLinks?.map((author) => author.name) ?? [],
      author_links: authorLinks,
      current_step: "submission",
      accepted_venue: "NeurIPS",
      accepted_year: 2035,
      notes:
        "Year: 2029\nStatus: Under Review\nTopic: meta agents and reliable evaluation\nSource: legacy import",
      created_at: "2035-01-01T00:00:00Z",
      updated_at: "2035-02-01T00:00:00Z",
    });
    const inputs = workshopNudgeInputsFromAdminBot({
      members: [
        member("ada", "Ada"),
        member("ben", "Ben"),
        member("old", "Old", "alumni"),
        { ...member("collab", "External Collaborator"), privilege_level: "external_collaborator" },
      ],
      papers: [
        storedPaper("linked", [{ name: "Ada", member_id: "ada" }, { name: "Mystery Author" }]),
        storedPaper("unlinked", [{ name: "Outside Author", email: "outside@example.test" }]),
      ],
      attendees: [
        {
          paper_id: "linked",
          attendee_key: "ada",
          member_id: "ada",
          name: "Ada",
          attending: "yes",
          confirmed_at: "2035-01-15T00:00:00Z",
        },
      ],
      workshops: [profile("meta", "neurips-2035")],
    });

    expect(inputs.papers).toHaveLength(2);
    expect(inputs.papers[0]).toMatchObject({
      paper_id: "linked",
      year: 2035,
      topic_summary: "meta agents and reliable evaluation",
      current_submission_state: "Under Review: NeurIPS",
      recipient_member_id: "ada",
      publication_sources: ["AdminBot paper store", "legacy import"],
    });
    expect(inputs.attendance).toEqual([
      expect.objectContaining({
        member_id: "ada",
        parent_conference_key: "neurips-2035",
        attendance_likelihood: 100,
      }),
    ]);
    expect(inputs.coverage).toEqual({
      members_without_usable_papers: [{ member_id: "ben", name: "Ben" }],
      papers_with_unresolved_authors: [
        { paper_id: "linked", title: "Meta agents", author_names: ["Mystery Author"] },
      ],
      papers_without_active_recipients: [{ paper_id: "unlinked", title: "Unlinked paper" }],
    });
  });

  it("nudges only the first author, never a professor or an alumnus, and skips settled papers", () => {
    const member = (
      id: string,
      name: string,
      extra: Partial<AdminBotLabMember> = {},
    ): AdminBotLabMember =>
      ({
        id,
        name,
        email: `${id}@cs.toronto.edu`,
        privilege_level: "member",
        access: [],
        status: "active",
        created_at: "2035-01-01T00:00:00Z",
        updated_at: "2035-01-01T00:00:00Z",
        ...extra,
      }) as AdminBotLabMember;
    const paper = (
      id: string,
      extra: Partial<AdminBotPaperRecord> = {},
    ): AdminBotPaperRecord =>
      ({
        id,
        title: id,
        authors: [],
        current_step: "submission",
        created_at: "2035-01-01T00:00:00Z",
        updated_at: "2035-02-01T00:00:00Z",
        ...extra,
      }) as AdminBotPaperRecord;

    const inputs = workshopNudgeInputsFromAdminBot({
      members: [
        member("ada", "Ada"),
        member("ben", "Ben"),
        // Status still `active`, but the governance record says alumni: the roster keeps leavers
        // whose status was never flipped, and they must not be nudged.
        member("gone", "Gone", { member_type: "alumni, coauthor-minor" }),
        member("prof", "Zhijing", { role: "Professor" }),
      ],
      papers: [
        // Linked author order decides when no explicit first author is recorded: Ada, not Ben.
        paper("ordered", {
          author_links: [
            { name: "Ada", member_id: "ada" },
            { name: "Ben", member_id: "ben" },
          ],
        }),
        // The explicit record wins over link order.
        paper("explicit", {
          first_author_member_id: "ben",
          author_links: [
            { name: "Ada", member_id: "ada" },
            { name: "Ben", member_id: "ben" },
          ],
        }),
        // First-authored by people the sweep must not address: no fallback to a coauthor.
        paper("professors", {
          author_links: [
            { name: "Zhijing", member_id: "prof" },
            { name: "Ada", member_id: "ada" },
          ],
        }),
        paper("alumni-led", { author_links: [{ name: "Gone", member_id: "gone" }] }),
        // Settled papers spend no model calls and nudge nobody.
        paper("accepted", {
          venue_decision: "accept",
          author_links: [{ name: "Ada", member_id: "ada" }],
        }),
        paper("published-note", {
          notes: "Status: Published\nVenue: ICML",
          author_links: [{ name: "Ada", member_id: "ada" }],
        }),
      ],
      attendees: [],
      workshops: [profile("meta", "neurips-2035")],
    });

    const recipients = new Map(
      inputs.papers
        .filter((entry) => entry.recipient_member_id)
        .map((entry) => [entry.paper_id, entry.recipient_member_id]),
    );
    expect(recipients).toEqual(
      new Map([
        ["ordered", "ada"],
        ["explicit", "ben"],
      ]),
    );
    expect(inputs.papers.map((entry) => entry.paper_id)).not.toContain("accepted");
    expect(inputs.papers.map((entry) => entry.paper_id)).not.toContain("published-note");
    expect(inputs.coverage.papers_without_active_recipients.map((entry) => entry.paper_id)).toEqual(
      ["alumni-led", "professors"],
    );
    // Neither the professor nor the alumnus is a member the sweep considers at all.
    expect(
      inputs.coverage.members_without_usable_papers.map((entry) => entry.member_id),
    ).not.toContain("prof");
    expect(
      inputs.coverage.members_without_usable_papers.map((entry) => entry.member_id),
    ).not.toContain("gone");
  });

  it("judges a co-authored paper once and recommends it to every author", async () => {
    const seen: string[][] = [];
    const result = await matchWorkshopNudges({
      papers: [
        { ...paper("shared", "member-1") },
        { ...paper("shared", "member-2"), recipient_display_name: "Ben" },
      ],
      workshops: [profile("fit", "neurips-2026")],
      match: async (request) => {
        seen.push(request.papers.map((entry) => entry.paper_id));
        return request.papers.flatMap((entry) =>
          request.workshops.map((workshop) => ({
            workshop_id: workshop.workshop_id,
            paper_id: entry.paper_id,
            relevance: 0.9,
            reason: "fits",
          })),
        );
      },
    });
    expect(seen).toEqual([["shared"]]);
    expect(result.recipients.map((entry) => entry.recipient_member_id)).toEqual([
      "member-1",
      "member-2",
    ]);
    expect(result.recipients.every((entry) => entry.draft !== null)).toBe(true);
  });

  it("refuses to serialize a draft with nothing to say", () => {
    expect(() => buildWorkshopNudgeDraft("member-1", "Ada", [])).toThrow(
      /at least one recommendation/u,
    );
  });

  it("refuses a matcher answer naming a paper or workshop it was not given", async () => {
    await expect(
      matchWorkshopNudges({
        papers: [paper("p-1", "member-1")],
        workshops: [profile("fit", "neurips-2026")],
        match: async () => [
          { workshop_id: "fit", paper_id: "someone-elses-paper", relevance: 0.9, reason: "no" },
        ],
      }),
    ).rejects.toThrow(/unknown pair/u);
  });
});
