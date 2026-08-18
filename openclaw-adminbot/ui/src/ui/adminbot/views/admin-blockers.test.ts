/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import {
  type AdminBotPaperRecord,
  createEmptyAdminBotDashboardData,
} from "../controllers/admin.ts";
import {
  blockerLog,
  fileBlockerInput,
  editBlockerInput,
  openBlocker,
  openBlockers,
  openEntries,
  recoverBlockerInput,
  resolveBlockerInput,
  resolvedBlockers,
} from "../blockers.ts";
import { renderAdminBot, type AdminBotProps, type BlockerSort } from "./admin.ts";

function entry(over: Partial<Record<string, string>> = {}) {
  return { stage: "submission", title: "t", note: "n", by: "Pat", at: "2026-08-01T00:00:00Z", ...over };
}

function paper(log: unknown[], id = "p1", title = "Paper"): AdminBotPaperRecord {
  return {
    id,
    title,
    authors: ["Pat Doe"],
    current_step: "submission",
    artifacts: { blocker_log: JSON.stringify(log) },
  } as AdminBotPaperRecord;
}

const papers: AdminBotPaperRecord[] = [
  paper(
    [entry({ stage: "submission", title: "OpenReview rejects the PDF", by: "Pat Doe", at: "2026-08-01T00:00:00Z" })],
    "late",
    "Zebra Effects",
  ),
  paper(
    [
      entry({ stage: "brainstorm", title: "Waiting on compute quota", by: "Sam Lee", at: "2026-08-14T00:00:00Z" }),
      entry({ title: "Old thing", at: "2026-07-01T00:00:00Z", resolved_at: "2026-07-05T00:00:00Z", resolved_by: "Zhijing" }),
    ],
    "early",
    "Alpha Priors",
  ),
];

function props(over: Partial<AdminBotProps> = {}): AdminBotProps {
  return {
    panel: "papers",
    mode: "admin",
    connected: true,
    loading: false,
    error: null,
    data: { ...createEmptyAdminBotDashboardData(), papers, loadedAt: Date.now() },
    busyActionId: null,
    notice: null,
    onRefresh: () => undefined,
    onApprove: () => undefined,
    onRemove: () => undefined,
    onExecute: () => undefined,
    onSaveMember: () => undefined,
    onSaveOwnProfile: () => undefined,
    onSavePaper: () => undefined,
    onDeletePaper: () => undefined,
    onSaveSettings: () => undefined,
    onSaveSensitiveInfo: () => undefined,
    ...over,
  } as AdminBotProps;
}

function draw(over: Partial<AdminBotProps> = {}): HTMLElement {
  const host = document.createElement("div");
  render(renderAdminBot(props(over)), host);
  return host;
}

function titles(host: HTMLElement, scope = "[data-testid=blockers-open]"): string[] {
  return [...host.querySelectorAll(`${scope} .blocker__title`)].map((n) => n.textContent?.trim() ?? "");
}

