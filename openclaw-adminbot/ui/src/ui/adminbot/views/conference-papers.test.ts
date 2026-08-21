/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmptyVenuePapersState,
  type AdminBotVenuePaperHit,
  type AdminBotVenuePapersState,
} from "../controllers/admin.ts";
import { renderConferencePapers, type ConferencePapersProps } from "./conference-papers.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

// Rendered text with runs of whitespace collapsed: lit templates are wrapped by the formatter, so
// a phrase that reads as one line in the source can arrive with a newline in the middle of it.
function text(node: Element | null): string {
  return (node?.textContent ?? "").replace(/\s+/gu, " ").trim();
}

const SOURCES = [
  { venue_id: "ICLR.cc/2025/Conference", label: "ICLR 2025", paper_count: 3704 },
  { venue_id: "NeurIPS.cc/2025/Conference", label: "NeurIPS 2025", paper_count: 0 },
];

function hit(overrides: Partial<AdminBotVenuePaperHit> = {}): AdminBotVenuePaperHit {
  return {
    paper: {
      id: "p1",
      title: "On Alignment",
      abstract: "We study alignment.",
      keywords: ["AI safety", "diffusion"],
      venue: "ICLR 2025 Oral",
      pdf_url: "https://openreview.net/pdf/p1.pdf",
      forum_url: "https://openreview.net/forum?id=p1",
    },
    score: 0.52,
    relevance: 1,
    matched_keywords: ["AI safety"],
    ...overrides,
  };
}

function draw(
  state: Partial<AdminBotVenuePapersState> = {},
  handlers: Partial<ConferencePapersProps> = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const props: ConferencePapersProps = {
    state: {
      ...createEmptyVenuePapersState(),
      sources: SOURCES,
      venueId: "ICLR.cc/2025/Conference",
      interests: "AI safety",
      ...state,
    },
    onVenueChange: vi.fn(),
    onInterestsChange: vi.fn(),
    onSearch: vi.fn(),
    onToggleAbstract: vi.fn(),
    ...handlers,
  };
  render(renderConferencePapers(props), container);
  return { container, props };
}

describe("renderConferencePapers", () => {
  it("offers every configured conference and preselects the chosen one", () => {
    const { container } = draw();
    const select = container.querySelector<HTMLSelectElement>(
      '[data-testid="conference-papers-venue"]',
    );
    expect([...(select?.options ?? [])].map((option) => option.textContent?.trim())).toEqual([
      "ICLR 2025",
      "NeurIPS 2025",
    ]);
    expect(select?.value).toBe("ICLR.cc/2025/Conference");
  });

  it("will not search with an empty interests box", () => {
    const empty = draw({ interests: "   " });
    expect(
      empty.container.querySelector<HTMLButtonElement>('[data-testid="conference-papers-search"]')
        ?.disabled,
    ).toBe(true);
    const filled = draw({ interests: "AI safety" });
    expect(
      filled.container.querySelector<HTMLButtonElement>('[data-testid="conference-papers-search"]')
        ?.disabled,
    ).toBe(false);
  });

  // A member who never filled in their profile needs to know why the box started empty.
  it("says where the interests came from, and that editing is per-search", () => {
    const fresh = draw({ interestsTouched: false });
    expect(fresh.container.textContent).toContain("From your profile's research topics");
    const edited = draw({ interestsTouched: true });
    expect(edited.container.textContent).toContain("your profile is unchanged");
  });

  // An unindexed conference and one with nothing for you need different reactions from the reader:
  // one is an admin task, the other is an answer.
  it("distinguishes a conference that has never been indexed", () => {
    const indexed = draw({ venueId: "ICLR.cc/2025/Conference" });
    expect(
      indexed.container.querySelector('[data-testid="conference-papers-unindexed"]'),
    ).toBeNull();
    // Whitespace-normalised, and not asserting the grouped digits: the formatter wraps this
    // template across lines, and toLocaleString follows the ambient locale.
    expect(text(indexed.container)).toMatch(/3.?704 accepted papers/u);

    const unindexed = draw({ venueId: "NeurIPS.cc/2025/Conference" });
    expect(
      unindexed.container.querySelector('[data-testid="conference-papers-unindexed"]'),
    ).not.toBeNull();
  });

  it("says so plainly when the conference holds nothing relevant", () => {
    const { container } = draw({
      result: {
        venue_id: "ICLR.cc/2025/Conference",
        label: "ICLR 2025",
        searched: 3704,
        results: [],
        nothing_relevant: true,
      },
    });
    const none = container.querySelector('[data-testid="conference-papers-none"]');
    expect(text(none)).toContain("Nothing close at ICLR 2025");
    expect(text(none)).toMatch(/3.?704/u);
  });

  describe("a result row", () => {
    function drawn(overrides: Partial<AdminBotVenuePaperHit> = {}, expanded: string[] = []) {
      return draw({
        expanded,
        result: {
          venue_id: "ICLR.cc/2025/Conference",
          label: "ICLR 2025",
          searched: 3704,
          results: [hit(overrides)],
          nothing_relevant: false,
        },
      });
    }

    it("links the paper and its PDF, and names the track", () => {
      const { container } = drawn();
      const row = container.querySelector('[data-testid="conference-paper-p1"]');
      expect(row?.querySelector("a")?.getAttribute("href")).toBe(
        "https://openreview.net/forum?id=p1",
      );
      expect(row?.textContent).toContain("ICLR 2025 Oral");
      expect(row?.innerHTML).toContain("https://openreview.net/pdf/p1.pdf");
    });

    // The row explaining itself: which of the member's own interests this paper echoes.
    it("marks only the keywords that echo the member's interests", () => {
      const { container } = drawn();
      const matched = container.querySelectorAll(".conference-papers__keyword--matched");
      expect([...matched].map((node) => node.textContent?.trim())).toEqual(["AI safety"]);
      expect(container.querySelectorAll(".conference-papers__keyword")).toHaveLength(2);
    });

    it("shows match strength as a percentage of the best match here", () => {
      const { container } = drawn({ relevance: 0.62 });
      expect(container.querySelector(".conference-papers__match-value")?.textContent?.trim()).toBe(
        "62%",
      );
    });

    it("keeps the abstract behind a toggle", () => {
      const closed = drawn();
      expect(closed.container.querySelector(".conference-papers__abstract")).toBeNull();
      const open = drawn({}, ["p1"]);
      expect(open.container.querySelector(".conference-papers__abstract")?.textContent).toContain(
        "We study alignment.",
      );
    });

    it("asks to toggle the abstract of the row that was pressed", () => {
      const onToggleAbstract = vi.fn();
      const container = draw(
        {
          result: {
            venue_id: "v",
            label: "ICLR 2025",
            searched: 1,
            results: [hit()],
            nothing_relevant: false,
          },
        },
        { onToggleAbstract },
      ).container;
      container
        .querySelector<HTMLButtonElement>('[data-testid="conference-paper-abstract-p1"]')
        ?.click();
      expect(onToggleAbstract).toHaveBeenCalledWith("p1");
    });
  });

  it("tells a member when no conferences have been set up at all", () => {
    const { container } = draw({ sources: [], venueId: "" });
    expect(
      container.querySelector('[data-testid="conference-papers-empty-sources"]'),
    ).not.toBeNull();
  });

  it("shows the service's own message when a search fails", () => {
    const { container } = draw({ error: "ICLR 2025 has not been indexed yet" });
    expect(
      container.querySelector('[data-testid="conference-papers-error"]')?.textContent,
    ).toContain("not been indexed");
  });
});
