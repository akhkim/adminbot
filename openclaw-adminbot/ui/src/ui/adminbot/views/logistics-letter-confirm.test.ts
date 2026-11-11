// The student's "Letter was submitted" answer: when it is offered, and how it reads afterwards.
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogisticsRequest } from "../api/logistics.ts";
import {
  canConfirmLetter,
  canUndoLetterConfirmation,
  isLetterOverdue,
  letterConfirmationText,
} from "./logistics-letter-confirm.ts";
import {
  renderAdminBotLogisticsRequests,
  type AdminBotLogisticsRequestsProps,
} from "./logistics-requests.ts";

const NOW = new Date("2026-12-10T13:00:00Z");

function letter(fields: Partial<LogisticsRequest> = {}): LogisticsRequest {
  return {
    id: "logreq_1",
    kind: "recommendation_letters",
    member_id: "ada",
    member_name: "Ada Lovelace",
    status: "submitted",
    submitted_at: "2026-11-01T09:00:00Z",
    updated_at: "2026-11-01T09:00:00Z",
    schools: [{ school: "MIT", letter_deadline: "2026-12-01", deadline_timezone: "UTC" }],
    deadline_at: "2026-12-01T23:59:00Z",
    ...fields,
  } as LogisticsRequest;
}

function draw(fields: Partial<AdminBotLogisticsRequestsProps>) {
  const confirms: { id: string; undo: boolean }[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderAdminBotLogisticsRequests({
      requests: [],
      loading: false,
      error: null,
      open: null,
      openLoading: false,
      onOpenRequest: () => {},
      viewerIsAdmin: false,
      viewerMemberId: "ada",
      onWithdraw: () => {},
      onConfirmLetter: (id, undo) => confirms.push({ id, undo }),
      onEdit: () => {},
      onSetStatus: () => {},
      onDelete: () => {},
      statusNote: "",
      onStatusNoteChange: () => {},
      ...fields,
    }),
    container,
  );
  return { container, confirms };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("when the answer is on offer", () => {
  it("is overdue only past the deadline and while still open", () => {
    expect(isLetterOverdue(letter(), NOW)).toBe(true);
    expect(isLetterOverdue(letter({ deadline_at: "2026-12-20T00:00:00Z" }), NOW)).toBe(false);
    expect(isLetterOverdue(letter({ status: "completed" }), NOW)).toBe(false);
    expect(isLetterOverdue(letter({ deadline_at: undefined }), NOW)).toBe(false);
  });

  it("is the requester's own, on an open letter request", () => {
    expect(canConfirmLetter(letter(), "ada")).toBe(true);
    expect(canConfirmLetter(letter({ status: "in_progress" }), "ada")).toBe(true);
    expect(canConfirmLetter(letter(), "grace")).toBe(false);
    expect(canConfirmLetter(letter({ status: "declined" }), "ada")).toBe(false);
    expect(canConfirmLetter(letter({ kind: "document_signature" }), "ada")).toBe(false);
  });

  it("can be taken back only by the student who gave it", () => {
    const mine = letter({ status: "completed", confirmed_by: "ada", confirmed_via: "member" });
    expect(canUndoLetterConfirmation(mine, "ada")).toBe(true);
    expect(canUndoLetterConfirmation(mine, "grace")).toBe(false);
    expect(
      canUndoLetterConfirmation({ ...mine, confirmed_by: "ada", confirmed_via: "admin" }, "ada"),
    ).toBe(false);
  });
});

describe("how a confirmation reads", () => {
  it("names who confirmed and how", () => {
    const base = letter({
      status: "completed",
      confirmed_by: "ada",
      confirmed_by_name: "Ada Lovelace",
      confirmed_at: "2026-12-10T13:00:00Z",
    });
    expect(letterConfirmationText({ ...base, confirmed_via: "member_after_reminder" })).toMatch(
      /^Submitted, confirmed by Ada Lovelace on .+ after the deadline check$/u,
    );
    expect(letterConfirmationText({ ...base, confirmed_via: "member" })).toMatch(
      /^Submitted, confirmed by Ada Lovelace on /u,
    );
    expect(
      letterConfirmationText({ ...base, confirmed_by_name: "Zhijing Jin", confirmed_via: "admin" }),
    ).toMatch(/^Submitted, marked by Zhijing Jin on /u);
    expect(letterConfirmationText(letter())).toBe("");
  });
});

describe("the member's requests view", () => {
  // The view reads the clock itself; pin it past the 2026-12-01 deadline.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("puts the answer on an overdue row and asks before sending it", () => {
    vi.stubGlobal("confirm", () => true);
    const { container, confirms } = draw({ requests: [letter()] });

    const button = container.querySelector<HTMLButtonElement>('[data-testid="letter-confirm-row"]');
    expect(button?.textContent).toContain("Letter was submitted");
    button?.click();

    expect(confirms).toEqual([{ id: "logreq_1", undo: false }]);
  });

  it("leaves a row whose deadline is still ahead alone", () => {
    const { container } = draw({ requests: [letter({ deadline_at: "2099-01-01T00:00:00Z" })] });
    expect(container.querySelector('[data-testid="letter-confirm-row"]')).toBeNull();
  });

  it("flags an overdue letter in the detail and offers the answer", () => {
    const { container } = draw({ open: letter() });
    expect(container.querySelector('[data-testid="letter-overdue"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="letter-confirm"]')).not.toBeNull();
  });

  it("offers undo on the student's own confirmation and shows who confirmed", () => {
    const { container, confirms } = draw({
      open: letter({
        status: "completed",
        confirmed_by: "ada",
        confirmed_by_name: "Ada Lovelace",
        confirmed_at: "2026-12-10T13:00:00Z",
        confirmed_via: "member_after_reminder",
      }),
    });

    expect(container.querySelector('[data-testid="letter-confirmation"]')?.textContent).toContain(
      "confirmed by Ada Lovelace",
    );
    container.querySelector<HTMLButtonElement>('[data-testid="letter-confirm-undo"]')?.click();
    expect(confirms).toEqual([{ id: "logreq_1", undo: true }]);
  });

  it("gives an admin-marked letter no undo for the student", () => {
    const { container } = draw({
      open: letter({
        status: "completed",
        confirmed_by: "zhijing",
        confirmed_by_name: "Zhijing Jin",
        confirmed_at: "2026-12-10T13:00:00Z",
        confirmed_via: "admin",
      }),
    });
    expect(container.querySelector('[data-testid="letter-confirm-undo"]')).toBeNull();
    expect(container.querySelector('[data-testid="letter-confirmation"]')?.textContent).toContain(
      "marked by Zhijing Jin",
    );
  });
});
