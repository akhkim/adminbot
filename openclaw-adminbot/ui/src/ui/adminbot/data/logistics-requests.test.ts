// The two conversions either side of the logistics wire: what the form sends, and what the list
// draws. Deadline arithmetic and ordering are the service's now (see
// extensions/adminbot/src/workflows/logistics/requests.ts) -- one answer to "which of these is
// soonest", derived once on write, rather than one per client.
import { describe, expect, it } from "vitest";
import { createFactRow, createMeetingRow, createSchoolRow } from "./logistics-draft.ts";
import {
  attachmentDataUrl,
  describeSubmitBlock,
  factToWire,
  fileToAttachment,
  filledFacts,
  filledMeetings,
  filledSchools,
  formatFileSize,
  lettersRequestInput,
  meetingRequestInput,
  meetingToWire,
  oversizedFile,
  requestToFormState,
  schoolToWire,
  signatureRequestInput,
  MAX_ATTACHMENT_BYTES,
} from "./logistics-requests.ts";

function makeFile(name: string, contents = "hello", type = "application/pdf"): File {
  return new File([contents], name, { type });
}

function bigFile(name: string, size: number): File {
  const file = makeFile(name);
  Object.defineProperty(file, "size", { value: size });
  return file;
}

describe("formatFileSize", () => {
  it("keeps a decimal below ten units and drops it above", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1024 * 1024 * 1.44)).toBe("1.4 MB");
    expect(formatFileSize(1024 * 247)).toBe("247 KB");
  });
});

describe("fileToAttachment", () => {
  it("carries the bytes as base64, without the data: prefix the reader hands back", async () => {
    const attachment = await fileToAttachment(makeFile("form.pdf", "hello"));
    expect(attachment).toEqual({
      name: "form.pdf",
      size: 5,
      content_type: "application/pdf",
      data_base64: Buffer.from("hello").toString("base64"),
    });
  });

  it("round-trips back into something a browser will save", async () => {
    const attachment = await fileToAttachment(makeFile("form.pdf", "hello"));
    expect(attachmentDataUrl(attachment)).toBe(
      `data:application/pdf;base64,${Buffer.from("hello").toString("base64")}`,
    );
  });

  it("names a type for a file the browser would not, so the download is still openable", () => {
    expect(attachmentDataUrl({ name: "x", size: 1, data_base64: "AA==" })).toContain(
      "data:application/octet-stream;base64,",
    );
  });
});

describe("row conversion", () => {
  it("sends a school row under the names the service knows it by, blanks omitted", () => {
    expect(
      schoolToWire(
        createSchoolRow({
          school: "  MIT  ",
          letterDeadline: "2026-12-01",
          letterDeadlineTime: "17:00",
          deadlineTimezone: "America/New_York",
          notes: "",
        }),
      ),
    ).toEqual({
      school: "MIT",
      letter_deadline: "2026-12-01",
      letter_deadline_time: "17:00",
      deadline_timezone: "America/New_York",
    });
  });

  it("keeps the stamp a meeting row was created with rather than restamping it on send", () => {
    const row = createMeetingRow({ purpose: "sync", lengthMinutes: "30" });
    const wire = meetingToWire(row);
    expect(wire.submitted_at).toBe(new Date(row.submittedAt).toISOString());
    expect(wire.length_minutes).toBe(30);
  });

  it("leaves a length that is not a number off the row rather than sending NaN", () => {
    expect(
      meetingToWire(createMeetingRow({ purpose: "sync", lengthMinutes: "" })),
    ).not.toHaveProperty("length_minutes");
  });

  it("trims a fact down to what the writer reads", () => {
    expect(
      factToWire(createFactRow({ project: " AdminBot ", contribution: " the gate " })),
    ).toEqual({ project: "AdminBot", contribution: "the gate" });
  });
});

