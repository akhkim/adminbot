/* @vitest-environment jsdom */

// The author list as people: what each row says about who it names, and what the two add controls
// put on the paper.
import { render } from "lit";
import { describe, expect, it } from "vitest";
import "./member-select.ts";
import { renderPaperCoauthors, type PaperAuthorLink } from "./paper-coauthors.ts";

const MEMBERS = [
  { id: "joeun-yook", name: "Joeun Yook", hint: "yookjoeu@cs.toronto.edu" },
  { id: "andrew-kim", name: "Andrew Kim", hint: "akim@cs.toronto.edu" },
  { id: "zhijing-jin", name: "Zhijing Jin", hint: "zjin@cs.toronto.edu" },
];

function draw(
  links: PaperAuthorLink[],
  options: {
    readOnly?: boolean;
    draft?: { email: string; name: string; twitter?: string };
  } = {},
) {
  const changes: PaperAuthorLink[][] = [];
  const drafts: Array<{ email?: string; name?: string; twitter?: string }> = [];
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderPaperCoauthors({
      paperId: "p1",
      links,
      members: MEMBERS,
      draftEmail: options.draft?.email ?? "",
      draftName: options.draft?.name ?? "",
      draftTwitter: options.draft?.twitter ?? "",
      onDraftChange: (draft) => drafts.push(draft),
      ...(options.readOnly ? {} : { onChange: (next) => changes.push(next) }),
    }),
    container,
  );
  return { container, changes, drafts };
}

