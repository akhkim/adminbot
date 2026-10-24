import { describe, expect, it, vi } from "vitest";
import type { AdminBotStoredProposal } from "../contracts/actions.js";
import type {
  AdminBotSlidesWorkingGroupsPayload,
  GoogleSlidesClient,
  SlidesFaceRequest,
  SlidesPresentation,
} from "../contracts/google-slides.js";
import { findSlideByTitle, measureWorkingGroupsSlide } from "../workflows/slides/face-layout-measure.js";
import { planWorkingGroupsSlide } from "../workflows/slides/face-layout-plan.js";
import { buildFaceRequests } from "../workflows/slides/face-layout-requests.js";
import {
  image,
  legacyFace,
  syntheticDeck,
  syntheticMember,
  taggedFace,
} from "../workflows/slides/face-layout.test-helpers.js";
import { faceOwnerTag, WORKING_GROUP_BOXES } from "../workflows/slides/working-groups.js";
import { createGoogleSlidesExecutor, slidesWorkingGroupsFromEnv, type FacePipeline } from "./google-slides.js";

function proposal(payload: unknown, type = "slides.sync_working_groups"): AdminBotStoredProposal {
  return {
    id: "act_1",
    type: type as AdminBotStoredProposal["type"],
    summary: "sync",
    proposed_payload: payload,
    risk_tier: "T2",
    payload_hash: "h",
    status: "approved",
    approval_requirement: { requires_approval: true, approver_roles: ["admin"], min_approvals: 1 },
    approvals: [],
    created_at: "2026-10-15T00:00:00.000Z",
    updated_at: "2026-10-15T00:00:00.000Z",
  };
}

// Causality: five hand-placed faces, one face this sync placed for somebody who has since left,
// and one new member. With removals on: a delete, a create and its alt-text tag.
function scenario(): { deck: SlidesPresentation; payload: AdminBotSlidesWorkingGroupsPayload } {
  const members = Array.from({ length: 5 }, (_, index) => syntheticMember(`c${index}`, "causality"));
  const leaver = syntheticMember("c8", "causality");
  const deck = syntheticDeck({
    causality: [...members.map((member, index) => legacyFace(member, index)), taggedFace("causality", leaver)],
  });
  const roster = [...members, { ...leaver, research_topics: [] }, syntheticMember("c9", "causality")];
  const found = findSlideByTitle(deck, "Scaling to 50-100 Technical Members");
  if (!found.ok) {
    throw new Error(found.reason);
  }
  const plan = planWorkingGroupsSlide({
    slideObjectId: found.slide.objectId,
    measured: measureWorkingGroupsSlide(found.slide, WORKING_GROUP_BOXES),
    members: roster,
    allowRemovals: true,
  });
  return { deck, payload: buildFaceRequests(plan, deck.presentationId) };
}

function fakeClient(deck: SlidesPresentation) {
  return {
    getPresentation: vi.fn(async (_id: string): Promise<SlidesPresentation> => deck),
    batchUpdate: vi.fn(async (_id: string, _requests: readonly SlidesFaceRequest[]): Promise<unknown> => ({})),
  } satisfies GoogleSlidesClient;
}

function fakePipeline(options: { failFor?: string } = {}) {
  const released: string[] = [];
  const pipeline: FacePipeline = {
    fetchAvatar: vi.fn(async (url: string) => {
      if (options.failFor && url.includes(options.failFor)) {
        throw new Error("avatar download failed (404)");
      }
      return new Uint8Array([1]);
    }),
    render: vi.fn(async () => Buffer.from("png")),
    host: {
      publish: vi.fn(async (_png: Buffer, name: string) => ({
        url: `https://drive.example/${name}`,
        release: async () => {
          released.push(name);
        },
      })),
    },
  };
  return { pipeline, released };
}

