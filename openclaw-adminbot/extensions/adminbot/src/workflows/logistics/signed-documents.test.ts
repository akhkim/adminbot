import { describe, expect, it } from "vitest";
import type { AdminBotLogisticsRequest } from "../../contracts/actions.js";
import { MAX_ATTACHMENT_BYTES } from "./requests.js";
import {
  clearSettledRequestFiles,
  signedDocumentEmailBody,
  signedDocumentEmailSubject,
  storedRequestBytes,
  validateSignedDocuments,
} from "./signed-documents.js";

const bytes = (count: number) => Buffer.alloc(count, 1).toString("base64");

function request(fields: Partial<AdminBotLogisticsRequest> = {}): AdminBotLogisticsRequest {
  return {
    id: "logreq_1",
    kind: "document_signature",
    member_id: "ada",
    member_name: "Ada Lovelace",
    status: "submitted",
    submitted_at: "2026-08-19T10:00:00.000Z",
    updated_at: "2026-08-19T10:00:00.000Z",
    documents: [{ name: "form.pdf", size: 900, data_base64: bytes(900) }],
    attachments: [],
    description: "Visa letter for the Berlin trip",
    ...fields,
  };
}

describe("validateSignedDocuments", () => {
  it("needs a file, and a name for it", () => {
    expect(validateSignedDocuments([])).toMatch(/required/u);
    expect(validateSignedDocuments([{ name: "  ", size: 0, data_base64: bytes(10) }])).toMatch(
      /file name/u,
    );
  });

  it("refuses an empty upload, which is what a failed file picker produces", () => {
    expect(validateSignedDocuments([{ name: "signed.pdf", size: 0, data_base64: "" }])).toMatch(
      /not readable|empty/u,
    );
  });

  it("refuses bytes that are not base64 rather than storing a corrupt attachment", () => {
    expect(
      validateSignedDocuments([{ name: "signed.pdf", size: 0, data_base64: "not base64!!" }]),
    ).toMatch(/base64/u);
  });

  it("holds the signed document to the same size cap as the original", () => {
    expect(
      validateSignedDocuments([
        { name: "huge.pdf", size: 0, data_base64: bytes(MAX_ATTACHMENT_BYTES + 3) },
      ]),
    ).toMatch(/larger than/u);
  });

  it("accepts a real signed document", () => {
    expect(
      validateSignedDocuments([{ name: "signed.pdf", size: 0, data_base64: bytes(2048) }]),
    ).toBeNull();
  });
});

describe("storedRequestBytes", () => {
  it("adds up everything the request is holding, signed copy included", () => {
    expect(
      storedRequestBytes(
        request({ signed_documents: [{ name: "signed.pdf", size: 0, data_base64: bytes(100) }] }),
      ),
    ).toBe(1000);
  });

  it("is zero for a request whose files are already gone", () => {
    expect(storedRequestBytes(request({ documents: [{ name: "form.pdf", size: 900 }] }))).toBe(0);
  });
});

describe("clearSettledRequestFiles", () => {
  it("keeps the documents of a request somebody is still working on", () => {
    const open = clearSettledRequestFiles(request({ status: "in_progress" }));
    expect(open.documents?.[0]?.data_base64).toBeTruthy();
    expect(open.files_cleared_at).toBeUndefined();
  });

  it("drops the bytes once nobody is waiting on it, and says when", () => {
    for (const status of ["completed", "declined", "withdrawn"] as const) {
      const settled = clearSettledRequestFiles(request({ status }));
      expect(settled.documents?.[0]?.data_base64).toBeUndefined();
      expect(settled.files_cleared_at).toBeTruthy();
      // The history stays readable: which document, how big, and that it existed.
      expect(settled.documents?.[0]).toMatchObject({ name: "form.pdf", size: 900 });
    }
  });

  it("takes the signed copy with it -- it has already been mailed", () => {
    const settled = clearSettledRequestFiles(
      request({
        status: "completed",
        signed_documents: [{ name: "signed.pdf", size: 12, data_base64: bytes(12) }],
      }),
    );
    expect(settled.signed_documents?.[0]?.data_base64).toBeUndefined();
    expect(settled.signed_documents?.[0]?.name).toBe("signed.pdf");
  });

  it("does not claim to have cleared a request that was holding nothing", () => {
    // Otherwise a letters request would be stamped as though documents had been dropped from it.
    const settled = clearSettledRequestFiles({
      ...request({ status: "completed" }),
      documents: [],
      attachments: [],
    });
    expect(settled.files_cleared_at).toBeUndefined();
  });

  it("is idempotent, so a second status change cannot restamp it", () => {
    const once = clearSettledRequestFiles(request({ status: "completed" }));
    const twice = clearSettledRequestFiles(once);
    expect(twice.files_cleared_at).toBe(once.files_cleared_at);
  });
});

describe("the email that carries the signed document", () => {
  it("names what the member asked for, so the subject matches what they remember", () => {
    expect(signedDocumentEmailSubject(request())).toBe("Signed: Visa letter for the Berlin trip");
  });

  it("falls back to something plain when the request said nothing", () => {
    expect(signedDocumentEmailSubject(request({ description: undefined }))).toBe(
      "Your signed documents",
    );
  });

  it("addresses the member and names the file, since the attachment is the message", () => {
    const body = signedDocumentEmailBody(request(), [
      { name: "signed.pdf", size: 10, data_base64: bytes(10) },
    ]);
    expect(body).toContain("Hi Ada,");
    expect(body).toContain("signed.pdf");
    expect(body).toContain("Visa letter for the Berlin trip");
  });

  it("passes on what the admin wrote", () => {
    const body = signedDocumentEmailBody(
      request(),
      [{ name: "signed.pdf", size: 10, data_base64: bytes(10) }],
      "Left the second page unsigned -- it needs your supervisor.",
    );
    expect(body).toContain("needs your supervisor");
  });

  it("reads as plural when there are several", () => {
    const body = signedDocumentEmailBody(request(), [
      { name: "one.pdf", size: 10, data_base64: bytes(10) },
      { name: "two.pdf", size: 10, data_base64: bytes(10) },
    ]);
    expect(body).toContain("Your documents have been signed");
    expect(body).toContain("one.pdf, two.pdf");
  });
});
