// The four eligibility surfaces, on synthetic members only. What is under test is what each one
// shows for a given result -- the arithmetic behind the result is the service's, and is covered by
// extensions/adminbot/src/workflows/logistics/rec-letter-eligibility.test.ts.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type {
  RecLetterAdminEligibility,
  RecLetterEligibility,
  RecLetterFreezeIncident,
} from "../api/rec-letter-eligibility.ts";
import { EMPTY_FREEZE_FORM } from "../controllers/rec-letter-eligibility.ts";
import {
  formatMonthRuns,
  formatRecLetterDay,
  renderRecLetterAdvisory,
  renderRecLetterBadge,
  renderRecLetterDetailPanel,
  renderRecLetterFreezeAdmin,
  type RecLetterFreezeAdminProps,
} from "./rec-letter-eligibility.ts";

function result(overrides: Partial<RecLetterEligibility> = {}): RecLetterEligibility {
  return {
    member_id: "m-alpha",
    status: "eligible",
    as_of: "2026-10-16",
    advisory: true,
    is_alumni: false,
    freeze: { frozen: false },
    hours: {
      status: "met",
      qualifying_months: 6,
      required_months: 5,
      min_weekly_hours: 20,
      months: [
        { month: "2026-03", average_weekly_hours: 22, qualifies: true },
        { month: "2026-04", average_weekly_hours: 10, qualifies: false },
      ],
    },
    attendance: {
      status: "met",
      min_rate: 0.8,
      min_roster_coverage: 0.7,
      window_months: 3,
      best_window: {
        start_month: "2026-05",
        end_month: "2026-07",
        mondays_held: 12,
        mondays_with_roster: 10,
        mondays_present: 9,
        wednesday_weeks_held: 12,
        wednesday_weeks_with_roster: 10,
        wednesday_weeks_present: 9,
        monday_rate: 0.9,
        wednesday_rate: 0.9,
        monday_coverage: 10 / 12,
        wednesday_coverage: 10 / 12,
        assessable: true,
        passes: true,
      },
      windows_assessed: 4,
      windows_considered: 6,
    },
    missing: [],
    ...overrides,
  };
}

function draw(template: unknown): HTMLElement {
  const container = document.createElement("div");
  render(template, container);
  return container;
}

const byTestId = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("formatRecLetterDay", () => {
  it("prints the stored day whatever the reader's zone", () => {
    // Noon UTC rendered in UTC: the day cannot slip back west of Greenwich.
    expect(formatRecLetterDay("2027-01-15")).toContain("15");
    expect(formatRecLetterDay("not-a-day")).toBe("not-a-day");
  });
});

describe("queue badge", () => {
  it("is absent until the summary arrives", () => {
    expect(byTestId(draw(renderRecLetterBadge(undefined)), "rec-eligibility-badge")).toBeNull();
  });

  it("names the status, and the end date of a freeze", () => {
    const eligible = byTestId(
      draw(renderRecLetterBadge({ member_id: "m-alpha", status: "eligible" })),
      "rec-eligibility-badge",
    );
    expect(eligible?.dataset.status).toBe("eligible");
    expect(eligible?.className).toContain("rec-eligibility__pill--eligible");

    const frozen = byTestId(
      draw(
        renderRecLetterBadge({ member_id: "m-beta", status: "frozen", frozen_until: "2027-02-01" }),
      ),
      "rec-eligibility-badge",
    );
    expect(frozen?.dataset.status).toBe("frozen");
    expect(frozen?.textContent).toContain(formatRecLetterDay("2027-02-01"));
  });
});

