import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AdminBotStoredProposal } from "../contracts/actions.js";
import type {
  AdminBotSlidesWorkingGroupsPayload,
  GoogleSlidesClient,
  SlidesPresentation,
} from "../contracts/google-slides.js";
import { findSlideByTitle, measureWorkingGroupsSlide } from "../workflows/slides/face-layout-measure.js";
import { planWorkingGroupsSlide } from "../workflows/slides/face-layout-plan.js";
import { buildFaceRequests } from "../workflows/slides/face-layout-requests.js";
import {
  legacyFace,
  syntheticDeck,
  syntheticMember,
} from "../workflows/slides/face-layout.test-helpers.js";
import { WORKING_GROUP_BOXES } from "../workflows/slides/working-groups.js";
import {
  createGoogleSlidesClient,
  createGoogleSlidesExecutor,
  googleSlidesTokenSourceFromEnv,
  serviceAccountTokenSource,
  slidesWorkingGroupsFromEnv,
} from "./google-slides.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

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

// One member leaves Causality and one joins: a payload with a delete, moves and a create.
function scenario(): { deck: SlidesPresentation; payload: AdminBotSlidesWorkingGroupsPayload } {
  const members = Array.from({ length: 5 }, (_, index) => syntheticMember(`c${index}`, "causality"));
  const deck = syntheticDeck({ causality: members.map((member, index) => legacyFace(member, index)) });
  const roster = [
    ...members.map((member, index) => (index === 0 ? { ...member, research_topics: [] } : member)),
    syntheticMember("c9", "causality"),
  ];
  const found = findSlideByTitle(deck, "Scaling to 50-100 Technical Members");
  if (!found.ok) {
    throw new Error(found.reason);
  }
  const plan = planWorkingGroupsSlide({
    slideObjectId: found.slide.objectId,
    measured: measureWorkingGroupsSlide(found.slide, WORKING_GROUP_BOXES),
    members: roster,
  });
  return { deck, payload: buildFaceRequests(plan, deck.presentationId) };
}

function fakeClient(deck: SlidesPresentation): GoogleSlidesClient & { batchUpdate: ReturnType<typeof vi.fn> } {
  return {
    getPresentation: vi.fn(async () => deck),
    batchUpdate: vi.fn(async () => ({})),
  };
}

describe("createGoogleSlidesClient", () => {
  it("reads only the fields the measurement needs and posts batch updates, with the bearer token", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = createGoogleSlidesClient({
      token: async () => "tok",
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse({ presentationId: "p1", slides: [] });
      }) as typeof fetch,
    });
    await client.getPresentation("p1");
    await client.batchUpdate("p1", [{ deleteObject: { objectId: "adminbot_face_interp_0123456789ab" } }]);
    expect(calls[0]!.url).toContain("/presentations/p1?fields=");
    expect(calls[0]!.url).toContain(encodeURIComponent("slides(objectId,pageElements)"));
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(calls[1]!.url).toMatch(/\/presentations\/p1:batchUpdate$/u);
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({
      requests: [{ deleteObject: { objectId: "adminbot_face_interp_0123456789ab" } }],
    });
  });

  it("surfaces Google's error message without the token", async () => {
    const client = createGoogleSlidesClient({
      token: async () => "secret-token",
      fetch: (async () => jsonResponse({ error: { message: "The caller does not have permission" } }, 403)) as typeof fetch,
    });
    const error = await client.getPresentation("p1").catch((caught: Error) => caught);
    expect(error.message).toContain("403");
    expect(error.message).toContain("does not have permission");
    expect(error.message).not.toContain("secret-token");
  });
});

