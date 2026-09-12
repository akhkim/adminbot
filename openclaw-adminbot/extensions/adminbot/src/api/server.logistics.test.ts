// The logistics routes over real HTTP: who the wire lets in, and what it refuses.
//
// A sibling of server.test.ts rather than more of it -- that file is already the longest test in
// the extension. The harness below is deliberately its own: these tests need one member, one
// colleague and one admin with real session tokens, and nothing else server.test.ts sets up.
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotLogisticsRequestInput } from "../contracts/actions.js";
import type { CallSheetSource } from "./call-sheet-config.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-service-token";
const PASSWORD = "correcthorse";

const running: {
  mock: ReturnType<typeof createAdminBotMockService>;
  cleanup: string;
}[] = [];

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
  /** Session tokens, by member id. */
  tokens: Record<string, string>;
};

/**
 * @param callSheet Turns the automatic call-sheet push on, with a stub workbook. Left out, the
 * push is off: it probes a doc-prep link over the network and reads a real spreadsheet, and these
 * tests are about who the wire lets in.
 */
async function startLab(callSheet?: CallSheetSource): Promise<Lab> {
  const sensitiveInfoPath = path.join(
    os.tmpdir(),
    `adminbot-logistics-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
  );
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    sensitiveInfoPath,
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
    dcsFormRunner: async () => {},
    autoQueueMeetingRequests: Boolean(callSheet),
    ...(callSheet ? { callSheet } : {}),
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
    ["ada", "member"],
    ["grace", "member"],
    ["zhijing", "admin"],
  ] as const) {
    const seeded = mock.service.upsertLabMember({
      id,
      name: id,
      email: `${id}@cs.toronto.edu`,
      privilege_level: privilege,
    });
    if (!seeded.ok) {
      throw new Error(seeded.error.message);
    }
    await fetch(`${baseUrl}/auth/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        member_id: id,
        email: `${id}@cs.toronto.edu`,
        password: PASSWORD,
      }),
    });
    const pending = await fetch(`${baseUrl}/auth/registrations?status=pending`, {
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    const registrations = (
      (await pending.json()) as {
        registrations: { id: string; member_id?: string }[];
      }
    ).registrations;
    const claim = registrations.find((entry) => entry.member_id === id);
    if (!claim) {
      throw new Error(`no pending claim for ${id}`);
    }
    const approved = mock.auth.approveRegistration(claim.id, "test-admin");
    if (!approved.ok) {
      throw new Error(approved.error.message);
    }
    const login = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `${id}@cs.toronto.edu`,
        password: PASSWORD,
      }),
    });
    tokens[id] = ((await login.json()) as { session_token: string }).session_token;
  }
  return { baseUrl, tokens };
}

