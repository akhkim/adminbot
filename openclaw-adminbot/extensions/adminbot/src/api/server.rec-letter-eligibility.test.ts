// The letter-eligibility and freeze routes over real HTTP: who may read and write what.
//
// Its own harness rather than a borrowed one: these tests need two members and an admin with real
// session tokens, and the point of most of them is what a member is *not* shown.
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withCompleteProfile } from "../contracts/profile-completion.test-helpers.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-service-token";
const PASSWORD = "correcthorse";

const running: { mock: ReturnType<typeof createAdminBotMockService>; cleanup: string }[] = [];

afterEach(async () => {
  while (running.length > 0) {
    const entry = running.pop();
    if (!entry) {
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      entry.mock.server.close((error) => (error ? reject(error) : resolve()));
    });
    entry.mock.close();
    await rm(entry.cleanup, { force: true });
  }
});

type Lab = {
  baseUrl: string;
  tokens: Record<string, string>;
  mock: ReturnType<typeof createAdminBotMockService>;
};

async function startLab(): Promise<Lab> {
  const sensitiveInfoPath = path.join(
    os.tmpdir(),
    `adminbot-rec-eligibility-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
  );
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    sensitiveInfoPath,
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
    dcsRosterRecorder: async () => ({
      username: "stub@example.test",
      password: "stub",
      candidates: ["stub@example.test"],
    }),
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
    throw new Error("missing mock service address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  running.push({ mock, cleanup: sensitiveInfoPath });

  const tokens: Record<string, string> = {};
  for (const [id, privilege] of [
    ["m-alpha", "member"],
    ["m-beta", "member"],
    ["m-admin", "admin"],
  ] as const) {
    const seeded = mock.service.upsertLabMember(
      withCompleteProfile({
        id,
        name: `Member ${id}`,
        email: `${id}@example.test`,
        privilege_level: privilege,
        joined_month: "2025-01",
      }),
    );
    if (!seeded.ok) {
      throw new Error(seeded.error.message);
    }
    await fetch(`${baseUrl}/auth/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member_id: id, email: `${id}@example.test`, password: PASSWORD }),
    });
    const pending = await fetch(`${baseUrl}/auth/registrations?status=pending`, {
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    const registrations = (
      (await pending.json()) as { registrations: { id: string; member_id?: string }[] }
    ).registrations;
    const claim = registrations.find((entry) => entry.member_id === id);
    if (!claim) {
      throw new Error(`no pending claim for ${id}`);
    }
    const approved = await mock.auth.approveRegistration(claim.id, "test-admin");
    if (!approved.ok) {
      throw new Error(approved.error.message);
    }
    const login = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `${id}@example.test`, password: PASSWORD }),
    });
    tokens[id] = ((await login.json()) as { session_token: string }).session_token;
  }
  return { baseUrl, tokens, mock };
}

