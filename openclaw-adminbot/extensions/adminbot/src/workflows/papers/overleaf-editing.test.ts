import { describe, expect, it } from "vitest";
import { ADMINBOT_LAB_OVERLEAF_HOST } from "../../contracts/overleaf.js";
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

  it("accepts a project on the lab's own Overleaf, which is where papers are written now", () => {
    const payload = buildOverleafEditPayload({
      title: "Paper Three",
      authors: ["Alice"],
      overleafEditUrl: `https://${ADMINBOT_LAB_OVERLEAF_HOST}/project/65f2a1c9d4e3b7a801f6`,
      requestedEdits: "Fix typo in abstract.",
      members: [],
    });

    expect(() => assertOverleafPayloadReady(payload)).not.toThrow();
  });

  // The destination, not just its presence: an approved edit is posted to the configured bridge,
  // and a paper record pointing somewhere else is the one way it could be aimed at a host nobody
  // chose. Refused at execution rather than silently sent.
  it("refuses to execute against a link that is not an Overleaf project we know", () => {
    for (const overleafEditUrl of [
      "https://evil.example/project/65f2a1c9d4e3b7a801f6",
      "https://www.overleaf.com/read/xzqvbnmklpqr",
      "http://www.overleaf.com/project/65f2a1c9d4e3b7a801f6",
    ]) {
      const payload = buildOverleafEditPayload({
        title: "Paper Four",
        authors: ["Alice"],
        overleafEditUrl,
        requestedEdits: "Fix typo in abstract.",
        members: [],
      });
      expect(() => assertOverleafPayloadReady(payload)).toThrow(/must be an https project link/u);
    }
  });
});
