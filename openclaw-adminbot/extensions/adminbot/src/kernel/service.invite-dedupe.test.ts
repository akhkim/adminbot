// Recurring channel sweeps re-file every invite they still think is owed (issue #536). A failed
// invite stays approved, so these pin that a rerun reuses it rather than adding another copy.
import { describe, expect, it } from "vitest";
import { AdminBotMemoryStore, AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

const CHANNELS = ["discussion-causal-inference", "meeting-causal-inference"];

function labWithMajor(options: { inviteFails: boolean }) {
  const store = new AdminBotMemoryStore();
  const attempts: string[] = [];
  const service = new AdminBotService(store, {
    executor: {
      execute: async (proposal) => {
        attempts.push(proposal.id);
        if (options.inviteFails) {
          // Transient on purpose: a channel or member failure would pause the invite instead.
          throw new Error("Slack request timed out");
        }
        return { handled: true };
      },
    },
  });
  unwrap(
    service.upsertLabMember({
      id: "major",
      name: "Major",
      receives_nudges: true,
      privilege_level: "external_collaborator",
      collaborator_subgroup: "coauthor_major",
      slack_user_id: "U-major",
      research_topics: ["causal inference"],
    } as never),
  );
  return { service, store, attempts };
}

describe("slack invite dedupe across sweeps", () => {
  it("reuses an outstanding failed invite instead of filing a copy each run", async () => {
    const { service, store, attempts } = labWithMajor({ inviteFails: true });
    await service.syncTopicChannels("cron", CHANNELS);
    await service.syncTopicChannels("cron", CHANNELS);
    await service.syncTopicChannels("cron", CHANNELS);

    const invites = store.listProposalsByType("slack.invite_to_channel");
    expect(invites).toHaveLength(2);
    expect(invites.every((proposal) => proposal.status === "approved")).toBe(true);
    // Still retried every run, just against the one ledger row per channel and person.
    expect(attempts).toHaveLength(6);
    expect(new Set(attempts)).toEqual(new Set(invites.map((proposal) => proposal.id)));
  });

  it("hands back the outstanding invite when the same payload is proposed again", () => {
    const { service } = labWithMajor({ inviteFails: true });
    const invite = {
      type: "slack.invite_to_channel" as const,
      summary: "Add Major to #discussion-causal-inference",
      target: { service: "slack", channel: "slack", target: "discussion-causal-inference" },
      proposed_payload: { channel: "discussion-causal-inference", user_id: "U-major" },
    };
    const first = unwrap(service.createProposal(invite));
    const second = unwrap(service.createProposal({ ...invite, summary: "Same invite, new sweep" }));
    expect(second.id).toBe(first.id);
    // A different person is a different effect.
    const other = unwrap(
      service.createProposal({
        ...invite,
        proposed_payload: { channel: "discussion-causal-inference", user_id: "U-other" },
      }),
    );
    expect(other.id).not.toBe(first.id);
  });

  // Proposals filed before every action carried a payload have none to compare. Hashing that
  // absence threw, and one such approved invite crashed every sweep that filed a new invite.
  it("files a new invite past an old outstanding one that has no payload at all", () => {
    const { service, store } = labWithMajor({ inviteFails: true });
    const invite = {
      type: "slack.invite_to_channel" as const,
      summary: "Add Major to #discussion-causal-inference",
      target: { service: "slack", channel: "slack", target: "discussion-causal-inference" },
      proposed_payload: { channel: "discussion-causal-inference", user_id: "U-major" },
    };
    const template = unwrap(service.createProposal({ ...invite, summary: "template" }));
    const legacy = { ...template, id: "act_legacy", status: "approved" as const };
    delete (legacy as { proposed_payload?: unknown }).proposed_payload;
    store.saveProposal(legacy);
    store.saveProposal({ ...template, status: "rejected" });

    const filed = unwrap(service.createProposal(invite));
    expect(filed.id).not.toBe("act_legacy");
    expect(filed.proposed_payload).toEqual(invite.proposed_payload);
    // The ordinary dedupe still holds for the new invite.
    expect(unwrap(service.createProposal(invite)).id).toBe(filed.id);
  });

  it("files a new invite once the earlier one has executed", async () => {
    const { service, store } = labWithMajor({ inviteFails: false });
    await service.syncTopicChannels("cron", CHANNELS);
    await service.syncTopicChannels("cron", CHANNELS);

    const invites = store.listProposalsByType("slack.invite_to_channel");
    // Settled invites are history, not outstanding work, so they do not suppress a later one.
    expect(invites).toHaveLength(4);
    expect(invites.every((proposal) => proposal.status === "executed")).toBe(true);
  });
});
