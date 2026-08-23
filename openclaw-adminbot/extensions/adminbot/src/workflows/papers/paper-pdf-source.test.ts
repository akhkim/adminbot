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
