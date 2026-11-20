import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGroupMeetingEventId } from "../contracts/group-meeting.js";
import { withCompleteProfile } from "../contracts/profile-completion.test-helpers.js";
import { createAdminBotMockService } from "./server.js";
const running: { app: ReturnType<typeof createAdminBotMockService>; dir: string }[] = [];
afterEach(async () => {
  for (const { app, dir } of running.splice(0)) {
    await new Promise<void>((resolve) => {
      app.server.close(() => resolve());
    });
    app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "roster-page-"));
  const reader = vi.fn(async () => [
    {
      id: resolveGroupMeetingEventId(),
      summary: "Monday",
      start: "2026-10-26T13:30:00Z",
      attendees: ["ALIAS@example.test"],
    },
  ]);
  const app = createAdminBotMockService({
    databasePath: join(dir, "test.sqlite"),
    serviceToken: "test-token",
    calendarEventsReader: reader,
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
  });
  running.push({ app, dir });
  for (let i = 0; i < 105; i++) {
    const result = app.service.upsertLabMember(
      withCompleteProfile({
        id: `person-${i}`,
        name: `Person ${i}`,
        email: `person-${i}@example.test`,
        privilege_level: "member",
        location: i === 104 ? "Zurich" : "London",
        joined_month: i === 104 ? "2019-01" : "2025-01",
        member_type: "full",
        calendar_email: i === 104 ? "alias@example.test" : undefined,
        personal_circumstances: i === 104 ? "Private test note" : undefined,
        whatsapp: i === 104 ? "+15551234567" : undefined,
      }),
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }
  }
  await new Promise<void>((resolve) => {
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No port");
  }
  const url = `http://127.0.0.1:${address.port}/lab/members/roster`;
  const get = (query = "", token = "test-token") =>
    fetch(url + query, { headers: { Authorization: `Bearer ${token}` } });
  const token = async (admin: boolean) => {
    const id = admin ? "admin" : "member";
    const result = app.service.upsertLabMember(
      withCompleteProfile({
        id,
        name: id,
        email: `${id}@example.test`,
        privilege_level: admin ? "admin" : "member",
      }),
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    await app.auth.claim({
      member_id: id,
      email: `${id}@example.test`,
      password: "test-password-123",
    });
    const registration = (await app.auth.listRegistrations("pending")).find(
      (r) => r.member_id === id,
    )!;
    await app.auth.approveRegistration(registration.id, "test");
    const login = await app.auth.login({
      email: `${id}@example.test`,
      password: "test-password-123",
    });
    if (!login.ok) {
      throw new Error(login.error.message);
    }
    return login.payload.session_token;
  };
  return { app, get, token, reader };
}
describe("GET /lab/members/roster", () => {
  it("paginates SQLite records after filtering/sorting, with global options", async () => {
    const { get, reader } = await setup();
    const first = await (await get("?limit=50&offset=0")).json();
    expect(first.members).toHaveLength(50);
    expect(first.total).toBe(105);
    expect(first.members[0].id).toBe("person-104");
    const filtered = await (await get("?limit=50&offset=50&location=Zurich")).json();
    expect(filtered.members.map((m: { id: string }) => m.id)).toEqual(["person-104"]);
    expect(filtered.offset).toBe(0);
    expect(filtered.options.location).toEqual(["London", "Zurich"]);
    expect(reader).not.toHaveBeenCalled();
    expect((await get("?limit=1000")).status).toBe(400);
    expect((await get("?offset=-1")).status).toBe(400);
    expect((await get("", "invalid-token")).status).toBe(401);
  });
  it("allows member roster reads but keeps calendar membership filtering admin-only", async () => {
    const { get, token, reader } = await setup();
    const member = await token(false);
    const publicPage = await (await get("?location=Zurich", member)).json();
    expect(publicPage.members).toHaveLength(1);
    expect(publicPage.members[0]).not.toHaveProperty("personal_circumstances");
    expect(publicPage.members[0]).not.toHaveProperty("whatsapp");
    expect((await (await get("?q=15551234567", member)).json()).total).toBe(0);
    expect((await get(`?meeting=${resolveGroupMeetingEventId()}`, member)).status).toBe(403);
    expect(reader).not.toHaveBeenCalled();
    const admin = await token(true);
    const privatePage = await (await get("?location=Zurich", admin)).json();
    expect(privatePage.members[0].personal_circumstances).toBe("Private test note");
    // The failure comes first: a successful calendar read is kept for a minute, so a failure
    // asked for after one would be answered from the kept read instead. A failed one is not kept.
    reader.mockRejectedValueOnce(new Error("offline"));
    const failed = await get(`?meeting=${resolveGroupMeetingEventId()}`, admin);
    expect(failed.status).toBe(500); // sendJson maps connector 502s for the Cloudflare tunnel.
    expect((await failed.json()).error.message).toContain("offline");
    const response = await get(`?meeting=${resolveGroupMeetingEventId()}`, admin);
    expect(response.status).toBe(200);
    expect((await response.json()).members.map((m: { id: string }) => m.id)).toEqual([
      "person-104",
    ]);
  });
  it("sends lean rows with their papers attached and answers an unchanged page with 304", async () => {
    const { app, get } = await setup();
    const paper = app.service.upsertPaper({
      id: "paper-1",
      title: "Roster Study",
      authors: ["Person 104"],
      current_step: "submission",
      artifacts: { conference: "ExampleConf" },
    });
    if (!paper.ok) {
      throw new Error(paper.error.message);
    }
    const first = await get("?limit=50&offset=0");
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const body = await first.json();
    const row = body.members[0];
    expect(row.id).toBe("person-104");
    expect(row.roster_papers).toEqual([{ title: "Roster Study", conference: "ExampleConf" }]);
    // Heavy per-member records the table never draws stay on the detail read.
    for (const field of ["field_provenance", "onboarding", "availability", "time_off", "trips"]) {
      expect(row).not.toHaveProperty(field);
    }
    expect(body.members[1]).not.toHaveProperty("roster_papers");
    const again = await fetch(first.url, {
      headers: { Authorization: "Bearer test-token", "If-None-Match": etag! },
    });
    expect(again.status).toBe(304);
    // A roster write moves the tag, so the next read draws the change.
    const write = app.service.upsertLabMember(
      withCompleteProfile({
        id: "person-0",
        name: "Person 0 Renamed",
        email: "person-0@example.test",
        privilege_level: "member",
        member_type: "full",
      }),
    );
    expect(write.ok).toBe(true);
    const changed = await fetch(first.url, {
      headers: { Authorization: "Bearer test-token", "If-None-Match": etag! },
    });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
    // A paper write moves it too, since rows carry their papers.
    const next = changed.headers.get("etag")!;
    app.service.upsertPaper({
      id: "paper-1",
      title: "Roster Study Renamed",
      authors: ["Person 104"],
      current_step: "submission",
    });
    const afterPaper = await fetch(first.url, {
      headers: { Authorization: "Bearer test-token", "If-None-Match": next },
    });
    expect(afterPaper.status).toBe(200);
    expect((await afterPaper.json()).members[0].roster_papers[0].title).toBe(
      "Roster Study Renamed",
    );
  });
});
