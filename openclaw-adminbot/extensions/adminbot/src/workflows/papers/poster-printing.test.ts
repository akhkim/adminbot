import { describe, expect, it } from "vitest";
import type { AdminBotPaperRecord } from "../../contracts/actions.js";
import type {
  AdminBotPosterPrintBatchRecord,
  AdminBotPosterPrintRequestRecord,
} from "../../contracts/poster-printing.js";
import {
  buildPosterPrintBatches,
  duePosterPrintReminders,
  posterPrintConferenceKey,
  posterPrintDayText,
  posterPrintHandoff,
  posterPrintReminderStage,
  type PosterPrintConferenceSite,
  type PosterPrintInputs,
} from "./poster-printing.js";

const SITES: PosterPrintConferenceSite[] = [
  {
    key: "neuripssydney:2026",
    group_key: "neurips:2026",
    label: "NeurIPS 2026 — Sydney",
    multi_site: true,
    starts: "2026-12-08",
  },
  {
    key: "neuripsparis:2026",
    group_key: "neurips:2026",
    label: "NeurIPS 2026 — Paris",
    multi_site: true,
    starts: "2026-12-09",
  },
  {
    key: "neuripsatlanta:2026",
    group_key: "neurips:2026",
    label: "NeurIPS 2026 — Atlanta",
    multi_site: true,
    starts: "2026-12-10",
  },
  {
    key: "emnlp:2026",
    group_key: "emnlp:2026",
    label: "EMNLP 2026",
    multi_site: false,
    starts: "2026-10-24",
  },
];

function paper(id: string, extra: Partial<AdminBotPaperRecord> = {}): AdminBotPaperRecord {
  return {
    id,
    title: `Paper ${id}`,
    authors: [],
    current_step: "overleaf_writing",
    venue_decision: "accept",
    accepted_venue: "NeurIPS",
    accepted_year: 2026,
    first_author_member_id: `author-${id}`,
    ...extra,
  } as AdminBotPaperRecord;
}

function request(
  paperId: string,
  extra: Partial<AdminBotPosterPrintRequestRecord> = {},
): AdminBotPosterPrintRequestRecord {
  return {
    conference_key: "neurips:2026",
    paper_id: paperId,
    choice: "lab_print",
    updated_at: "2026-11-01T00:00:00Z",
    ...extra,
  };
}

function inputs(extra: Partial<PosterPrintInputs> = {}): PosterPrintInputs {
  const papers = extra.papers ?? [];
  return {
    papers,
    batches: [],
    requests: [],
    sites: SITES,
    posterSlots: new Map(),
    members: new Map([
      ["rahul", { name: "Rahul Printer" }],
      ...papers.map((p) => [p.first_author_member_id!, { name: `Author ${p.id}` }] as const),
    ]),
    going: new Map(),
    handoffs: new Map(),
    today: "2026-11-20",
    ...extra,
  };
}

const DEFAULTS: AdminBotPosterPrintBatchRecord = {
  conference_key: "default",
  printer_member_id: "rahul",
  print_location: "MPI Tübingen",
  updated_at: "2026-11-01T00:00:00Z",
};

describe("which papers owe a poster", () => {
  it("counts a paper accepted by the OpenReview sync even before anyone set the decision", () => {
    expect(
      posterPrintConferenceKey(
        paper("a", { venue_decision: undefined, openreview_sync: { status: "accepted" } } as never),
      ),
    ).toBe("neurips:2026");
    expect(posterPrintConferenceKey(paper("b", { venue_decision: "reject" } as never))).toBe(
      undefined,
    );
    expect(posterPrintConferenceKey(paper("c", { accepted_venue: "" }))).toBe(undefined);
  });
});