function call(lab: Lab, who: string, pathname: string, init: RequestInit = {}) {
  const bearer = who === "service" ? SERVICE_TOKEN : lab.tokens[who];
  return fetch(`${lab.baseUrl}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

const SECRET_NOTE = "admin-only context that must not reach the member";

async function recordFreeze(lab: Lab, memberId = "m-alpha", occurredOn = "2026-01-15") {
  const response = await call(lab, "m-admin", "/logistics/freeze-incidents", {
    method: "POST",
    body: JSON.stringify({
      member_id: memberId,
      kind: "hallucinated_citation_desk_rejection",
      occurred_on: occurredOn,
      paper_id: "paper-synthetic-1",
      note: SECRET_NOTE,
    }),
  });
  return { response, body: (await response.json()) as { id: string; created_by: string } };
}

describe("freeze incidents", () => {
  it("lets an admin record, list and delete one, auditing each change", async () => {
    const lab = await startLab();
    const { response, body } = await recordFreeze(lab);
    expect(response.status).toBe(201);
    expect(body.id).toMatch(/^rlfreeze_/);
    expect(body.created_by).toBe("m-admin");

    const listed = await call(lab, "m-admin", "/logistics/freeze-incidents?member_id=m-alpha");
    expect(listed.status).toBe(200);
    const incidents = ((await listed.json()) as { incidents: { id: string; note?: string }[] })
      .incidents;
    expect(incidents.map((incident) => incident.id)).toEqual([body.id]);
    expect(incidents[0]?.note).toBe(SECRET_NOTE);

    const removed = await call(lab, "m-admin", `/logistics/freeze-incidents/${body.id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    const again = await call(lab, "m-admin", `/logistics/freeze-incidents/${body.id}`, {
      method: "DELETE",
    });
    expect(again.status).toBe(404);

    const audit = lab.mock.store
      .listAuditEvents()
      .filter((event) => event.type.startsWith("rec_letter_freeze."));
    expect(audit.map((event) => event.type).toSorted()).toEqual([
      "rec_letter_freeze.deleted",
      "rec_letter_freeze.recorded",
    ]);
    // The note is the lab's context, not something to copy into a trail read more widely.
    expect(JSON.stringify(audit)).not.toContain(SECRET_NOTE);
  });

  it("refuses members and the service token on every verb", async () => {
    const lab = await startLab();
    const { body } = await recordFreeze(lab);
    for (const who of ["m-alpha", "m-beta", "service"]) {
      expect((await call(lab, who, "/logistics/freeze-incidents")).status).toBe(403);
      expect(
        (
          await call(lab, who, "/logistics/freeze-incidents", {
            method: "POST",
            body: JSON.stringify({ member_id: "m-beta", occurred_on: "2026-01-15" }),
          })
        ).status,
      ).toBe(403);
      expect(
        (await call(lab, who, `/logistics/freeze-incidents/${body.id}`, { method: "DELETE" }))
          .status,
      ).toBe(403);
    }
  });

  it("refuses an unknown member, a bad date and a future date", async () => {
    const lab = await startLab();
    const post = (payload: object) =>
      call(lab, "m-admin", "/logistics/freeze-incidents", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    expect((await post({ member_id: "m-nobody", occurred_on: "2026-01-15" })).status).toBe(404);
    expect((await post({ member_id: "m-alpha", occurred_on: "2026-02-30" })).status).toBe(400);
    expect((await post({ member_id: "m-alpha", occurred_on: "2999-01-01" })).status).toBe(400);
    expect(
      (await post({ member_id: "m-alpha", occurred_on: "2026-01-15", kind: "other" })).status,
    ).toBe(400);
  });
});

