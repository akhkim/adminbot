/* @vitest-environment jsdom */

// The edit feed. What these cover is the sentence each row makes: who did it, to what, on whose
// record -- the three facts the table has always held and nothing has ever shown.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { RecentUpdateRow } from "../auth/session.ts";
import { fieldLabel, renderRecentEdits } from "./recent-edits.ts";

function row(overrides: Partial<RecentUpdateRow> = {}): RecentUpdateRow {
  return {
    id: "e1",
    at: "2026-09-04T10:00:00.000Z",
    subject: "profile",
    source: "member",
    actor_member_id: "ada",
    actor_name: "Ada Lovelace",
    field_key: "location",
    slot_id: "profile:location",
    ...overrides,
  };
}

function draw(updates: RecentUpdateRow[], overrides = {}) {
  const container = document.createElement("div");
  render(
    renderRecentEdits({
      updates,
      loading: false,
      error: null,
      onReload: () => {},
      ...overrides,
    }),
    container,
  );
  return container;
}

describe("renderRecentEdits", () => {
  it("names the actor and the field", () => {
    const text = draw([row()]).textContent ?? "";
    expect(text).toContain("Ada Lovelace");
    // The profile field list's own label for `location`, not the key: naming a field is the
    // reader's job precisely so it reads the way the profile form reads.
    expect(text).toContain("Resident location");
  });

  // The distinction the whole feature exists for: an admin editing somebody else's record reads
  // differently from that member filling it in themselves.
  it("says whose record it was when somebody else typed it", () => {
    const text =
      draw([
        row({
          actor_member_id: "grace",
          actor_name: "Grace Hopper",
          subject_member_id: "ada",
          subject_member_name: "Ada Lovelace",
          source: "admin",
        }),
      ]).textContent ?? "";
    expect(text).toContain("Grace Hopper");
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("By an admin");
  });

  it("leaves the record owner unsaid on a self-edit", () => {
    const container = draw([row()]);
    expect(container.querySelector(".recent-edits__subject")).toBeNull();
  });

  it("names the paper a slot edit landed on", () => {
    const text =
      draw([
        row({
          subject: "paper_slot",
          field_key: "arxiv",
          slot_id: "paper_slot:cais:arxiv",
          paper_id: "cais",
          paper_title: "Causal Abstraction",
        }),
      ]).textContent ?? "";
    expect(text).toContain("Causal Abstraction");
    expect(text).toContain("arXiv abstract page");
  });

  it("shows an empty log as empty rather than as an error", () => {
    const container = draw([]);
    expect(container.querySelector('[data-testid="recent-edits-empty"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="recent-edits-error"]')).toBeNull();
  });

  // A service that predates the route is the likely first experience of this page, since the UI
  // ships on merge and the service is deployed separately.
  it("shows the failure instead of an empty feed", () => {
    const container = draw([], { error: "This service build has no edit log yet" });
    expect(container.querySelector('[data-testid="recent-edits-error"]')?.textContent).toContain(
      "no edit log yet",
    );
    expect(container.querySelector('[data-testid="recent-edits-empty"]')).toBeNull();
  });

  it("re-reads on demand", () => {
    const onReload = vi.fn();
    const container = draw([row()], { onReload });
    container.querySelector<HTMLButtonElement>('[data-testid="recent-edits-reload"]')?.click();
    expect(onReload).toHaveBeenCalledOnce();
  });
});

// An unknown key is still an edit that happened. Dropping the row would make the feed quietly
// understate how much has been going on.
describe("fieldLabel", () => {
  // Roster bookkeeping -- member_type, privilege_level -- is not a question the profile form asks,
  // so it has no entry in PROFILE_FIELDS and no label to look up.
  it("says a field it has no label for the way a person would", () => {
    expect(fieldLabel(row({ field_key: "member_type", slot_id: "profile:member_type" }))).toBe(
      "Member type",
    );
  });

  it("names a paper record edit", () => {
    expect(fieldLabel(row({ subject: "paper", slot_id: "paper:cais", field_key: undefined }))).toBe(
      "Paper record",
    );
  });
});
