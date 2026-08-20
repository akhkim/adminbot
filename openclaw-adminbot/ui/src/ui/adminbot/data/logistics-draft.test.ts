import { describe, expect, it } from "vitest";
import {
  createFactRow,
  createMeetingRow,
  createSchoolRow,
  isEmptySchoolRow,
  parseLogisticsDraft,
  parseMeetingRequestDraft,
  parseRecommendationLettersDraft,
  logisticsDraftScope,
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
      parseRecommendationLettersDraft({
        schools: [],
        cvOverleafUrl: "   ",
        savedAt: 1,
      }),
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

describe("parseRecommendationLettersDraft with facts", () => {
  it("reads the facts table back and reassigns row ids", () => {
    const draft = parseRecommendationLettersDraft({
      schools: [],
      facts: [
        {
          project: "Causal NLP",
          contribution: "Built the annotation pipeline.",
        },
      ],
      cvOverleafUrl: "",
      driveFolderUrl: "",
      savedAt: 1_700_000_000_000,
    });
    expect(draft?.facts).toHaveLength(1);
    expect(draft?.facts[0]).toMatchObject({ project: "Causal NLP" });
    // Ids are view-side identity, never trusted from the record.
    expect(draft?.facts[0].id).toMatch(/^fact-\d+$/u);
  });

  it("still reads a record written before the facts table existed", () => {
    const draft = parseRecommendationLettersDraft({
      schools: [{ school: "Stanford" }],
      cvOverleafUrl: "",
      driveFolderUrl: "",
      savedAt: 0,
    });
    expect(draft?.facts).toEqual([]);
  });

  it("treats a draft with nothing but blank rows as no draft", () => {
    expect(
      parseRecommendationLettersDraft({
        schools: [],
        facts: [{ project: "  ", contribution: "" }],
        cvOverleafUrl: "",
        driveFolderUrl: "",
        savedAt: 1,
      }),
    ).toBeNull();
  });
});

describe("createMeetingRow", () => {
  it("stamps when the request was made and prefills the viewer's zone", () => {
    const before = Date.now();
    const row = createMeetingRow();
    expect(row.submittedAt).toBeGreaterThanOrEqual(before);
    expect(row.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(row.id).not.toBe(createMeetingRow().id);
  });
});

describe("parseMeetingRequestDraft", () => {
  it("keeps the stored stamp rather than restamping on restore", () => {
    const draft = parseMeetingRequestDraft({
      meetings: [
        {
          submittedAt: 1_700_000_000_000,
          purpose: "Committee check-in",
          preferredTime: "2027-01-08T14:00",
          timezone: "America/Toronto",
          lengthMinutes: "45",
        },
      ],
      savedAt: 1_700_000_000_001,
    });
    expect(draft?.meetings[0]).toMatchObject({
      submittedAt: 1_700_000_000_000,
      purpose: "Committee check-in",
      lengthMinutes: "45",
    });
    expect(draft?.savedAt).toBe(1_700_000_000_001);
  });

  it("treats a missing or empty record as no draft", () => {
    expect(parseMeetingRequestDraft(null)).toBeNull();
    expect(parseMeetingRequestDraft({ meetings: [], savedAt: 1 })).toBeNull();
    expect(
      parseMeetingRequestDraft({
        meetings: [{ purpose: "", preferredTime: "", lengthMinutes: "" }],
        savedAt: 1,
      }),
    ).toBeNull();
  });

  it("gives a row written before the stamp existed a usable one rather than dropping it", () => {
    const draft = parseMeetingRequestDraft({
      meetings: [{ purpose: "Advising" }],
      savedAt: 0,
    });
    expect(draft?.meetings[0].purpose).toBe("Advising");
    expect(draft?.meetings[0].submittedAt).toBeGreaterThan(0);
  });
});

describe("createFactRow", () => {
  it("starts blank and never copies an id", () => {
    const first = createFactRow({ project: "Nudges" });
    expect(createFactRow({ ...first }).id).not.toBe(first.id);
  });
});

describe("logisticsDraftScope", () => {
  it("keys a draft to the member it belongs to", () => {
    expect(logisticsDraftScope("ada")).toBe("ada");
    expect(logisticsDraftScope("  ada  ")).toBe("ada");
  });

  it("gives a signed-out browser its own scope rather than sharing anybody's", () => {
    // Without this, a shared machine hands the next person the last one's half-written request and
    // the documents they attached to it.
    expect(logisticsDraftScope(null)).toBe("anonymous");
    expect(logisticsDraftScope(undefined)).toBe("anonymous");
    expect(logisticsDraftScope("")).toBe("anonymous");
    expect(logisticsDraftScope("   ")).toBe("anonymous");
  });
});

describe("a meeting row's zone on restore", () => {
  it("keeps a zone the member cleared on purpose cleared", () => {
    const draft = parseMeetingRequestDraft({
      meetings: [{ purpose: "sync", timezone: "" }],
      savedAt: 1,
    });
    expect(draft?.meetings[0]?.timezone).toBe("");
  });

  it("still fills in the browser's zone for a row written before the column existed", () => {
    const draft = parseMeetingRequestDraft({
      meetings: [{ purpose: "sync" }],
      savedAt: 1,
    });
    expect(draft?.meetings[0]?.timezone).toBeTruthy();
  });
});
