import { describe, expect, it } from "vitest";
import { assertOverleafPayloadReady, buildOverleafEditPayload } from "./overleaf-editing.js";

describe("AdminBot Overleaf editing helpers", () => {
  it("builds affiliation-check edit payloads from paper links and member notes", () => {
    const payload = buildOverleafEditPayload({
      paperId: "paper-1",
      title: "Paper One",
      authors: ["alice", "zhijing", "unknown"],
      overleafEditUrl: "https://www.overleaf.com/project/abc",
      requestedEdits: "Check affiliations and update author block.",
      mode: "affiliation_check",
      members: [
        {
          id: "alice",
          name: "Alice Doe",
          privilege_level: "member",
          access: [],
          notes: "Main affiliation: Jinesis",
          created_at: "2026-06-01T00:00:00.000Z",
          updated_at: "2026-06-01T00:00:00.000Z",
        },
        {
          id: "zhijing",
          name: "Zhijing Jin",
          privilege_level: "admin",
          access: [],
          created_at: "2026-06-01T00:00:00.000Z",
          updated_at: "2026-06-01T00:00:00.000Z",
        },
      ],
    });

    expect(payload.action).toBe("apply_overleaf_project_edits");
    expect(payload.targetFiles).toEqual(["main.tex"]);
    expect(payload.affiliationPolicy?.rules).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Jinesis Lab, University of Toronto & Vector Institute"),
        expect.stringContaining("Never use"),
      ]),
    );
    expect(payload.affiliationPolicy?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ author: "Alice Doe", status: "ok" }),
        expect.objectContaining({ author: "Zhijing Jin", status: "confirm" }),
        expect.objectContaining({ author: "unknown", status: "missing" }),
      ]),
    );
    expect(() => assertOverleafPayloadReady(payload)).toThrow(/requires confirmation/u);
  });

  it("accepts manual edits when the Overleaf link and requested changes are present", () => {
    const payload = buildOverleafEditPayload({
      title: "Paper Two",
      authors: ["Alice"],
      overleafEditUrl: "https://www.overleaf.com/project/def",
      requestedEdits: "Fix typo in abstract.",
      targetFiles: ["sections/abstract.tex"],
      members: [],
    });

    expect(payload.mode).toBe("manual");
    expect(payload.targetFiles).toEqual(["sections/abstract.tex"]);
    expect(() => assertOverleafPayloadReady(payload)).not.toThrow();
  });
});
