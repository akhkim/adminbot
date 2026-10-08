import { describe, expect, it } from "vitest";
import type { AdminBotMemberNotification } from "../../contracts/actions.js";
import { notificationFeed } from "./notification-feed.js";

function note(
  id: string,
  created_at: string,
  extra: Partial<AdminBotMemberNotification> = {},
): AdminBotMemberNotification {
  return {
    id,
    member_id: "ada",
    kind: "profile",
    title: id,
    body: "",
    created_at,
    ...extra,
  };
}

const READ = "2026-01-10T00:00:00.000Z";

describe("notificationFeed", () => {
  it("keeps each kind's newest card and every unread one, and drops read siblings", () => {
    const feed = notificationFeed([
      note("p3", "2026-01-03T00:00:00.000Z", { read_at: READ }),
      note("p2", "2026-01-02T00:00:00.000Z"),
      note("p1", "2026-01-01T00:00:00.000Z", { read_at: READ }),
      note("m1", "2026-01-01T00:00:00.000Z", { kind: "meeting", read_at: READ }),
    ]);
    expect(feed.map((item) => item.id)).toEqual(["p3", "p2", "m1"]);
  });

  it("keeps an older escalated card over a newer read send, as the dashboard does", () => {
    const feed = notificationFeed([
      note("new", "2026-01-03T00:00:00.000Z", { read_at: READ }),
      note("esc", "2026-01-01T00:00:00.000Z", { read_at: READ, escalated_at: READ }),
      note("imp", "2026-01-02T00:00:00.000Z", { read_at: READ, important: true }),
    ]);
    expect(feed.map((item) => item.id)).toEqual(["esc"]);
  });

  it("does not repeat the owner, who is always the caller", () => {
    const [item] = notificationFeed([note("p1", "2026-01-01T00:00:00.000Z")]);
    expect(item).not.toHaveProperty("member_id");
    expect(item).toMatchObject({ id: "p1", kind: "profile", title: "p1" });
  });
});
