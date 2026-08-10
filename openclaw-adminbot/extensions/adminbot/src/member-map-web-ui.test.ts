import { describe, expect, it } from "vitest";
import { renderMemberMapWebUi } from "./member-map-web-ui.js";

// buildSidebarHtml (and the escapeHtml/placeCount helpers it calls) are pure functions of the
// /member-map response -- no DOM or Leaflet dependency -- so the real client-side code can be
// sliced out of the rendered page and executed directly against fake "summary" and "full"
// payloads. That is a much stronger guarantee than asserting the source text merely contains an
// `isFull` check: it proves the function actually withholds names given a summary payload, not
// just that some conditional exists somewhere.
// The three functions needed aren't contiguous in the page (Leaflet setup code, which needs a
// real `L` global this test doesn't have, sits between them), so each is pulled out individually
// by matching its balanced braces rather than slicing a fixed range of the source.
function extractFunctionSource(html: string, name: string): string {
  const nameIndex = html.indexOf(`function ${name}(`);
  if (nameIndex === -1) {
    throw new Error(`member-map-web-ui.ts's structure changed; could not find function ${name}`);
  }
  const braceStart = html.indexOf("{", nameIndex);
  let depth = 0;
  for (let i = braceStart; i < html.length; i += 1) {
    if (html[i] === "{") depth += 1;
    else if (html[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return html.slice(nameIndex, i + 1);
      }
    }
  }
  throw new Error(`unbalanced braces extracting function ${name}`);
}

function extractSidebarBuilder(): (data: unknown) => string {
  const html = renderMemberMapWebUi();
  const body =
    [extractFunctionSource(html, "escapeHtml"), extractFunctionSource(html, "placeCount"), extractFunctionSource(html, "buildSidebarHtml")].join(
      "\n",
    ) + "\nreturn buildSidebarHtml;";
  // eslint-disable-next-line no-new-func -- deliberately executing the page's own real script.
  return new Function(body)();
}

const SUMMARY_DATA = {
  mode: "summary",
  places: [
    { key: "toronto", label: "Toronto", country: "Canada", lat: 43.6532, lon: -79.3832, count: 2 },
  ],
};

const FULL_DATA = {
  mode: "full",
  places: [
    {
      key: "toronto",
      label: "Toronto",
      country: "Canada",
      lat: 43.6532,
      lon: -79.3832,
      members: [
        { member_id: "a", name: "Ada Lovelace", source: "roster" },
        { member_id: "b", name: "Bo", source: "slack" },
      ],
    },
  ],
  unplaced: [{ member_id: "z", name: "Zedunia", raw: "somewhere", source: "roster" }],
};

describe("member-map-web-ui's sidebar builder", () => {
  it("never puts a name in the DOM for a summary payload", () => {
    const buildSidebarHtml = extractSidebarBuilder();
    const html = buildSidebarHtml(SUMMARY_DATA);
    expect(html).toContain("Toronto");
    expect(html).toContain("2");
    expect(html).not.toContain("Ada");
    expect(html).not.toContain("Bo");
  });

  it("shows names and the unplaced list for a full payload", () => {
    const buildSidebarHtml = extractSidebarBuilder();
    const html = buildSidebarHtml(FULL_DATA);
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Bo");
    expect(html).toContain("Zedunia");
  });
});