describe("request detail panel", () => {
  const admin = (eligibility: RecLetterEligibility): RecLetterAdminEligibility => ({
    member: { id: eligibility.member_id, name: "Member Alpha" },
    eligibility,
    incidents: [],
    attestations: [],
  });

  it("shows loading, then an error, without a verdict", () => {
    const loading = draw(renderRecLetterDetailPanel({ value: null, loading: true, error: null }));
    expect(byTestId(loading, "rec-eligibility-panel")?.dataset.status).toBeUndefined();
    const failed = draw(
      renderRecLetterDetailPanel({ value: null, loading: false, error: "Could not load" }),
    );
    expect(failed.querySelector('[role="alert"]')?.textContent).toContain("Could not load");
  });

  it("draws the verdict and both criteria", () => {
    const root = draw(
      renderRecLetterDetailPanel({ value: admin(result()), loading: false, error: null }),
    );
    expect(byTestId(root, "rec-eligibility-panel")?.dataset.status).toBe("eligible");
    expect(byTestId(root, "rec-eligibility-hours")?.textContent).toContain("2026-03");
    // A month that fell short is not listed among the qualifying ones.
    expect(byTestId(root, "rec-eligibility-hours")?.textContent).not.toContain("2026-04");
    expect(byTestId(root, "rec-eligibility-attendance")?.textContent).toContain("90%");
    expect(byTestId(root, "rec-eligibility-frozen")).toBeNull();
  });

  it("puts a freeze above the criteria with its end date", () => {
    const frozen = result({
      status: "frozen",
      freeze: { frozen: true, frozen_until: "2027-03-01", incident_count: 1 },
    });
    const root = draw(
      renderRecLetterDetailPanel({ value: admin(frozen), loading: false, error: null }),
    );
    expect(byTestId(root, "rec-eligibility-frozen")?.textContent).toContain(
      formatRecLetterDay("2027-03-01"),
    );
  });

  it("says why attendance could not be judged when no window had enough rosters", () => {
    const thin = result({
      status: "insufficient_data",
      attendance: { ...result().attendance, status: "insufficient_data", best_window: null },
    });
    const root = draw(
      renderRecLetterDetailPanel({ value: admin(thin), loading: false, error: null }),
    );
    expect(byTestId(root, "rec-eligibility-attendance")?.textContent).toContain("70%");
  });
});

describe("member advisory note", () => {
  it("states the policy even when the read failed", () => {
    const root = draw(renderRecLetterAdvisory({ value: null, loading: false, error: "nope" }));
    const note = byTestId(root, "rec-eligibility-advisory");
    expect(note?.getAttribute("role")).toBe("note");
    expect(note?.dataset.status).toBe("unknown");
    expect(note?.textContent).toContain("20");
    // The error is not the member's to act on; the form stays theirs to submit.
    expect(note?.textContent).not.toContain("nope");
  });

  it("lists what is still missing for a member who is not there yet", () => {
    const notYet = result({
      status: "not_yet",
      hours: { ...result().hours, status: "not_met", qualifying_months: 2 },
      missing: [
        { code: "hours_short", qualifying_months: 2, required_months: 5 },
        { code: "attendance_below_threshold" },
      ],
    });
    const root = draw(renderRecLetterAdvisory({ value: notYet, loading: false, error: null }));
    const text = byTestId(root, "rec-eligibility-advisory")?.textContent ?? "";
    expect(text).toContain("2");
    expect(text).toContain("5");
  });

  it("shows only the end date of the member's own freeze", () => {
    const frozen = result({
      status: "frozen",
      freeze: { frozen: true, frozen_until: "2027-03-01" },
      missing: [{ code: "frozen", frozen_until: "2027-03-01" }],
    });
    const root = draw(renderRecLetterAdvisory({ value: frozen, loading: false, error: null }));
    expect(byTestId(root, "rec-eligibility-frozen")?.textContent).toContain(
      formatRecLetterDay("2027-03-01"),
    );
  });
});

