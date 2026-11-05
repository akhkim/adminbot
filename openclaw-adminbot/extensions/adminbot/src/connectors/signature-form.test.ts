import { describe, expect, it, vi } from "vitest";
import {
  SIGNATURE_FORM_EMAIL_FIELD,
  SIGNATURE_FORM_FIELDS,
  SIGNATURE_FORM_SIGN_IN_REQUIRED,
  dateParts,
  signatureFormBody,
  submitSignatureForm,
} from "./signature-form.js";

const REQUEST = {
  name: "Ada Lovelace",
  driveUrl: "https://drive.google.com/file/d/abc/view",
  deadline: "2026-09-30",
  context: "Needs a wet signature for the department.",
};

describe("the body Google is sent", () => {
  it("answers each question by its own id", () => {
    const body = signatureFormBody(REQUEST);
    expect(body?.get(SIGNATURE_FORM_FIELDS.name)).toBe("Ada Lovelace");
    expect(body?.get(SIGNATURE_FORM_FIELDS.driveUrl)).toBe(
      "https://drive.google.com/file/d/abc/view",
    );
    expect(body?.get(SIGNATURE_FORM_FIELDS.context)).toBe(
      "Needs a wet signature for the department.",
    );
  });

  // A Google date question is three fields. One string in `entry.<id>` is accepted and stored
  // blank, which is the failure nobody notices.
  it("splits the deadline the way a date question expects", () => {
    const body = signatureFormBody(REQUEST);
    expect(body?.get(`${SIGNATURE_FORM_FIELDS.deadline}_year`)).toBe("2026");
    expect(body?.get(`${SIGNATURE_FORM_FIELDS.deadline}_month`)).toBe("9");
    expect(body?.get(`${SIGNATURE_FORM_FIELDS.deadline}_day`)).toBe("30");
    expect(body?.get(SIGNATURE_FORM_FIELDS.deadline)).toBeNull();
  });

  // The form collects emails as "Responder input": Google's own field, no sign-in needed.
  it("records the member's account email in the form's email column", () => {
    const body = signatureFormBody({ ...REQUEST, email: " ada@example.test " });
    expect(body?.get(SIGNATURE_FORM_EMAIL_FIELD)).toBe("ada@example.test");
    expect(signatureFormBody(REQUEST)?.has(SIGNATURE_FORM_EMAIL_FIELD)).toBe(false);
    expect(
      signatureFormBody({ ...REQUEST, email: "not an address" })?.has(SIGNATURE_FORM_EMAIL_FIELD),
    ).toBe(false);
  });

  // The question is optional, and an empty answer is different from an answer of "".
  it("leaves the optional context out when it is blank", () => {
    expect(
      signatureFormBody({ ...REQUEST, context: "   " })?.has(SIGNATURE_FORM_FIELDS.context),
    ).toBe(false);
    expect(
      signatureFormBody({ ...REQUEST, context: undefined })?.has(SIGNATURE_FORM_FIELDS.context),
    ).toBe(false);
  });
});

describe("dateParts", () => {
  it("takes an ISO date and drops the leading zeros Google does not want", () => {
    expect(dateParts("2026-01-05")).toEqual({ year: "2026", month: "1", day: "5" });
  });

  it("refuses anything that is not a calendar date", () => {
    expect(dateParts("")).toBeUndefined();
    expect(dateParts("30/09/2026")).toBeUndefined();
    expect(dateParts("2026-09")).toBeUndefined();
    // Shaped like a date, and not one.
    expect(dateParts("2026-02-31")).toBeUndefined();
  });
});

describe("submitSignatureForm", () => {
  it("posts to the form and reports success", async () => {
    const post = vi.fn(async () => ({ status: 200 }));
    const result = await submitSignatureForm(REQUEST, { post });
    expect(result).toEqual({ ok: true });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toContain("/formResponse");
  });

  it("reports a refusal rather than pretending it landed", async () => {
    const post = vi.fn(async () => ({ status: 500 }));
    const result = await submitSignatureForm(REQUEST, { post });
    expect(result).toEqual({ ok: false, error: "the form answered 500" });
  });

  // A form that collects verified emails sends an anonymous POST to Google's login page. That is
  // the form's setting, not a transient failure, and the member is told what to do about it.
  it("says so when the form will only take a signed-in response", async () => {
    for (const answer of [
      {
        status: 302,
        location: "https://accounts.google.com/ServiceLogin?service=wise&continue=x",
      },
      { status: 401 },
      { status: 403 },
    ]) {
      const result = await submitSignatureForm(REQUEST, { post: vi.fn(async () => answer) });
      expect(result).toEqual({ ok: false, error: SIGNATURE_FORM_SIGN_IN_REQUIRED });
    }
    // Any other redirect is still just a refusal.
    const elsewhere = await submitSignatureForm(REQUEST, {
      post: vi.fn(async () => ({ status: 302, location: "https://docs.google.com/forms/x" })),
    });
    expect(elsewhere).toEqual({ ok: false, error: "the form answered 302" });
  });

  // The member is watching the button; a thrown fetch has to come back as a sentence.
  it("never throws when the network does", async () => {
    const post = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND docs.google.com");
    });
    const result = await submitSignatureForm(REQUEST, { post });
    expect(result).toEqual({ ok: false, error: "getaddrinfo ENOTFOUND docs.google.com" });
  });

  it("refuses to post an incomplete request at all", async () => {
    const post = vi.fn(async () => ({ status: 200 }));
    expect(await submitSignatureForm({ ...REQUEST, name: " " }, { post })).toEqual({
      ok: false,
      error: "a name is required",
    });
    expect(await submitSignatureForm({ ...REQUEST, driveUrl: "" }, { post })).toEqual({
      ok: false,
      error: "a link to the document is required",
    });
    expect(await submitSignatureForm({ ...REQUEST, deadline: "soon" }, { post })).toEqual({
      ok: false,
      error: "not a calendar date: soon",
    });
    expect(post).not.toHaveBeenCalled();
  });
});
