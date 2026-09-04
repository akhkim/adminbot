import { describe, expect, it } from "vitest";
import type { AdminBotPaperRecord } from "./controllers/admin.ts";
import {
  applyModelSuggestions,
  buildImportPlan,
  createCandidates,
  matchColumns,
  matchRows,
  parseSheet,
  planImport,
} from "./paper-import.ts";

function paper(over: Partial<AdminBotPaperRecord> = {}): AdminBotPaperRecord {
  return {
    id: "p1",
    title: "Causal Abstraction for Agents",
    authors: ["Ada Lovelace"],
    current_step: "overleaf_writing",
    artifacts: {},
    ...over,
  } as unknown as AdminBotPaperRecord;
}

describe("parseSheet", () => {
  it("reads what a spreadsheet puts on the clipboard", () => {
    const sheet = parseSheet("Title\tarXiv\nOne\thttps://arxiv.org/abs/1\nTwo\t");
    expect(sheet.headers).toEqual(["Title", "arXiv"]);
    expect(sheet.rows).toEqual([
      ["One", "https://arxiv.org/abs/1"],
      ["Two", ""],
    ]);
  });

  it("reads a CSV export, keeping a comma that is inside a title", () => {
    const sheet = parseSheet('Title,Venue\n"Agents, revisited",ICLR 2027');
    expect(sheet.headers).toEqual(["Title", "Venue"]);
    expect(sheet.rows).toEqual([["Agents, revisited", "ICLR 2027"]]);
  });

  // Tabs win when both are present: a title with a comma in it must not split a tabbed paste.
  it("prefers tabs over commas when the block has both", () => {
    const sheet = parseSheet("Title\tVenue\nAgents, revisited\tICLR 2027");
    expect(sheet.rows).toEqual([["Agents, revisited", "ICLR 2027"]]);
  });

  it("survives CRLF and blank lines", () => {
    expect(parseSheet("Title\r\nOne\r\n\r\n").rows).toEqual([["One"]]);
  });

  // The header row says how wide the sheet is. Deciding from the whole block let a comma inside a
  // value split a one-column sheet in two, and the row then matched no paper.
  it("keeps a one-column sheet whole when a value contains a comma", () => {
    expect(parseSheet("Title\ncausal abstraction, for agents").rows).toEqual([
      ["causal abstraction, for agents"],
    ]);
  });
});

describe("matching their columns to ours", () => {
  it("matches a header the lab actually spells", () => {
    const sheet = parseSheet("Paper\tShort name\tOverleaf (edit)\tStart date\nx\ty\tz\tw");
    const matched = matchColumns(sheet);
    expect(matched.map((column) => column.target)).toEqual([
      "title",
      "alias",
      "overleaf_edit_url",
      "started_on",
    ]);
    expect(matched.every((column) => column.how === "header")).toBe(true);
  });

  // The column a header cannot place, and the values can.
  it("claims a column by the shape of its values when the header says nothing", () => {
    const sheet = parseSheet(
      "Title\tCol B\nOne\thttps://arxiv.org/abs/2401.1\nTwo\thttps://arxiv.org/abs/2401.2",
    );
    const matched = matchColumns(sheet);
    expect(matched[1]).toMatchObject({ target: "arxiv_url", how: "value" });
  });

  it("leaves a column nothing claims visible rather than dropping it", () => {
    const sheet = parseSheet("Title\tWho is chasing this\nOne\tZhijing");
    const matched = matchColumns(sheet);
    expect(matched[1]?.target).toBeUndefined();
    expect(matched[1]?.how).toBe("none");
    const plan = buildImportPlan(sheet, matched, matchRows(sheet, matched, []));
    expect(plan.unmappedHeaders).toEqual(["Who is chasing this"]);
  });

  it("gives one target to one source column", () => {
    const sheet = parseSheet("Title\tPaper title\nOne\tOne again");
    const matched = matchColumns(sheet);
    expect(matched[0]?.target).toBe("title");
    expect(matched[1]?.target).toBeUndefined();
  });

  // A read-only column cannot be filled, so it must never be an import target. The blocker log
  // is one: each entry carries an author and a timestamp, and an import that wrote it would
  // replace a history with a column of retyped titles.
  it("never maps onto a column the grid will not write", () => {
    const sheet = parseSheet("Open blockers\tX post drafted\nstuck\tyes");
    expect(matchColumns(sheet).map((column) => column.target)).toEqual([undefined, undefined]);
  });

  // The venue's answer is writable now, on the sheet as on the card, so a sheet of decisions
  // imports rather than being silently ignored.
  it("maps a column of decisions, which the grid now writes", () => {
    const sheet = parseSheet("Venue decision\naccept");
    expect(matchColumns(sheet)[0]?.target).toBe("venue_decision");
  });
});

describe("the model's suggestions", () => {
  const sheet = parseSheet("Title\tThe latex one\nOne\thttps://www.overleaf.com/project/abc");

  it("fills a gap the local pass left", () => {
    const local = matchColumns(sheet);
    const leftover = local[1];
    if (leftover) {
      delete leftover.target;
      leftover.how = "none";
    }
    const merged = applyModelSuggestions(local, {
      "The latex one": "overleaf_edit_url",
    });
    expect(merged[1]).toMatchObject({
      target: "overleaf_edit_url",
      how: "model",
    });
  });

  it("does not overrule a column the header or the values already settled", () => {
    const local = matchColumns(parseSheet("Title\tarXiv\nOne\thttps://arxiv.org/abs/1"));
    const merged = applyModelSuggestions(local, {
      Title: "topic",
      arXiv: "poster_url",
    });
    expect(merged.map((column) => column.target)).toEqual(["title", "arxiv_url"]);
  });

  it("ignores a suggestion that is not a writable column", () => {
    const local = matchColumns(parseSheet("Title\tMystery\nOne\tx"));
    const merged = applyModelSuggestions(local, { Mystery: "blocker_log" });
    expect(merged[1]?.target).toBeUndefined();
    expect(applyModelSuggestions(local, { Mystery: "not_a_column" })[1]?.target).toBeUndefined();
  });
});