describe("createGoogleSlidesExecutor", () => {
  it("leaves other action types to other executors", async () => {
    const executor = createGoogleSlidesExecutor({ client: fakeClient(syntheticDeck({})) });
    expect(await executor.execute(proposal({}, "sheet.update_cells"))).toEqual({ handled: false });
  });

  it("validates but does not write while the kill switch is off", async () => {
    const { deck, payload } = scenario();
    const client = fakeClient(deck);
    const outcome = await createGoogleSlidesExecutor({ client }).execute(proposal(payload));
    expect(outcome).toMatchObject({ handled: true, delivered: false });
    expect(outcome.reason).toContain("ADMINBOT_SLIDES_WRITE");
    expect(client.batchUpdate).not.toHaveBeenCalled();
  });

  it("renders each new face round, points Slides at the hosted copy, and unshares it afterwards", async () => {
    const { deck, payload } = scenario();
    expect(payload.requests.map((request) => Object.keys(request)[0])).toEqual([
      "deleteObject",
      "createImage",
      "updatePageElementAltText",
    ]);
    const client = fakeClient(deck);
    const { pipeline, released } = fakePipeline();
    const outcome = await createGoogleSlidesExecutor({ client, write: true, faces: pipeline }).execute(
      proposal(payload),
    );
    expect(outcome).toMatchObject({ handled: true });
    expect(outcome.delivered).toBeUndefined();
    const face = payload.faces[0]!;
    expect(pipeline.fetchAvatar).toHaveBeenCalledWith(face.avatar_url);
    expect(pipeline.render).toHaveBeenCalledWith(expect.any(Uint8Array), face.ring);
    const sent = client.batchUpdate.mock.calls[0]![1] as SlidesFaceRequest[];
    expect(sent[1]).toMatchObject({ createImage: { url: `https://drive.example/${face.object_id}.png` } });
    expect(sent[2]).toEqual(payload.requests[2]);
    expect(released).toEqual([`${face.object_id}.png`]);
  });

  it("still unshares the hosted faces when the batch update fails", async () => {
    const { deck, payload } = scenario();
    const client = fakeClient(deck);
    client.batchUpdate.mockRejectedValueOnce(new Error("Google said no"));
    const { pipeline, released } = fakePipeline();
    await expect(
      createGoogleSlidesExecutor({ client, write: true, faces: pipeline }).execute(proposal(payload)),
    ).rejects.toThrow(/Google said no/u);
    expect(released).toHaveLength(1);
  });

  it("drops a face whose photo cannot be used, and reports it", async () => {
    const { deck, payload } = scenario();
    const client = fakeClient(deck);
    const { pipeline } = fakePipeline({ failFor: "c9" });
    const outcome = await createGoogleSlidesExecutor({ client, write: true, faces: pipeline }).execute(
      proposal(payload),
    );
    expect(client.batchUpdate.mock.calls[0]![1]).toEqual([payload.requests[0]]);
    expect(outcome.artifacts?.faces_not_added).toContain("c9");
  });

  it("refuses when a face to delete was moved, or an image now sits where a face would go", async () => {
    const { deck, payload } = scenario();
    const moved = structuredClone(deck);
    const target = moved.slides![1]!.pageElements!.find(
      (element) => element.objectId === payload.expected[0]!.object_id,
    )!;
    target.transform!.translateX! += 200_000;
    const client = fakeClient(moved);
    const { pipeline } = fakePipeline();
    const executor = createGoogleSlidesExecutor({ client, write: true, faces: pipeline });
    expect((await executor.execute(proposal(payload))).reason).toContain("has been moved");

    const crowded = structuredClone(deck);
    const create = payload.requests.find((request) => "createImage" in request)!;
    const at = "createImage" in create ? create.createImage.elementProperties.transform : null;
    crowded.slides![1]!.pageElements!.push(image("g_new_by_hand", at!.translateX, at!.translateY, 502_920));
    client.getPresentation.mockResolvedValueOnce(crowded);
    expect((await executor.execute(proposal(payload))).reason).toContain("now sits where a new face would go");
    expect(client.batchUpdate).not.toHaveBeenCalled();
    expect(pipeline.host.publish).not.toHaveBeenCalled();
  });

  it("refuses to delete a face that no longer carries the AdminBot tag", async () => {
    const members = [syntheticMember("c0", "causality")];
    const leaver = syntheticMember("c8", "causality");
    const deck = syntheticDeck({
      causality: [legacyFace(members[0]!, 0), { objectId: "g_ours", description: faceOwnerTag(leaver.id) }],
    });
    const found = findSlideByTitle(deck, "Scaling to 50-100 Technical Members");
    const plan = planWorkingGroupsSlide({
      slideObjectId: found.ok ? found.slide.objectId : "",
      measured: measureWorkingGroupsSlide(deck.slides![1]!, WORKING_GROUP_BOXES),
      members,
      allowRemovals: true,
    });
    const payload = buildFaceRequests(plan, deck.presentationId);
    expect(payload.requests).toEqual([{ deleteObject: { objectId: "g_ours" } }]);
    const retagged = structuredClone(deck);
    retagged.slides![1]!.pageElements!.find((element) => element.objectId === "g_ours")!.description = "Someone";
    const outcome = await createGoogleSlidesExecutor({ client: fakeClient(retagged), write: true }).execute(
      proposal(payload),
    );
    expect(outcome.reason).toContain("no longer carries the AdminBot tag");
  });

  it("refuses moves, edits, untagged creates and labels it did not plan", async () => {
    const { deck, payload } = scenario();
    const executor = createGoogleSlidesExecutor({ client: fakeClient(deck), write: true });
    const withRequests = (requests: unknown[]) => proposal({ ...payload, requests });
    await expect(
      executor.execute(withRequests([{ updatePageElementTransform: { objectId: "g_photo_0_c0" } }])),
    ).rejects.toThrow(/only createImage, updatePageElementAltText and deleteObject/u);
    await expect(executor.execute(withRequests([{ deleteText: { objectId: "g_slide_title" } }]))).rejects.toThrow(
      /only createImage/u,
    );
    await expect(executor.execute(withRequests([{ deleteObject: { objectId: "g_box_interp" } }]))).rejects.toThrow(
      /not planned/u,
    );
    await expect(
      executor.execute(
        withRequests([
          { updatePageElementAltText: { objectId: "g_photo_0_c0", title: "x", description: faceOwnerTag("c0") } },
        ]),
      ),
    ).rejects.toThrow(/only faces created in this batch/u);
    const create = payload.requests[1]!;
    await expect(
      executor.execute(
        withRequests([
          create,
          {
            updatePageElementAltText: {
              objectId: "createImage" in create ? create.createImage.objectId : "",
              title: "x",
              description: faceOwnerTag("somebody-else"),
            },
          },
        ]),
      ),
    ).rejects.toThrow(/does not name the planned member/u);
    await expect(
      executor.execute(
        withRequests([
          {
            createImage: {
              objectId: "g_untagged",
              url: "https://example.com/x.png",
              elementProperties: { pageObjectId: payload.slide_object_id },
            },
          },
        ]),
      ),
    ).rejects.toThrow(/not an AdminBot face id/u);
  });

  it("needs a face host before it can add faces", async () => {
    const { deck, payload } = scenario();
    await expect(
      createGoogleSlidesExecutor({ client: fakeClient(deck), write: true }).execute(proposal(payload)),
    ).rejects.toThrow(/ADMINBOT_SLIDES_FACE_FOLDER_ID/u);
  });
});

