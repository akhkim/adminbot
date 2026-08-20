// The logistics request half of the service, cut from service.test.ts so neither file grows past
// what anyone reads in one sitting. Covers the parts a route cannot check for itself: who may read
// whose request, who may answer one, and what a withdrawal leaves behind.
import { describe, expect, it } from "vitest";
import type { AdminBotLogisticsRequestInput } from "../contracts/actions.js";
import { AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

function serviceWithMembers(): AdminBotService {
  const service = new AdminBotService();
  unwrap(
    service.upsertLabMember({
      id: "ada",
      name: "Ada",
      privilege_level: "member",
    }),
  );
  unwrap(
    service.upsertLabMember({
      id: "grace",
      name: "Grace",
      privilege_level: "member",
    }),
  );
  unwrap(
    service.upsertLabMember({
      id: "zhijing",
      name: "Zhijing",
      privilege_level: "admin",
    }),
  );
  return service;
}

const LETTERS: AdminBotLogisticsRequestInput = {
  kind: "recommendation_letters",
  schools: [
    {
      school: "MIT",
      letter_deadline: "2026-12-01",
      letter_deadline_time: "17:00",
      deadline_timezone: "America/New_York",
    },
  ],
  facts: [{ project: "AdminBot", contribution: "wrote the approval gate" }],
  cv_overleaf_url: "https://overleaf.com/read/abc",
};

const SIGNATURE: AdminBotLogisticsRequestInput = {
  kind: "document_signature",
  documents: [
    {
      name: "form.pdf",
      size: 0,
      content_type: "application/pdf",
      data_base64: Buffer.alloc(64, 7).toString("base64"),
    },
  ],
  description: "Visa letter, needed before the trip",
};

describe("submitLogisticsRequest", () => {
  it("signs the request with the session's member, not anything in the body", () => {
    const service = serviceWithMembers();
    const request = unwrap(
      service.submitLogisticsRequest("ada", {
        ...LETTERS,
        member_id: "grace",
        member_name: "Grace",
      } as AdminBotLogisticsRequestInput),
    );
    expect(request.member_id).toBe("ada");
    expect(request.member_name).toBe("Ada");
    expect(request.status).toBe("submitted");
    expect(request.deadline_at).toBe("2026-12-01T22:00:00.000Z");
  });

  it("refuses a request from someone who is not on the roster", () => {
    const service = serviceWithMembers();
    expect(service.submitLogisticsRequest("nobody", LETTERS)).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("refuses an empty request with the reason, rather than storing it", () => {
    const service = serviceWithMembers();
    const result = service.submitLogisticsRequest("ada", {
      kind: "recommendation_letters",
      schools: [],
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(unwrap(service.listLogisticsRequests()).requests).toEqual([]);
  });

  it("does not echo the file bytes back at the sender who just uploaded them", () => {
    const service = serviceWithMembers();
    const request = unwrap(service.submitLogisticsRequest("ada", SIGNATURE));
    expect(request.documents).toEqual([
      { name: "form.pdf", size: 64, content_type: "application/pdf" },
    ]);
  });

  it("writes an audit line naming the request, which is what makes it checkable later", () => {
    const service = serviceWithMembers();
    const request = unwrap(service.submitLogisticsRequest("ada", LETTERS));
    const events = service.listAuditEvents();
    expect(events.some((event) => event.type === "logistics_request.submitted")).toBe(true);
    expect(
      events.find((event) => event.type === "logistics_request.submitted")?.details,
    ).toMatchObject({ request_id: request.id, kind: "recommendation_letters" });
  });
});

describe("listLogisticsRequests", () => {
  it("shows a member their own requests and nobody else's", () => {
    const service = serviceWithMembers();
    unwrap(service.submitLogisticsRequest("ada", LETTERS));
    unwrap(service.submitLogisticsRequest("grace", SIGNATURE));
    const mine = unwrap(service.listLogisticsRequests("ada")).requests;
    expect(mine.map((request) => request.member_id)).toEqual(["ada"]);
    expect(unwrap(service.listLogisticsRequests()).requests).toHaveLength(2);
  });

  it("puts the most urgent first, with the deadline-less request last", () => {
    const service = serviceWithMembers();
    unwrap(service.submitLogisticsRequest("ada", SIGNATURE));
    unwrap(service.submitLogisticsRequest("ada", LETTERS));
    expect(unwrap(service.listLogisticsRequests()).requests.map((r) => r.kind)).toEqual([
      "recommendation_letters",
      "document_signature",
    ]);
  });

  it("leaves the file bytes out of a list, which is the whole reason the list is cheap", () => {
    const service = serviceWithMembers();
    unwrap(service.submitLogisticsRequest("ada", SIGNATURE));
    const [listed] = unwrap(service.listLogisticsRequests()).requests;
    expect(listed?.documents?.[0]?.data_base64).toBeUndefined();
    expect(listed?.documents?.[0]?.size).toBe(64);
  });
});

describe("getLogisticsRequest", () => {
  it("hands the bytes over on the read that opens one request", () => {
    const service = serviceWithMembers();
    const submitted = unwrap(service.submitLogisticsRequest("ada", SIGNATURE));
    const opened = unwrap(
      service.getLogisticsRequest(submitted.id, {
        member_id: "ada",
        is_admin: false,
      }),
    );
    expect(opened.documents?.[0]?.data_base64).toBe(Buffer.alloc(64, 7).toString("base64"));
  });

  it("tells a member reaching for a colleague's request the same thing a bad id gets", () => {
    const service = serviceWithMembers();
    const submitted = unwrap(service.submitLogisticsRequest("ada", SIGNATURE));
    expect(
      service.getLogisticsRequest(submitted.id, {
        member_id: "grace",
        is_admin: false,
      }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      service.getLogisticsRequest("logreq_nope", {
        member_id: "grace",
        is_admin: false,
      }),
    ).toMatchObject({ ok: false, status: 404 });
  });

  it("opens anybody's for an admin", () => {
    const service = serviceWithMembers();
    const submitted = unwrap(service.submitLogisticsRequest("ada", SIGNATURE));
    expect(
      unwrap(
        service.getLogisticsRequest(submitted.id, {
          member_id: "zhijing",
          is_admin: true,
        }),
      ).member_id,
    ).toBe("ada");
  });
});

describe("setLogisticsRequestStatus", () => {
  it("records who answered, when, and what they said", () => {
    const service = serviceWithMembers();
    const submitted = unwrap(service.submitLogisticsRequest("ada", LETTERS));
    const answered = unwrap(
      service.setLogisticsRequestStatus(submitted.id, "declined", "zhijing", "  ask again in May "),
    );
    expect(answered).toMatchObject({
      status: "declined",
      decided_by: "zhijing",
      resolution_note: "ask again in May",
    });
    expect(answered.decided_at).toBeTruthy();
  });

  it("refuses to let the lab withdraw on the requester's behalf", () => {
    const service = serviceWithMembers();
    const submitted = unwrap(service.submitLogisticsRequest("ada", LETTERS));
    expect(service.setLogisticsRequestStatus(submitted.id, "withdrawn", "zhijing")).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("404s on a request that is not there", () => {
    const service = serviceWithMembers();
    expect(service.setLogisticsRequestStatus("logreq_nope", "completed", "zhijing")).toMatchObject({
      ok: false,
      status: 404,
    });
  });
});

describe("withdrawLogisticsRequest", () => {
  it("marks the request rather than deleting it, so an admin mid-way through can see why", () => {
    const service = serviceWithMembers();
    const submitted = unwrap(service.submitLogisticsRequest("ada", SIGNATURE));
    expect(unwrap(service.withdrawLogisticsRequest(submitted.id, "ada")).status).toBe("withdrawn");
    expect(unwrap(service.listLogisticsRequests()).requests).toHaveLength(1);
  });

  it("takes the documents with it -- a withdrawn request is no place to keep them", () => {
    const service = serviceWithMembers();
    const submitted = unwrap(service.submitLogisticsRequest("ada", SIGNATURE));
    unwrap(service.withdrawLogisticsRequest(submitted.id, "ada"));
    const opened = unwrap(
      service.getLogisticsRequest(submitted.id, {
        member_id: "ada",
        is_admin: false,
      }),
    );
    expect(opened.documents?.[0]?.data_base64).toBeUndefined();
    expect(opened.documents?.[0]?.name).toBe("form.pdf");
  });

  it("is not something one member can do to another's request", () => {
    const service = serviceWithMembers();
    const submitted = unwrap(service.submitLogisticsRequest("ada", SIGNATURE));
    expect(service.withdrawLogisticsRequest(submitted.id, "grace")).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("refuses once the work is done, because there is nothing left to call off", () => {
    const service = serviceWithMembers();
    const submitted = unwrap(service.submitLogisticsRequest("ada", SIGNATURE));
    unwrap(service.setLogisticsRequestStatus(submitted.id, "completed", "zhijing"));
    expect(service.withdrawLogisticsRequest(submitted.id, "ada")).toMatchObject({
      ok: false,
      status: 409,
    });
  });
});

describe("updateLogisticsRequest", () => {
  it("re-derives the deadline from the corrected rows rather than leaving the old one", () => {
    const service = serviceWithMembers();
    const submitted = unwrap(service.submitLogisticsRequest("ada", LETTERS));
    const edited = unwrap(
      service.updateLogisticsRequest(submitted.id, "ada", {
        kind: "recommendation_letters",
        schools: [
          {
            school: "MIT",
            letter_deadline: "2026-10-01",
            deadline_timezone: "UTC",
          },
        ],
      }),
    );
    expect(edited.deadline_at).toBe("2026-10-01T23:59:00.000Z");
    // Same ask, corrected: it keeps its place in the queue rather than going to the back.
    expect(edited.submitted_at).toBe(submitted.submitted_at);
  });

  it("cannot be used to change the template the request was filed under", () => {
    const service = serviceWithMembers();
    const submitted = unwrap(service.submitLogisticsRequest("ada", LETTERS));
    const edited = unwrap(
      service.updateLogisticsRequest(submitted.id, "ada", {
        ...LETTERS,
        kind: "book_meeting",
      }),
    );
    expect(edited.kind).toBe("recommendation_letters");
  });

  it("stops once the lab has picked the request up", () => {
    const service = serviceWithMembers();
    const submitted = unwrap(service.submitLogisticsRequest("ada", LETTERS));
    unwrap(service.setLogisticsRequestStatus(submitted.id, "in_progress", "zhijing"));
    expect(service.updateLogisticsRequest(submitted.id, "ada", LETTERS)).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  it("belongs to the member who filed it", () => {
    const service = serviceWithMembers();
    const submitted = unwrap(service.submitLogisticsRequest("ada", LETTERS));
    expect(service.updateLogisticsRequest(submitted.id, "grace", LETTERS)).toMatchObject({
      ok: false,
      status: 404,
    });
  });
});

describe("returning the signed document", () => {
  const SIGNED = [
    {
      name: "form-signed.pdf",
      size: 0,
      content_type: "application/pdf",
      data_base64: Buffer.alloc(2048, 3).toString("base64"),
    },
  ];

  function labWithMail() {
    const sent: { to: string; subject: string; body: string; attachments: unknown[] }[] = [];
    const service = new AdminBotService(undefined, {
      executor: {
        execute: async (proposal) => {
          if (proposal.type !== "logistics.send_signed_document") {
            return { handled: false };
          }
          sent.push(proposal.proposed_payload as never);
          return { handled: true };
        },
      },
    });
    unwrap(
      service.upsertLabMember({
        id: "ada",
        name: "Ada Lovelace",
        email: "ada@cs.toronto.edu",
        privilege_level: "member",
      }),
    );
    unwrap(service.upsertLabMember({ id: "zhijing", name: "Zhijing", privilege_level: "admin" }));
    return { service, sent };
  }

  it("mails the file to the member who asked, at the address on the roster", async () => {
    const { service, sent } = labWithMail();
    const filed = unwrap(service.submitLogisticsRequest("ada", SIGNATURE));
    const done = unwrap(
      await service.fileSignedLogisticsDocument(filed.id, "zhijing", SIGNED, "All three pages."),
    );

    expect(sent).toHaveLength(1);
    // Never from the caller: an admin picks the file, not the recipient.
    expect(sent[0]?.to).toBe("ada@cs.toronto.edu");
    expect(sent[0]?.attachments).toHaveLength(1);
    expect(done.status).toBe("completed");
    expect(done.signed_sent_to).toBe("ada@cs.toronto.edu");
    expect(done.signed_sent_at).toBeTruthy();
  });

  it("clears every stored file once it has gone, and says what was freed", async () => {
    const { service } = labWithMail();
    const filed = unwrap(service.submitLogisticsRequest("ada", SIGNATURE));
    const done = unwrap(await service.fileSignedLogisticsDocument(filed.id, "zhijing", SIGNED));

    const stored = unwrap(
      service.getLogisticsRequest(filed.id, { member_id: "zhijing", is_admin: true }),
    );
    expect(stored.documents?.[0]?.data_base64).toBeUndefined();
    expect(stored.signed_documents?.[0]?.data_base64).toBeUndefined();
    // What it was is still on the record -- the name and the size outlive the bytes.
    expect(stored.signed_documents?.[0]).toMatchObject({ name: "form-signed.pdf" });
    expect(done.files_cleared_at).toBeTruthy();

    const cleared = service
      .listAuditEvents()
      .find((event) => event.type === "logistics_request.files_cleared");
    expect(cleared?.details).toMatchObject({ request_id: filed.id, status: "completed" });
    expect(Number(cleared?.details?.bytes_freed)).toBeGreaterThan(0);
  });

  it("leaves the request untouched when the mail could not be sent", async () => {
    const service = new AdminBotService(undefined, {
      executor: { execute: async () => ({ handled: false }) },
    });
    unwrap(
      service.upsertLabMember({
        id: "ada",
        name: "Ada",
        email: "ada@cs.toronto.edu",
        privilege_level: "member",
      }),
    );
    const filed = unwrap(service.submitLogisticsRequest("ada", SIGNATURE));
    expect(await service.fileSignedLogisticsDocument(filed.id, "zhijing", SIGNED)).toMatchObject({
      ok: false,
      status: 502,
    });
    // A member who never received the document must not find their request marked done.
    const stored = unwrap(
      service.getLogisticsRequest(filed.id, { member_id: "ada", is_admin: false }),
    );
    expect(stored.status).toBe("submitted");
    expect(stored.documents?.[0]?.data_base64).toBeTruthy();
  });

  it("refuses when the member has no address to send it to", async () => {
    const { service } = labWithMail();
    unwrap(service.upsertLabMember({ id: "noemail", name: "No Email", privilege_level: "member" }));
    const filed = unwrap(service.submitLogisticsRequest("noemail", SIGNATURE));
    expect(await service.fileSignedLogisticsDocument(filed.id, "zhijing", SIGNED)).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  it("only applies to a signature request", async () => {
    const { service } = labWithMail();
    const letters = unwrap(service.submitLogisticsRequest("ada", LETTERS));
    expect(await service.fileSignedLogisticsDocument(letters.id, "zhijing", SIGNED)).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  it("refuses an upload that is not a readable file", async () => {
    const { service } = labWithMail();
    const filed = unwrap(service.submitLogisticsRequest("ada", SIGNATURE));
    expect(
      await service.fileSignedLogisticsDocument(filed.id, "zhijing", [
        { name: "signed.pdf", size: 0, data_base64: "" },
      ]),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it("404s on a request that is not there", async () => {
    const { service } = labWithMail();
    expect(
      await service.fileSignedLogisticsDocument("logreq_nope", "zhijing", SIGNED),
    ).toMatchObject({ ok: false, status: 404 });
  });
});

describe("settling a request without a signed document", () => {
  it("clears the files when an admin marks it done or declines it", () => {
    const service = serviceWithMembers();
    for (const status of ["completed", "declined"] as const) {
      const filed = unwrap(service.submitLogisticsRequest("ada", SIGNATURE));
      unwrap(service.setLogisticsRequestStatus(filed.id, status, "zhijing"));
      const stored = unwrap(
        service.getLogisticsRequest(filed.id, { member_id: "zhijing", is_admin: true }),
      );
      expect(stored.documents?.[0]?.data_base64).toBeUndefined();
      expect(stored.files_cleared_at).toBeTruthy();
    }
  });

  it("keeps them while the request is still being worked on", () => {
    const service = serviceWithMembers();
    const filed = unwrap(service.submitLogisticsRequest("ada", SIGNATURE));
    unwrap(service.setLogisticsRequestStatus(filed.id, "in_progress", "zhijing"));
    const stored = unwrap(
      service.getLogisticsRequest(filed.id, { member_id: "zhijing", is_admin: true }),
    );
    expect(stored.documents?.[0]?.data_base64).toBeTruthy();
  });
});
