import { describe, expect, it } from "vitest";
import {
  createSchoolRow,
  isEmptySchoolRow,
  parseLogisticsDraft,
  parseRecommendationLettersDraft,
} from "./logistics-draft.ts";

function makeFile(name: string): File {
  return new File(["x"], name, { type: "application/pdf" });
}

describe("parseLogisticsDraft", () => {
  it("reads a draft written by this form", () => {
    const draft = parseLogisticsDraft({
      description: "Visa letter",
      signatureFiles: [makeFile("contract.pdf")],
      attachments: [makeFile("itinerary.pdf")],
      savedAt: 1_700_000_000_000,
    });
    expect(draft?.description).toBe("Visa letter");
    expect(draft?.signatureFiles.map((file) => file.name)).toEqual(["contract.pdf"]);
    expect(draft?.attachments.map((file) => file.name)).toEqual(["itinerary.pdf"]);
    expect(draft?.savedAt).toBe(1_700_000_000_000);
  });

  it("treats a missing record as no draft", () => {
    expect(parseLogisticsDraft(undefined)).toBeNull();
    expect(parseLogisticsDraft(null)).toBeNull();
    expect(parseLogisticsDraft("draft")).toBeNull();
  });

  it("treats an empty draft as no draft", () => {
    // Restoring this would show a "Saved" timestamp for a form nobody filled in.
    expect(
      parseLogisticsDraft({
        description: "",
        signatureFiles: [],
        attachments: [],
        savedAt: 1_700_000_000_000,
      }),
    ).toBeNull();
  });

  it("keeps the description when the stored file lists are unusable", () => {
    // A record from an older build of this form still has to give back what it can.
    const draft = parseLogisticsDraft({
      description: "Visa letter",
      signatureFiles: "not-a-list",
      attachments: [makeFile("itinerary.pdf"), { name: "bogus" }],
      savedAt: "yesterday",
    });
    expect(draft?.description).toBe("Visa letter");
    expect(draft?.signatureFiles).toEqual([]);
    // The one real File survives; the plain object beside it is dropped.
    expect(draft?.attachments.map((file) => file.name)).toEqual(["itinerary.pdf"]);
    expect(draft?.savedAt).toBe(0);
  });

  it("survives a record that only has files", () => {
    const draft = parseLogisticsDraft({
      signatureFiles: [makeFile("contract.pdf")],
    });
    expect(draft?.description).toBe("");
    expect(draft?.signatureFiles.map((file) => file.name)).toEqual(["contract.pdf"]);
  });
});

describe("createSchoolRow", () => {
  it("starts every column blank and gives the row an id of its own", () => {
    const row = createSchoolRow();
    expect(isEmptySchoolRow(row)).toBe(true);
    expect(row.id).not.toBe(createSchoolRow().id);
  });

  it("keeps the fields it is given but never the id beside them", () => {
    const first = createSchoolRow({ school: "Stanford" });
    // Copying a row's fields must not copy its identity: lit keys the table by id.
    const copy = createSchoolRow({ ...first });
    expect(copy.school).toBe("Stanford");
    expect(copy.id).not.toBe(first.id);
  });

  it("does not count whitespace as filled in", () => {
    expect(isEmptySchoolRow(createSchoolRow({ school: "   " }))).toBe(true);
    expect(isEmptySchoolRow(createSchoolRow({ letterStatus: "requested" }))).toBe(false);
  });
});

describe("parseRecommendationLettersDraft", () => {
  it("reads a table written by this form", () => {
    const draft = parseRecommendationLettersDraft({
      schools: [
        {
          school: "Stanford",
          applicationDeadline: "2026-12-01",
          letterDeadline: "2026-11-24",
          applicationStatus: "submitted",
          letterStatus: "requested",
          program: "PhD in Computer Science",
          programLink: "https://example.edu/phd",
          notes: "Joint degree — wants statistics coursework named.",
        },
      ],
      savedAt: 1_700_000_000_000,
    });
    expect(draft?.schools).toHaveLength(1);
    expect(draft?.schools[0].school).toBe("Stanford");
    expect(draft?.schools[0].letterDeadline).toBe("2026-11-24");
    expect(draft?.savedAt).toBe(1_700_000_000_000);
  });

  it("gives restored rows fresh ids", () => {
    // A stored id was minted by an earlier visit's counter, which has since restarted -- reusing
    // it would let two rows on screen share a key.
    const draft = parseRecommendationLettersDraft({
      schools: [{ id: "school-1", school: "Stanford" }],
    });
    const minted = createSchoolRow();
    expect(draft?.schools[0].id).not.toBe(minted.id);
    expect(draft?.schools[0].school).toBe("Stanford");
  });

  it("treats a missing record as no draft", () => {
    expect(parseRecommendationLettersDraft(undefined)).toBeNull();
    expect(parseRecommendationLettersDraft(null)).toBeNull();
    expect(parseRecommendationLettersDraft("draft")).toBeNull();
  });

  it("keeps the two links the request travels with", () => {
    const draft = parseRecommendationLettersDraft({
      schools: [{ school: "Stanford" }],
      cvOverleafUrl: "https://www.overleaf.com/project/abc",
      driveFolderUrl: "https://drive.google.com/drive/folders/mine",
      savedAt: 1_700_000_000_000,
    });
    expect(draft?.cvOverleafUrl).toBe("https://www.overleaf.com/project/abc");
    expect(draft?.driveFolderUrl).toBe("https://drive.google.com/drive/folders/mine");
  });

  it("restores a draft that is only a link", () => {
    // Pasting the Overleaf link and stopping there is a real half-filled request.
    const draft = parseRecommendationLettersDraft({
      schools: [],
      cvOverleafUrl: "https://www.overleaf.com/project/abc",
    });
    expect(draft?.schools).toEqual([]);
    expect(draft?.cvOverleafUrl).toBe("https://www.overleaf.com/project/abc");
    expect(draft?.driveFolderUrl).toBe("");
  });

  it("treats a blank table with blank links as no draft", () => {
    expect(parseRecommendationLettersDraft({ schools: [], savedAt: 1 })).toBeNull();
    expect(
      parseRecommendationLettersDraft({
        schools: [{ school: "" }],
        savedAt: 1,
      }),
    ).toBeNull();
    expect(
      parseRecommendationLettersDraft({ schools: [], cvOverleafUrl: "   ", savedAt: 1 }),
    ).toBeNull();
  });

  it("keeps the rows it can read and drops the ones it cannot", () => {
    const draft = parseRecommendationLettersDraft({
      schools: [{ school: "Stanford", program: 42 }, "MIT", null],
      savedAt: "yesterday",
    });
    expect(draft?.schools).toHaveLength(1);
    // A field stored as something other than text falls back to blank rather than losing the row.
    expect(draft?.schools[0].program).toBe("");
    expect(draft?.savedAt).toBe(0);
  });
});
