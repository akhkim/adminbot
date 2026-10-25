// Where the draft looks for a PDF nobody uploaded, and what it refuses to guess at.
import { describe, expect, it } from "vitest";
import type { AdminBotPaperSlotRecord } from "../../contracts/paper-slots.js";
import { driveFileIdFromUrl, resolvePaperPdfSource } from "./paper-pdf-source.js";

function slot(
  fields: Partial<AdminBotPaperSlotRecord> & { slot: string },
): AdminBotPaperSlotRecord {
  return { paper_id: "p1", status: "provided", ...fields } as AdminBotPaperSlotRecord;
}

describe("driveFileIdFromUrl", () => {
  it("reads all three spellings Drive hands out", () => {
    expect(
      driveFileIdFromUrl("https://drive.google.com/file/d/1PdF9xAbCdEf/view?usp=sharing"),
    ).toBe("1PdF9xAbCdEf");
    expect(driveFileIdFromUrl("https://drive.google.com/open?id=1PdF9xAbCdEf")).toBe(
      "1PdF9xAbCdEf",
    );
    expect(driveFileIdFromUrl("https://drive.google.com/uc?export=download&id=1PdF9xAbCdEf")).toBe(
      "1PdF9xAbCdEf",
    );
  });

  it("refuses anything that is not a file", () => {
    // A folder or a Doc would download as something that is not the paper.
    expect(driveFileIdFromUrl("https://drive.google.com/drive/folders/1aBcD")).toBeUndefined();
    expect(driveFileIdFromUrl("https://docs.google.com/document/d/1aBcD/edit")).toBeUndefined();
    expect(driveFileIdFromUrl("")).toBeUndefined();
    expect(driveFileIdFromUrl("not a url")).toBeUndefined();
  });
});

describe("resolvePaperPdfSource", () => {
  it("prefers the versioned arXiv PDF for X over the Drive copy", () => {
    expect(
      resolvePaperPdfSource(
        [
          slot({ slot: "arxiv", url: "https://arxiv.org/abs/2608.27510v2" }),
          slot({
            slot: "drive_pdf_arxiv",
            url: "https://drive.google.com/file/d/1PdF9xAbCdEf/view",
          }),
        ],
        true,
      ),
    ).toEqual({ kind: "arxiv", id: "2608.27510v2", url: "https://arxiv.org/abs/2608.27510v2" });
  });
  it("finds the Drive copy the card already collected", () => {
    const source = resolvePaperPdfSource([
      slot({ slot: "overleaf_edit", url: "https://overleaf.com/project/65f2" }),
      slot({ slot: "drive_pdf_arxiv", url: "https://drive.google.com/file/d/1PdF9xAbCdEf/view" }),
    ]);
    expect(source).toEqual({
      kind: "drive",
      fileId: "1PdF9xAbCdEf",
      url: "https://drive.google.com/file/d/1PdF9xAbCdEf/view",
    });
  });

  it("says what to do when there is no PDF on file", () => {
    const source = resolvePaperPdfSource([]);
    expect(source.kind).toBe("none");
    expect(source.kind === "none" && source.reason).toContain("Drive copy");
  });

  it("does not try to read a folder link as the paper", () => {
    const source = resolvePaperPdfSource([
      slot({ slot: "drive_pdf_arxiv", url: "https://drive.google.com/drive/folders/1aBcD" }),
    ]);
    expect(source.kind).toBe("none");
    expect(source.kind === "none" && source.reason).toContain("does not point at a file");
  });

  it("does not fall back to Overleaf, which cannot be asked for a compiled PDF", () => {
    const source = resolvePaperPdfSource([
      slot({ slot: "overleaf_edit", url: "https://overleaf.com/project/65f2" }),
    ]);
    expect(source.kind).toBe("none");
  });
});

describe("resolvePaperPdfSource card fallbacks", () => {
  it("uses the arXiv link on the card when no slot holds one (PruneGround's case)", () => {
    expect(
      resolvePaperPdfSource([], true, { arxiv_url: "https://arxiv.org/abs/2610.01234" }),
    ).toEqual({ kind: "arxiv", id: "2610.01234", url: "https://arxiv.org/abs/2610.01234" });
  });

  it("uses the card's Drive PDF link when no slot holds one", () => {
    expect(
      resolvePaperPdfSource([], false, {
        google_drive_pdf_url: "https://drive.google.com/file/d/1CardPdfXyZ9/view",
      }),
    ).toEqual({
      kind: "drive",
      fileId: "1CardPdfXyZ9",
      url: "https://drive.google.com/file/d/1CardPdfXyZ9/view",
    });
  });

  it("lets LinkedIn fall back to arXiv rather than refuse for want of a Drive copy", () => {
    expect(
      resolvePaperPdfSource([slot({ slot: "arxiv", url: "https://arxiv.org/abs/2608.27510" })]),
    ).toMatchObject({ kind: "arxiv", id: "2608.27510" });
  });

  it("still prefers the Drive copy for LinkedIn when both exist", () => {
    expect(
      resolvePaperPdfSource([], false, {
        arxiv_url: "https://arxiv.org/abs/2608.27510",
        google_drive_pdf_url: "https://drive.google.com/file/d/1CardPdfXyZ9/view",
      }),
    ).toMatchObject({ kind: "drive", fileId: "1CardPdfXyZ9" });
  });

  it("prefers the slot over the card when both are filled", () => {
    expect(
      resolvePaperPdfSource(
        [slot({ slot: "arxiv", url: "https://arxiv.org/abs/2608.27510v2" })],
        true,
        { arxiv_url: "https://arxiv.org/abs/2608.27510v1" },
      ),
    ).toMatchObject({ id: "2608.27510v2" });
  });

  it("names the abstract as a way out when nothing is on file", () => {
    const source = resolvePaperPdfSource([], true, {});
    expect(source.kind === "none" && source.reason).toContain("paste the abstract");
  });
});
