import { describe, expect, it } from "vitest";
import type { AdminBotPaperRecord } from "./controllers/admin.ts";
import {
  agoLabel,
  alertText,
  notifyFields,
  nudgeAlerts,
  nudgeLog,
  nudgeSaveInput,
  papersWithUnread,
  seenSaveInput,
  unreadCount,
} from "./nudge-alerts.ts";

function paper(artifacts: Record<string, string>, id = "p1"): AdminBotPaperRecord {
  return {
    id,
    title: `Paper ${id}`,
    authors: ["Pat Doe"],
    current_step: "submission",
    artifacts,
  } as AdminBotPaperRecord;
}

function log(...entries: { at: string; node: string; by?: string }[]): string {
  return JSON.stringify(entries.map((entry) => ({ by: "Zhijing", ...entry })));
}

describe("nudge notifications", () => {
  it("is silent until an admin nudges", () => {
    expect(nudgeAlerts([paper({})])).toEqual([]);
  });

  it("keeps read notifications in the list instead of deleting them", () => {
    const alerts = nudgeAlerts([
      paper({
        nudge_log: log({ at: "2026-08-17T12:00:00Z", node: "Slides" }, { at: "2026-08-10T12:00:00Z", node: "Drive PDF" }),
        nudge_seen_at: "2026-08-11T00:00:00Z",
      }),
    ]);
    expect(alerts).toHaveLength(2);
    expect(alerts.map((alert) => alert.read)).toEqual([false, true]);
  });

  it("counts only the unread ones on the badge", () => {
    const papers = [
      paper({
        nudge_log: log({ at: "2026-08-17T12:00:00Z", node: "Slides" }, { at: "2026-08-10T12:00:00Z", node: "Drive PDF" }),
        nudge_seen_at: "2026-08-11T00:00:00Z",
      }),
    ];
    expect(unreadCount(papers)).toBe(1);
  });

  it("goes quiet without emptying once everything is read", () => {
    const papers = [
      paper({ nudge_log: log({ at: "2026-08-10T12:00:00Z", node: "Slides" }), nudge_seen_at: "2026-08-17T00:00:00Z" }),
    ];
    expect(unreadCount(papers)).toBe(0);
    expect(nudgeAlerts(papers)).toHaveLength(1);
  });

  it("appends rather than replacing, so history accumulates", () => {
    const existing = paper({ nudge_log: log({ at: "2026-08-10T12:00:00Z", node: "Drive PDF" }) });
    const input = nudgeSaveInput(existing, "Slides", "Zhijing", new Date("2026-08-17T12:00:00Z"));
    const written = JSON.parse(input.nudgeLog ?? "[]") as { node: string }[];
    expect(written.map((entry) => entry.node)).toEqual(["Slides", "Drive PDF"]);
  });

  it("caps read notifications but never drops an unread one", () => {
    // Everything stays unread here (no watermark), so nothing may be trimmed.
    let current = paper({});
    for (let i = 0; i < 40; i += 1) {
      const input = nudgeSaveInput(current, `n${i}`, "Zhijing", new Date(2026, 0, i + 1));
      current = paper({ nudge_log: input.nudgeLog ?? "" });
    }
    expect(nudgeLog(current)).toHaveLength(40);
    expect(unreadCount([current])).toBe(40);

    // Once read, the log trims back to the cap on the next write.
    const read = paper({ nudge_log: current.artifacts?.nudge_log ?? "", nudge_seen_at: "2027-01-01T00:00:00Z" });
    const after = nudgeSaveInput(read, "newest", "Zhijing", new Date(2027, 5, 1));
    const log = JSON.parse(after.nudgeLog ?? "[]") as unknown[];
    expect(log).toHaveLength(21);
  });

  it("still shows notifications written before the log existed", () => {
    const legacy = paper({ nudge_at: "2026-08-17T12:00:00Z", nudge_node: "Slides", nudge_by: "Zhijing" });
    expect(nudgeAlerts([legacy])).toHaveLength(1);
  });

  it("survives a corrupt log rather than blanking the page", () => {
    expect(nudgeLog(paper({ nudge_log: "{not json" }))).toEqual([]);
  });

  it("marks read by moving a watermark, touching no entry", () => {
    const input = seenSaveInput(paper({ nudge_log: log({ at: "2026-08-17T12:00:00Z", node: "Slides" }) }));
    expect(input.nudgeSeenAt).toBeTruthy();
    expect(input.nudgeLog).toBeUndefined();
  });

  it("marks all read by touching only papers that have something unread", () => {
    const papers = [
      paper({ nudge_log: log({ at: "2026-08-17T12:00:00Z", node: "a" }) }, "unread"),
      paper({ nudge_log: log({ at: "2026-08-01T12:00:00Z", node: "b" }), nudge_seen_at: "2026-08-02T00:00:00Z" }, "read"),
      paper({}, "none"),
    ];
    expect(papersWithUnread(papers).map((entry) => entry.id)).toEqual(["unread"]);
  });

  it("orders newest first across papers", () => {
    const alerts = nudgeAlerts([
      paper({ nudge_log: log({ at: "2026-08-10T00:00:00Z", node: "old" }) }, "a"),
      paper({ nudge_log: log({ at: "2026-08-17T00:00:00Z", node: "new" }) }, "b"),
    ]);
    expect(alerts.map((alert) => alert.node)).toEqual(["new", "old"]);
  });

  it("says what happened, per kind", () => {
    expect(alertText({ kind: "nudge", node: "Slides", by: "Z", at: "" })).toEqual({
      action: "asked you to update",
      subject: "Slides",
    });
    expect(alertText({ kind: "blocker_solved", node: "Quota", by: "Z", at: "" }).action).toBe(
      "reviewed and closed your blocker",
    );
    expect(alertText({ kind: "blocker_reopened", node: "Quota", by: "Z", at: "" }).action).toBe(
      "reopened your blocker",
    );
  });

  it("treats an entry written before kinds existed as a nudge", () => {
    expect(alertText({ node: "Slides", by: "Z", at: "" }).action).toBe("asked you to update");
  });

  it("notifies in the same write as the blocker change", () => {
    const fields = notifyFields(paper({}), "blocker_solved", "Quota exhausted", "Zhijing");
    const log = JSON.parse(fields.nudgeLog ?? "[]") as { kind: string; node: string }[];
    expect(log[0]).toMatchObject({ kind: "blocker_solved", node: "Quota exhausted" });
    // Only the log -- the caller supplies id/title/step from its own input.
    expect(Object.keys(fields)).toEqual(["nudgeLog"]);
  });

  it("reads age in the units a person would say it in", () => {
    const now = Date.parse("2026-08-17T12:00:00Z");
    expect(agoLabel("2026-08-17T11:59:30Z", now)).toBe("just now");
    expect(agoLabel("2026-08-17T11:30:00Z", now)).toBe("30m ago");
    expect(agoLabel("2026-08-17T09:00:00Z", now)).toBe("3h ago");
    expect(agoLabel("2026-08-14T12:00:00Z", now)).toBe("3d ago");
  });
});
