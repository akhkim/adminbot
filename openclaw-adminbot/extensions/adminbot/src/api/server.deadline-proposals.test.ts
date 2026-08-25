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

async function startService() {
  const mock = createAdminBotMockService({
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
        body: JSON.stringify(input()),
      });
      expect(submittedResponse.status).toBe(201);
      const submitted = (await submittedResponse.json()) as DeadlineProposalView;
      expect(submitted.status).toBe("pending");

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
