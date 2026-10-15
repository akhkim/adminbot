import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoogleSlidesClient } from "../contracts/google-slides.js";
import {
  legacyFace,
  syntheticDeck,
  syntheticMember,
} from "../workflows/slides/face-layout.test-helpers.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-slides-service-token";
const running: Array<ReturnType<typeof createAdminBotMockService>> = [];

afterEach(async () => {
  for (const mock of running.splice(0)) {
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
    mock.close();
  }
});

async function start(options: Parameters<typeof createAdminBotMockService>[0] = {}) {
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
    ...options,
  });
  await new Promise<void>((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
  running.push(mock);
  const address = mock.server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing address");
  }
  return { mock, baseUrl: `http://127.0.0.1:${address.port}` };
}

const auth = { Authorization: `Bearer ${SERVICE_TOKEN}` };

function configured() {
  const members = [0, 1, 2].map((index) => syntheticMember(`c${index}`, "causality"));
  const client: GoogleSlidesClient = {
    getPresentation: vi.fn(async () =>
      syntheticDeck({ causality: members.slice(0, 2).map((member, index) => legacyFace(member, index)) }),
    ),
    batchUpdate: vi.fn(async () => ({})),
  };
  return {
    members,
    client,
    options: {
      slidesWorkingGroups: {
        presentationId: "deck_synthetic",
        slideTitle: "Scaling to 50-100 Technical Members",
        client,
      },
    },
  };
}

describe("working-groups slide routes", () => {
  it("answers 503 when no deck is configured and 401 without a principal", async () => {
    const { baseUrl } = await start();
    expect((await fetch(`${baseUrl}/slides/working-groups/preview`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/slides/working-groups/preview`, { headers: auth })).status).toBe(503);
  });

  it("previews as JSON or as a before/after SVG, then proposes on apply", async () => {
    const { members, client, options } = configured();
    const { baseUrl, mock } = await start(options);
    for (const member of members) {
      mock.service.upsertLabMember(member as never);
    }
    const preview = await fetch(`${baseUrl}/slides/working-groups/preview`, { headers: auth });
    expect(preview.status).toBe(200);
    const body = (await preview.json()) as { payload: { groups: Array<{ group: string; status: string }> } };
    expect(body.payload.groups.find((group) => group.group === "causality")).toMatchObject({ status: "update" });

    const svg = await fetch(`${baseUrl}/slides/working-groups/preview?format=svg`, { headers: auth });
    expect(svg.headers.get("content-type")).toContain("image/svg+xml");
    const text = await svg.text();
    expect(text).toMatch(/^<svg/u);
    expect(text).not.toContain("example.com/avatars");

    expect(
      (
        await fetch(`${baseUrl}/slides/working-groups/apply`, {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify({ trigger: "member_change" }),
        })
      ).status,
    ).toBe(400);
    const applied = await fetch(`${baseUrl}/slides/working-groups/apply`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ trigger: "schedule" }),
    });
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({
      changed: true,
      proposal: { type: "slides.sync_working_groups", status: "pending" },
    });
    // Proposing never writes; only an approved execution does.
    expect(client.batchUpdate).not.toHaveBeenCalled();
  });
});
