import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AdminBotLabMemberInput } from "../contracts/actions.js";
import { withCompleteProfile } from "../contracts/profile-completion.test-helpers.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "travel-service-token";
const running: Array<ReturnType<typeof createAdminBotMockService>> = [];

// A synthetic conference far enough out that the test never ages into "past".
let datasetDir: string;
let previousDatasetPath: string | undefined;
beforeAll(() => {
  datasetDir = mkdtempSync(join(tmpdir(), "adminbot-travel-"));
  const file = join(datasetDir, "deadlines.json");
  writeFileSync(
    file,
    JSON.stringify({
      items: [
        {
          id: "synthconf2099_paper",
          name: "SynthConf 2099",
          venue_type: "conference",
          venue_group: "SynthConf 2099",
          venue_family: "SynthConf",
          deadline_aoe: "2099-01-15 23:59:59",
          conference_location: "Paris, France; Sydney, Australia",
          schedule: [
            {
              milestone: "conference",
              label: "Main conference — Paris",
              starts: "2099-06-01",
              ends: "2099-06-04",
            },
            {
              milestone: "conference",
              label: "Main conference — Sydney",
              starts: "2099-06-02",
              ends: "2099-06-05",
            },
          ],
        },
      ],
    }),
  );
  previousDatasetPath = process.env.ADMINBOT_DEADLINE_DATASET_PATH;
  process.env.ADMINBOT_DEADLINE_DATASET_PATH = file;
});

afterAll(() => {
  if (previousDatasetPath === undefined) {
    delete process.env.ADMINBOT_DEADLINE_DATASET_PATH;
  } else {
    process.env.ADMINBOT_DEADLINE_DATASET_PATH = previousDatasetPath;
  }
  rmSync(datasetDir, { recursive: true, force: true });
});

afterEach(async () => {
  while (running.length > 0) {
    const mock = running.pop();
    if (!mock) {
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      mock.server.close((error) => (error ? reject(error) : resolve()));
    });
    mock.close();
  }
});

const MEMBERS = [
  {
    id: "ada",
    name: "Ada Member",
    email: "ada@lab.test",
    privilege_level: "member",
    location: "Paris",
  },
  {
    id: "bob",
    name: "Bob Member",
    email: "bob@lab.test",
    privilege_level: "member",
    location: "Toronto",
  },
  {
    id: "ext",
    name: "Eve External",
    email: "ext@lab.test",
    privilege_level: "external_collaborator",
  },
] as const;