describe("admin freeze records", () => {
  const incident: RecLetterFreezeIncident = {
    id: "rlfreeze_1",
    member_id: "m-beta",
    kind: "hallucinated_citation_desk_rejection",
    occurred_on: "2024-02-29",
    paper_id: "paper-7",
    note: "synthetic note",
    created_by: "admin:m-admin",
    created_at: "2024-03-01T00:00:00.000Z",
  };

  function props(overrides: Partial<RecLetterFreezeAdminProps> = {}): RecLetterFreezeAdminProps {
    return {
      incidents: [incident],
      members: [
        { id: "m-alpha", name: "Member Alpha" },
        { id: "m-beta", name: "Member Beta" },
      ],
      loading: false,
      error: null,
      saving: false,
      deletingId: null,
      form: EMPTY_FREEZE_FORM,
      onFormChange: vi.fn(),
      onRecord: vi.fn(),
      onDelete: vi.fn(),
      ...overrides,
    };
  }

  it("lists each incident by name with the day its freeze ends", () => {
    const root = draw(renderRecLetterFreezeAdmin(props()));
    const row = byTestId(root, "rec-eligibility-incident");
    expect(row?.textContent).toContain("Member Beta");
    expect(row?.textContent).toContain("synthetic note");
    // Feb 29 plus a year rolls to Mar 1, the same as the service.
    expect(row?.textContent).toContain(formatRecLetterDay("2025-03-01"));
  });

  it("records from the form and deletes by id", () => {
    const p = props();
    const root = draw(renderRecLetterFreezeAdmin(p));
    root.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(p.onRecord).toHaveBeenCalledOnce();

    const select = byTestId(root, "rec-eligibility-incident-member") as HTMLSelectElement;
    select.value = "m-alpha";
    select.dispatchEvent(new Event("change"));
    expect(p.onFormChange).toHaveBeenCalledWith({ memberId: "m-alpha" });

    root
      .querySelector<HTMLButtonElement>('[data-testid="rec-eligibility-incident"] button')
      ?.click();
    expect(p.onDelete).toHaveBeenCalledWith("rlfreeze_1");
  });

  it("falls back to a text field when the roster is not loaded", () => {
    const root = draw(renderRecLetterFreezeAdmin(props({ members: [], incidents: [] })));
    expect(byTestId(root, "rec-eligibility-incident-member")?.tagName).toBe("INPUT");
    expect(root.textContent).toContain("No freezes");
  });
});