describe("dropping the blank row at the bottom of a table", () => {
  it("keeps the rows somebody typed in and no others", () => {
    const schools = [createSchoolRow({ school: "MIT" }), createSchoolRow()];
    expect(filledSchools(schools)).toHaveLength(1);
    expect(filledFacts([createFactRow({ project: "AdminBot" }), createFactRow()])).toHaveLength(1);
    expect(
      filledMeetings([createMeetingRow({ purpose: "sync" }), createMeetingRow()]),
    ).toHaveLength(1);
  });
});

describe("request builders", () => {
  it("reads the picked files into a signature request", async () => {
    const input = await signatureRequestInput({
      files: [makeFile("form.pdf", "sign here")],
      description: "  before the trip  ",
      attachments: [makeFile("itinerary.pdf", "flights")],
    });
    expect(input.kind).toBe("document_signature");
    expect(input.documents?.map((file) => file.name)).toEqual(["form.pdf"]);
    expect(input.attachments?.map((file) => file.name)).toEqual(["itinerary.pdf"]);
    expect(input.description).toBe("before the trip");
  });

  it("sends only the letters rows that were filled in", () => {
    const input = lettersRequestInput({
      schools: [createSchoolRow({ school: "MIT" }), createSchoolRow()],
      facts: [createFactRow({ project: "AdminBot", contribution: "the gate" }), createFactRow()],
      cvOverleafUrl: "https://overleaf.com/read/abc",
      driveFolderUrl: "",
    });
    expect(input.schools).toEqual([{ school: "MIT" }]);
    expect(input.facts).toEqual([{ project: "AdminBot", contribution: "the gate" }]);
    expect(input.cv_overleaf_url).toBe("https://overleaf.com/read/abc");
    expect(input).not.toHaveProperty("drive_folder_url");
  });

  it("sends the meeting rows as one request", () => {
    const input = meetingRequestInput({
      rows: [
        createMeetingRow({
          purpose: "sync",
          preferredTime: "2026-09-01T14:00",
        }),
      ],
    });
    expect(input.kind).toBe("book_meeting");
    expect(input.meetings?.[0]).toMatchObject({
      purpose: "sync",
      preferred_time: "2026-09-01T14:00",
    });
  });
});

describe("describeSubmitBlock", () => {
  it("refuses an empty request of each kind, so an empty one never reaches the queue", () => {
    expect(
      describeSubmitBlock("document_signature", {
        files: [],
        description: "",
        attachments: [],
      }),
    ).toEqual({ reason: "empty" });
    expect(
      describeSubmitBlock("recommendation_letters", {
        schools: [createSchoolRow()],
        facts: [],
        cvOverleafUrl: "",
        driveFolderUrl: "",
      }),
    ).toEqual({ reason: "empty" });
    expect(describeSubmitBlock("book_meeting", { rows: [] })).toEqual({
      reason: "empty",
    });
  });

  it("names the file that is too big, because that is the one the member has to act on", () => {
    expect(
      describeSubmitBlock("document_signature", {
        files: [bigFile("scan.pdf", MAX_ATTACHMENT_BYTES + 1)],
        description: "",
        attachments: [],
      }),
    ).toEqual({ reason: "file-too-big", file: "scan.pdf" });
  });

  it("catches a set of files that is only too big added up", () => {
    expect(
      describeSubmitBlock("document_signature", {
        files: Array.from({ length: 5 }, (_, index) =>
          bigFile(`part-${index}.pdf`, MAX_ATTACHMENT_BYTES),
        ),
        description: "",
        attachments: [],
      }),
    ).toEqual({ reason: "request-too-big" });
  });

  it("asks for the school's name and the meeting's purpose, the two things a row is unreadable without", () => {
    expect(
      describeSubmitBlock("recommendation_letters", {
        schools: [createSchoolRow({ notes: "the one with the nice campus" })],
        facts: [],
        cvOverleafUrl: "",
        driveFolderUrl: "",
      }),
    ).toEqual({ reason: "no-name" });
    expect(
      describeSubmitBlock("book_meeting", {
        rows: [createMeetingRow({ preferredTime: "2026-09-01T14:00" })],
      }),
    ).toEqual({ reason: "no-purpose" });
  });

  it("lets a filled-in request through", () => {
    expect(
      describeSubmitBlock("document_signature", {
        files: [makeFile("form.pdf")],
        description: "",
        attachments: [],
      }),
    ).toBeNull();
  });
});