describe("matching their rows to our papers", () => {
  const papers = [
    paper({ id: "p1", title: "Causal Abstraction for Agents", alias: "cais" }),
    paper({
      id: "p2",
      title: "Something Else",
      artifacts: { overleaf_edit_url: "https://www.overleaf.com/project/xyz" },
    }),
  ];

  it("matches on the title, through punctuation and case", () => {
    const sheet = parseSheet("Title\ncausal abstraction, for agents");
    const matched = matchRows(sheet, matchColumns(sheet), papers);
    expect(matched[0]).toMatchObject({ paperId: "p1", how: "title" });
  });

  it("falls back to the short name", () => {
    const sheet = parseSheet("Title\tShort name\nRenamed entirely\tCAIS");
    const matched = matchRows(sheet, matchColumns(sheet), papers);
    expect(matched[0]).toMatchObject({ paperId: "p1", how: "alias" });
  });

  // The case a title match misses: the paper was renamed after the sheet was last touched.
  it("falls back to a link already on the record", () => {
    const sheet = parseSheet(
      "Title\tOverleaf (edit)\nA New Name\thttps://www.overleaf.com/project/xyz",
    );
    const matched = matchRows(sheet, matchColumns(sheet), papers);
    expect(matched[0]).toMatchObject({ paperId: "p2", how: "link" });
  });

  it("gives one paper to one row, rather than letting the second overwrite the first", () => {
    const sheet = parseSheet("Title\nCausal Abstraction for Agents\nCausal abstraction for agents");
    const matched = matchRows(sheet, matchColumns(sheet), papers);
    expect(matched[0]?.paperId).toBe("p1");
    expect(matched[1]?.paperId).toBeUndefined();
    expect(matched[1]?.how).toBe("none");
  });
});

describe("the plan", () => {
  const papers = [paper({ id: "p1", title: "Causal Abstraction for Agents" })];

  it("fills the cells it can, in the shape the grid's own edits map holds", () => {
    const plan = planImport(
      "Title\tarXiv\tVenue\nCausal Abstraction for Agents\thttps://arxiv.org/abs/2401.1\tICLR 2027",
      papers,
    );
    expect(plan.fills.get("p1")).toEqual(
      new Map([
        ["title", "Causal Abstraction for Agents"],
        ["arxiv_url", "https://arxiv.org/abs/2401.1"],
        ["venue", "ICLR 2027"],
      ]),
    );
  });

  // One bad cell in row 34 must not make the sheet unimportable, nor ride in unnoticed.
  it("leaves a cell the grid would mark bad, and says which", () => {
    const plan = planImport("Title\tarXiv\nCausal Abstraction for Agents\tnot-a-link", papers);
    expect(plan.fills.get("p1")?.has("arxiv_url")).toBe(false);
    expect(plan.rejected).toEqual([
      // The registry's own words: an evidence-backed link column is checked with the same
      // function the service will apply, so the cell says what the service would have said.
      {
        rowIndex: 0,
        column: "arxiv_url",
        value: "not-a-link",
        reason: "that is not a URL",
      },
    ]);
  });

  // Their blank is not an instruction to clear ours.
  it("does not clear a field just because their sheet left it empty", () => {
    const plan = planImport("Title\tVenue\nCausal Abstraction for Agents\t", papers);
    expect(plan.fills.get("p1")?.has("venue")).toBe(false);
  });

  it("never fills a row that matched no paper", () => {
    const plan = planImport("Title\tVenue\nA Paper We Do Not Have\tICLR 2027", papers);
    expect(plan.fills.size).toBe(0);
    expect(plan.unmatched).toEqual([0]);
  });
});

describe("the create step", () => {
  const papers = [paper({ id: "p1", title: "Causal Abstraction for Agents" })];

  it("offers the unmatched rows, and says what each is missing", () => {
    const text =
      "Title\tShort name\tStart date\tVenue\n" +
      "Brand New Paper\tbnp\t2026-03-01\tICLR 2027\n" +
      "Half A Row\t\t\tNeurIPS";
    const sheet = parseSheet(text);
    const plan = planImport(text, papers);
    const candidates = createCandidates(sheet, plan);

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      rowIndex: 0,
      values: {
        title: "Brand New Paper",
        alias: "bnp",
        started_on: "2026-03-01",
      },
      missing: [],
    });
    // Reported rather than guessed: an invented alias names somebody's Slack channel.
    expect(candidates[1]?.missing).toEqual(["alias", "started_on"]);
  });

  it("drops a value the grid would refuse rather than carrying it into a new paper", () => {
    const text = "Title\tShort name\tStart date\nNew One\tBob's Project\t2026-03-01";
    const plan = planImport(text, papers);
    const [candidate] = createCandidates(parseSheet(text), plan);
    expect(candidate?.values.alias).toBeUndefined();
    expect(candidate?.missing).toContain("alias");
  });
});
