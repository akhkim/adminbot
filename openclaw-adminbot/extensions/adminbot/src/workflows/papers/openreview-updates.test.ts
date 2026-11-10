import { describe, expect, it } from "vitest";
import { evidenceFromAuthorResults, type OpenReviewEvidence } from "./openreview-paper-sync.js";
import { buildOpenReviewUpdatesNotice, openReviewUpdatesFor } from "./openreview-updates.js";

const now = new Date("2026-11-10T12:00:00Z");
const base: OpenReviewEvidence = {
  source: "author_results",
  status: "under_review",
  title: "Synthetic Paper",
  submission_id: "F1",
  forums: ["F1"],
};
const lines = (evidence: OpenReviewEvidence, stagesClosed: string[] = []) =>
  openReviewUpdatesFor({ paperId: "p1", evidence, stagesClosed, now }).map((update) => update.line);

describe("what OpenReview newly says about a paper", () => {
  it("keeps upcoming unmet author deadlines inside the horizon", () => {
    const evidence: OpenReviewEvidence = {
      ...base,
      author_tasks: [
        {
          kind: "camera_ready",
          name: "Camera Ready Revision",
          due: "2026-11-26T11:59:00Z",
          closes: "2026-11-28T11:59:00Z",
          open: true,
          forms: 1,
          done: 0,
        },
        {
          kind: "revision",
          name: "Rebuttal Revision",
          due: "2026-11-19T11:59:00Z",
          closes: "2026-11-19T12:29:00Z",
          open: true,
          forms: 1,
          done: 0,
        },
        {
          kind: "rebuttal",
          name: "Rebuttal",
          due: "2026-11-09T11:59:00Z",
          open: true,
          forms: 1,
          done: 0,
        },
        {
          kind: "form",
          name: "Checklist",
          due: "2027-07-10T11:59:00Z",
          open: true,
          forms: 1,
          done: 0,
        },
      ],
    };
    expect(lines(evidence)).toEqual([
      "Camera Ready Revision due 2026-11-26 11:59 UTC (OpenReview accepts it until 2026-11-28 11:59 UTC).",
      // A half-hour grace is not worth a mention.
      "Rebuttal Revision due 2026-11-19 11:59 UTC.",
    ]);
  });

  it("says reviews are out only while the paper is under review", () => {
    expect(lines(base, ["reviews_out"])).toEqual(["Reviews are out."]);
    expect(lines({ ...base, status: "accepted" }, ["reviews_out", "rebuttal", "decision"])).toEqual(
      [],
    );
    expect(lines({ ...base, status: "rejected" }, ["reviews_out", "decision"])).toEqual([
      "Rejected; the reviews are on OpenReview.",
    ]);
    expect(lines({ ...base, status: "rejected" }, [])).toEqual([]);
  });

  it("ignores committee comments that are already old when first seen", () => {
    expect(
      lines({ ...base, discussion: { comments: 4, last_at: "2026-10-01T00:00:00Z" } }),
    ).toEqual([]);
  });

  it("keys each line to the fact, so a moved deadline is news again", () => {
    const task = {
      kind: "rebuttal" as const,
      name: "Rebuttal",
      due: "2026-11-20T11:59:00Z",
      open: true,
      forms: 2,
      done: 0,
    };
    const [first] = openReviewUpdatesFor({
      paperId: "p1",
      evidence: { ...base, author_tasks: [task] },
      stagesClosed: [],
      now,
    });
    const [moved] = openReviewUpdatesFor({
      paperId: "p1",
      evidence: { ...base, author_tasks: [{ ...task, due: "2026-11-22T11:59:00Z", done: 1 }] },
      stagesClosed: [],
      now,
    });
    expect(first.subject).toBe("openreview|p1|task|F1|rebuttal|Rebuttal|2026-11-20T11:59:00Z");
    expect(moved.subject).not.toBe(first.subject);
  });

  it("gathers a pass into one notice and caps the list", () => {
    const updates = Array.from({ length: 14 }, (_, index) => ({
      subject: `s${index}`,
      paper_id: `p${index}`,
      line: "Reviews are out.",
    }));
    const papers = new Map(
      updates.map((update) => [
        update.paper_id,
        { title: `Paper ${update.paper_id}`, venue: "ICLR 2027" },
      ]),
    );
    const notice = buildOpenReviewUpdatesNotice(updates, papers);
    expect(notice.title).toBe("OpenReview: news on 14 papers");
    expect(notice.body.startsWith('"Paper p0" (ICLR 2027)\n- Reviews are out.')).toBe(true);
    expect(notice.body).not.toContain("Paper p12");
    expect(notice.body.endsWith("...and 2 more papers; see each forum on OpenReview.")).toBe(true);
  });
});

describe("reading the snapshot's deadlines", () => {
  it("keeps well-formed tasks and committee comment counts, and drops the rest", () => {
    const [evidence] = evidenceFromAuthorResults({
      fetched_at: "2026-11-10T00:00:00Z",
      submissions: [
        {
          id: "n1",
          forum: "F1",
          title: "Synthetic Paper",
          status: "under_review",
          author_tasks: [
            {
              kind: "rebuttal",
              name: "Rebuttal",
              due: "2026-11-20T11:59:00+00:00",
              closes: null,
              open: true,
              forms: 2,
              done: 1,
            },
            { kind: "mystery", name: "?", due: "2026-11-20T11:59:00+00:00", open: true },
            { kind: "form", name: "Undated", due: null, open: true },
          ],
          discussion: { comments: 3, last_at: "2026-11-09T00:00:00+00:00" },
        },
      ],
    });
    expect(evidence.author_tasks).toEqual([
      {
        kind: "rebuttal",
        name: "Rebuttal",
        due: "2026-11-20T11:59:00+00:00",
        open: true,
        forms: 2,
        done: 1,
      },
    ]);
    expect(evidence.discussion).toEqual({ comments: 3, last_at: "2026-11-09T00:00:00+00:00" });
  });
});