describe("eligibility reads", () => {
  it("shows the admin the full result and the incidents, by member or by request", async () => {
    const lab = await startLab();
    const { body: incident } = await recordFreeze(
      lab,
      "m-alpha",
      new Date().toISOString().slice(0, 10),
    );
    const byMember = await call(lab, "m-admin", "/logistics/eligibility?member_id=m-alpha");
    expect(byMember.status).toBe(200);
    const payload = (await byMember.json()) as {
      eligibility: {
        status: string;
        freeze: { latest_incident_id?: string; incident_count?: number };
      };
      incidents: { id: string; note?: string }[];
    };
    expect(payload.eligibility.status).toBe("frozen");
    expect(payload.eligibility.freeze).toMatchObject({
      latest_incident_id: incident.id,
      incident_count: 1,
    });
    expect(payload.incidents[0]?.note).toBe(SECRET_NOTE);

    const filed = await call(lab, "m-alpha", "/logistics/requests", {
      method: "POST",
      body: JSON.stringify({
        kind: "recommendation_letters",
        schools: [{ school: "Synthetic University", letter_deadline: "2027-12-01" }],
      }),
    });
    expect(filed.status).toBe(201);
    const requestId = ((await filed.json()) as { id: string }).id;
    const byRequest = await call(
      lab,
      "m-admin",
      `/logistics/eligibility?request_id=${encodeURIComponent(requestId)}`,
    );
    expect(byRequest.status).toBe(200);
    expect(((await byRequest.json()) as { member: { id: string } }).member.id).toBe("m-alpha");

    expect((await call(lab, "m-admin", "/logistics/eligibility")).status).toBe(400);
    expect((await call(lab, "m-admin", "/logistics/eligibility?request_id=nope")).status).toBe(404);
  });

  it("never lets a member read somebody else's result", async () => {
    const lab = await startLab();
    await recordFreeze(lab, "m-beta");
    for (const pathname of [
      "/logistics/eligibility?member_id=m-beta",
      "/logistics/eligibility?member_id=m-alpha",
      "/logistics/eligibility/summary?member_ids=m-beta",
    ]) {
      expect((await call(lab, "m-alpha", pathname)).status).toBe(403);
    }
  });

  it("gives a member their own result with the date and nothing else about the freeze", async () => {
    const lab = await startLab();
    const today = new Date().toISOString().slice(0, 10);
    const { body: incident } = await recordFreeze(lab, "m-alpha", today);
    const own = await call(lab, "m-alpha", "/logistics/eligibility/me?member_id=m-beta");
    expect(own.status).toBe(200);
    const text = await own.text();
    const payload = JSON.parse(text) as {
      member_id: string;
      status: string;
      freeze: Record<string, unknown>;
    };
    // The query is ignored: the route reads the session, never a parameter.
    expect(payload.member_id).toBe("m-alpha");
    expect(payload.status).toBe("frozen");
    expect(Object.keys(payload.freeze).toSorted()).toEqual(["frozen", "frozen_until"]);
    expect(text).not.toContain(SECRET_NOTE);
    expect(text).not.toContain(incident.id);
    expect(text).not.toContain("paper-synthetic-1");

    // A colleague's freeze is not in their own read either.
    const beta = await call(lab, "m-beta", "/logistics/eligibility/me");
    const betaPayload = (await beta.json()) as { status: string; freeze: { frozen: boolean } };
    expect(betaPayload.freeze.frozen).toBe(false);
    expect(betaPayload.status).not.toBe("frozen");
  });

  it("summarizes a page of members for the queue badges", async () => {
    const lab = await startLab();
    await recordFreeze(lab, "m-beta", new Date().toISOString().slice(0, 10));
    const response = await call(
      lab,
      "m-admin",
      "/logistics/eligibility/summary?member_ids=m-alpha,m-beta,m-nobody",
    );
    expect(response.status).toBe(200);
    const { summaries } = (await response.json()) as {
      summaries: { member_id: string; status: string; frozen_until?: string }[];
    };
    expect(summaries.map((entry) => [entry.member_id, entry.status])).toEqual([
      ["m-alpha", "insufficient_data"],
      ["m-beta", "frozen"],
    ]);
    expect(summaries[1]?.frozen_until).toBeDefined();
    const tooMany = Array.from({ length: 101 }, (_, index) => `m-${index}`).join(",");
    expect(
      (await call(lab, "m-admin", `/logistics/eligibility/summary?member_ids=${tooMany}`)).status,
    ).toBe(400);
  });
});

const ATTEST_NOTE = "admin-only reason for confirming the hours";

