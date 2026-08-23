// The weekly log on a paper card: one box for your own week, and everyone else's underneath.
import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { PaperWeeklyUpdate } from "../auth/session.ts";
import { renderPaperWeeklyUpdates } from "./paper-weekly-updates.ts";

// A Sunday inside the week starting Monday 17 Aug 2026.
const NOW = new Date("2026-08-23T18:00:00.000Z");

function update(fields: Partial<PaperWeeklyUpdate> & { member_id: string }): PaperWeeklyUpdate {
  return {
    paper_id: "p1",
    week_start: "2026-08-17",
    body: "Ran the ablation.",
    created_at: "2026-08-21T00:00:00.000Z",
    updated_at: "2026-08-21T00:00:00.000Z",
    ...fields,
  };
}

function draw(updates: PaperWeeklyUpdate[], extra: { memberId?: string; readOnly?: boolean } = {}) {
  const saved: string[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderPaperWeeklyUpdates({
      paperId: "p1",
      updates,
      now: NOW,
      memberNames: { ada: "Ada Lovelace", rahul: "Rahul Shrestha" },
      ...(extra.memberId === undefined ? {} : { memberId: extra.memberId }),
      ...(extra.readOnly ? {} : { onSave: (body: string) => saved.push(body) }),
    }),
    container,
  );
  return { container, saved };
}

describe("renderPaperWeeklyUpdates", () => {
  it("asks for this week by name", () => {
    const { container } = draw([], { memberId: "ada" });
    expect(container.textContent).toContain("17–23 Aug");
    expect(container.textContent).toContain("What did you do on this paper this week?");
  });

  it("puts the member's own entry in the box, not in the log", () => {
    const { container } = draw(
      [update({ member_id: "ada", body: "Wrote §5." }), update({ member_id: "rahul" })],
      { memberId: "ada" },
    );
    const box = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="paper-weekly-update-box-p1"]',
    );
    expect(box?.value).toBe("Wrote §5.");
    // Their own line for this week appears once -- in the box they can edit.
    expect(
      container.querySelector('[data-testid="paper-weekly-update-p1-ada-2026-08-17"]'),
    ).toBeNull();
    // A coauthor's does appear, with their name on it.
    const other = container.querySelector(
      '[data-testid="paper-weekly-update-p1-rahul-2026-08-17"]',
    );
    expect(other?.textContent).toContain("Rahul Shrestha");
  });

  it("saves a changed line, and does not save an unchanged one", () => {
    const { container, saved } = draw([update({ member_id: "ada", body: "Wrote §5." })], {
      memberId: "ada",
    });
    const box = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="paper-weekly-update-box-p1"]',
    );
    box!.value = "Wrote §5.";
    box!.dispatchEvent(new Event("change"));
    expect(saved).toEqual([]);

    box!.value = "  Wrote §5 and ran the ablation.  ";
    box!.dispatchEvent(new Event("change"));
    expect(saved).toEqual(["Wrote §5 and ran the ablation."]);
  });

  it("shows earlier weeks under this one, newest first", () => {
    const { container } = draw(
      [
        update({ member_id: "rahul", week_start: "2026-08-10", body: "Older." }),
        update({ member_id: "rahul", body: "Newer." }),
      ],
      { memberId: "ada" },
    );
    const weeks = [...container.querySelectorAll(".weekly-updates__week-label")].map(
      (node) => node.textContent ?? "",
    );
    expect(weeks[0]).toContain("17–23 Aug");
    expect(weeks[1]).toContain("10–16 Aug");
  });

  it("says the log is empty rather than rendering a bare heading", () => {
    const { container } = draw([], { memberId: "ada" });
    expect(container.querySelector(".weekly-updates__empty")?.textContent).toContain(
      "yours would be the first",
    );
  });

  it("gives no box to a reader who cannot write here", () => {
    const { container } = draw([update({ member_id: "rahul" })], { readOnly: true });
    expect(container.querySelector('[data-testid="paper-weekly-update-box-p1"]')).toBeNull();
    // The log is still readable -- that is the point of it.
    expect(container.textContent).toContain("Ran the ablation.");
  });
});
