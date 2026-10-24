import { describe, expect, it, vi } from "vitest";
import { selectCampaignRecipients } from "../workflows/nudges/campaign.js";
import {
  hasPersonalWebsite,
  PERSONAL_WEBSITE_NUDGE,
} from "../workflows/nudges/personal-website.js";
import { AdminBotService, AdminBotMemoryStore } from "./service.js";

function setup() {
  let now = new Date("2030-01-01T10:00:00Z");
  const execute = vi.fn(async () => ({ handled: true }));
  const store = new AdminBotMemoryStore();
  const service = new AdminBotService(store, {
    executor: { execute },
    now: () => now,
    nudgeCampaignPaceMs: 0,
  });
  service.upsertLabMember({
    id: "ada",
    name: "Ada Example",
    status: "active",
    privilege_level: "member",
    receives_nudges: true,
    slack_user_id: "U-SYNTHETIC",
  });
  return {
    service,
    store,
    execute,
    advance: (days: number) => {
      now = new Date(now.getTime() + days * 86400000);
    },
  };
}

describe("weekly personal webpage reminder", () => {
  it("recognizes real URL-shaped values, including imported bare domains, but not placeholders", () => {
    for (const value of ["https://ada.example/research", "ada.github.io", "www.ada.example"])
      expect(hasPersonalWebsite(value)).toBe(true);
    for (const value of [undefined, "", " ", "WIP", "coming soon", "javascript:alert(1)"])
      expect(hasPersonalWebsite(value)).toBe(false);
  });
  it("respects contact opt-outs, STOP, alumni, external status and PI exclusions", () => {
    const { store } = setup();
    const base = store.getLabMember("ada")!;
    const members = [
      base,
      { ...base, id: "off", receives_nudges: false },
      { ...base, id: "stopped", slack_stop_at: "2029-12-31" },
      { ...base, id: "alum", member_type: "alumni" },
      { ...base, id: "external", status: "external" },
      { ...base, id: "pi" },
      { ...base, id: "no-slack", slack_user_id: undefined },
      { ...base, id: "has-site", personal_website: "https://example.test" },
    ];
    const result = selectCampaignRecipients(PERSONAL_WEBSITE_NUDGE, {
      members,
      ledger: [],
      headProfessorMemberId: "pi",
      now: new Date(),
    });
    expect(result.recipients.map((x) => x.member.id)).toEqual(["ada"]);
  });
  it("previews without sending; records actual delivery, waits seven days and stops after a website is saved", async () => {
    const { service, execute, advance } = setup();
    expect(await service.sendPersonalWebsiteReminders("admin", { dry_run: true })).toMatchObject({
      count: 1,
      dry_run: true,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(await service.sendPersonalWebsiteReminders("admin", { dry_run: false })).toMatchObject({
      refused: "confirm_required",
    });
    expect(
      await service.sendPersonalWebsiteReminders("scheduler", { dry_run: false, scheduled: true }),
    ).toMatchObject({ sent: 1, failed: [] });
    expect(execute).toHaveBeenCalledTimes(1);
    advance(6.99);
    expect(await service.sendPersonalWebsiteReminders("admin", { dry_run: true })).toMatchObject({
      count: 0,
    });
    advance(0.01);
    expect(await service.sendPersonalWebsiteReminders("admin", { dry_run: true })).toMatchObject({
      count: 1,
    });
    service.upsertLabMember({ id: "ada", personal_website: "https://ada.example" });
    expect(await service.sendPersonalWebsiteReminders("admin", { dry_run: true })).toMatchObject({
      count: 0,
    });
  });
  it("does not stamp failed delivery and shares overlapping live passes", async () => {
    const { service, execute } = setup();
    execute.mockResolvedValueOnce({ handled: false });
    expect(
      await service.sendPersonalWebsiteReminders("cron", { dry_run: false, scheduled: true }),
    ).toMatchObject({ sent: 0 });
    expect(await service.sendPersonalWebsiteReminders("admin", { dry_run: true })).toMatchObject({
      count: 1,
    });
    await Promise.all([
      service.sendPersonalWebsiteReminders("cron", { dry_run: false, scheduled: true }),
      service.sendPersonalWebsiteReminders("cron", { dry_run: false, scheduled: true }),
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("keeps the website out of the more frequent generic profile reminder", async () => {
    const { service, execute } = setup();
    vi.spyOn(service, "membersNeedingProfileAttention").mockReturnValue([
      {
        id: "ada",
        name: "Ada",
        missing_fields: ["personal_website"],
        timeline_short: false,
        timeline_entries: 3,
      },
    ]);
    expect(
      await service.sendMandatoryFieldsReminders("cron", {
        include: "profile",
        excludePersonalWebsite: true,
      }),
    ).toMatchObject({ payload: { created: [] } });
    expect(execute).not.toHaveBeenCalled();
  });
});
