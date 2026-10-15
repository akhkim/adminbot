import { describe, expect, it, vi } from "vitest";
import { createGoogleSlidesExecutor } from "../connectors/google-slides.js";
import type { AdminBotLabMember } from "../contracts/actions.js";
import type { GoogleSlidesClient, SlidesPresentation } from "../contracts/google-slides.js";
import {
  applyRequests,
  legacyFace,
  syntheticDeck,
  syntheticMember,
} from "../workflows/slides/face-layout.test-helpers.js";
import { AdminBotService } from "./service.js";
import { affectsWorkingGroupsSlide } from "./service.slides-working-groups.js";

const TITLE = "Scaling to 50-100 Technical Members";

function lab(options: { debounceMs?: number } = {}) {
  const founders = Array.from({ length: 5 }, (_, index) => syntheticMember(`mi${index}`, "multiagent"));
  let deck: SlidesPresentation = syntheticDeck({
    multiagent: founders.map((member, index) => legacyFace(member, index)),
  });
  const client: GoogleSlidesClient = {
    getPresentation: vi.fn(async () => deck),
    batchUpdate: vi.fn(async (_id, requests) => {
      deck = applyRequests(deck, requests);
      return {};
    }),
  };
  const service = new AdminBotService(undefined, {
    executor: createGoogleSlidesExecutor({
      client,
      write: true,
      faces: {
        fetchAvatar: async () => new Uint8Array([1]),
        render: async () => Buffer.from("png"),
        host: {
          publish: async (_png, name) => ({ url: `https://drive.example/${name}`, release: async () => {} }),
        },
      },
    }),
    slidesWorkingGroups: {
      presentationId: "deck_synthetic",
      slideTitle: TITLE,
      client,
      debounceMs: options.debounceMs ?? 60_000,
    },
  });
  for (const member of founders) {
    service.upsertLabMember(member as never);
  }
  return { service, client, founders, deck: () => deck };
}

function add(service: AdminBotService, member: AdminBotLabMember) {
  const result = service.upsertLabMember(member as never);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
}

describe("slides working-groups sync", () => {
  it("answers 503 when no deck is configured, and schedules nothing on a save", async () => {
    const service = new AdminBotService();
    expect(await service.previewSlidesWorkingGroups()).toMatchObject({ ok: false, status: 503 });
    expect(await service.syncSlidesWorkingGroups("admin")).toMatchObject({ ok: false, status: 503 });
    add(service, syntheticMember("x", "interp"));
    expect(service.listPending()).toMatchObject({ payload: { proposals: [] } });
  });

  it("previews without proposing", async () => {
    const { service } = lab();
    add(service, syntheticMember("mi9", "multiagent", { name: "Nia New" }));
    const preview = await service.previewSlidesWorkingGroups();
    expect(preview.ok && preview.payload.plan.groups.find((group) => group.key === "multiagent")).toMatchObject({
      status: "update",
      added: ["Nia New"],
    });
    expect(service.listPending()).toMatchObject({ payload: { proposals: [] } });
  });

  it("proposes one T2 admin-approved change, reuses it, and supersedes it when the roster moves on", async () => {
    const { service, client, deck } = lab();
    add(service, syntheticMember("mi9", "multiagent"));
    const first = await service.syncSlidesWorkingGroups("admin", "schedule");
    if (!first.ok) {
      throw new Error(first.error.message);
    }
    expect(first.payload.proposal).toMatchObject({
      type: "slides.sync_working_groups",
      risk_tier: "T2",
      status: "pending",
      approval_requirement: { requires_approval: true, approver_roles: ["admin"] },
    });
    const again = await service.syncSlidesWorkingGroups("admin", "schedule");
    expect(again.ok && again.payload).toMatchObject({ reused: true, superseded: [] });
    expect(again.ok && again.payload.proposal?.id).toBe(first.payload.proposal!.id);

    add(service, syntheticMember("mi8", "multiagent"));
    const third = await service.syncSlidesWorkingGroups("admin", "schedule");
    expect(third.ok && third.payload.superseded).toEqual([first.payload.proposal!.id]);

    // Nothing is written until an admin approves, then the exact requests are sent.
    const proposal = third.ok ? third.payload.proposal! : undefined;
    expect(await service.execute(proposal!.id, { dry_run: false })).toMatchObject({ ok: false });
    expect(client.batchUpdate).not.toHaveBeenCalled();
    service.approve(proposal!.id, {
      payload_hash: proposal!.payload_hash,
      approver_id: "admin",
      approver_role: "admin",
    });
    expect(await service.execute(proposal!.id, { dry_run: false })).toMatchObject({ ok: true });
    expect(client.batchUpdate).toHaveBeenCalledTimes(1);
    expect(
      deck().slides![1]!.pageElements!.filter((element) => element.objectId.startsWith("adminbot_face_multiagent_")),
    ).toHaveLength(2);

    // With the slide now matching the roster, the next weekly run proposes nothing.
    const settled = await service.syncSlidesWorkingGroups("admin", "schedule");
    expect(settled.ok && settled.payload).toMatchObject({ changed: false });
    expect(settled.ok && settled.payload.proposal).toBeUndefined();
  });

  it("debounces a burst of member saves into one background plan", async () => {
    const { service, client } = lab({ debounceMs: 5 });
    vi.mocked(client.getPresentation).mockClear();
    add(service, syntheticMember("mi7", "multiagent"));
    add(service, syntheticMember("mi8", "multiagent"));
    add(service, syntheticMember("mi9", "multiagent"));
    await vi.waitFor(() => {
      expect(
        service.listAuditEvents().filter((event) => event.type === "slides.working_groups_planned"),
      ).toHaveLength(1);
    });
    expect(client.getPresentation).toHaveBeenCalledTimes(1);
    const planned = service.listAuditEvents().find((event) => event.type === "slides.working_groups_planned")!;
    expect(planned.details).toMatchObject({ trigger: "member_change", changed: true });
  });

  it("audits a failed read instead of throwing at the caller", async () => {
    const { service, client } = lab();
    vi.mocked(client.getPresentation).mockRejectedValueOnce(new Error("Google Slides request failed (403)"));
    expect(await service.syncSlidesWorkingGroups("admin")).toMatchObject({ ok: false, status: 502 });
    expect(service.listAuditEvents().some((event) => event.type === "slides.working_groups_failed")).toBe(true);
  });
});

describe("affectsWorkingGroupsSlide", () => {
  it("fires on new eligible members and theme, eligibility or photo changes only", () => {
    const member = syntheticMember("a", "interp");
    expect(affectsWorkingGroupsSlide(undefined, member)).toBe(true);
    expect(affectsWorkingGroupsSlide(undefined, { ...member, member_type: "coauthor-minor" })).toBe(false);
    expect(affectsWorkingGroupsSlide(member, { ...member, timezone: "UTC" } as never)).toBe(false);
    expect(affectsWorkingGroupsSlide(member, { ...member, research_topics: ["Causal inference"] })).toBe(true);
    expect(affectsWorkingGroupsSlide(member, { ...member, avatar_url: "https://example.com/new.png" })).toBe(true);
    expect(affectsWorkingGroupsSlide(member, { ...member, status: "alumni" })).toBe(true);
    // Power Concentration has no theme id; it is matched on keywords, so those count too.
    expect(affectsWorkingGroupsSlide(member, { ...member, projects: ["AI and democracy"] } as never)).toBe(true);
  });
});
