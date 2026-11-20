/* @vitest-environment jsdom */

// The research-outreach section. The cases are about the two ways it could mislead: offering to
// mail a draft that is not finished, and writing to a sheet people keep without showing what.
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperOutreach, PaperOutreachDraft } from "../api/paper-admin.ts";
import {
  acceptanceRowsAsTsv,
  renderPaperOutreach,
  type PaperOutreachProps,
} from "./paper-outreach.ts";

function draft(overrides: Partial<PaperOutreachDraft> = {}): PaperOutreachDraft {
  return {
    key: "vector",
    institute: "Vector Institute",
    label: "Faculty newsletter",
    stage: "acceptance",
    channel: "email",
    cadence: "Biweekly",
    paper_ids: ["p1"],
    subject: "ICLR 2027 acceptances",
    body: "1. Judging the Judges",
    needs_edit: false,
    notes: [],
    to: ["newsletter@example.org"],
    cc: ["editor@example.org"],
    sendable: true,
    ...overrides,
  };
}

function outreach(overrides: Partial<PaperOutreach> = {}): PaperOutreach {
  return {
    venue: "ICLR 2027",
    paper_count: 1,
    papers: [{ id: "p1", title: "Judging the Judges", summary: "" }],
    drafts: [draft()],
    acceptance_rows: [
      {
        paper_id: "p1",
        year: "2027",
        title: "Judging the Judges",
        conference: "ICLR 2027",
        authors: "Ada Lovelace, Alan Turing",
        paper_link: "https://arxiv.org/abs/2606.00001",
      },
    ],
    acceptance_sheet_configured: true,
    ...overrides,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

function draw(overrides: Partial<PaperOutreachProps> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const props: PaperOutreachProps = {
    data: outreach(),
    loading: false,
    busy: null,
    error: null,
    notice: null,
    sent: [],
    sheet: null,
    onSend: () => undefined,
    onSaveSummary: () => undefined,
    onCheckSheet: () => undefined,
    onAddToSheet: () => undefined,
    ...overrides,
  };
  render(renderPaperOutreach(props), container);
  return container;
}

const find = (container: Element, id: string) =>
  container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("renderPaperOutreach", () => {
  it("draws nothing until something has been read", () => {
    expect(find(draw({ data: null }), "outreach")).toBeNull();
  });

  it("shows who a finished draft goes to and sends it by its outlet key", () => {
    const onSend = vi.fn();
    const container = draw({ onSend });
    const row = find(container, "outreach-outlet-vector");
    expect(row?.textContent).toContain("newsletter@example.org");
    expect(row?.textContent).toContain("editor@example.org");
    find(container, "outreach-send-vector")?.click();
    expect(onSend).toHaveBeenCalledWith("vector");
  });

  it("offers no send for a draft a person still has to finish", () => {
    const container = draw({
      data: outreach({ drafts: [draft({ needs_edit: true, sendable: false })] }),
    });
    expect(find(container, "outreach-send-vector")).toBeNull();
    // Still copyable: the draft is the starting point for the person who finishes it.
    expect(find(container, "outreach-copy-vector")).not.toBeNull();
    expect(find(container, "outreach-outlet-vector")?.textContent).toContain("needs a summary");
  });

  it("asks once for each paper's sentence and saves it by paper", () => {
    const onSaveSummary = vi.fn();
    const container = draw({ onSaveSummary });
    expect(find(container, "outreach-summaries-state")?.textContent).toContain("1");
    const input = find(container, "outreach-summary-p1") as HTMLInputElement;
    input.value = "Judges disagree more than they admit.";
    input.dispatchEvent(new Event("change"));
    expect(onSaveSummary).toHaveBeenCalledWith("p1", "Judges disagree more than they admit.");
  });

  it("says so when every paper has its sentence", () => {
    const container = draw({
      data: outreach({ papers: [{ id: "p1", title: "Judging the Judges", summary: "Done." }] }),
    });
    expect((find(container, "outreach-summary-p1") as HTMLInputElement).value).toBe("Done.");
    expect(find(container, "outreach-summaries-state")?.textContent).toContain("Every paper");
  });

  it("offers neither a send nor a copy for an outlet no paper matches", () => {
    const container = draw({
      data: outreach({ drafts: [draft({ paper_ids: [], sendable: false })] }),
    });
    expect(find(container, "outreach-send-vector")).toBeNull();
    expect(find(container, "outreach-copy-vector")).toBeNull();
    expect(find(container, "outreach-outlet-vector")?.textContent).toContain("no matching papers");
  });

  it("links a form outlet to its form rather than mailing it", () => {
    const container = draw({
      data: outreach({
        drafts: [
          draft({
            key: "cls",
            channel: "form",
            to: [],
            cc: [],
            sendable: false,
            form_url: "https://example.org/form",
          }),
        ],
      }),
    });
    expect(find(container, "outreach-send-cls")).toBeNull();
    const link = find(container, "outreach-outlet-cls")?.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.org/form");
    expect(link?.getAttribute("rel")).toContain("noopener");
  });

  it("offers an outline to copy and never to send", () => {
    const container = draw({
      data: outreach({
        drafts: [
          draft({
            key: "featured_article",
            stage: "camera_ready",
            channel: "doc",
            needs_edit: true,
            to: [],
            cc: [],
            sendable: false,
          }),
        ],
      }),
    });
    expect(find(container, "outreach-send-featured_article")).toBeNull();
    expect(find(container, "outreach-copy-featured_article")).not.toBeNull();
    const row = find(container, "outreach-outlet-featured_article");
    expect(row?.textContent).toContain("an outline to write");
    // No recipients line at all: an outline is not addressed to anybody.
    expect(row?.textContent).not.toContain("nobody to send");
  });

  it("puts the submissions record first, under its own moment", () => {
    const container = draw({
      data: outreach({
        drafts: [draft(), draft({ key: "mpi_submissions", stage: "submission" })],
      }),
    });
    const headings = [...container.querySelectorAll(".adminbot-outreach__heading")].map((node) =>
      node.textContent?.trim(),
    );
    expect(headings.indexOf("After the submission deadline")).toBeGreaterThanOrEqual(0);
    expect(headings.indexOf("After the submission deadline")).toBeLessThan(
      headings.indexOf("On acceptance"),
    );
  });

  it("marks an outlet already mailed, so a second send is a visible choice", () => {
    const container = draw({ sent: ["vector"] });
    expect(find(container, "outreach-send-vector")?.textContent).toContain("Send again");
  });

  it("holds every other send while one is in flight", () => {
    const container = draw({
      busy: "dcs",
      data: outreach({ drafts: [draft(), draft({ key: "dcs" })] }),
    });
    expect(find(container, "outreach-send-vector")?.hasAttribute("disabled")).toBe(true);
  });

  it("says when the recipients are misconfigured", () => {
    const container = draw({
      data: outreach({
        config_error: "outlets must be an object",
        drafts: [draft({ sendable: false })],
      }),
    });
    expect(find(container, "outreach-config-error")?.textContent).toContain(
      "outlets must be an object",
    );
  });

  it("compares with the sheet before it offers to add anything", () => {
    const onCheckSheet = vi.fn();
    const onAddToSheet = vi.fn();
    const before = draw({ onCheckSheet, onAddToSheet });
    expect(find(before, "outreach-sheet-add")).toBeNull();
    find(before, "outreach-sheet-check")?.click();
    expect(onCheckSheet).toHaveBeenCalledOnce();

    const data = outreach();
    const after = draw({
      onAddToSheet,
      sheet: { dry_run: true, total: 1, missing: data.acceptance_rows, added: 0 },
    });
    // The rows about to be written are named before the button that writes them.
    expect(find(after, "outreach-sheet-result")?.textContent).toContain("Judging the Judges");
    find(after, "outreach-sheet-add")?.click();
    expect(onAddToSheet).toHaveBeenCalledOnce();
  });

  it("says the sheet is up to date rather than offering an empty write", () => {
    const container = draw({ sheet: { dry_run: true, total: 1, missing: [], added: 0 } });
    expect(find(container, "outreach-sheet-result")?.textContent).toContain("already holds all 1");
    expect(find(container, "outreach-sheet-add")).toBeNull();
  });

  it("points to the exported tab when the server does not write the sheet", () => {
    const container = draw({ data: outreach({ acceptance_sheet_configured: false }) });
    expect(find(container, "outreach-sheet-check")).toBeNull();
    // The explanation rides on the link's tooltip, not as a paragraph (ui/DESIGN.md rule 3).
    expect(container.textContent).not.toContain("every six hours");
    expect(find(container, "outreach-sheet-open")?.getAttribute("title")).toContain(
      "every six hours",
    );
    expect(find(container, "outreach-sheet-open")?.getAttribute("href")).toContain(
      "gid=1274660812",
    );
  });

  it("still shows the acceptance rows when no venue is chosen", () => {
    const container = draw({
      data: outreach({ venue: undefined, drafts: [], papers: [], paper_count: 0 }),
    });
    expect(find(container, "outreach-sheet-rows")?.textContent).toContain("Judging the Judges");
    expect(container.querySelector('[data-testid^="outreach-outlet-"]')).toBeNull();
    expect(container.textContent).not.toContain("Compose from a venue");
  });

  it("hides the row list and Copy rows when there are no accepted papers", () => {
    const container = draw({
      data: outreach({ venue: undefined, drafts: [], papers: [], acceptance_rows: [] }),
    });
    expect(find(container, "outreach-sheet-rows")).toBeNull();
    expect(container.textContent).not.toContain("Copy rows");
    expect(find(container, "outreach-sheet-open")).not.toBeNull();
  });
});

describe("acceptanceRowsAsTsv", () => {
  it("leads with the tab's header and keeps a tab in a title from splitting the row", () => {
    const [first] = outreach().acceptance_rows;
    const rows = first ? [Object.assign(first, { title: "A\tB" })] : [];
    const [header, line] = acceptanceRowsAsTsv(rows).split("\n");
    expect(header).toBe("year\tpaper title\tconference\tauthors\tpaper_link");
    expect(line?.split("\t")).toHaveLength(5);
  });
});