describe("attestations", () => {
  it("lets an admin confirm hours, counts them as met and audits each change", async () => {
    const lab = await startLab();
    const before = await call(lab, "m-admin", "/logistics/eligibility?member_id=m-alpha");
    expect(((await before.json()) as { eligibility: { status: string } }).eligibility.status).toBe(
      "insufficient_data",
    );

    const created = await call(lab, "m-admin", "/logistics/eligibility-attestations", {
      method: "POST",
      body: JSON.stringify({ member_id: "m-alpha", criterion: "hours", note: ATTEST_NOTE }),
    });
    expect(created.status).toBe(201);
    const attestation = (await created.json()) as { id: string; created_by: string };
    expect(attestation.id).toMatch(/^rlattest_/);
    expect(attestation.created_by).toBe("m-admin");

    const after = await call(lab, "m-admin", "/logistics/eligibility?member_id=m-alpha");
    const payload = (await after.json()) as {
      eligibility: { status: string; hours: { status: string; attested?: { note?: string } } };
      attestations: { id: string; note?: string }[];
    };
    expect(payload.eligibility.status).toBe("eligible");
    expect(payload.eligibility.hours).toMatchObject({
      status: "met",
      attested: { note: ATTEST_NOTE },
    });
    expect(payload.attestations.map((entry) => entry.id)).toEqual([attestation.id]);

    // The member sees that it was confirmed, not by whom or why.
    const own = await call(lab, "m-alpha", "/logistics/eligibility/me");
    const ownText = await own.text();
    const ownPayload = JSON.parse(ownText) as {
      status: string;
      hours: { attested?: Record<string, unknown> };
    };
    expect(ownPayload.status).toBe("eligible");
    expect(Object.keys(ownPayload.hours.attested ?? {}).toSorted()).toEqual([
      "at",
      "attestation_id",
    ]);
    expect(ownText).not.toContain(ATTEST_NOTE);

    const removed = await call(
      lab,
      "m-admin",
      `/logistics/eligibility-attestations/${attestation.id}`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
    const gone = await call(
      lab,
      "m-admin",
      "/logistics/eligibility-attestations?member_id=m-alpha",
    );
    expect(((await gone.json()) as { attestations: unknown[] }).attestations).toEqual([]);

    const audit = lab.mock.store
      .listAuditEvents()
      .filter((event) => event.type.startsWith("rec_letter_attestation."));
    expect(audit.map((event) => event.type).toSorted()).toEqual([
      "rec_letter_attestation.deleted",
      "rec_letter_attestation.recorded",
    ]);
    expect(audit[0]?.details).toMatchObject({ member_id: "m-alpha", criterion: "hours" });
    expect(JSON.stringify(audit)).not.toContain(ATTEST_NOTE);
  });

  it("refuses members and the service token, and bad input", async () => {
    const lab = await startLab();
    for (const who of ["m-alpha", "m-beta", "service"]) {
      expect((await call(lab, who, "/logistics/eligibility-attestations")).status).toBe(403);
      expect(
        (
          await call(lab, who, "/logistics/eligibility-attestations", {
            method: "POST",
            body: JSON.stringify({ member_id: who, criterion: "hours" }),
          })
        ).status,
      ).toBe(403);
      expect(
        (await call(lab, who, "/logistics/eligibility-attestations/x", { method: "DELETE" }))
          .status,
      ).toBe(403);
    }
    const post = (payload: object) =>
      call(lab, "m-admin", "/logistics/eligibility-attestations", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    expect((await post({ member_id: "m-nobody", criterion: "hours" })).status).toBe(404);
    expect((await post({ member_id: "m-alpha", criterion: "freeze" })).status).toBe(400);
    expect(
      (await call(lab, "m-admin", "/logistics/eligibility-attestations/x", { method: "DELETE" }))
        .status,
    ).toBe(404);
  });
});

describe("backfilled hours", () => {
  it("counts past months a member adds to their own schedule", async () => {
    const lab = await startLab();
    const read = async () =>
      (await (await call(lab, "m-alpha", "/logistics/eligibility/me")).json()) as {
        status: string;
        hours: { status: string; qualifying_months: number; months_without_data: string[] };
      };
    const before = await read();
    expect(before.status).toBe("insufficient_data");
    expect(before.hours.months_without_data).toContain("2025-02");

    // Five months of 2025 committed at 25 h/week, entered after the fact.
    const saved = await call(lab, "m-alpha", "/lab/members/m-alpha", {
      method: "PUT",
      body: JSON.stringify({
        availability: [
          { start: "2025-02-01", end: "2025-06-30", hours_per_week: 25, project: "Backfill" },
        ],
      }),
    });
    expect(saved.status).toBe(200);
    const after = await read();
    expect(after.hours).toMatchObject({ status: "met", qualifying_months: 5 });
    expect(after.hours.months_without_data).not.toContain("2025-02");
    expect(after.status).toBe("eligible");
  });
});
