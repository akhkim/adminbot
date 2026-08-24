import { describe, expect, it } from "vitest";
import type { Embedder } from "../../connectors/embeddings.js";
import type { AdminBotLabMember, AdminBotPaperRecord } from "../../contracts/actions.js";
import {
  buildWorkshopNudgeDraft,
  matchWorkshopNudges,
  workshopNudgeInputsFromAdminBot,
  workshopProfilesFromDeadlines,
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

const semanticEmbedder: Embedder = async (texts) =>
  texts.map((text) => (text.includes("off-topic") ? [0, 1] : [1, 0]));

describe("workshop nudge matching", () => {
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
      embed: semanticEmbedder,
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
    expect(result.excluded_by_submission_rules).toHaveLength(2);
    expect(
      result.excluded_by_submission_rules.every(
        (entry) => entry.workshop.workshop_id === "blocked",
      ),
    ).toBe(true);
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
      embed: semanticEmbedder,
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
      embed: semanticEmbedder,
    });
    expect(result.recipients).toEqual([]);
  });

  it("is stable and never lets attendance overtake a stronger semantic match", async () => {
    const vectors: Record<string, number[]> = {
      strong: [1, 0],
      attended: [0.99, 0.141_067],
      baseline1: [0.4, 0.916_515],
      baseline2: [0.3, 0.953_939],
    };
    const embed: Embedder = async (texts) =>
      texts.map((text) => {
        if (text.startsWith("task:")) {
          return [1, 0];
        }
        const id = Object.keys(vectors).find((candidate) => text.includes(`Workshop ${candidate}`));
        return vectors[id ?? "baseline2"] as number[];
      });
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
      embed,
      now: new Date("2035-01-01T00:00:00Z"),
    };
    const first = await matchWorkshopNudges(params);
    const second = await matchWorkshopNudges(params);

    expect(first).toEqual(second);
    expect(first.recipients[0]?.recommendations.map((entry) => entry.workshop.workshop_id)).toEqual(
      ["strong", "attended"],
    );
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

  it("refuses to serialize a draft from unclear or prohibited pairs", () => {
    const base = {
      pair_id: "p::w",
      paper: paper("p", "member-1"),
      workshop: profile("w", "neurips-2026", "unclear"),
      semantic_score: 1,
      topic_relevance: 1,
      topic_evidence: ["safety"],
      rank_explanation: "semantic",
      draftable: false,
    };
    expect(() => buildWorkshopNudgeDraft("member-1", "Ada", [base])).toThrow(
      /at least one allowed recommendation/u,
    );
  });
});