describe("slidesWorkingGroupsFromEnv", () => {
  it("is absent without a deck, needs GOG_ACCOUNT, and keeps writes and removals off by default", async () => {
    const capture = vi.fn(async () => "{}");
    expect(slidesWorkingGroupsFromEnv({ GOG_ACCOUNT: "bot@example.com" }, { capture })).toBeUndefined();
    expect(() =>
      slidesWorkingGroupsFromEnv({ ADMINBOT_SLIDES_WORKING_GROUPS_PRESENTATION_ID: "deck" }, { capture }),
    ).toThrow(/GOG_ACCOUNT/u);
    const configured = slidesWorkingGroupsFromEnv(
      { ADMINBOT_SLIDES_WORKING_GROUPS_PRESENTATION_ID: "deck", GOG_ACCOUNT: "bot@example.com" },
      { capture },
    )!;
    expect(configured.source).toMatchObject({
      presentationId: "deck",
      slideTitle: "Scaling to 50-100 Technical Members",
    });
    expect(configured.source.allowRemovals).toBeUndefined();
    const { payload } = scenario();
    expect(await configured.executor.execute(proposal(payload))).toMatchObject({ delivered: false });
    expect(capture).not.toHaveBeenCalled();
    expect(
      slidesWorkingGroupsFromEnv(
        {
          ADMINBOT_SLIDES_WORKING_GROUPS_PRESENTATION_ID: "deck",
          GOG_ACCOUNT: "bot@example.com",
          ADMINBOT_SLIDES_ALLOW_REMOVALS: "1",
        },
        { capture },
      )!.source.allowRemovals,
    ).toBe(true);
  });

  it("only auto-applies when writes and a face folder are on", () => {
    const capture = vi.fn(async () => "{}");
    const base = {
      ADMINBOT_SLIDES_WORKING_GROUPS_PRESENTATION_ID: "deck",
      GOG_ACCOUNT: "bot@example.com",
      ADMINBOT_SLIDES_AUTO_APPLY: "1",
    };
    expect(() => slidesWorkingGroupsFromEnv(base, { capture })).toThrow(/ADMINBOT_SLIDES_WRITE=1/u);
    expect(() =>
      slidesWorkingGroupsFromEnv({ ...base, ADMINBOT_SLIDES_WRITE: "1" }, { capture }),
    ).toThrow(/ADMINBOT_SLIDES_FACE_FOLDER_ID/u);
    const configured = slidesWorkingGroupsFromEnv(
      { ...base, ADMINBOT_SLIDES_WRITE: "1", ADMINBOT_SLIDES_FACE_FOLDER_ID: "folder" },
      { capture },
    )!;
    expect(configured.source.autoApply).toBe(true);
    expect(
      slidesWorkingGroupsFromEnv(
        { ADMINBOT_SLIDES_WORKING_GROUPS_PRESENTATION_ID: "deck", GOG_ACCOUNT: "bot@example.com" },
        { capture },
      )!.source.autoApply,
    ).toBeUndefined();
  });
});