describe("oversizedFile", () => {
  it("finds nothing to complain about in a normal set", () => {
    expect(oversizedFile([makeFile("a.pdf"), makeFile("b.pdf")])).toBeNull();
  });
});

describe("requestToFormState", () => {
  const base = {
    id: "logreq_1",
    member_id: "ada",
    member_name: "Ada",
    status: "submitted" as const,
    submitted_at: "2026-08-02T09:30:00.000Z",
    updated_at: "2026-08-02T09:30:00.000Z",
  };

  it("brings a signature request's documents back as files, not just their names", () => {
    const form = requestToFormState({
      ...base,
      kind: "document_signature",
      documents: [
        {
          name: "form.pdf",
          size: 5,
          content_type: "application/pdf",
          data_base64: Buffer.from("hello").toString("base64"),
        },
      ],
      description: "before the trip",
      attachments: [],
    });
    expect(form.signature?.files[0]?.name).toBe("form.pdf");
    expect(form.signature?.files[0]?.type).toBe("application/pdf");
    expect(form.signature?.files[0]?.size).toBe(5);
    expect(form.signature?.description).toBe("before the trip");
  });

  it("fills every column of a school row back in", () => {
    const form = requestToFormState({
      ...base,
      kind: "recommendation_letters",
      schools: [
        {
          school: "MIT",
          letter_deadline: "2026-12-01",
          letter_deadline_time: "17:00",
          deadline_timezone: "America/New_York",
          notes: "two writers",
        },
      ],
      facts: [{ project: "AdminBot", contribution: "the gate" }],
      cv_overleaf_url: "https://overleaf.com/read/abc",
    });
    expect(form.letters?.schools[0]).toMatchObject({
      school: "MIT",
      letterDeadline: "2026-12-01",
      letterDeadlineTime: "17:00",
      deadlineTimezone: "America/New_York",
      notes: "two writers",
      // Columns the request did not carry come back blank rather than undefined, because every
      // field on this form is a string the member types into.
      applicationDeadline: "",
    });
    expect(form.letters?.facts[0]).toMatchObject({ project: "AdminBot", contribution: "the gate" });
  });

  it("gives a letters request with no facts a blank row to type into", () => {
    const form = requestToFormState({
      ...base,
      kind: "recommendation_letters",
      schools: [{ school: "MIT" }],
    });
    expect(form.letters?.facts).toHaveLength(1);
    expect(form.letters?.facts[0]?.project).toBe("");
  });

  it("keeps when a meeting was asked for rather than restamping it as now", () => {
    const form = requestToFormState({
      ...base,
      kind: "book_meeting",
      meetings: [
        {
          purpose: "sync",
          preferred_time: "2026-09-01T14:00",
          timezone: "UTC",
          length_minutes: 30,
          submitted_at: "2026-08-01T00:00:00.000Z",
        },
      ],
    });
    expect(form.meeting?.rows[0]).toMatchObject({
      purpose: "sync",
      preferredTime: "2026-09-01T14:00",
      timezone: "UTC",
      lengthMinutes: "30",
      submittedAt: Date.parse("2026-08-01T00:00:00.000Z"),
    });
  });

  it("gives restored rows fresh ids, so lit keeps each row pointing at its own inputs", () => {
    const form = requestToFormState({
      ...base,
      kind: "recommendation_letters",
      schools: [{ school: "MIT" }, { school: "Berkeley" }],
    });
    const ids = form.letters?.schools.map((row) => row.id) ?? [];
    expect(new Set(ids).size).toBe(2);
  });
});
