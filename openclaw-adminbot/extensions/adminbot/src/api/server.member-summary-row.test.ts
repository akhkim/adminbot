import { afterEach, describe, expect, it } from "vitest";
import {
  adminBotConfidentialMemberFields,
  adminBotInferredLocationMemberFields,
  adminBotScheduleMemberFields,
  type AdminBotLabMemberInput,
} from "../contracts/actions.js";
import { adminBotOwnerOnlyMemberFields } from "../contracts/member-owner-fields.js";
import { memberSummaryRow } from "./routes/member-summary-row.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "summary-row-service-token";
const PASSWORD = "correcthorse";
const running: Array<ReturnType<typeof createAdminBotMockService>> = [];

afterEach(async () => {
  while (running.length > 0) {
    const mock = running.pop()!;
    await new Promise<void>((resolve, reject) => {
      mock.server.close((error) => (error ? reject(error) : resolve()));
    });
    mock.close();
  }
});

// A peer with something in nearly every field, so a field the projection lets through shows up.
const PEER: AdminBotLabMemberInput = {
  id: "peer",
  name: "Pat Peer",
  email: "peer@cs.toronto.edu",
  calendar_email: "peer.calendar@cs.toronto.edu",
  correspondence_email: "peer@vectorinstitute.ai",
  slack_user_id: "U0PEER",
  privilege_level: "member",
  member_type: "alumni",
  status: "part_time",
  role: "PhD Student",
  research_branch: "NLP",
  research_topics: ["causal inference"],
  projects: ["project-1"],
  hours_per_week: 20,
  location: "Toronto",
  current_city: "Zurich",
  affiliation: "University of Toronto",
  timezone: "America/Toronto",
  personal_website: "https://example.org/~peer",
  github_url: "https://github.com/peer",
  elevator_pitch: "I study causal reasoning in language models.",
  notes: "Met at NeurIPS.",
  availability: [{ start: "2026-09-01", end: "2026-12-20", hours_per_week: 20 }],
  time_off: [{ start: "2026-12-21", end: "2027-01-04", kind: "vacation", availability: "none" }],
} as AdminBotLabMemberInput;

