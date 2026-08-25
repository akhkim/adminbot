// The sweep end to end: what reaches Slack, what the member is told, and what happens when it fails.
import { describe, expect, it } from "vitest";
import { AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

function serviceWithTorontoFour(options: { inviteFails?: boolean } = {}) {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const service = new AdminBotService(undefined, {
    executor: {
      execute: async (proposal) => {
        sent.push({
          type: proposal.type,
          payload: (proposal.proposed_payload ?? {}) as Record<string, unknown>,
        });
        if (proposal.type === "slack.invite_to_channel" && options.inviteFails) {
          throw new Error("Slack has no open channel named #group-toronto");
        }
        return { handled: true };
      },
    },
  });
  for (let index = 0; index < 4; index += 1) {
    unwrap(
      service.upsertLabMember({
        id: `m${index}`,
        name: `Member ${index}`,
        privilege_level: "member",
        status: "active",
        slack_user_id: `U-M${index}`,
        current_city: "Toronto",
      } as never),
    );
  }
  return { service, sent };
}

const memberById = (service: AdminBotService, id: string) =>
  unwrap(service.listLabMembers()).members.find((entry) => entry.id === id);

describe("syncCityChannels", () => {
  it("invites everyone once and tells them where they went", async () => {
    const { service, sent } = serviceWithTorontoFour();
    const result = unwrap(await service.syncCityChannels("cron"));

    expect(result.groups).toEqual([{ channel: "group-toronto", place: "Toronto", members: 4 }]);
    expect(result.invited).toHaveLength(4);
    const invites = sent.filter((entry) => entry.type === "slack.invite_to_channel");
    expect(invites).toHaveLength(4);
    expect(invites[0]?.payload).toEqual({ channel: "group-toronto", user_id: "U-M0" });

    // Told afterwards, on all three channels the nudge funnel uses.
    const notified = unwrap(service.listMemberNotifications("m0")).notifications;
    expect(notified[0]?.title).toBe("Added to #group-toronto");
    expect(notified[0]?.body).toContain("just leave the channel");
  });

  it("does nothing the second time, which is what lets somebody leave", async () => {
    const { service, sent } = serviceWithTorontoFour();
    unwrap(await service.syncCityChannels("cron"));
    const again = unwrap(await service.syncCityChannels("cron"));
    expect(again.invited).toEqual([]);
    expect(sent.filter((entry) => entry.type === "slack.invite_to_channel")).toHaveLength(4);
  });

  it("stamps even when Slack refuses, so a broken channel is not a nightly retry", async () => {
    const { service, sent } = serviceWithTorontoFour({ inviteFails: true });
    const result = unwrap(await service.syncCityChannels("cron"));
    expect(result.invited).toEqual([]);
    expect(result.skipped).toHaveLength(4);
    expect(memberById(service, "m0")?.city_channel_invited_at).toBeTruthy();

    const again = unwrap(await service.syncCityChannels("cron"));
    expect(again.skipped).toEqual([]);
    expect(sent.filter((entry) => entry.type === "slack.invite_to_channel")).toHaveLength(4);
  });

  it("waits until a city has four", async () => {
    const { service, sent } = serviceWithTorontoFour();
    // Three in a second city is not yet a channel.
    for (let index = 0; index < 3; index += 1) {
      unwrap(
        service.upsertLabMember({
          id: `z${index}`,
          name: `Zurich ${index}`,
          privilege_level: "member",
          status: "active",
          slack_user_id: `U-Z${index}`,
          current_city: "Zürich",
        } as never),
      );
    }
    unwrap(await service.syncCityChannels("cron"));
    expect(sent.some((entry) => entry.payload.channel === "group-zurich")).toBe(false);

    unwrap(
      service.upsertLabMember({
        id: "z3",
        name: "Zurich 3",
        privilege_level: "member",
        status: "active",
        slack_user_id: "U-Z3",
        current_city: "Zurich",
      } as never),
    );
    const result = unwrap(await service.syncCityChannels("cron"));
    expect(result.groups.map((group) => group.channel)).toContain("group-zurich");
    // The three who were already there are invited now, not skipped for having been counted before.
    expect(result.invited.filter((entry) => entry.channel === "group-zurich")).toHaveLength(4);
  });

  it("does not let a member clear their own stamp to be re-added", async () => {
    // The stamp is not on the self-editable whitelist, so a profile save cannot touch it.
    const { service } = serviceWithTorontoFour();
    unwrap(await service.syncCityChannels("cron"));
    expect(memberById(service, "m0")?.city_channel_invited_at).toBeTruthy();
    unwrap(
      service.updateOwnProfile("m0", {
        city_channel_invited_at: undefined,
        current_city: "Toronto",
      } as never),
    );
    // Still stamped: the field is not on the self-editable whitelist, so the save cannot reach it.
    expect(memberById(service, "m0")?.city_channel_invited_at).toBeTruthy();
  });
});