describe("renderPaperCoauthors", () => {
  it("says which rows are lab members and which are not", () => {
    const { container } = draw([
      { name: "Joeun Yook*", member_id: "joeun-yook" },
      { name: "Bernhard Schölkopf", email: "bs@tue.mpg.de" },
      { name: "Somebody Unknown" },
    ]);
    const rows = [...container.querySelectorAll(".coauthor")].map((row) => row.textContent ?? "");
    expect(rows[0]).toContain("lab member");
    expect(rows[1]).toContain("bs@tue.mpg.de");
    // The one row that needs a human decision says so instead of being guessed at.
    expect(rows[2]).toContain("not linked");
    expect(container.querySelector(".coauthor--unlinked")).not.toBeNull();
  });

  it("adds a lab member from the roster, in print order", () => {
    const { container, changes } = draw([{ name: "Joeun Yook", member_id: "joeun-yook" }]);
    const picker = container.querySelector("adminbot-member-select") as HTMLElement & {
      onPick: (id: string) => void;
    };
    picker.onPick("andrew-kim");
    expect(changes[0]).toEqual([
      { name: "Joeun Yook", member_id: "joeun-yook" },
      { name: "Andrew Kim", member_id: "andrew-kim" },
    ]);
  });

  it("does not offer somebody already on the paper", () => {
    const { container } = draw([{ name: "Joeun Yook", member_id: "joeun-yook" }]);
    const picker = container.querySelector("adminbot-member-select") as HTMLElement & {
      options: Array<{ id: string }>;
    };
    expect(picker.options.map((option) => option.id)).toEqual(["andrew-kim", "zhijing-jin"]);
  });

  it("adds an external by email, and refuses one without a usable address", () => {
    const blocked = draw([], { draft: { email: "not-an-address", name: "Bernhard" } });
    expect(
      blocked.container.querySelector<HTMLButtonElement>(
        '[data-testid="paper-coauthor-add-external-p1"]',
      )?.disabled,
    ).toBe(true);

    const ready = draw([{ name: "Joeun Yook", member_id: "joeun-yook" }], {
      draft: { email: " BS@tue.mpg.de ", name: "Bernhard Schölkopf" },
    });
    ready.container
      .querySelector<HTMLButtonElement>('[data-testid="paper-coauthor-add-external-p1"]')
      ?.click();
    expect(ready.changes[0]?.[1]).toEqual({
      name: "Bernhard Schölkopf",
      email: "bs@tue.mpg.de",
    });
    // The boxes are cleared for the next one.
    expect(ready.drafts).toContainEqual({ email: "", name: "", twitter: "" });
  });

  it("takes an X handle alongside the address, and stores it bare", () => {
    // Stored without the "@" so a renderer adds the sigil once, rather than every caller guessing
    // whether the stored value already carries one.
    const { container, changes } = draw([], {
      draft: { email: "bs@tue.mpg.de", name: "Bernhard", twitter: "@bschoelkopf" },
    });
    container
      .querySelector<HTMLButtonElement>('[data-testid="paper-coauthor-add-external-p1"]')
      ?.click();
    expect(changes[0]?.[0]).toEqual({
      name: "Bernhard",
      email: "bs@tue.mpg.de",
      twitter: "bschoelkopf",
    });
  });

  it("refuses text that is not a handle rather than storing an unusable tag", () => {
    const { container } = draw([], {
      draft: { email: "bs@tue.mpg.de", name: "Bernhard", twitter: "ask at the workshop" },
    });
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="paper-coauthor-add-external-p1"]')
        ?.disabled,
    ).toBe(true);
    expect(
      container.querySelector('[data-testid="paper-coauthor-external-twitter-error-p1"]'),
    ).not.toBeNull();
  });

  it("leaves the handle optional -- a coauthor who is not on X still goes on the paper", () => {
    const { container } = draw([], { draft: { email: "bs@tue.mpg.de", name: "Bernhard" } });
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="paper-coauthor-add-external-p1"]')
        ?.disabled,
    ).toBe(false);
  });

  it("shows the handle on the row it belongs to", () => {
    const { container } = draw([
      { name: "Bernhard Schölkopf", email: "bs@tue.mpg.de", twitter: "bschoelkopf" },
      { name: "Joeun Yook", member_id: "joeun-yook" },
    ]);
    expect(container.querySelector('[data-testid="paper-coauthor-x-p1-0"]')?.textContent).toContain(
      "@bschoelkopf",
    );
    // Nothing on the member row: their handle is on their profile, not on this paper.
    expect(container.querySelector('[data-testid="paper-coauthor-x-p1-1"]')).toBeNull();
  });

  it("falls back to the address when no name was typed", () => {
    const { container, changes } = draw([], { draft: { email: "bs@tue.mpg.de", name: "  " } });
    container
      .querySelector<HTMLButtonElement>('[data-testid="paper-coauthor-add-external-p1"]')
      ?.click();
    expect(changes[0]).toEqual([{ name: "bs@tue.mpg.de", email: "bs@tue.mpg.de" }]);
  });

  it("reorders and removes, because print order is load-bearing", () => {
    const links: PaperAuthorLink[] = [
      { name: "Joeun Yook", member_id: "joeun-yook" },
      { name: "Andrew Kim", member_id: "andrew-kim" },
    ];
    const moved = draw(links);
    moved.container
      .querySelector<HTMLButtonElement>('[data-testid="paper-coauthor-down-p1-0"]')
      ?.click();
    expect(moved.changes[0]?.map((link) => link.member_id)).toEqual(["andrew-kim", "joeun-yook"]);

    const removed = draw(links);
    removed.container
      .querySelector<HTMLButtonElement>('[data-testid="paper-coauthor-remove-p1-0"]')
      ?.click();
    expect(removed.changes[0]?.map((link) => link.member_id)).toEqual(["andrew-kim"]);

    // The ends of the list cannot walk off it.
    expect(
      moved.container.querySelector<HTMLButtonElement>('[data-testid="paper-coauthor-up-p1-0"]')
        ?.disabled,
    ).toBe(true);
  });

  it("gives a reader who may not edit the list no controls at all", () => {
    const { container } = draw([{ name: "Joeun Yook", member_id: "joeun-yook" }], {
      readOnly: true,
    });
    expect(container.querySelector(".coauthor__actions")).toBeNull();
    expect(container.querySelector("adminbot-member-select")).toBeNull();
    expect(container.querySelector('[data-testid="paper-coauthor-add-external-p1"]')).toBeNull();
    // The list itself is still readable -- that is the point of it.
    expect(container.textContent).toContain("Joeun Yook");
  });
});
