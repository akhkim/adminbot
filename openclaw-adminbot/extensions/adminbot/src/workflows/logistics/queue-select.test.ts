import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOGISTICS_QUEUE_QUERY,
  logisticsQueueParams,
  readLogisticsQueueQuery,
  selectLogisticsQueue,
  type LogisticsQueueRow,
} from "./queue-select.js";

function row(id: string, patch: Partial<LogisticsQueueRow> = {}): LogisticsQueueRow {
  return {
    id,
    kind: "document_signature",
    member_name: id,
    status: "submitted",
    submitted_at: "2026-09-01T00:00:00.000Z",
    ...patch,
  };
}

describe("selectLogisticsQueue", () => {
  it("leads with open work and then the most recently touched", () => {
    const rows = [
      row("done", { status: "completed", updated_at: "2026-09-30T00:00:00.000Z" }),
      row("old", { updated_at: "2026-09-02T00:00:00.000Z" }),
      row("new", { updated_at: "2026-09-20T00:00:00.000Z" }),
    ];
    expect(selectLogisticsQueue(rows, DEFAULT_LOGISTICS_QUEUE_QUERY).map((r) => r.id)).toEqual([
      "new",
      "old",
      "done",
    ]);
    expect(
      selectLogisticsQueue(rows, { ...DEFAULT_LOGISTICS_QUEUE_QUERY, status: "open" }).map(
        (r) => r.id,
      ),
    ).toEqual(["new", "old"]);
  });

  it("keeps undated requests last in either deadline direction", () => {
    const rows = [
      row("none", { kind: "recommendation_letters", schools: [{ school: "A" }] }),
      row("dec", {
        kind: "recommendation_letters",
        schools: [{ school: "B", letter_deadline: "2026-12-01", deadline_timezone: "UTC" }],
      }),
      row("nov", {
        kind: "recommendation_letters",
        schools: [{ school: "C", letter_deadline: "2026-11-01", deadline_timezone: "UTC" }],
      }),
    ];
    const sorted = (dir: "asc" | "desc") =>
      selectLogisticsQueue(rows, { status: "all", sort: "deadline", dir }).map((r) => r.id);
    expect(sorted("asc")).toEqual(["nov", "dec", "none"]);
    expect(sorted("desc")).toEqual(["dec", "nov", "none"]);
  });
});

describe("selectLogisticsQueue search", () => {
  const rows = [
    row("jane-mit", {
      kind: "recommendation_letters",
      member_name: "Jane Example",
      schools: [{ school: "Example Institute", program: "PhD Robotics" }],
    }),
    row("jane-state", {
      kind: "recommendation_letters",
      member_name: "Jane Example",
      schools: [{ school: "Example State" }],
    }),
    row("jose", {
      kind: "recommendation_letters",
      member_name: "José Sample",
      schools: [{ school: "Example Institute" }],
    }),
  ];
  const search = (q: string) =>
    selectLogisticsQueue(rows, { ...DEFAULT_LOGISTICS_QUEUE_QUERY, q })
      .map((r) => r.id)
      .toSorted();

  it("finds a person's requests by name, accent-insensitively", () => {
    expect(search("jane")).toEqual(["jane-mit", "jane-state"]);
    expect(search("jose")).toEqual(["jose"]);
  });

  it("matches every word across the name, school and program", () => {
    expect(search("jane institute")).toEqual(["jane-mit"]);
    expect(search("robotics")).toEqual(["jane-mit"]);
    expect(search("jane harbor")).toEqual([]);
  });
});

describe("logistics queue query string", () => {
  it("round-trips what the browser sends", () => {
    const query = {
      status: "open",
      kind: "book_meeting",
      q: "mit",
      sort: "deadline",
      dir: "asc",
    } as const;
    expect(readLogisticsQueueQuery(logisticsQueueParams(query))).toEqual(query);
    expect(logisticsQueueParams(DEFAULT_LOGISTICS_QUEUE_QUERY).toString()).toBe("");
  });

  it("refuses values it does not know", () => {
    for (const raw of ["status=nope", "kind=nope", "sort=nope", "dir=up", `q=${"x".repeat(121)}`]) {
      expect(readLogisticsQueueQuery(new URLSearchParams(raw))).toBe("invalid");
    }
  });
});