describe("blocker log", () => {
  it("keeps a resolved blocker instead of deleting it", () => {
    const filed = paper([entry({ at: "2026-08-01T00:00:00Z" })]);
    const input = resolveBlockerInput(filed, "2026-08-01T00:00:00Z", "Zhijing");
    const log = JSON.parse(input.blockerLog ?? "[]") as { resolved_by?: string }[];
    expect(log).toHaveLength(1);
    expect(log[0]?.resolved_by).toBe("Zhijing");
  });

  it("stops counting a resolved blocker as open", () => {
    const resolved = paper([entry({ resolved_at: "2026-08-05T00:00:00Z" })]);
    expect(openBlocker(resolved)).toBeUndefined();
    expect(resolvedBlockers([resolved])).toHaveLength(1);
  });

  it("recovers a misclick back to open, leaving no trace", () => {
    const resolved = paper([entry({ at: "2026-08-01T00:00:00Z", resolved_at: "x", resolved_by: "Zhijing" })]);
    const input = recoverBlockerInput(resolved, "2026-08-01T00:00:00Z");
    const log = JSON.parse(input.blockerLog ?? "[]") as Record<string, unknown>[];
    expect(log[0]).not.toHaveProperty("resolved_at");
    expect(log[0]).not.toHaveProperty("resolved_by");
    expect(log).toHaveLength(1);
  });

  it("makes a recovered blocker open again, so the member sees it as before", () => {
    const solved = paper([entry({ at: "2026-08-01T00:00:00Z", resolved_at: "2026-08-05T00:00:00Z" })]);
    expect(openBlocker(solved)).toBeUndefined();
    const back = paper(
      JSON.parse(recoverBlockerInput(solved, "2026-08-01T00:00:00Z").blockerLog ?? "[]"),
    );
    expect(openBlocker(back)?.title).toBe("t");
    expect(resolvedBlockers([back])).toEqual([]);
  });

  it("keeps several blockers open on one paper", () => {
    const one = paper([entry({ title: "first", at: "2026-08-01T00:00:00Z" })]);
    const input = fileBlockerInput(one, { stage: "submission", title: "second", note: "", by: "Pat" });
    const log = JSON.parse(input.blockerLog ?? "[]") as { title: string }[];
    expect(log.map((e) => e.title)).toEqual(["second", "first"]);
    expect(openEntries(paper(log))).toHaveLength(2);
  });

  it("edits one blocker without touching its siblings", () => {
    const two = paper([
      entry({ title: "keep", at: "2026-08-02T00:00:00Z" }),
      entry({ title: "change", at: "2026-08-01T00:00:00Z" }),
    ]);
    const input = editBlockerInput(two, "2026-08-01T00:00:00Z", {
      stage: "drive_pdf",
      title: "changed",
      note: "new detail",
    });
    const log = JSON.parse(input.blockerLog ?? "[]") as { title: string; stage: string }[];
    expect(log.map((e) => e.title)).toEqual(["keep", "changed"]);
    expect(log[1]?.stage).toBe("drive_pdf");
  });

  it("resolves one of several, leaving the rest open", () => {
    const two = paper([
      entry({ title: "a", at: "2026-08-02T00:00:00Z" }),
      entry({ title: "b", at: "2026-08-01T00:00:00Z" }),
    ]);
    const input = resolveBlockerInput(two, "2026-08-01T00:00:00Z", "Zhijing");
    const log = JSON.parse(input.blockerLog ?? "[]") as unknown[];
    expect(openEntries(paper(log)).map((e) => e.title)).toEqual(["a"]);
  });

  it("never trims an open blocker, however long the history", () => {
    // 60 resolved entries is past the cap; the open one must still survive the write.
    const history = Array.from({ length: 60 }, (_, i) =>
      entry({ title: `old ${i}`, at: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`, resolved_at: "2026-02-01T00:00:00Z" }),
    );
    const loaded = paper([entry({ title: "still stuck", at: "2026-08-01T00:00:00Z" }), ...history]);
    const input = editBlockerInput(loaded, "2026-08-01T00:00:00Z", {
      stage: "submission",
      title: "still stuck",
      note: "",
    });
    const log = JSON.parse(input.blockerLog ?? "[]") as { title: string; resolved_at?: string }[];
    expect(log.filter((e) => !e.resolved_at).map((e) => e.title)).toEqual(["still stuck"]);
    expect(log.filter((e) => e.resolved_at).length).toBe(30);
  });

  it("carries 300 open blockers across the pipeline, because the cap is per paper", () => {
    const many = Array.from({ length: 300 }, (_, i) =>
      paper([entry({ title: `blocker ${i}`, at: `2026-08-01T00:00:00Z` })], `p${i}`, `Paper ${i}`),
    );
    expect(openBlockers(many)).toHaveLength(300);
  });

  it("records who reported it", () => {
    const input = fileBlockerInput(paper([]), { stage: "submission", title: "x", note: "", by: "Sam Lee" });
    const log = JSON.parse(input.blockerLog ?? "[]") as { by: string }[];
    expect(log[0]?.by).toBe("Sam Lee");
  });

  it("adds alongside what is already there, open or resolved", () => {
    const existing = paper([
      entry({ title: "current", at: "2026-08-02T00:00:00Z" }),
      entry({ title: "done", at: "2026-07-01T00:00:00Z", resolved_at: "2026-07-02T00:00:00Z" }),
    ]);
    const input = fileBlockerInput(existing, { stage: "submission", title: "new", note: "", by: "Pat" });
    const log = JSON.parse(input.blockerLog ?? "[]") as { title: string }[];
    expect(log.map((e) => e.title)).toEqual(["new", "current", "done"]);
  });

  it("still reads blockers filed before the log existed", () => {
    const legacy = {
      id: "p",
      title: "P",
      authors: [],
      current_step: "submission",
      artifacts: { blocker_title: "old style", blocker_stage: "submission" },
    } as unknown as AdminBotPaperRecord;
    expect(blockerLog(legacy)).toHaveLength(1);
    expect(openBlocker(legacy)?.title).toBe("old style");
  });

  it("survives a corrupt log rather than blanking the page", () => {
    const bad = { id: "p", title: "P", authors: [], current_step: "submission", artifacts: { blocker_log: "{no" } } as unknown as AdminBotPaperRecord;
    expect(blockerLog(bad)).toEqual([]);
  });
});

describe("reported blockers view", () => {
  it("lists only open blockers in the main list", () => {
    expect(titles(draw())).toEqual(["Waiting on compute quota", "OpenReview rejects the PDF"]);
  });

  it("puts resolved ones in history with a count", () => {
    const host = draw();
    expect(host.querySelector(".blockers__history-summary")?.textContent?.trim()).toBe("History (1)");
  });

  it("offers a reply box on open rows only", () => {
    const host = draw();
    expect(host.querySelectorAll("[data-testid^=blocker-reply-]").length).toBe(2);
    expect(host.querySelectorAll("[data-testid^=blocker-send-]").length).toBe(2);
  });

  it("offers Mark as solved on open rows and Recover on history rows", () => {
    const host = draw();
    expect(host.querySelectorAll("[data-testid^=blocker-solve-]").length).toBe(2);
    expect(host.querySelectorAll("[data-testid^=blocker-recover-]").length).toBe(1);
  });

  it("names the reporter", () => {
    const host = draw();
    const names = [...host.querySelectorAll(".blocker__by")].map((n) => n.textContent?.trim());
    expect(names).toContain("Sam Lee");
    expect(names).toContain("Pat Doe");
  });

  it("sorts by stage, age and paper", () => {
    expect(titles(draw({ blockerSort: "stage" }))[0]).toBe("Waiting on compute quota");
    expect(titles(draw({ blockerSort: "age" }))[0]).toBe("OpenReview rejects the PDF");
    expect(titles(draw({ blockerSort: "paper" }))[0]).toBe("Waiting on compute quota");
  });

  it("reports every sort key the buttons offer", () => {
    const seen: BlockerSort[] = [];
    const host = draw({ onBlockerSort: (key) => seen.push(key) });
    for (const b of host.querySelectorAll<HTMLButtonElement>("[data-testid^=blocker-sort-]")) b.click();
    expect(seen).toEqual(["stage", "age", "paper"]);
  });
});
