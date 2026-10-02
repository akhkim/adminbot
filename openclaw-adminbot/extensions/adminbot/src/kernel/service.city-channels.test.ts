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
        receives_nudges: true,
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
          receives_nudges: true,
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
        receives_nudges: true,
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

  it("offers the new city's channel after a member moves, and never the old one again", async () => {
    const { service, sent } = serviceWithTorontoFour();
    unwrap(await service.syncCityChannels("cron"));
    expect(memberById(service, "m0")?.city_channels_invited).toEqual(["group-toronto"]);

    // m0 moves to Zürich, and three more people are already there, so the city clears the
    // four-member threshold.
    unwrap(service.upsertLabMember({ receives_nudges: true, id: "m0", current_city: "Zurich" } as never));
    for (let index = 0; index < 3; index += 1) {
      unwrap(
        service.upsertLabMember({
          receives_nudges: true,
          id: `z${index}`,
          name: `Zurich ${index}`,
          privilege_level: "member",
          status: "active",
          slack_user_id: `U-Z${index}`,
          current_city: "Zurich",
        } as never),
      );
    }
    const moved = unwrap(await service.syncCityChannels("cron"));

    // The move is the whole point: the old global stamp used to suppress this invite entirely.
    expect(moved.invited).toContainEqual({ member_id: "m0", channel: "group-zurich" });
    expect(memberById(service, "m0")?.city_channels_invited).toEqual([
      "group-toronto",
      "group-zurich",
    ]);

    // Moving away removes nobody: this sweep only ever adds.
    expect(sent.some((entry) => entry.type.includes("remove") || entry.type.includes("kick"))).toBe(
      false,
    );

    // Back to Toronto later: already offered that channel once, so it is not offered again.
    unwrap(service.upsertLabMember({ receives_nudges: true, id: "m0", current_city: "Toronto" } as never));
    const back = unwrap(await service.syncCityChannels("cron"));
    expect(back.invited.some((entry) => entry.member_id === "m0")).toBe(false);
  });

  it("reads a legacy stamp as covering the channel the member is in now", async () => {
    // Members stamped before per-channel tracking carry no list. Re-inviting them to the channel
    // they are already in (or deliberately left) is the one outcome this must never produce.
    const { service } = serviceWithTorontoFour();
    unwrap(await service.syncCityChannels("cron"));
    const legacy = memberById(service, "m1")!;
    unwrap(
      service.upsertLabMember({
        receives_nudges: true,
        ...legacy,
        city_channels_invited: undefined,
        city_channel_invited_at: "2026-01-01T00:00:00.000Z",
      } as never),
    );
    const again = unwrap(await service.syncCityChannels("cron"));
    expect(again.invited.some((entry) => entry.member_id === "m1")).toBe(false);
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
