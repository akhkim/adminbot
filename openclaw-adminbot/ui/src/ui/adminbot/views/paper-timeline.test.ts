// The timeline is the card's claim about where a paper is, so what it must not do is claim
// progress nobody has evidence for -- and what it must do is move on its own when evidence lands.
import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { PaperSlotRow } from "../auth/session.ts";
import { buildPaperTimeline, renderPaperTimeline } from "./paper-timeline.ts";

function rows(settled: string[], extra: PaperSlotRow[] = []): PaperSlotRow[] {
  return [
    ...settled.map((slot) => ({ paper_id: "p1", slot, status: "provided" as const })),
    ...extra,
  ];
}

function lane(slots: PaperSlotRow[], branch: string, decision?: string) {
  const timeline = buildPaperTimeline(slots, decision ? { venue_decision: decision } : {});
  const found = timeline.find((entry) => entry.branch === branch);
  if (!found) {
    throw new Error(`no ${branch} lane`);
  }
  return found;
}

function nodeState(slots: PaperSlotRow[], branch: string, id: string) {
  return lane(slots, branch).nodes.find((node) => node.id === id)?.state;
}

describe("buildPaperTimeline", () => {
  it("draws the trunk and all four branches, not one path", () => {
    const branches = buildPaperTimeline(rows([])).map((entry) => entry.branch);
    expect(branches).toEqual(["core", "talk", "social", "archive", "venue"]);
  });

  it("captions every node, so a new slot cannot render a bare chart id", () => {
    for (const entry of buildPaperTimeline(rows([]))) {
      for (const node of entry.nodes) {
        expect(node.label).not.toBe(node.id);
      }
    }
  });

  it("opens every branch off the compiled PDF at once, not in sequence", () => {
    const before = rows(["project_folder", "overleaf_edit", "papermentor_review", "fixes_merged"]);
    for (const branch of ["talk", "archive", "venue"]) {
      expect(lane(before, branch).opensAfter).toBe("Paper PDF compiles cleanly");
    }
    const after = rows([
      ...["project_folder", "overleaf_edit", "papermentor_review", "fixes_merged"],
      "pdf_ready",
    ]);
    for (const branch of ["talk", "archive", "venue"]) {
      expect(lane(after, branch).opensAfter).toBeUndefined();
    }
    // Three lanes ready together is the fact the single track could not express.
    expect(nodeState(after, "talk", "SL")).toBe("ready");
    expect(nodeState(after, "archive", "DA")).toBe("ready");
    expect(nodeState(after, "venue", "SB")).toBe("ready");
  });

  it("closes a dot as soon as its evidence lands, with nothing else to press", () => {
    expect(nodeState(rows([]), "core", "BR")).toBe("ready");
    expect(nodeState(rows(["project_folder"]), "core", "BR")).toBe("done");
    // And the next one opens by itself.
    expect(nodeState(rows(["project_folder"]), "core", "OV")).toBe("ready");
  });

  it("holds a node open until every required slot on it is in", () => {
    const half = rows([
      "project_folder",
      "overleaf_edit",
      "papermentor_review",
      "fixes_merged",
      "pdf_ready",
      "submission",
    ]);
    const node = lane(half, "venue").nodes.find((entry) => entry.id === "SB");
    expect(node?.state).toBe("ready");
    expect(node?.provided).toBe(1);
    expect(node?.total).toBe(2);
  });

  it("ignores advisory slots, so a dot can actually fill", () => {
    // `poster_physical` is bookkeeping nobody is chased for; the poster node must not wait on it.
    const done = rows([
      "project_folder",
      "overleaf_edit",
      "papermentor_review",
      "fixes_merged",
      "pdf_ready",
      "slides",
      "poster",
    ]);
    expect(nodeState(done, "talk", "PO")).toBe("done");
  });

  it("flags a value the service rejected rather than counting it either way", () => {
    const invalid = rows([], [{ paper_id: "p1", slot: "project_folder", status: "invalid" }]);
    expect(nodeState(invalid, "core", "BR")).toBe("attention");
  });

  it("ends the venue lane on what the venue said", () => {
    const submitted = rows([
      "project_folder",
      "overleaf_edit",
      "papermentor_review",
      "fixes_merged",
      "pdf_ready",
      "submission",
      "submission_id",
    ]);
    expect(lane(submitted, "venue").nodes.at(-1)).toMatchObject({
      id: "DC",
      label: "Venue decision",
      state: "ready",
    });
    expect(lane(submitted, "venue", "accept").nodes.at(-1)).toMatchObject({
      label: "Accepted",
      state: "done",
    });
    // A rejection is answered, not achieved: it must not read as a finished green lane.
    const rejected = lane(submitted, "venue", "reject").nodes.at(-1);
    expect(rejected).toMatchObject({ label: "Rejected", state: "attention" });
    expect(lane(submitted, "venue", "reject").complete).toBe(false);
  });
});

describe("renderPaperTimeline", () => {
  function draw(slots: PaperSlotRow[], paper: { venue_decision?: string } = {}) {
    const container = document.createElement("div");
    document.body.append(container);
    render(renderPaperTimeline({ paperId: "p1", slots, paper }), container);
    return container;
  }

  it("renders nothing until the card's slots have arrived", () => {
    expect(draw([]).textContent?.trim()).toBe("");
  });

  it("marks the state on each dot so it can be read without colour", () => {
    const container = draw(rows(["project_folder"]));
    expect(
      container
        .querySelector('[data-testid="paper-timeline-node-p1-BR"]')
        ?.getAttribute("data-state"),
    ).toBe("done");
    expect(
      container
        .querySelector('[data-testid="paper-timeline-node-p1-OV"]')
        ?.getAttribute("data-state"),
    ).toBe("ready");
  });

  it("says what a shut branch is waiting for instead of showing dead dots", () => {
    const container = draw(rows(["project_folder"]));
    const talk = container.querySelector('[data-testid="paper-timeline-lane-p1-talk"]');
    expect(talk?.textContent).toContain("opens after Paper PDF compiles cleanly");
  });
});
