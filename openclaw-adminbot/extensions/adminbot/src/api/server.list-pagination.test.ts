import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAdminBotMockService } from "./server.js";

const token = "test-list-token";

describe.each(["memory", "sqlite"] as const)("paginated list routes (%s)", (kind) => {
  it("pages and searches permitted fields without changing legacy responses or redaction", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "adminbot-list-page-"));
    const mock = createAdminBotMockService({
      serviceToken: token,
      ...(kind === "sqlite" ? { databasePath: path.join(tempDir, "state.sqlite") } : {}),
      calendarInviteRunner: async () => {},
      accountApprovedEmailRunner: async () => {},
    });
    try {
      for (const member of [
        { id: "ada", name: "Ada", email: "ada@example.org", research_topics: ["Causality"] },
        { id: "ben", name: "Ben", email: "ben@example.org", projects: ["Robotics"] },
        { id: "cy", name: "Cy", email: "cy@example.org", personal_circumstances: "private-query" },
      ]) {
        const saved = mock.service.upsertLabMember({ ...member, privilege_level: "member" });
        expect(saved.ok).toBe(true);
      }
      for (const paper of [
        { id: "p1", title: "Causal Methods", authors: ["Ada"], venue: "ICLR" },
        { id: "p2", title: "Systems", authors: ["Ben"], venue: "NeurIPS" },
        { id: "p3", title: "Systems", authors: ["Cy"], venue: "EACL" },
      ]) {
        const saved = mock.service.upsertPaper({ ...paper, current_step: "overleaf_writing" });
        expect(saved.ok).toBe(true);
      }
      const ada = mock.store.getLabMember("ada")!;
      mock.store.saveLabMember({
        ...ada,
        personal_circumstances: "private-self",
        field_provenance: { name: { source: "member", at: "2026-09-01T00:00:00.000Z" } },
        onboarding: {
          completed: [],
          remaining: [],
          steps: [
            {
              id: "social",
              label: "Follow the lab",
              category: "Welcome",
              status: "remaining",
              required: true,
              detail: "Long onboarding instructions should stay out of summary rows.",
            },
          ],
        },
      });
      const cyStored = mock.store.getLabMember("cy")!;
      mock.store.saveLabMember({ ...cyStored, onboarding: null as never });
      const benStored = { ...mock.store.getLabMember("ben")! };
      delete benStored.onboarding;
      mock.store.saveLabMember(benStored);
      mock.store.saveBadgeAssignment({
        member_id: "ada",
        badge_id: "community_building__ambassador",
        family_key: "community_building",
        awarded_at: "2026-09-01T00:00:00.000Z",
        awarded_by: "test-admin",
        source: "admin",
      });
      const badgeDefs = vi.spyOn(mock.store, "listBadgeDefinitions");
      const badgeAssignments = vi.spyOn(mock.store, "listBadgeAssignments");
      await new Promise<void>((resolve, reject) => {
        mock.server.once("error", reject);
        mock.server.listen(0, "127.0.0.1", resolve);
      });
      const address = mock.server.address();
      if (!address || typeof address === "string") {
        throw new Error("missing server address");
      }
      const base = `http://127.0.0.1:${address.port}`;
      const get = async (route: string) => {
        const response = await fetch(`${base}${route}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        return { status: response.status, body: await response.json() };
      };

      const legacy = await get("/lab/members");
      expect(legacy.status).toBe(200);
      expect(Object.keys(legacy.body)).toEqual(["members"]);
      expect(legacy.body.members).toHaveLength(3);
      expect(legacy.body.members[0].assigned_badges).toMatchObject([
        { badge_id: "community_building__ambassador" },
      ]);
      expect(badgeDefs).toHaveBeenCalledTimes(1);
      expect(badgeAssignments).toHaveBeenCalledTimes(1);

      const summary = await get("/lab/members?view=summary");
      expect(summary.status).toBe(200);
      expect(summary.body.self).toBeUndefined();
      const adaSummary = summary.body.members.find((member: { id: string }) => member.id === "ada");
      expect(adaSummary).toMatchObject({
        id: "ada",
        onboarding: { steps: [{ id: "social", status: "remaining" }] },
        assigned_badges: [{ badge_id: "community_building__ambassador" }],
      });
      expect(adaSummary.field_provenance).toBeUndefined();
      expect(adaSummary.access).toBeUndefined();
      expect(adaSummary.personal_circumstances).toBeUndefined();
      expect(adaSummary.onboarding.steps[0].detail).toBeUndefined();
      expect(
        summary.body.members.find((member: { id: string }) => member.id === "ben").onboarding,
      ).toBeUndefined();
      expect(
        summary.body.members.find((member: { id: string }) => member.id === "cy").onboarding,
      ).toBeNull();

      const claim = await mock.auth.claim({
        member_id: "ada",
        email: "ada@example.org",
        password: "correcthorse",
      });
      expect(claim.ok).toBe(true);
      const registration = (await mock.auth.listRegistrations("pending")).find(
        (entry) => entry.member_id === "ada",
      );
      expect(registration).toBeDefined();
      expect((await mock.auth.approveRegistration(registration!.id, "test-admin")).ok).toBe(true);
      const login = await mock.auth.login({ email: "ada@example.org", password: "correcthorse" });
      if (!login.ok) {
        throw new Error(login.error.message);
      }
      const selfResponse = await fetch(`${base}/lab/members/self`, {
        headers: { Authorization: `Bearer ${login.payload.session_token}` },
      });
      expect(selfResponse.status).toBe(200);
      expect(await selfResponse.json()).toMatchObject({
        member: {
          id: "ada",
          personal_circumstances: "private-self",
          field_provenance: { name: { source: "member" } },
          assigned_badges: [{ badge_id: "community_building__ambassador" }],
        },
      });
      expect((await get("/lab/members/self")).status).toBe(403);
      const ownResponse = await fetch(`${base}/lab/members?view=summary`, {
        headers: { Authorization: `Bearer ${login.payload.session_token}` },
      });
      const ownSummary = await ownResponse.json();
      expect(ownSummary.self).toMatchObject({
        id: "ada",
        personal_circumstances: "private-self",
        field_provenance: { name: { source: "member" } },
        onboarding: { steps: [{ id: "social", detail: expect.any(String) }] },
      });
      expect(ownSummary.self.access).toEqual(expect.any(Array));
      expect(
        ownSummary.members.find((member: { id: string }) => member.id === "cy"),
      ).not.toHaveProperty("personal_circumstances");
      expect((await get("/lab/members?view=bogus")).status).toBe(400);
      expect((await get("/lab/members?view=summary&limit=1")).status).toBe(400);

      expect(await get("/lab/members?limit=1&offset=1")).toMatchObject({
        status: 200,
        body: { total: 3, limit: 1, offset: 1, members: [{ id: "ben" }] },
      });
      expect(badgeAssignments).toHaveBeenLastCalledWith(["ben"]);
      expect(await get("/lab/members?limit=10&q=causal")).toMatchObject({
        body: { total: 1, members: [{ id: "ada" }] },
      });
      expect(await get("/lab/members?q=ben%40example.org")).toMatchObject({
        body: { total: 1, limit: 50, members: [{ id: "ben" }] },
      });
      expect(await get("/lab/members?limit=1&offset=2&q=example.org")).toMatchObject({
        body: { total: 3, members: [{ id: "cy" }] },
      });
      expect(await get("/lab/members?q=robotics")).toMatchObject({
        body: { total: 1, members: [{ id: "ben" }] },
      });
      expect(await get("/lab/members?q=private-query")).toMatchObject({
        body: { total: 0, members: [] },
      });
      const cy = (await get("/lab/members?limit=10")).body.members.find(
        (member: { id: string }) => member.id === "cy",
      );
      expect(cy.personal_circumstances).toBeUndefined();

      expect(Object.keys((await get("/papers")).body)).toEqual(["papers"]);
      expect(await get("/papers?limit=1&offset=2")).toMatchObject({
        body: { total: 3, limit: 1, offset: 2, papers: [{ id: "p3" }] },
      });
      expect(await get("/papers?limit=5&q=ada")).toMatchObject({
        body: { total: 1, papers: [{ id: "p1" }] },
      });
      expect(await get("/papers?limit=5&q=eacl")).toMatchObject({
        body: { total: 1, papers: [{ id: "p3" }] },
      });
      expect(await get("/papers?limit=1&offset=1&q=systems")).toMatchObject({
        body: { total: 2, papers: [{ id: "p3" }] },
      });
      for (const route of [
        "/lab/members?limit=0",
        "/lab/members?limit=101",
        "/lab/members?offset=-1",
        "/papers?limit=nope",
      ]) {
        expect((await get(route)).status).toBe(400);
      }
    } finally {
      await new Promise<void>((resolve) => {
        mock.server.close(() => resolve());
      });
      mock.close();
      await rm(tempDir, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });
});
