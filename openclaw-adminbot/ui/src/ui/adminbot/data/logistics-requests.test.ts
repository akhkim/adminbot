import { describe, expect, it } from "vitest";
import { createSchoolRow } from "./logistics-draft.ts";
import {
  compareRequests,
  schoolDeadlines,
  soonestDeadline,
  type LogisticsRequest,
} from "./logistics-requests.ts";

function request(fields: Partial<LogisticsRequest> = {}): LogisticsRequest {
  return {
    id: "recommendation-letters",
    member: "Ada Lovelace",
    savedAt: 1_700_000_000_000,
    deadline: null,
    type: "recommendationLetters",
    schools: [],
    cvOverleafUrl: "",
    driveFolderUrl: "",
    ...fields,
  } as LogisticsRequest;
}

describe("soonestDeadline", () => {
  it("takes the nearest date, which is what makes one request more urgent", () => {
    expect(soonestDeadline(["2026-12-01", "2026-11-24", "2027-01-15"])).toBe("2026-11-24");
  });

  it("ignores anything that is not a stored date", () => {
    expect(soonestDeadline(["", "soon", "2026-12-01"])).toBe("2026-12-01");
    expect(soonestDeadline(["", "soon"])).toBeNull();
    expect(soonestDeadline([])).toBeNull();
  });
});

describe("schoolDeadlines", () => {
  it("counts both dates on every row -- either one passing makes the letter late", () => {
    const schools = [
      createSchoolRow({ applicationDeadline: "2026-12-01", letterDeadline: "2026-11-24" }),
      createSchoolRow({ applicationDeadline: "2026-12-15" }),
    ];
    expect(schoolDeadlines(schools)).toEqual(["2026-12-01", "2026-11-24", "2026-12-15", ""]);
    expect(soonestDeadline(schoolDeadlines(schools))).toBe("2026-11-24");
  });
});

describe("compareRequests", () => {
  it("puts the nearest deadline first", () => {
    const near = request({ deadline: "2026-11-24" });
    const far = request({ deadline: "2026-12-01" });
    expect([far, near].toSorted(compareRequests).map((entry) => entry.deadline)).toEqual([
      "2026-11-24",
      "2026-12-01",
    ]);
  });

  it("sorts a request with no deadline last, not first", () => {
    // There is nothing to be late for, so it must not sit above a dated request.
    const dated = request({ deadline: "2026-12-01" });
    const undated = request({ id: "document-signature", deadline: null });
    expect([undated, dated].toSorted(compareRequests).map((entry) => entry.id)).toEqual([
      "recommendation-letters",
      "document-signature",
    ]);
  });

  it("breaks a tie on the most recently saved", () => {
    const older = request({ id: "a", deadline: "2026-12-01", savedAt: 1 });
    const newer = request({ id: "b", deadline: "2026-12-01", savedAt: 2 });
    expect([older, newer].toSorted(compareRequests).map((entry) => entry.id)).toEqual(["b", "a"]);
  });
});