describe("placing papers at a site", () => {
  it("uses the author's answer, then their trip, and lists the rest under every city", () => {
    const views = buildPosterPrintBatches(
      inputs({
        papers: [paper("answered"), paper("booked"), paper("unplaced")],
        requests: [request("answered", { site_key: "neuripsparis:2026" })],
        going: new Map([["neuripsatlanta:2026", new Set(["author-booked"])]]),
      }),
    );
    const bySite = new Map(views.map((view) => [view.conference_key, view]));
    expect(bySite.get("neuripsparis:2026")!.papers.map((p) => [p.paper_id, p.site_source])).toEqual(
      [
        ["unplaced", "unknown"],
        ["answered", "request"],
      ],
    );
    expect(
      bySite.get("neuripsatlanta:2026")!.papers.map((p) => [p.paper_id, p.site_source]),
    ).toEqual([
      ["booked", "trip"],
      ["unplaced", "unknown"],
    ]);
    expect(bySite.get("neuripssydney:2026")!.papers.map((p) => p.paper_id)).toEqual(["unplaced"]);
    expect(bySite.get("neuripsatlanta:2026")!.papers[0].first_author_going).toBe(true);
  });

  it("places every paper at the only site of a single-site conference", () => {
    const views = buildPosterPrintBatches(
      inputs({
        papers: [paper("e", { accepted_venue: "EMNLP" })],
        today: "2026-10-01",
      }),
    );
    expect(views.map((view) => view.conference_key)).toContain("emnlp:2026");
    const emnlp = views.find((view) => view.conference_key === "emnlp:2026")!;
    expect(emnlp.papers[0].site_source).toBe("single");
    expect(emnlp.deadline_on).toBe("2026-10-10");
  });

  it("drops a site on its start day and a past-year conference the dataset does not know", () => {
    const views = buildPosterPrintBatches(
      inputs({
        papers: [
          paper("n"),
          paper("old", { accepted_venue: "Obscure Workshop", accepted_year: 2025 }),
          paper("new", { accepted_venue: "Obscure Workshop", accepted_year: 2026 }),
        ],
        today: "2026-12-09",
      }),
    );
    expect(views.map((view) => view.conference_key).toSorted()).toEqual([
      "neuripsatlanta:2026",
      "obscureworkshop:2026",
    ]);
    const unknown = views.find((view) => view.conference_key === "obscureworkshop:2026")!;
    expect(unknown.status).toBe("no_deadline");
    expect(unknown.deadline_source).toBe("none");
  });
});

describe("paper states and the batch status", () => {
  it("reads the slot for the file and honours an old not-needed answer", () => {
    const views = buildPosterPrintBatches(
      inputs({
        papers: [paper("ready"), paper("nofile"), paper("self"), paper("waived"), paper("open")],
        requests: [
          request("ready", { site_key: "neuripsparis:2026" }),
          request("nofile", { site_key: "neuripsparis:2026" }),
          request("self", { choice: "self_print", site_key: "neuripsparis:2026" }),
        ],
        posterSlots: new Map([
          ["ready", { poster_url: "https://drive.example/ready.pdf" }],
          ["waived", { physical: "not_needed" }],
        ]),
      }),
    );
    const paris = views.find((view) => view.conference_key === "neuripsparis:2026")!;
    const states = new Map(paris.papers.map((p) => [p.paper_id, p.state]));
    expect(Object.fromEntries(states)).toEqual({
      open: "unanswered",
      waived: "no_poster",
      nofile: "missing_file",
      ready: "ready",
      self: "self_print",
    });
    expect(paris.counts).toEqual({
      unanswered: 1,
      missing_file: 1,
      ready: 1,
      self_print: 1,
      no_poster: 1,
    });
  });

  it("derives the deadline from lead days, lets an admin fix it, and moves through due and sent", () => {
    const base = inputs({ papers: [paper("p")], batches: [DEFAULTS] });
    const paris = (input: PosterPrintInputs) =>
      buildPosterPrintBatches(input).find((view) => view.conference_key === "neuripsparis:2026")!;

    const collecting = paris(base);
    expect(collecting).toMatchObject({
      deadline_on: "2026-11-25",
      deadline_source: "lead_days",
      days_left: 5,
      status: "collecting",
      printer: { member_id: "rahul", name: "Rahul Printer" },
      print_location: "MPI Tübingen",
    });

    const fixed = paris({
      ...base,
      batches: [
        DEFAULTS,
        { conference_key: "neuripsparis:2026", deadline_on: "2026-11-20", updated_at: "x" },
      ],
    });
    expect(fixed).toMatchObject({ deadline_on: "2026-11-20", deadline_source: "set", status: "due" });

    const sent = paris({ ...base, today: "2026-11-26", handoffs: new Map([["neuripsparis:2026", "t"]]) });
    expect(sent).toMatchObject({ status: "sent", sent_at: "t" });
  });
});

