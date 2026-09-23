/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmptyLabPapersState,
  createEmptyVenuePapersState,
  type AdminBotLabPaperHit,
  type AdminBotLabPapersState,
  type AdminBotVenuePaperHit,
  type AdminBotVenuePapersState,
} from "../controllers/admin.ts";
import {
  renderConferencePapers,
  type ConferencePapersProps,
  type ConferencePapersTab,
} from "./conference-papers.ts";
import type { LabPapersProps } from "./lab-papers.ts";

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

describe("the lab half of Find Interesting Papers", () => {
  function labState(overrides: Partial<AdminBotLabPapersState> = {}): AdminBotLabPapersState {
    return { ...createEmptyLabPapersState(), query: "causality", ...overrides };
  }

  function labHit(overrides: Partial<AdminBotLabPaperHit> = {}): AdminBotLabPaperHit {
    const best = {
      segment_id: "s1",
      label: "Part 1.1.1 Evaluation hacking",
      score: 0.44,
      margin: 0.2,
      band: "core",
    };
    return {
      paper_id: "eval-awareness",
      title: "Eval Awareness",
      score: 0.44,
      margin: 0.2,
      band: "core",
      segments: [best],
      best_segment: best,
      matched_terms: ["causality"],
      evidence: "title_only",
      ...overrides,
    };
  }

  function drawLab(
    lab: Partial<AdminBotLabPapersState> = {},
    handlers: Partial<LabPapersProps> = {},
    tab: ConferencePapersTab = "lab",
  ) {
    const container = document.createElement("div");
    document.body.append(container);
    const labProps: LabPapersProps = {
      state: labState(lab),
      onQueryChange: vi.fn(),
      onSearch: vi.fn(),
      onToggleSections: vi.fn(),
      ...handlers,
    };
    const props: ConferencePapersProps = {
      state: { ...createEmptyVenuePapersState(), sources: SOURCES },
      onVenueChange: vi.fn(),
      onInterestsChange: vi.fn(),
      onSearch: vi.fn(),
      onToggleAbstract: vi.fn(),
      lab: labProps,
      tab,
      onTabChange: vi.fn(),
    };
    render(renderConferencePapers(props), container);
    return { container, props, labProps };
  }

  it("shows no tab bar for a visitor, who has no lab half at all", () => {
    // The route behind it returns the lab's own paper titles and is gated server-side, so a tab
    // that could only 401 is a worse answer than no tab.
    const { container } = draw();
    expect(container.querySelector('[data-testid="conference-papers-tabs"]')).toBeNull();
    expect(container.querySelector('[data-testid="conference-papers-venue"]')).not.toBeNull();
  });

  it("offers both halves to a member, and opens on the conference one", () => {
    const { container } = drawLab({}, {}, "conference");
    expect(container.querySelector('[data-testid="conference-papers-tabs"]')).not.toBeNull();
    // The conference search is still what the page is for; ours is the second answer.
    expect(container.querySelector('[data-testid="conference-papers-venue"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lab-papers-query"]')).toBeNull();
  });

  it("swaps the panel when the lab tab is selected", () => {
    const { container } = drawLab();
    expect(container.querySelector('[data-testid="lab-papers-query"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="conference-papers-venue"]')).toBeNull();
  });

  it("asks the host to change tab rather than deciding itself", () => {
    const { container, props } = drawLab({}, {}, "conference");
    container
      .querySelector<HTMLButtonElement>('[data-testid="conference-papers-tab-lab"]')!
      .click();
    expect(props.onTabChange).toHaveBeenCalledWith("lab");
  });

  it("will not rank an empty query", () => {
    const { container } = drawLab({ query: "   " });
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="lab-papers-search"]')!.disabled,
    ).toBe(true);
  });

  it("names the section a paper answers and how thin the record was", () => {
    const { container } = drawLab({
      result: {
        query_kind: "proposal",
        segment_count: 16,
        scored: 94,
        matches: [labHit()],
        off_topic: [],
        nothing_relevant: false,
        uncovered_segments: [],
      },
    });
    const row = container.querySelector('[data-testid="lab-paper-eval-awareness"]');
    expect(text(row)).toContain("Eval Awareness");
    expect(text(row)).toContain("Part 1.1.1 Evaluation hacking");
    // The caveat that matters: a core band read off eight words is not a fact.
    expect(text(row)).toContain("from the title alone");
    expect(text(row)).toContain("Core");
  });

  it("lists the sections nothing covers, which is the half a paper list cannot answer", () => {
    const { container } = drawLab({
      result: {
        query_kind: "proposal",
        segment_count: 16,
        scored: 94,
        matches: [labHit()],
        off_topic: [],
        nothing_relevant: false,
        uncovered_segments: [{ id: "p1.2.4", label: "Part 1.2.4 Regulation", text: "…" }],
      },
    });
    const gaps = container.querySelector('[data-testid="lab-papers-gaps"]');
    expect(text(gaps)).toContain("1 sections nothing covers");
    expect(text(gaps)).toContain("Part 1.2.4 Regulation");
  });

  it("does not offer a gap list for a plain keyword search", () => {
    // "Which sections are uncovered" is meaningless when the query had no sections.
    const { container } = drawLab({
      result: {
        query_kind: "keywords",
        segment_count: 1,
        scored: 94,
        matches: [labHit()],
        off_topic: [],
        nothing_relevant: false,
        uncovered_segments: [{ id: "q", label: "causality", text: "causality" }],
      },
    });
    expect(container.querySelector('[data-testid="lab-papers-gaps"]')).toBeNull();
  });

  it("says an empty result is a fact about the lab, not a failed search", () => {
    const { container } = drawLab({
      result: {
        query_kind: "keywords",
        segment_count: 1,
        scored: 94,
        matches: [],
        off_topic: [],
        nothing_relevant: true,
        uncovered_segments: [],
      },
    });
    expect(text(container.querySelector('[data-testid="lab-papers-none"]'))).toContain(
      "Nothing of ours is about this",
    );
  });

  it("carries the service's own error sentence", () => {
    const { container } = drawLab({ error: "could not reach the embedding model" });
    expect(text(container.querySelector('[data-testid="lab-papers-error"]'))).toContain(
      "could not reach the embedding model",
    );
  });
});
