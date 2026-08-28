import { describe, expect, it } from "vitest";
import {
  addressOfResponse,
  buildLinkMap,
  nextPageToken,
  parseFormResponses,
  responseLink,
} from "../../scripts/adminbot-form-response-links.ts";

const FORM_ID = "13rrKRIqjAZXYoS-k8c4fdzzjaBRXhgZrCGTloFRR_10";

describe("form response links", () => {
  // gog's envelope shape varies per command, so the responses array is located rather than assumed.
  it("finds the responses array wherever the envelope puts it", () => {
    const bare = JSON.stringify([{ responseId: "a", respondentEmail: "a@x.edu" }]);
    expect(parseFormResponses(bare)).toHaveLength(1);

    const wrapped = JSON.stringify({
      result: { responses: [{ responseId: "b" }, { responseId: "c" }] },
      nextPageToken: "tok",
    });
    expect(parseFormResponses(wrapped).map((r) => r.responseId)).toEqual(["b", "c"]);
    expect(nextPageToken(wrapped)).toBe("tok");

    expect(parseFormResponses("")).toEqual([]);
    expect(parseFormResponses(JSON.stringify({ responses: [] }))).toEqual([]);
    expect(nextPageToken(JSON.stringify({ responses: [] }))).toBeUndefined();
    expect(() => parseFormResponses("not json")).toThrow(/did not return JSON/u);
  });

  // respondentEmail is only populated when the form collects addresses; these forms ask for one in
  // a free-text question instead.
  it("takes the collected address, else an address out of the answers", () => {
    expect(addressOfResponse({ respondentEmail: "Collected@X.edu" })).toBe("collected@x.edu");
    expect(
      addressOfResponse({
        answers: {
          "1a2b": { textAnswers: { answers: [{ value: "Ada Lovelace" }] } },
          "3c4d": { textAnswers: { answers: [{ value: "  Ada@Example.edu " }] } },
        },
      }),
    ).toBe("ada@example.edu");
    // No address anywhere is undefined, not a guess: an unattributed response must be reported.
    expect(addressOfResponse({ responseId: "x" })).toBeUndefined();
  });

  it("maps addresses to their own submission, newest winning", () => {
    const { links, unattributed } = buildLinkMap(FORM_ID, [
      { responseId: "first", respondentEmail: "ada@x.edu" },
      { responseId: "second", respondentEmail: "ada@x.edu" },
      { responseId: "orphan" },
      { respondentEmail: "no-id@x.edu" },
    ]);
    expect(links["ada@x.edu"]).toBe(responseLink(FORM_ID, "second"));
    expect(unattributed).toEqual(["orphan"]);
    expect(Object.keys(links)).toEqual(["ada@x.edu"]);
  });

  it("builds a link that names one response on the right form", () => {
    const link = responseLink(FORM_ID, "ACYDBNi");
    expect(link).toBe(`https://docs.google.com/forms/d/${FORM_ID}/edit#response=ACYDBNi`);
  });
});