describe("reminders", () => {
  it("fires three times: three weeks out, the last week, the last two days", () => {
    expect([30, 22, 21, 8, 7, 3, 2, 0, -1].map(posterPrintReminderStage)).toEqual([
      undefined,
      undefined,
      "opening",
      "opening",
      "week",
      "week",
      "final",
      "final",
      undefined,
    ]);
  });

  it("sends one message per unplaced paper, from the soonest city, keyed by the conference", () => {
    const views = buildPosterPrintBatches(
      inputs({
        papers: [paper("unplaced"), paper("done"), paper("orphan", { first_author_member_id: undefined })],
        requests: [request("done", { choice: "self_print" })],
        batches: [DEFAULTS],
      }),
    );
    const reminders = duePosterPrintReminders(views, (id) => `https://bot.example/p/${id}`);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({
      paper_id: "unplaced",
      member_id: "author-unplaced",
      conference_key: "neuripssydney:2026",
      stage: "week",
      deadline_on: "2026-11-24",
      idempotency_key: "poster-print-reminder:neurips:2026:unplaced:2026-11-24:week",
    });
    expect(reminders[0].text).toContain("more than one city");
    expect(reminders[0].text).toContain("https://bot.example/p/unplaced");
  });

  it("asks for the file when the lab is printing but nothing is linked", () => {
    const views = buildPosterPrintBatches(
      inputs({
        papers: [paper("p")],
        requests: [request("p", { site_key: "neuripsparis:2026" })],
        batches: [DEFAULTS, { conference_key: "neuripsparis:2026", notes: "PDF only", updated_at: "x" }],
        today: "2026-11-24",
      }),
    );
    const [reminder] = duePosterPrintReminders(views, () => "url");
    expect(reminder.stage).toBe("final");
    expect(reminder.text).toMatch(/^Last call: NeurIPS 2026 — Paris posters go to Rahul Printer \(MPI Tübingen\)/u);
    expect(reminder.text).toContain("no poster file is linked yet");
    expect(reminder.text).toContain("Note from the printer: PDF only");
    expect(reminder.text).toContain(posterPrintDayText("2026-11-25"));
  });

  it("writes the deadline as a calendar date, not a countdown", () => {
    expect(posterPrintDayText("2026-11-25")).toBe("Wednesday 25 November");
  });
});

describe("the printer's list", () => {
  const due = (extra: Partial<PosterPrintInputs> = {}) =>
    buildPosterPrintBatches(
      inputs({
        papers: [paper("ready"), paper("nofile"), paper("unplaced")],
        requests: [
          request("ready", { site_key: "neuripsparis:2026", size: "A0", orientation: "portrait", copies: 2 }),
          request("nofile", { site_key: "neuripsparis:2026", size: "custom", custom_size: "36x48 in" }),
        ],
        posterSlots: new Map([["ready", { poster_url: "https://drive.example/ready.pdf" }]]),
        going: new Map([["neuripsparis:2026", new Set(["author-ready"])]]),
        batches: [DEFAULTS],
        today: "2026-11-25",
        ...extra,
      }),
    ).find((view) => view.conference_key === "neuripsparis:2026")!;

  it("lists what to print with sizes and files, and leaves out papers not placed in this city", () => {
    const handoff = posterPrintHandoff(due(), "https://bot.example/posters")!;
    expect(handoff.paper_ids.toSorted()).toEqual(["nofile", "ready"]);
    expect(handoff.text).toContain("A0, portrait, 2 copies");
    expect(handoff.text).toContain("36x48 in");
    expect(handoff.text).toContain("NO FILE YET");
    expect(handoff.text).toContain("author attending");
    expect(handoff.text).toContain("1 paper(s) have not answered yet");
    expect(handoff.text).not.toContain("Paper unplaced");
  });

  it("keeps the same key for the same list and a new one when the list changes", () => {
    const first = posterPrintHandoff(due(), "u")!;
    expect(posterPrintHandoff(due(), "u")!.idempotency_key).toBe(first.idempotency_key);
    const fileArrived = posterPrintHandoff(
      due({
        posterSlots: new Map([
          ["ready", { poster_url: "https://drive.example/ready.pdf" }],
          ["nofile", { poster_url: "https://drive.example/nofile.pdf" }],
        ]),
      }),
      "u",
    )!;
    expect(fileArrived.idempotency_key).not.toBe(first.idempotency_key);
    expect(first.idempotency_key.startsWith("poster-print-handoff:neuripsparis:2026:")).toBe(true);
  });

  it("files nothing before the deadline or without a printer", () => {
    expect(posterPrintHandoff(due({ today: "2026-11-20" }), "u")).toBe(undefined);
    expect(posterPrintHandoff(due({ batches: [] }), "u")).toBe(undefined);
  });
});