function asMember(lab: Lab, memberId: string, extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${lab.tokens[memberId]}`, ...extra };
}

async function submit(
  lab: Lab,
  memberId: string,
  body: AdminBotLogisticsRequestInput,
): Promise<{ status: number; request: { id: string; status: string } }> {
  const res = await fetch(`${lab.baseUrl}/logistics/requests`, {
    method: "POST",
    headers: asMember(lab, memberId, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    request: (await res.json()) as { id: string; status: string },
  };
}

const LETTERS: AdminBotLogisticsRequestInput = {
  kind: "recommendation_letters",
  schools: [{ school: "MIT", letter_deadline: "2026-12-01", deadline_timezone: "UTC" }],
};

const MEETING: AdminBotLogisticsRequestInput = {
  kind: "book_meeting",
  meetings: [
    {
      purpose: "thesis check-in",
      preferred_time: "2026-09-01T14:00",
      timezone: "UTC",
    },
  ],
};

describe("logistics request routes", () => {
  it("refuses everyone without a member session, including the service principal", async () => {
    const lab = await startLab();
    const anonymous = await fetch(`${lab.baseUrl}/logistics/requests`);
    expect(anonymous.status).toBe(401);
    const asService = await fetch(`${lab.baseUrl}/logistics/requests`, {
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    // A request is signed by whoever sent it, and the service principal is nobody in particular.
    expect(asService.status).toBe(401);
  });

  it("stores a submitted request and hands it back to its member", async () => {
    const lab = await startLab();
    const submitted = await submit(lab, "ada", LETTERS);
    expect(submitted.status).toBe(201);
    expect(submitted.request.status).toBe("submitted");

    const mine = await fetch(`${lab.baseUrl}/logistics/requests`, {
      headers: asMember(lab, "ada"),
    });
    const body = (await mine.json()) as {
      requests: { id: string; member_id: string }[];
    };
    expect(body.requests.map((entry) => entry.id)).toEqual([submitted.request.id]);
    expect(body.requests[0]?.member_id).toBe("ada");
  });

  it("shows an admin the lab's queue and a member only their own", async () => {
    const lab = await startLab();
    await submit(lab, "ada", LETTERS);
    await submit(lab, "grace", MEETING);

    const asAda = await fetch(`${lab.baseUrl}/logistics/requests`, {
      headers: asMember(lab, "ada"),
    });
    expect(((await asAda.json()) as { requests: unknown[] }).requests).toHaveLength(1);

    const asAdmin = await fetch(`${lab.baseUrl}/logistics/requests`, {
      headers: asMember(lab, "zhijing"),
    });
    expect(((await asAdmin.json()) as { requests: unknown[] }).requests).toHaveLength(2);
  });

  it("keeps one member out of another's request, with the same answer a bad id gets", async () => {
    const lab = await startLab();
    const submitted = await submit(lab, "ada", LETTERS);
    const peek = await fetch(`${lab.baseUrl}/logistics/requests/${submitted.request.id}`, {
      headers: asMember(lab, "grace"),
    });
    expect(peek.status).toBe(404);
    const asAdmin = await fetch(`${lab.baseUrl}/logistics/requests/${submitted.request.id}`, {
      headers: asMember(lab, "zhijing"),
    });
    expect(asAdmin.status).toBe(200);
  });

  it("lets the lab answer a request, and refuses to let a member answer their own", async () => {
    const lab = await startLab();
    const submitted = await submit(lab, "ada", LETTERS);
    const url = `${lab.baseUrl}/logistics/requests/${submitted.request.id}/status`;

    const byMember = await fetch(url, {
      method: "PUT",
      headers: asMember(lab, "ada", { "Content-Type": "application/json" }),
      body: JSON.stringify({ status: "completed" }),
    });
    expect(byMember.status).toBe(403);

    const byAdmin = await fetch(url, {
      method: "PUT",
      headers: asMember(lab, "zhijing", { "Content-Type": "application/json" }),
      body: JSON.stringify({
        status: "completed",
        resolution_note: "signed and returned",
      }),
    });
    expect(byAdmin.status).toBe(200);
    await expect(byAdmin.json()).resolves.toMatchObject({
      status: "completed",
      resolution_note: "signed and returned",
      decided_by: "zhijing",
    });
  });

  it("rejects a status the queue does not have", async () => {
    const lab = await startLab();
    const submitted = await submit(lab, "ada", LETTERS);
    const res = await fetch(`${lab.baseUrl}/logistics/requests/${submitted.request.id}/status`, {
      method: "PUT",
      headers: asMember(lab, "zhijing", {
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ status: "nearly-done" }),
    });
    expect(res.status).toBe(400);
  });

  it("lets the requester withdraw, and nobody else", async () => {
    const lab = await startLab();
    const submitted = await submit(lab, "ada", LETTERS);
    const url = `${lab.baseUrl}/logistics/requests/${submitted.request.id}/withdraw`;
    expect((await fetch(url, { method: "POST", headers: asMember(lab, "grace") })).status).toBe(
      404,
    );
    const mine = await fetch(url, {
      method: "POST",
      headers: asMember(lab, "ada"),
    });
    expect(mine.status).toBe(200);
    await expect(mine.json()).resolves.toMatchObject({ status: "withdrawn" });
  });

  it("lets a member correct a request nobody has picked up", async () => {
    const lab = await startLab();
    const submitted = await submit(lab, "ada", LETTERS);
    const res = await fetch(`${lab.baseUrl}/logistics/requests/${submitted.request.id}`, {
      method: "PUT",
      headers: asMember(lab, "ada", { "Content-Type": "application/json" }),
      body: JSON.stringify({
        kind: "recommendation_letters",
        schools: [
          {
            school: "Berkeley",
            letter_deadline: "2026-10-01",
            deadline_timezone: "UTC",
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      deadline_at: "2026-10-01T23:59:00.000Z",
    });
  });

  it("carries a document's bytes on the read that opens one request, and not in the list", async () => {
    const lab = await startLab();
    const data = Buffer.from("%PDF-1.4 signed here").toString("base64");
    const submitted = await submit(lab, "ada", {
      kind: "document_signature",
      documents: [{ name: "form.pdf", size: 0, data_base64: data }],
    });
    expect(submitted.status).toBe(201);

    const list = await fetch(`${lab.baseUrl}/logistics/requests`, {
      headers: asMember(lab, "ada"),
    });
    const listed = (
      (await list.json()) as {
        requests: { documents: { data_base64?: string }[] }[];
      }
    ).requests;
    expect(listed[0]?.documents[0]?.data_base64).toBeUndefined();

    const opened = await fetch(`${lab.baseUrl}/logistics/requests/${submitted.request.id}`, {
      headers: asMember(lab, "ada"),
    });
    await expect(opened.json()).resolves.toMatchObject({
      documents: [{ name: "form.pdf", data_base64: data }],
    });
  });

  it("refuses a body past the wire cap while it is still arriving", async () => {
    const lab = await startLab();
    // Comfortably past the 28MB ceiling, sent as one string so the cap has to catch it mid-read.
    const oversized = "A".repeat(30 * 1024 * 1024);
    const res = await fetch(`${lab.baseUrl}/logistics/requests`, {
      method: "POST",
      headers: asMember(lab, "ada", { "Content-Type": "application/json" }),
      body: JSON.stringify({
        kind: "document_signature",
        documents: [{ name: "huge.pdf", size: 0, data_base64: oversized }],
      }),
    });
    expect(res.status).toBe(413);
  });

  it("404s an unknown path under the logistics prefix rather than falling through", async () => {
    const lab = await startLab();
    const res = await fetch(`${lab.baseUrl}/logistics/requests/abc/nonsense`, {
      headers: asMember(lab, "ada"),
    });
    expect(res.status).toBe(404);
  });
});

describe("returning a signed document", () => {
  const SIGNATURE: AdminBotLogisticsRequestInput = {
    kind: "document_signature",
    documents: [
      {
        name: "form.pdf",
        size: 0,
        content_type: "application/pdf",
        data_base64: Buffer.from("%PDF-1.4 sign here").toString("base64"),
      },
    ],
    description: "Visa letter",
  };
  const SIGNED = {
    name: "form-signed.pdf",
    size: 0,
    content_type: "application/pdf",
    data_base64: Buffer.from("%PDF-1.4 signed").toString("base64"),
  };

  it("is admin-only: the member who asked cannot close their own request", async () => {
    const lab = await startLab();
    const submitted = await submit(lab, "ada", SIGNATURE);
    const res = await fetch(`${lab.baseUrl}/logistics/requests/${submitted.request.id}/signed`, {
      method: "POST",
      headers: asMember(lab, "ada", { "Content-Type": "application/json" }),
      body: JSON.stringify({ documents: [SIGNED] }),
    });
    expect(res.status).toBe(403);
  });

  it("refuses an upload with no readable file in it", async () => {
    const lab = await startLab();
    const submitted = await submit(lab, "ada", SIGNATURE);
    const res = await fetch(`${lab.baseUrl}/logistics/requests/${submitted.request.id}/signed`, {
      method: "POST",
      headers: asMember(lab, "zhijing", { "Content-Type": "application/json" }),
      body: JSON.stringify({ documents: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("404s for a request that is not there", async () => {
    const lab = await startLab();
    const res = await fetch(`${lab.baseUrl}/logistics/requests/logreq_nope/signed`, {
      method: "POST",
      headers: asMember(lab, "zhijing", { "Content-Type": "application/json" }),
      body: JSON.stringify({ documents: [SIGNED] }),
    });
    expect(res.status).toBe(404);
  });

  it("refuses an upload past the wire cap while it is still arriving", async () => {
    const lab = await startLab();
    const submitted = await submit(lab, "ada", SIGNATURE);
    const res = await fetch(`${lab.baseUrl}/logistics/requests/${submitted.request.id}/signed`, {
      method: "POST",
      headers: asMember(lab, "zhijing", { "Content-Type": "application/json" }),
      body: JSON.stringify({
        documents: [{ ...SIGNED, data_base64: "A".repeat(30 * 1024 * 1024) }],
      }),
    });
    expect(res.status).toBe(413);
  });
});

// A meeting request is answered by a row on Zhijing's call sheet, so submitting one proposes that
// row rather than waiting for somebody to remember to push the queue.
describe("the call-sheet row a meeting request proposes for itself", () => {
  const CALL_GRID: string[][] = [
    [
      "Name",
      "What topics do you want to go through?",
      "Your current city (or time range flexible for you tto receive calls)",
      "Doc prep of all the questions (before the call)",
      'Have you messaged Zhijing a "hello" on whatsapp?',
      "min_length of the call possible",
      "until when is it ok to make this call?",
      "time you entered this call request",
    ],
    ["", "", "", "", "", "", "", ""],
    ["Finished calls", "", "", "", "", "", "", ""],
  ];

  function callSheet(): CallSheetSource {
    return {
      spreadsheetId: "1ZqdaRze",
      tab: "Whatsapp call requests",
      read: async () => CALL_GRID,
    };
  }

  // A placeholder link never reaches the network (parseDocPrepLink settles it), so this asserts the
  // wiring without a doc-prep probe: the request is stored, and the answer explains the refusal.
  it("tells the member when the doc prep link is still a placeholder", async () => {
    const lab = await startLab(callSheet());
    const res = await fetch(`${lab.baseUrl}/logistics/requests`, {
      method: "POST",
      headers: asMember(lab, "ada", { "Content-Type": "application/json" }),
      body: JSON.stringify({
        kind: "book_meeting",
        meetings: [{ purpose: "thesis check-in", doc_prep_url: "TODO" }],
      } satisfies AdminBotLogisticsRequestInput),
    });
    // 201, the same status the service answered before this hook existed.
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      kind: string;
      call_sheet?: { queued: boolean; message: string };
    };
    // The request is saved either way -- the push decorates this response, it never decides it.
    expect(body.id).toBeTruthy();
    expect(body.kind).toBe("book_meeting");
    expect(body.call_sheet?.queued).toBe(false);
    expect(body.call_sheet?.message).not.toBe("");
  });

  // Every other kind goes nowhere near the call sheet.
  it("says nothing about the call sheet on a request of another kind", async () => {
    const lab = await startLab(callSheet());
    const res = await fetch(`${lab.baseUrl}/logistics/requests`, {
      method: "POST",
      headers: asMember(lab, "ada", { "Content-Type": "application/json" }),
      body: JSON.stringify(LETTERS),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { kind?: string; call_sheet?: unknown };
    expect(body.kind).toBe("recommendation_letters");
    expect(body.call_sheet).toBeUndefined();
  });
});
