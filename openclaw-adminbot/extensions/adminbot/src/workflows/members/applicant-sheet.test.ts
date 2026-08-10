import { describe, expect, it } from "vitest";
import { selectUnreviewedApplicants } from "./applicant-sheet.js";

const header = [
  "Timestamp",
  "Full Name",
  "Preferred name to be called",
  "Email",
  "Why do you want to join?",
  "Link to your CV",
];

const rows = [
  header,
  [
    "2026-07-01T10:00:00Z",
    "Ada Lovelace",
    "Ada",
    "ada@example.test",
    "Curious",
    "https://drive.example/ada",
  ],
  [
    "2026-07-20T09:30:00Z",
    "Alan Turing",
    "Alan",
    "alan@example.test",
    "Machines",
    "https://drive.example/alan",
  ],
];

describe("selectUnreviewedApplicants", () => {
  it("maps the live form columns and returns every row when no cursor is set", () => {
    expect(selectUnreviewedApplicants(rows)).toEqual([
      {
        name: "Ada Lovelace",
        email: "ada@example.test",
        cv_link: "https://drive.example/ada",
        submitted_at: "2026-07-01T10:00:00Z",
      },
      {
        name: "Alan Turing",
        email: "alan@example.test",
        cv_link: "https://drive.example/alan",
        submitted_at: "2026-07-20T09:30:00Z",
      },
    ]);
  });

  it("filters to submissions strictly newer than the review cursor", () => {
    expect(selectUnreviewedApplicants(rows, "2026-07-01T10:00:00Z")).toEqual([
      expect.objectContaining({ name: "Alan Turing" }),
    ]);
    expect(selectUnreviewedApplicants(rows, "2026-08-01T00:00:00Z")).toEqual([]);
    expect(selectUnreviewedApplicants(rows, "not a date")).toHaveLength(2);
  });

  it("tolerates missing headers, short rows, and blank spacer rows", () => {
    const renamed = [
      ["Timestamp", "Name", "Email address"],
      ["2026-07-20T09:30:00Z", "Grace Hopper", "grace@example.test"],
      ["", "", ""],
    ];

    expect(selectUnreviewedApplicants(renamed, "2026-07-01T00:00:00Z")).toEqual([
      {
        name: "Grace Hopper",
        email: "grace@example.test",
        cv_link: "",
        submitted_at: "2026-07-20T09:30:00Z",
      },
    ]);
    expect(selectUnreviewedApplicants([])).toEqual([]);
  });

  it("keeps rows whose timestamp cannot be parsed so nobody is silently dropped", () => {
    const malformed = [header, ["", "Katherine Johnson", "Katherine", "k@example.test", "", "url"]];

    expect(selectUnreviewedApplicants(malformed, "2026-07-01T00:00:00Z")).toEqual([
      expect.objectContaining({ name: "Katherine Johnson", cv_link: "url" }),
    ]);
  });
});