async function startLab() {
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    allowedOrigins: ["http://127.0.0.1:5197"],
  });
  await new Promise<void>((resolve, reject) => {
    mock.server.once("error", reject);
    mock.server.listen(0, "127.0.0.1", () => {
      mock.server.off("error", reject);
      resolve();
    });
  });
  const address = mock.server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing server address");
  }
  running.push(mock);
  for (const member of MEMBERS) {
    // Complete profiles: the profile gate refuses every route but the profile to a member without.
    const saved = mock.service.upsertLabMember(
      withCompleteProfile({ status: "active", ...member }) as AdminBotLabMemberInput,
    );
    if (!saved.ok) {
      throw new Error(saved.error.message);
    }
  }
  return { mock, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function memberSession(
  mock: ReturnType<typeof createAdminBotMockService>,
  baseUrl: string,
  memberId: (typeof MEMBERS)[number]["id"],
): Promise<Record<string, string>> {
  const email = `${memberId}@lab.test`;
  await fetch(`${baseUrl}/auth/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ member_id: memberId, email, password: "correcthorse" }),
  });
  const registration = (await mock.auth.listRegistrations("pending")).find(
    (entry) => entry.member_id === memberId,
  );
  if (!registration) {
    throw new Error(`no registration for ${memberId}`);
  }
  const approved = await mock.auth.approveRegistration(registration.id, "test-admin");
  if (!approved.ok) {
    throw new Error(approved.error.message);
  }
  const login = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correcthorse" }),
  });
  const token = ((await login.json()) as { session_token: string }).session_token;
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

describe("Travel routes", () => {
  it("are member-session only: no visitor, no service token, no external collaborator", async () => {
    const { mock, baseUrl } = await startLab();
    expect((await fetch(`${baseUrl}/travel`)).status).toBe(401);
    expect(
      (await fetch(`${baseUrl}/travel`, { headers: { Authorization: `Bearer ${SERVICE_TOKEN}` } }))
        .status,
    ).toBe(403);
    const ext = await memberSession(mock, baseUrl, "ext");
    expect((await fetch(`${baseUrl}/travel`, { headers: ext })).status).toBe(403);
    expect(
      (
        await fetch(`${baseUrl}/travel/sharing`, {
          method: "PUT",
          headers: ext,
          body: JSON.stringify({ enabled: true }),
        })
      ).status,
    ).toBe(403);
  });

  it("RSVPs per site, shares a location on opt-in, and finds the other member", async () => {
    const { mock, baseUrl } = await startLab();
    const ada = await memberSession(mock, baseUrl, "ada");
    const bob = await memberSession(mock, baseUrl, "bob");

    const first = await (await fetch(`${baseUrl}/travel`, { headers: ada })).json();
    expect(first.conferences.map((site: { label: string }) => site.label)).toEqual([
      "SynthConf 2099 — Paris",
      "SynthConf 2099 — Sydney",
    ]);
    expect(first.sharing).toEqual({ enabled: false });

    const rsvp = await fetch(
      `${baseUrl}/travel/conferences/${encodeURIComponent("synthconfparis:2099")}/rsvp`,
      {
        method: "PUT",
        headers: bob,
        body: JSON.stringify({ intent: "going", funding: "flight_only", needs_lodging: true }),
      },
    );
    expect(rsvp.status).toBe(200);
    expect((await rsvp.json()).trip).toMatchObject({
      arrival_on: "2099-06-01",
      departure_on: "2099-06-04",
      needs_lodging: true,
    });
    const unknown = await fetch(`${baseUrl}/travel/conferences/nope%3A2099/rsvp`, {
      method: "PUT",
      headers: bob,
      body: JSON.stringify({ intent: "going" }),
    });
    expect(unknown.status).toBe(404);

    const seen = await (await fetch(`${baseUrl}/travel`, { headers: ada })).json();
    const paris = seen.conferences.find(
      (site: { key: string }) => site.key === "synthconfparis:2099",
    );
    expect(paris.going).toEqual([{ member_id: "bob", name: "Bob Member", airbnb: true }]);
    expect(JSON.stringify(seen)).not.toContain("flight_only");

    // A fix before opting in is refused, and nothing is stored.
    const early = await fetch(`${baseUrl}/travel/location`, {
      method: "POST",
      headers: bob,
      body: JSON.stringify({ lat: 48.86, lon: 2.35 }),
    });
    expect(early.status).toBe(409);
    expect(mock.store.listLocationShares()).toEqual([]);

    for (const headers of [ada, bob]) {
      const on = await fetch(`${baseUrl}/travel/sharing`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ enabled: true }),
      });
      expect(on.status).toBe(200);
    }
    const fix = await fetch(`${baseUrl}/travel/location`, {
      method: "POST",
      headers: bob,
      body: JSON.stringify({ lat: 48.871_234, lon: 2.331_987, accuracy_m: 25 }),
    });
    expect(fix.status).toBe(200);
    expect((await fix.json()).sharing.location).toMatchObject({ label: "Paris", accuracy_m: 25 });
    // Stored at ~1 km precision, never the raw fix.
    expect(mock.store.getLocationShare("bob")).toMatchObject({ lat: 48.87, lon: 2.33 });

    const lookup = await fetch(`${baseUrl}/travel/whos-in?place=${encodeURIComponent("Paris")}`, {
      headers: ada,
    });
    expect(lookup.status).toBe(200);
    const found = await lookup.json();
    expect(found.people).toEqual([
      expect.objectContaining({
        member_id: "bob",
        basis: "live",
        place: expect.objectContaining({ label: "Paris" }),
      }),
    ]);
    expect(JSON.stringify(found)).not.toMatch(/48\.87|2\.33/u);

    const off = await fetch(`${baseUrl}/travel/sharing`, {
      method: "PUT",
      headers: bob,
      body: JSON.stringify({ enabled: false }),
    });
    expect(off.status).toBe(200);
    expect(mock.store.getLocationShare("bob")).toBeUndefined();
    const after = await (
      await fetch(`${baseUrl}/travel/whos-in?place=Paris`, { headers: ada })
    ).json();
    expect(after.people).toEqual([]);

    const withdraw = await fetch(
      `${baseUrl}/travel/conferences/${encodeURIComponent("synthconfparis:2099")}/rsvp`,
      { method: "DELETE", headers: bob },
    );
    expect(withdraw.status).toBe(200);
    expect((await withdraw.json()).withdrawn).toBe(true);
  });

  it("rejects malformed JSON", async () => {
    const { mock, baseUrl } = await startLab();
    const ada = await memberSession(mock, baseUrl, "ada");
    const bad = await fetch(`${baseUrl}/travel/sharing`, {
      method: "PUT",
      headers: ada,
      body: "{",
    });
    expect(bad.status).toBe(400);
  });
});

describe("Events routes", () => {
  it("are member-session only and serve the member's own view and settings", async () => {
    const { mock, baseUrl } = await startLab();
    expect((await fetch(`${baseUrl}/events`)).status).toBe(401);
    expect(
      (await fetch(`${baseUrl}/events`, { headers: { Authorization: `Bearer ${SERVICE_TOKEN}` } }))
        .status,
    ).toBe(403);
    const ext = await memberSession(mock, baseUrl, "ext");
    expect((await fetch(`${baseUrl}/events`, { headers: ext })).status).toBe(403);

    const ada = await memberSession(mock, baseUrl, "ada");
    const view = await (await fetch(`${baseUrl}/events`, { headers: ada })).json();
    // Ada's profile says Paris: the Paris site sorts first and is marked near her.
    expect(view.viewer_location).toEqual({ label: "Paris", source: "profile" });
    expect(
      view.events.map((card: { label: string; near_you: boolean }) => [card.label, card.near_you]),
    ).toEqual([
      ["SynthConf 2099 — Paris", true],
      ["SynthConf 2099 — Sydney", false],
    ]);
    // Zero setup: both kinds of intro are on before anybody touches a setting.
    expect(view.preferences).toEqual({ events: true, city: true });
    expect(view.also_nearby).toMatchObject({ locked: false, place_label: "Paris", people: [] });

    const bad = await fetch(`${baseUrl}/events/preferences`, {
      method: "PUT",
      headers: ada,
      body: JSON.stringify({ city: "please" }),
    });
    expect(bad.status).toBe(400);
    const saved = await fetch(`${baseUrl}/events/preferences`, {
      method: "PUT",
      headers: ada,
      body: JSON.stringify({ city: false }),
    });
    expect(await saved.json()).toEqual({ preferences: { events: true, city: false } });
    // Turned off: she sees only that the list exists.
    const after = await (await fetch(`${baseUrl}/events`, { headers: ada })).json();
    expect(after.also_nearby).toEqual({ locked: true });
  });

  it("takes Say hi only from a member session, with an event or a lab-mate", async () => {
    const { mock, baseUrl } = await startLab();
    const sayHi = (headers: Record<string, string> | undefined, body: string) =>
      fetch(`${baseUrl}/events/say-hi`, { method: "POST", ...(headers ? { headers } : {}), body });
    expect((await sayHi(undefined, "{}")).status).toBe(401);
    expect((await sayHi(await memberSession(mock, baseUrl, "ext"), "{}")).status).toBe(403);
    const ada = await memberSession(mock, baseUrl, "ada");
    expect((await sayHi(ada, "not json")).status).toBe(400);
    expect((await sayHi(ada, "{}")).status).toBe(400);
    // Ada has no Slack link in this lab: a well-formed tap says how to fix that.
    const unlinked = await sayHi(ada, JSON.stringify({ event_key: "synthconf:2099" }));
    expect(unlinked.status).toBe(409);
    expect(await unlinked.json()).toMatchObject({ error: { message: expect.stringContaining("Slack") } });
  });
});