// A 200 is not proof of shape: an older service, a proxy's catch-all, or a body written before a
// field existed can answer with less than a whole result. None of them may crash the requests page.
describe("partial or missing eligibility data", () => {
  const partials: Array<[string, unknown]> = [
    ["an unrelated body", { items: [], requests: [] }],
    ["status only", { member_id: "m-alpha", status: "eligible" }],
    ["no attendance", { ...result(), attendance: undefined }],
    ["no hours", { ...result(), hours: undefined }],
    ["no freeze", { ...result(), freeze: undefined }],
    ["no missing list", { ...result(), missing: undefined }],
  ];

  it.each(partials)("the advisory states the policy and says unavailable for %s", (_, value) => {
    const root = draw(
      renderRecLetterAdvisory({
        value: value as RecLetterEligibility,
        loading: false,
        error: null,
      }),
    );
    const note = byTestId(root, "rec-eligibility-advisory");
    expect(note?.dataset.status).toBe("unknown");
    expect(note?.textContent).toContain("20");
    expect(byTestId(root, "rec-eligibility-unavailable")?.textContent).toContain("unavailable");
  });

  it.each(partials)("the detail panel draws a neutral state for %s", (_, eligibility) => {
    const root = draw(
      renderRecLetterDetailPanel({
        value: {
          member: { id: "m-alpha", name: "Member Alpha" },
          eligibility,
          incidents: [],
          attestations: [],
        } as RecLetterAdminEligibility,
        loading: false,
        error: null,
      }),
    );
    const panel = byTestId(root, "rec-eligibility-panel");
    expect(panel?.dataset.status).toBe("unavailable");
    expect(panel?.textContent).toContain("unavailable");
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it("says checking while the read is in flight, and unavailable offline once it is not", () => {
    const checking = draw(renderRecLetterAdvisory({ value: null, loading: true, error: null }));
    expect(byTestId(checking, "rec-eligibility-advisory")?.textContent).toContain("Checking");
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    try {
      const offline = draw(renderRecLetterAdvisory({ value: null, loading: false, error: null }));
      expect(byTestId(offline, "rec-eligibility-unavailable")?.textContent).toContain(
        "unavailable offline",
      );
      const panel = draw(renderRecLetterDetailPanel({ value: null, loading: false, error: null }));
      expect(byTestId(panel, "rec-eligibility-panel")?.textContent).toContain(
        "unavailable offline",
      );
    } finally {
      onLine.mockRestore();
    }
  });
});

// The follow-up to the first release: a month with no availability row is unknown rather than 0h,
// attendance is shown but not counted, and an admin can confirm a criterion the records miss.
describe("data gaps, attestations and the attendance flag", () => {
  const admin = (
    eligibility: RecLetterEligibility,
    attestations: RecLetterAdminEligibility["attestations"] = [],
  ): RecLetterAdminEligibility => ({
    member: { id: eligibility.member_id, name: "Member Alpha" },
    eligibility,
    incidents: [],
    attestations,
  });

  // Joined in 2025-01; the availability page only has rows from 2026-07.
  const thinHistory = (): RecLetterEligibility =>
    result({
      status: "insufficient_data",
      hours: {
        status: "insufficient_data",
        qualifying_months: 1,
        required_months: 5,
        min_weekly_hours: 20,
        months_with_data: 1,
        months_without_data: ["2025-01", "2025-02", "2025-03", "2026-05", "2026-06"],
        months: [{ month: "2026-07", average_weekly_hours: 25, qualifies: true, has_data: true }],
      },
      attendance: { ...result().attendance, status: "insufficient_data", counted: false },
      missing: [
        {
          code: "hours_not_enough_history",
          qualifying_months: 1,
          required_months: 5,
          months_without_data: ["2025-01", "2025-02", "2025-03", "2026-05", "2026-06"],
        },
        { code: "attendance_no_window" },
      ],
    });

  it("compresses consecutive months into runs, across a year end", () => {
    expect(formatMonthRuns(["2025-12", "2025-11", "2026-01", "2026-03"])).toBe(
      "2025-11 to 2026-01, 2026-03",
    );
    expect(formatMonthRuns([])).toBe("");
  });

  it("calls a thin history 'Not enough data yet', never 'Not yet'", () => {
    const value = thinHistory();
    const badge = draw(
      renderRecLetterBadge({ member_id: value.member_id, status: "insufficient_data" }),
    );
    expect(badge.textContent).toContain("Not enough data yet");
    expect(badge.textContent).not.toMatch(/Not yet\b/);
    const panel = draw(
      renderRecLetterDetailPanel({ value: admin(value), loading: false, error: null }),
    );
    expect(byTestId(panel, "rec-eligibility-panel")?.dataset.status).toBe("insufficient_data");
    expect(byTestId(panel, "rec-eligibility-hours-unknown")?.textContent).toContain(
      "2025-01 to 2025-03, 2026-05 to 2026-06",
    );
  });

  it("tells the member which months have no data, and drops the rosters gap", () => {
    const root = draw(
      renderRecLetterAdvisory({ value: thinHistory(), loading: false, error: null }),
    );
    const text = byTestId(root, "rec-eligibility-advisory")?.textContent ?? "";
    expect(byTestId(root, "rec-eligibility-insufficient")?.textContent).toContain(
      "Not enough history yet",
    );
    expect(byTestId(root, "rec-eligibility-hours-unknown")?.textContent).toContain(
      "2025-01 to 2025-03",
    );
    expect(text).toContain("Time Availability");
    expect(text).not.toContain("meeting rosters");
    expect(byTestId(root, "rec-eligibility-attendance-note")?.textContent).toContain(
      "Meeting attendance isn't tracked yet and isn't counted",
    );
  });

  it("leaves attendance out of the member's 'Still to reach' while it is not counted", () => {
    const notYet = result({
      status: "not_yet",
      hours: { ...result().hours, status: "not_met", qualifying_months: 2 },
      attendance: { ...result().attendance, status: "not_met", counted: false },
      missing: [
        { code: "hours_short", qualifying_months: 2, required_months: 5 },
        { code: "attendance_below_threshold" },
      ],
    });
    const root = draw(renderRecLetterAdvisory({ value: notYet, loading: false, error: null }));
    const text = byTestId(root, "rec-eligibility-advisory")?.textContent ?? "";
    expect(text).toContain("2 of 5 months");
    expect(text).not.toContain("attendance at");
    expect(text).not.toContain("stretch");
  });

  it("labels attendance 'Not counted yet' for the admin and keeps the raw figures", () => {
    const value = result({ attendance: { ...result().attendance, counted: false } });
    const root = draw(
      renderRecLetterDetailPanel({ value: admin(value), loading: false, error: null }),
    );
    const attendance = byTestId(root, "rec-eligibility-attendance");
    expect(attendance?.dataset.counted).toBe("false");
    expect(attendance?.textContent).toContain("Not counted yet");
    expect(attendance?.textContent).toContain("90%");
  });

  it("labels an attested criterion, with the note for the admin and without it for the member", () => {
    const value = result({
      hours: {
        ...result().hours,
        status: "met",
        attested: {
          attestation_id: "rlattest_1",
          at: "2026-10-01T12:00:00.000Z",
          by: "admin:synthetic",
          note: "Worked full time on the synthetic project",
        },
      },
    });
    const panel = draw(
      renderRecLetterDetailPanel({ value: admin(value), loading: false, error: null }),
    );
    const hours = byTestId(panel, "rec-eligibility-hours");
    expect(hours?.textContent).toContain("Confirmed by admin");
    expect(byTestId(panel, "rec-eligibility-attested-hours")?.textContent).toContain(
      "Worked full time",
    );

    const memberView = result({
      hours: {
        ...result().hours,
        attested: { attestation_id: "rlattest_1", at: "2026-10-01T12:00:00.000Z" },
      },
    });
    const member = draw(
      renderRecLetterAdvisory({ value: memberView, loading: false, error: null }),
    );
    expect(byTestId(member, "rec-eligibility-attested-hours")?.textContent).toContain(
      "Hours confirmed by admin",
    );
  });

  it("records a confirmation with the note, and removes one by id", () => {
    const onAttest = vi.fn();
    const onRemove = vi.fn();
    const onNoteChange = vi.fn();
    const value = result({
      status: "insufficient_data",
      hours: { ...thinHistory().hours },
      attendance: { ...result().attendance, counted: false },
    });
    const root = draw(
      renderRecLetterDetailPanel({
        value: admin(value, [
          {
            id: "rlattest_old",
            member_id: "m-alpha",
            criterion: "hours",
            note: "Earlier confirmation",
            created_by: "admin:synthetic",
            created_at: "2026-09-01T12:00:00.000Z",
          },
        ]),
        loading: false,
        error: null,
        attest: {
          note: "",
          saving: null,
          removingId: null,
          error: null,
          onNoteChange,
          onAttest,
          onRemove,
        },
      }),
    );
    const textarea = root.querySelector<HTMLTextAreaElement>(
      '[data-testid="rec-eligibility-attest-note"]',
    );
    textarea!.value = "Synthetic note";
    textarea!.dispatchEvent(new Event("input"));
    expect(onNoteChange).toHaveBeenCalledWith("Synthetic note");
    byTestId(root, "rec-eligibility-attest-hours")?.click();
    expect(onAttest).toHaveBeenCalledWith("hours");
    // Attendance is not counted, so there is nothing for an admin to confirm yet.
    expect(byTestId(root, "rec-eligibility-attest-attendance")).toBeNull();
    const entry = byTestId(root, "rec-eligibility-attestation");
    expect(entry?.textContent).toContain("Earlier confirmation");
    entry?.querySelector("button")?.click();
    expect(onRemove).toHaveBeenCalledWith("rlattest_old");
  });

  it("draws no controls when the surface does not wire them", () => {
    const root = draw(
      renderRecLetterDetailPanel({ value: admin(result()), loading: false, error: null }),
    );
    expect(byTestId(root, "rec-eligibility-attest")).toBeNull();
  });
});