describe("serviceAccountTokenSource", () => {
  it("signs an RS256 JWT for the presentations scope and caches the token", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const bodies: string[] = [];
    const token = serviceAccountTokenSource({
      key: {
        client_email: "slides-bot@example.iam.gserviceaccount.com",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      },
      now: () => 1_800_000_000_000,
      fetch: (async (_url: string, init?: RequestInit) => {
        bodies.push(String(init!.body));
        return jsonResponse({ access_token: "ya29.test", expires_in: 3600 });
      }) as typeof fetch,
    });
    expect(await token()).toBe("ya29.test");
    expect(await token()).toBe("ya29.test");
    expect(bodies).toHaveLength(1);
    const assertion = new URLSearchParams(bodies[0]!).get("assertion")!;
    const [header, claims, signature] = assertion.split(".");
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toMatchObject({
      iss: "slides-bot@example.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/presentations",
      aud: "https://oauth2.googleapis.com/token",
    });
    const verified = createVerify("RSA-SHA256")
      .update(`${header}.${claims}`)
      .verify(publicKey, Buffer.from(signature!, "base64url"));
    expect(verified).toBe(true);
  });

  it("is configured from a key file or a raw token, and absent otherwise", async () => {
    expect(googleSlidesTokenSourceFromEnv({})).toBeUndefined();
    expect(await googleSlidesTokenSourceFromEnv({ ADMINBOT_SLIDES_ACCESS_TOKEN: "abc" })!()).toBe("abc");
    expect(() =>
      googleSlidesTokenSourceFromEnv(
        { ADMINBOT_SLIDES_SERVICE_ACCOUNT_FILE: "/keys/slides.json" },
        { readFile: () => JSON.stringify({ type: "authorized_user" }) },
      ),
    ).toThrow(/not a service-account key/u);
  });
});

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

  it("re-reads the slide and sends the planned requests when nothing drifted", async () => {
    const { deck, payload } = scenario();
    expect(payload.requests.map((request) => Object.keys(request)[0])).toEqual([
      "deleteObject",
      ...Array(payload.requests.length - 2).fill("updatePageElementTransform"),
      "createImage",
    ]);
    const client = fakeClient(deck);
    const outcome = await createGoogleSlidesExecutor({ client, write: true }).execute(proposal(payload));
    expect(outcome).toMatchObject({ handled: true });
    expect(outcome.delivered).toBeUndefined();
    expect(client.batchUpdate).toHaveBeenCalledWith(deck.presentationId, payload.requests);
  });

  it("refuses when a face was moved by hand after the plan was approved", async () => {
    const { deck, payload } = scenario();
    const moved = structuredClone(deck);
    const target = moved.slides![1]!.pageElements!.find(
      (element) => element.objectId === payload.expected[0]!.object_id,
    )!;
    target.transform!.translateX! += 200_000;
    const client = fakeClient(moved);
    const outcome = await createGoogleSlidesExecutor({ client, write: true }).execute(proposal(payload));
    expect(outcome).toMatchObject({ handled: true, delivered: false });
    expect(outcome.reason).toContain("has been moved");
    expect(client.batchUpdate).not.toHaveBeenCalled();
  });

  it("refuses requests outside the three it owns, or aimed at unplanned objects", async () => {
    const { deck, payload } = scenario();
    const executor = createGoogleSlidesExecutor({ client: fakeClient(deck), write: true });
    await expect(
      executor.execute(proposal({ ...payload, requests: [{ deleteText: { objectId: "g_slide_title" } }] })),
    ).rejects.toThrow(/only createImage/u);
    await expect(
      executor.execute(proposal({ ...payload, requests: [{ deleteObject: { objectId: "g_box_interp" } }] })),
    ).rejects.toThrow(/not planned/u);
    await expect(
      executor.execute(
        proposal({
          ...payload,
          requests: [
            {
              createImage: {
                objectId: "g_untagged",
                url: "https://example.com/x.png",
                elementProperties: { pageObjectId: payload.slide_object_id },
              },
            },
          ],
        }),
      ),
    ).rejects.toThrow(/not an AdminBot face id/u);
  });
});

describe("slidesWorkingGroupsFromEnv", () => {
  it("is absent without a deck, refuses a deck without credentials, and keeps writes off by default", async () => {
    expect(slidesWorkingGroupsFromEnv({ ADMINBOT_SLIDES_ACCESS_TOKEN: "abc" })).toBeUndefined();
    expect(() =>
      slidesWorkingGroupsFromEnv({ ADMINBOT_SLIDES_WORKING_GROUPS_PRESENTATION_ID: "deck" }),
    ).toThrow(/ADMINBOT_SLIDES_SERVICE_ACCOUNT_FILE/u);
    const configured = slidesWorkingGroupsFromEnv({
      ADMINBOT_SLIDES_WORKING_GROUPS_PRESENTATION_ID: "deck",
      ADMINBOT_SLIDES_ACCESS_TOKEN: "abc",
      ADMINBOT_SLIDES_FACE_URL_TEMPLATE: "https://images.example.com/?url={url}&mask=circle",
    })!;
    expect(configured.source).toMatchObject({
      presentationId: "deck",
      slideTitle: "Scaling to 50-100 Technical Members",
    });
    expect(configured.source.faceImageUrl!("https://a.example/p.png?x=1")).toBe(
      "https://images.example.com/?url=https%3A%2F%2Fa.example%2Fp.png%3Fx%3D1&mask=circle",
    );
    const { payload } = scenario();
    expect(await configured.executor.execute(proposal(payload))).toMatchObject({ delivered: false });
  });
});