async function startLab() {
  const mock = createAdminBotMockService({ serviceToken: SERVICE_TOKEN });
  await new Promise<void>((resolve) => mock.server.listen(0, "127.0.0.1", () => resolve()));
  const address = mock.server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing server address");
  }
  running.push(mock);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  for (const member of [
    PEER,
    { id: "admin", name: "Ada Admin", email: "admin@cs.toronto.edu", privilege_level: "admin" },
    {
      id: "member",
      name: "Mina Member",
      email: "member@cs.toronto.edu",
      privilege_level: "member",
    },
  ]) {
    const saved = mock.service.upsertLabMember(member as AdminBotLabMemberInput);
    if (!saved.ok) {
      throw new Error(saved.error.message);
    }
  }
  const session = async (id: string) => {
    const email = `${id}@cs.toronto.edu`;
    await fetch(`${baseUrl}/auth/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member_id: id, email, password: PASSWORD }),
    });
    const registration = (await mock.auth.listRegistrations("pending")).find(
      (entry) => entry.member_id === id,
    );
    await mock.auth.approveRegistration(registration!.id, "test-admin");
    const login = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const token = ((await login.json()) as { session_token: string }).session_token;
    return { Authorization: `Bearer ${token}` };
  };
  return { baseUrl, admin: await session("admin"), member: await session("member") };
}

async function summaryRows(baseUrl: string, headers: Record<string, string>) {
  const response = await fetch(`${baseUrl}/lab/members?view=summary`, { headers });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    members: Record<string, unknown>[];
    self: Record<string, unknown>;
  };
  return { ...body, byId: new Map(body.members.map((row) => [row.id, row])) };
}

const PEER_KEYS = [
  "affiliation",
  "correspondence_email",
  "email",
  "id",
  "member_type",
  "name",
  "slack_user_id",
  "status",
];

describe("GET /lab/members?view=summary rows", () => {
  it("sends a member only the fields peers may see, and nothing private", async () => {
    const { baseUrl, member } = await startLab();
    const { byId, self } = await summaryRows(baseUrl, member);
    const peer = byId.get("peer")!;
    expect(Object.keys(peer).toSorted()).toEqual(PEER_KEYS);
    const allowed = new Set([...PEER_KEYS, "privilege_level", "twitter_url", "assigned_badges"]);
    for (const row of byId.values()) {
      expect(Object.keys(row).filter((key) => !allowed.has(key))).toEqual([]);
      for (const field of [
        ...adminBotConfidentialMemberFields,
        ...adminBotOwnerOnlyMemberFields,
        ...adminBotScheduleMemberFields,
        ...adminBotInferredLocationMemberFields,
      ]) {
        expect(row).not.toHaveProperty(field);
      }
    }
    // The caller's own record still travels whole beside the rows.
    expect(self).toMatchObject({ id: "member", name: "Mina Member" });
  });

  it("gives an admin the planning fields as well, still compact", async () => {
    const { baseUrl, admin } = await startLab();
    const { byId } = await summaryRows(baseUrl, admin);
    expect(Object.keys(byId.get("peer")!).toSorted()).toEqual(
      [
        ...PEER_KEYS,
        "calendar_email",
        "current_city",
        "location",
        // Completed step ids only; see the memberSummaryRow case below.
        "onboarding",
        "projects",
        "research_branch",
        "research_topics",
        "timezone",
      ].toSorted(),
    );
    // Schedules, prose and links wait for the detail read.
    expect(byId.get("peer")).not.toHaveProperty("availability");
    expect(byId.get("peer")).not.toHaveProperty("elevator_pitch");
    expect(byId.get("admin")).toMatchObject({ privilege_level: "admin" });
  });

  it("omits null, empty and default fields", async () => {
    const { baseUrl, admin } = await startLab();
    const { byId } = await summaryRows(baseUrl, admin);
    const plain = byId.get("member")!;
    expect(plain).not.toHaveProperty("privilege_level");
    for (const value of Object.values(plain)) {
      expect([null, "", undefined]).not.toContain(value);
      expect(Array.isArray(value) && value.length === 0).toBe(false);
    }
  });
});

describe("GET /lab/members/:id/detail", () => {
  it("serves your own record and an admin's read of anyone's, and refuses a peer", async () => {
    const { baseUrl, admin, member } = await startLab();
    const read = (id: string, headers: Record<string, string>) =>
      fetch(`${baseUrl}/lab/members/${id}/detail`, { headers });
    expect((await read("peer", member)).status).toBe(403);
    expect((await read("member", member)).status).toBe(200);
    const response = await read("peer", admin);
    expect(response.status).toBe(200);
    const { member: record } = (await response.json()) as { member: Record<string, unknown> };
    expect(record).toMatchObject({ id: "peer", hours_per_week: 20 });
    expect(record.availability).toHaveLength(1);
    expect((await read("nobody", admin)).status).toBe(404);
  });
});

describe("memberSummaryRow", () => {
  it("keeps only completed onboarding steps, and drops a checklist with none", () => {
    const onboarding = {
      steps: [
        { id: "slack", status: "complete", note: "joined" },
        { id: "calendar", status: "pending" },
      ],
    };
    expect(memberSummaryRow({ id: "a", onboarding }, { isAdmin: true })).toEqual({
      id: "a",
      onboarding: { steps: [{ id: "slack", status: "complete" }] },
    });
    expect(
      memberSummaryRow({ id: "a", onboarding: { steps: [{ id: "x" }] } }, { isAdmin: true }),
    ).toEqual({ id: "a" });
    expect(memberSummaryRow({ id: "a", onboarding }, { isAdmin: false })).toEqual({ id: "a" });
  });
});
