// The daily directory sync reads Slack's zone for every linked active member, including the ones
// who never signed in to AdminBot -- the only map signal those members ever produce. Synthetic data.
import { describe, expect, it, vi } from "vitest";
import { AdminBotService } from "./service.js";

describe("Slack zone for members who never use AdminBot", () => {
  it("stamps slack_tz on a linked member with no sign-in, and the map places them by it", async () => {
    const service = new AdminBotService();
    const saved = service.upsertLabMember({
      id: "never-signed-in",
      name: "Quiet Member",
      slack_user_id: "U-QUIET",
    });
    expect(saved.ok).toBe(true);
    const fetchSlackTimezones = vi.fn(
      async (ids: string[]) => new Map<string, string | null>(ids.map((id) => [id, "Asia/Tokyo"])),
    );
    const result = await service.refreshMemberDirectoryFromSlack({ fetchSlackTimezones }, "cron");
    expect(result.ok).toBe(true);
    expect(fetchSlackTimezones).toHaveBeenCalledWith(["U-QUIET"]);

    const coverage = service.memberMapCoverage();
    expect(coverage.ok && coverage.payload.counts.timezone).toBe(1);
    expect(coverage.ok && coverage.payload.stale[0]).toMatchObject({
      member_id: "never-signed-in",
      placed_by: "timezone",
      place_label: "Tokyo",
    });
    expect(coverage.ok && coverage.payload.stale[0]?.last_seen_at).toBeUndefined();
  });
});
