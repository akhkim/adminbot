import { describe, expect, it, vi } from "vitest";
import {
  checkDocPrepLink,
  type DocPrepProbe,
  explainDocPrepVerdict,
  isPushableDocPrep,
  parseDocPrepLink,
} from "./doc-prep-link.js";

/** A real link out of the sheet, fragment and all, so the parser is tested on what people paste. */
const PASTED =
  "https://docs.google.com/document/d/1DvlfAFPHplL5kGH9zjpOFKAx2D3cltnltzQdpIY43i0/edit?usp=sharing";
const CANONICAL =
  "https://docs.google.com/document/d/1DvlfAFPHplL5kGH9zjpOFKAx2D3cltnltzQdpIY43i0/edit";

describe("parseDocPrepLink", () => {
  it("strips the sharing query off a pasted link", () => {
    expect(parseDocPrepLink(PASTED)).toEqual({
      ok: true,
      document_id: "1DvlfAFPHplL5kGH9zjpOFKAx2D3cltnltzQdpIY43i0",
      url: CANONICAL,
    });
  });

  it("strips a tab fragment, which never reaches the server anyway", () => {
    const parsed = parseDocPrepLink(
      "https://docs.google.com/document/d/1yQ51j1YH1ktXKm9J2lAFRBZ4zAEXOMJLgcCM16PA0zE/edit?tab=t.0",
    );
    expect(parsed).toMatchObject({
      ok: true,
      url: "https://docs.google.com/document/d/1yQ51j1YH1ktXKm9J2lAFRBZ4zAEXOMJLgcCM16PA0zE/edit",
    });
  });

  it("reads a bare document id as a doc link", () => {
    expect(parseDocPrepLink("1DvlfAFPHplL5kGH9zjpOFKAx2D3cltnltzQdpIY43i0")).toMatchObject({
      ok: true,
      url: CANONICAL,
    });
  });

  it.each(["", "   ", null, undefined, 42])("treats %p as missing", (value) => {
    expect(parseDocPrepLink(value)).toEqual({ ok: false, status: "missing" });
  });

  // The four rows in the live sheet that say TODO are the reason this status exists at all.
  it.each(["TODO", "todo", "TBD", "-", "N/A", "pending"])(
    "calls %s a placeholder rather than a broken URL",
    (value) => {
      expect(parseDocPrepLink(value)).toMatchObject({
        ok: false,
        status: "placeholder",
      });
    },
  );

  it("does not mistake a document titled TODO for a placeholder", () => {
    expect(parseDocPrepLink(`${PASTED}#todo`)).toMatchObject({ ok: true });
  });

  it("refuses a non-Google host", () => {
    expect(parseDocPrepLink("https://example.com/questions")).toMatchObject({
      ok: false,
      status: "not_a_doc",
      reason: "example.com is not Google Docs or Drive",
    });
  });

  it("names a Drive folder as the mistake it is", () => {
    expect(
      parseDocPrepLink("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp"),
    ).toMatchObject({
      ok: false,
      status: "not_a_doc",
      reason: "that is a folder, not a document",
    });
  });

  it("accepts the old drive.google.com/open?id= share form", () => {
    expect(
      parseDocPrepLink("https://drive.google.com/open?id=1DvlfAFPHplL5kGH9zjpOFKAx2D3cltn"),
    ).toMatchObject({
      ok: true,
      url: "https://drive.google.com/file/d/1DvlfAFPHplL5kGH9zjpOFKAx2D3cltn/view",
    });
  });

  it("refuses a non-http scheme", () => {
    expect(
      parseDocPrepLink("ftp://docs.google.com/document/d/1DvlfAFPHplL5kGH9zjpOFKAx2D3cltn"),
    ).toMatchObject({ ok: false, status: "malformed" });
  });

  it("refuses a doc id too short to be a real one", () => {
    expect(parseDocPrepLink("https://docs.google.com/document/d/abc/edit")).toMatchObject({
      ok: false,
      status: "malformed",
      reason: "document id is too short to be real",
    });
  });
});

describe("checkDocPrepLink", () => {
  const probeReturning = (status: number): DocPrepProbe => vi.fn(async () => status);

  it("probes the canonical URL, not the pasted one", async () => {
    const probe = probeReturning(200);
    await checkDocPrepLink(PASTED, probe);
    expect(probe).toHaveBeenCalledWith(CANONICAL);
  });

  it("calls a 200 pushable", async () => {
    const verdict = await checkDocPrepLink(PASTED, probeReturning(200));
    expect(verdict).toMatchObject({ status: "ok" });
    expect(isPushableDocPrep(verdict)).toBe(true);
  });

  // 401 is what the live sheet's second doc actually answers: it exists, it is just not shared.
  it.each([401, 403])("calls a %d restricted, not missing", async (status) => {
    const verdict = await checkDocPrepLink(PASTED, probeReturning(status));
    expect(verdict).toMatchObject({ status: "restricted" });
    expect(isPushableDocPrep(verdict)).toBe(false);
  });

  it.each([404, 410])("calls a %d not_found", async (status) => {
    expect(await checkDocPrepLink(PASTED, probeReturning(status))).toMatchObject({
      status: "not_found",
    });
  });

  it("reads a redirect as a sign-in wall rather than following it", async () => {
    expect(await checkDocPrepLink(PASTED, probeReturning(302))).toMatchObject({
      status: "restricted",
    });
  });

  it("does not blame the document when the probe throws", async () => {
    const probe: DocPrepProbe = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    });
    const verdict = await checkDocPrepLink(PASTED, probe);
    expect(verdict).toMatchObject({
      status: "unreachable",
      reason: "ENOTFOUND",
    });
  });

  it("does not blame the document for a 500 either", async () => {
    expect(await checkDocPrepLink(PASTED, probeReturning(500))).toMatchObject({
      status: "unreachable",
      reason: "HTTP 500",
    });
  });

  it("never probes a link that failed to parse", async () => {
    const probe = probeReturning(200);
    expect(await checkDocPrepLink("TODO", probe)).toMatchObject({
      status: "placeholder",
    });
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("explainDocPrepVerdict", () => {
  it("tells a member with an unshared doc what to do about it", () => {
    const message = explainDocPrepVerdict({
      status: "restricted",
      document_id: "x",
      url: CANONICAL,
    });
    expect(message).toContain("anyone-with-the-link");
  });

  it("quotes the placeholder back so the member knows which cell", () => {
    expect(explainDocPrepVerdict({ status: "placeholder", raw: "TODO" })).toContain('"TODO"');
  });
});
