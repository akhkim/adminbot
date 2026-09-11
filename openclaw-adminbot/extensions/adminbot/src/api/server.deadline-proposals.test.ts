import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AdminBotPrivilegeLevel } from "../contracts/actions.js";
import type {
  DeadlineProposalInput,
  DeadlineProposalView,
} from "../contracts/deadline-proposals.js";
import { createAdminBotMockService } from "./server.js";

function input(): DeadlineProposalInput {
  return {
    name: "API Workshop",
    parentConference: "EMNLP",
    parentYear: "2026",
    entryType: "workshop",
    deadlineDate: "2026-10-01",
    deadlineTime: "17:00",
    timezone: "Europe/Zurich",
    homepageUrl: "https://example.org/api-workshop/home",
    cfpUrl: "https://example.org/api-workshop/cfp",
    openReviewUrl: "",
    note: "Check the local-time conversion.",
  };
}

async function startService(databasePath?: string) {
  const mock = createAdminBotMockService({
    ...(databasePath ? { databasePath } : {}),
    serviceToken: "service-token",
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
    dcsFormRunner: async () => {},
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
    throw new Error("missing service address");
  }
  return { mock, baseUrl: `http://127.0.0.1:${address.port}` };
}

function createSession(
  mock: ReturnType<typeof createAdminBotMockService>,
  id: string,
  privilegeLevel: AdminBotPrivilegeLevel,
): string {
  const email = `${id}@cs.toronto.edu`;
  const member = mock.service.upsertLabMember({
    id,
    name: id,
    email,
    privilege_level: privilegeLevel,
  });
  if (!member.ok) {
    throw new Error(member.error.message);
  }
  const claim = mock.auth.claim({ member_id: id, email, password: "correcthorse" });
  if (!claim.ok) {
    throw new Error(claim.error.message);
  }
  const registration = mock.auth
    .listRegistrations("pending")
    .find((entry) => entry.member_id === id);
  if (!registration) {
    throw new Error("missing registration");
  }
  const approved = mock.auth.approveRegistration(registration.id, "bootstrap-admin");
  if (!approved.ok) {
    throw new Error(approved.error.message);
  }
  const login = mock.auth.login({ email, password: "correcthorse" });
  if (!login.ok) {
    throw new Error(login.error.message);
  }
  return login.payload.session_token;
}

describe("deadline proposal API", () => {
  it("enforces member submission and administrator review, then publishes publicly", async () => {
    const { mock, baseUrl } = await startService();
    try {
      const memberToken = createSession(mock, "member-one", "member");
      const otherMemberToken = createSession(mock, "member-two", "member");
      const adminToken = createSession(mock, "admin-one", "admin");

      const missingKey = await fetch(`${baseUrl}/deadline-proposals`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${memberToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input()),
      });
      expect(missingKey.status).toBe(400);

      const submittedResponse = await fetch(`${baseUrl}/deadline-proposals`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${memberToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "api-submit-1",
        },
        body: JSON.stringify({
          ...input(),
          submitter_contact: { name: "Impersonator", email: "wrong@example.org" },
        }),
      });
      expect(submittedResponse.status).toBe(201);
      const submitted = (await submittedResponse.json()) as DeadlineProposalView;
      expect(submitted.status).toBe("pending");
      expect(submitted).toMatchObject({
        submitter_name: "member-one",
        submitter_email: "member-one@cs.toronto.edu",
      });

      const otherSubmittedResponse = await fetch(`${baseUrl}/deadline-proposals`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${otherMemberToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "api-submit-other",
        },
        body: JSON.stringify({ ...input(), name: "Other Member Workshop" }),
      });
      const otherSubmitted = (await otherSubmittedResponse.json()) as DeadlineProposalView;

      const memberQueue = await fetch(`${baseUrl}/deadline-proposals`, {
        headers: { Authorization: `Bearer ${memberToken}` },
      });
      expect(memberQueue.status).toBe(200);
      await expect(memberQueue.json()).resolves.toEqual({
        proposals: [expect.objectContaining({ id: submitted.id, submitter_name: "member-one" })],
      });

      const adminQueue = await fetch(`${baseUrl}/deadline-proposals`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(adminQueue.status).toBe(200);
      const adminQueueBody = (await adminQueue.json()) as { proposals: DeadlineProposalView[] };
      expect(adminQueueBody.proposals.map((proposal) => proposal.id).toSorted()).toEqual(
        [submitted.id, otherSubmitted.id].toSorted(),
      );
      expect(adminQueueBody.proposals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: submitted.id, submitter_name: "member-one" }),
          expect.objectContaining({ id: otherSubmitted.id, submitter_name: "member-two" }),
        ]),
      );

      const memberRevision = await fetch(
        `${baseUrl}/deadline-proposals/${encodeURIComponent(submitted.id)}/revisions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${memberToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ...input(), note: "Member cannot revise the queue." }),
        },
      );
      expect(memberRevision.status).toBe(403);

      const revisionResponse = await fetch(
        `${baseUrl}/deadline-proposals/${encodeURIComponent(submitted.id)}/revisions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ...input(), deadlineDate: "2026-10-02" }),
        },
      );
      expect(revisionResponse.status).toBe(200);
      const revision = (await revisionResponse.json()) as DeadlineProposalView;
      expect(revision).toMatchObject({ current_revision: 2, status: "pending" });

      const publishedResponse = await fetch(
        `${baseUrl}/deadline-proposals/${encodeURIComponent(submitted.id)}/publish`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ payload_hash: revision.payload_hash }),
        },
      );
      expect(publishedResponse.status).toBe(200);
      await expect(publishedResponse.json()).resolves.toMatchObject({ status: "published" });

      const publicDataset = await fetch(`${baseUrl}/deadlines/venues.json`);
      const publicBody = (await publicDataset.json()) as {
        items: Array<{
          name?: string;
          venue_group?: string;
          homepage_url?: string;
          cfp_url?: string;
        }>;
      };
      expect(publicBody.items).toContainEqual(
        expect.objectContaining({
          name: "API Workshop",
          venue_group: "EMNLP 2026 Workshops",
          homepage_url: "https://example.org/api-workshop/home",
          cfp_url: "https://example.org/api-workshop/cfp",
        }),
      );

      const rejectedSubmission = await fetch(`${baseUrl}/deadline-proposals`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${memberToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "api-submit-2",
        },
        body: JSON.stringify({ ...input(), name: "Rejected Workshop" }),
      });
      const rejected = (await rejectedSubmission.json()) as DeadlineProposalView;
      const rejection = await fetch(
        `${baseUrl}/deadline-proposals/${encodeURIComponent(rejected.id)}/reject`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ note: "Not an official source." }),
        },
      );
      expect(rejection.status).toBe(200);
      await expect(rejection.json()).resolves.toMatchObject({ status: "rejected" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        mock.server.close((error) => (error ? reject(error) : resolve()));
      });
      mock.close();
    }
  });

  it("does not expose proposal creation to anonymous or service principals", async () => {
    const { mock, baseUrl } = await startService();
    try {
      const anonymous = await fetch(`${baseUrl}/deadline-proposals`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "anon-1" },
        body: JSON.stringify(input()),
      });
      expect(anonymous.status).toBe(401);

      const service = await fetch(`${baseUrl}/deadline-proposals`, {
        method: "POST",
        headers: {
          Authorization: "Bearer service-token",
          "Content-Type": "application/json",
          "Idempotency-Key": "service-1",
        },
        body: JSON.stringify(input()),
      });
      expect(service.status).toBe(403);

      expect((await fetch(`${baseUrl}/deadline-proposals`)).status).toBe(401);
      expect(
        (
          await fetch(`${baseUrl}/deadline-proposals`, {
            headers: { Authorization: "Bearer service-token" },
          })
        ).status,
      ).toBe(403);
    } finally {
      await new Promise<void>((resolve, reject) => {
        mock.server.close((error) => (error ? reject(error) : resolve()));
      });
      mock.close();
    }
  });
});

describe("public deadline proposals", () => {
  const key = "7ab6fa62-3419-43b7-b3c8-0a266277ef6a";
  const headers = { "Content-Type": "application/json", "Idempotency-Key": key };

  it("keeps visitor proposals private through revision and exact-hash publication", async () => {
    const { mock, baseUrl } = await startService();
    try {
      const submit = (body = input()) =>
        fetch(`${baseUrl}/public/deadline-proposals`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            ...body,
            submitter_member_id: "admin-one",
            submitter_contact: { name: "  Taylor Visitor  ", email: " taylor@example.org " },
          }),
        });
      const response = await submit();
      expect(response.status).toBe(202);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({ status: "received" });
      await expect((await submit()).json()).resolves.toEqual({ status: "received" });
      const queue = mock.service.listDeadlineProposals();
      if (!queue.ok) {
        throw new Error("missing queue");
      }
      expect(queue.payload.proposals).toHaveLength(1);
      const proposal = queue.payload.proposals[0]!;
      expect(proposal).toMatchObject({
        status: "pending",
        submitter_name: "Taylor Visitor",
        submitter_email: "taylor@example.org",
      });
      expect(proposal.submitter_member_id).toMatch(/^visitor:deadline:/u);
      const publicBefore = await (await fetch(`${baseUrl}/deadlines/venues.json`)).text();
      expect(publicBefore).not.toContain("API Workshop");
      const memberToken = createSession(mock, "member-visitor-test", "member");
      const adminToken = createSession(mock, "admin-visitor-test", "admin");
      const ownQueue = await fetch(`${baseUrl}/deadline-proposals`, {
        headers: { Authorization: `Bearer ${memberToken}` },
      });
      await expect(ownQueue.json()).resolves.toEqual({ proposals: [] });
      expect((await fetch(`${baseUrl}/deadline-proposals`)).status).toBe(401);
      const adminQueue = await fetch(`${baseUrl}/deadline-proposals`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      await expect(adminQueue.json()).resolves.toMatchObject({
        proposals: [{ submitter_name: "Taylor Visitor", submitter_email: "taylor@example.org" }],
      });
      for (const operation of ["revisions", "reject", "publish"]) {
        for (const token of [undefined, memberToken, "service-token"]) {
          const denied = await fetch(`${baseUrl}/deadline-proposals/${proposal.id}/${operation}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ ...input(), payload_hash: proposal.payload_hash }),
          });
          expect([401, 403]).toContain(denied.status);
        }
      }
      const revisionResponse = await fetch(
        `${baseUrl}/deadline-proposals/${proposal.id}/revisions`,
        {
          method: "POST",
          headers: { ...headers, Authorization: `Bearer ${adminToken}` },
          body: JSON.stringify({ ...input(), name: "Reviewed Visitor Workshop" }),
        },
      );
      expect(revisionResponse.status).toBe(200);
      const revision = (await revisionResponse.json()) as DeadlineProposalView;
      expect(revision).toMatchObject({
        submitter_name: "Taylor Visitor",
        submitter_email: "taylor@example.org",
      });
      const publish = (hash: string) =>
        fetch(`${baseUrl}/deadline-proposals/${proposal.id}/publish`, {
          method: "POST",
          headers: { ...headers, Authorization: `Bearer ${adminToken}` },
          body: JSON.stringify({ payload_hash: hash }),
        });
      expect((await publish(proposal.payload_hash)).status).toBe(409);
      expect((await publish(revision.payload_hash)).status).toBe(200);
      const published = await (await fetch(`${baseUrl}/deadlines/venues.json`)).text();
      expect(published).toContain("Reviewed Visitor Workshop");
      expect(published).not.toContain("visitor:deadline:");
      expect(published).not.toContain(proposal.payload_hash);
      expect(published).not.toContain("taylor@example.org");
      expect(published).not.toContain("Taylor Visitor");
      await expect((await submit()).json()).resolves.toEqual({ status: "received" });
    } finally {
      await new Promise<void>((resolve) => {
        mock.server.close(() => resolve());
      });
      mock.close();
    }
  });

  it("rejects invalid input and oversized bodies before enqueueing", async () => {
    const { mock, baseUrl } = await startService();
    try {
      const post = (body: string, extra = {}) =>
        fetch(`${baseUrl}/public/deadline-proposals`, {
          method: "POST",
          headers: { ...headers, ...extra },
          body,
        });
      expect(
        (await post(JSON.stringify(input()), { Origin: "https://untrusted.example" })).status,
      ).toBe(403);
      expect(
        (await post(JSON.stringify({ ...input(), submitter_contact: { email: "invalid" } })))
          .status,
      ).toBe(400);
      expect((await post("{")).status).toBe(400);
      expect((await post(JSON.stringify({ ...input(), note: "x".repeat(2001) }))).status).toBe(400);
      expect((await post(JSON.stringify({ ...input(), note: "x".repeat(17000) }))).status).toBe(
        413,
      );
      expect((await post(JSON.stringify(input()), { "Content-Type": "text/plain" })).status).toBe(
        415,
      );
      const limited = await post(JSON.stringify(input()), { "X-Forwarded-For": "198.51.100.99" });
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(mock.service.listDeadlineProposals()).toMatchObject({ payload: { proposals: [] } });
    } finally {
      await new Promise<void>((resolve) => {
        mock.server.close(() => resolve());
      });
      mock.close();
    }
  });

  it("accepts missing or non-UUID retry keys and keeps the public route write-only", async () => {
    const { mock, baseUrl } = await startService();
    try {
      for (const validKey of [undefined, "browser-retry", "browser-retry"]) {
        const response = await fetch(`${baseUrl}/public/deadline-proposals`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(validKey ? { "Idempotency-Key": validKey } : {}),
          },
          body: JSON.stringify({ ...input(), submitter_contact: { name: "", email: "" } }),
        });
        expect(response.status).toBe(202);
      }
      const queue = mock.service.listDeadlineProposals();
      if (!queue.ok) {
        throw new Error("missing queue");
      }
      expect(queue.payload.proposals).toHaveLength(2);
      expect(queue.payload.proposals[0]).toMatchObject({ submitter_name: "External visitor" });
      expect(queue.payload.proposals[0]?.submitter_email).toBeUndefined();
      const oversizedKey = await fetch(`${baseUrl}/public/deadline-proposals`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": "x".repeat(201) },
        body: JSON.stringify(input()),
      });
      expect(oversizedKey.status).toBe(400);
      expect((await fetch(`${baseUrl}/public/deadline-proposals`)).status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => {
        mock.server.close(() => resolve());
      });
      mock.close();
    }
  });
});

it("persists a visitor submission and its retry key across restarts without creating a member", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "adminbot-visitor-"));
  const databasePath = path.join(directory, "test.sqlite");
  let originalId = "";
  try {
    for (let run = 0; run < 2; run++) {
      const { mock, baseUrl } = await startService(databasePath);
      try {
        const response = await fetch(`${baseUrl}/public/deadline-proposals`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "c69641df-f7f9-4e9b-bdbf-7466401193f2",
          },
          body: JSON.stringify({
            ...input(),
            name: run === 0 ? "Durable Visitor Workshop" : "Changed retry",
            submitter_contact:
              run === 0
                ? { name: "Taylor", email: "taylor@example.org" }
                : { name: "Changed contact" },
          }),
        });
        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toEqual({ status: "received" });
        const queue = mock.service.listDeadlineProposals();
        if (!queue.ok) {
          throw new Error("missing queue");
        }
        expect(queue.payload.proposals).toHaveLength(1);
        const proposal = queue.payload.proposals[0]!;
        expect(proposal.deadline.name).toBe("Durable Visitor Workshop");
        expect(proposal).toMatchObject({
          submitter_name: "Taylor",
          submitter_email: "taylor@example.org",
        });
        expect(mock.store.getLabMember(proposal.submitter_member_id)).toBeUndefined();
        if (run === 0) {
          originalId = proposal.id;
        } else {
          expect(proposal.id).toBe(originalId);
          const adminToken = createSession(mock, "admin-durable-test", "admin");
          const rejection = await fetch(`${baseUrl}/deadline-proposals/${proposal.id}/reject`, {
            method: "POST",
            headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
            body: "{}",
          });
          expect(rejection.status).toBe(200);
          expect(await (await fetch(`${baseUrl}/deadlines/venues.json`)).text()).not.toContain(
            "Durable Visitor Workshop",
          );
        }
      } finally {
        await new Promise<void>((resolve) => {
          mock.server.close(() => resolve());
        });
        mock.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
