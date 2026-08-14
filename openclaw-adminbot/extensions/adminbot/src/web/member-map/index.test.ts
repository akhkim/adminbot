import { describe, expect, it } from "vitest";
import { renderMemberMapWebUi } from "./index.js";

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

function extractSidebarBuilder(): (data: unknown, expandedKeys: Set<string>) => string {
  const html = renderMemberMapWebUi();
  const body =
    [
      extractFunctionSource(html, "escapeHtml"),
      extractFunctionSource(html, "placeCount"),
      extractFunctionSource(html, "recentActiveMembers"),
      extractFunctionSource(html, "avatarsHtml"),
      extractFunctionSource(html, "nameListHtml"),
      extractFunctionSource(html, "buildSidebarHtml"),
    ].join("\n") + "\nreturn buildSidebarHtml;";
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
    const html = buildSidebarHtml(SUMMARY_DATA, new Set());
    expect(html).toContain("Toronto");
    expect(html).toContain("2");
    expect(html).not.toContain("Ada");
    expect(html).not.toContain("Bo");
  });

  it("shows names as hover titles on avatars, and the unplaced list, for a full payload", () => {
    const buildSidebarHtml = extractSidebarBuilder();
    const html = buildSidebarHtml(FULL_DATA, new Set());
    // Names are on the circles' title attributes, not printed as visible row text.
    expect(html).toContain('title="Ada Lovelace"');
    expect(html).toContain('title="Bo"');
    expect(html).toContain("Zedunia");
  });

  const FOUR_MEMBER_PLACE = {
    mode: "full",
    places: [
      {
        key: "toronto",
        label: "Toronto",
        country: "Canada",
        lat: 43.6532,
        lon: -79.3832,
        members: [
          { member_id: "a", name: "Ada", last_login_at: "2026-01-01T00:00:00.000Z" },
          { member_id: "b", name: "Bo", last_login_at: "2026-01-03T00:00:00.000Z" },
          { member_id: "c", name: "Cy", last_login_at: "2026-01-02T00:00:00.000Z" },
          { member_id: "d", name: "Di" },
        ],
      },
    ],
  };

  it("caps a place's avatars at 3, most-recently-logged-in first, with a '…' and an expand button", () => {
    const buildSidebarHtml = extractSidebarBuilder();
    const html = buildSidebarHtml(FOUR_MEMBER_PLACE, new Set());
    expect((html.match(/class="member-avatar"/g) || []).length).toBe(3);
    // Bo logged in most recently, then Cy, then Ada; Di (no login recorded) is left out.
    const order = [...html.matchAll(/title="([^"]+)"/g)].map((match) => match[1]);
    expect(order).toEqual(["Bo", "Cy", "Ada"]);
    expect(html).toContain("member-avatar-more");
    expect(html).not.toContain("Di");
    expect(html).toContain('class="place-expand-btn"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Show all 4");
  });

  it("adds a readable name list below the avatars once a place's key is expanded", () => {
    const buildSidebarHtml = extractSidebarBuilder();
    const html = buildSidebarHtml(FOUR_MEMBER_PLACE, new Set(["toronto"]));
    // The avatar row stays capped at 3 even when expanded — expanding adds the list, it does
    // not turn every member into another circle to hover.
    expect((html.match(/class="member-avatar"/g) || []).length).toBe(3);
    expect(html).toContain("member-avatar-more");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Show less");
    const listNames = [...html.matchAll(/<li>([^<]+)<\/li>/g)].map((match) => match[1]);
    expect(listNames).toEqual(["Ada", "Bo", "Cy", "Di"]);
  });

  it("omits the expand button for a place with 3 or fewer members", () => {
    const buildSidebarHtml = extractSidebarBuilder();
    const html = buildSidebarHtml(FULL_DATA, new Set());
    expect(html).not.toContain("place-expand-btn");
  });

  it("falls back to an initial when a member has no avatar_url", () => {
    const buildSidebarHtml = extractSidebarBuilder();
    const html = buildSidebarHtml(
      {
        mode: "full",
        places: [
          {
            key: "toronto",
            label: "Toronto",
            country: "Canada",
            lat: 43.6532,
            lon: -79.3832,
            members: [{ member_id: "a", name: "Ada" }],
          },
        ],
      },
      new Set(),
    );
    expect(html).toContain('<span class="member-avatar" title="Ada">A</span>');
  });
});

describe("member-map-web-ui's page shell", () => {
  it("emits an inline script that actually parses", () => {
    // The page is built as one TS template literal, so a stray backtick or an over-escaped quote
    // in a comment or string silently truncates it and ships a page that dies at parse time.
    // toContain assertions cannot see that; compiling the script can. Function() compiles without
    // running, so no DOM/Leaflet global is needed.
    const html = renderMemberMapWebUi();
    const script = html.slice(
      html.indexOf("<script>") + "<script>".length,
      html.lastIndexOf("</script>"),
    );
    expect(script.length).toBeGreaterThan(1000);
    expect(() => new Function(script)).not.toThrow();
  });

  it("wires the Slack refresh and directory sync buttons to their own status line each", () => {
    const html = renderMemberMapWebUi();
    expect(html).toContain('id="map-refresh"');
    expect(html).toContain('id="map-status"');
    expect(html).toContain('id="directory-sync"');
    expect(html).toContain('id="directory-status"');
    expect(html).toContain("Sync Slack IDs &amp; timezones");
    // Two independent actions must not share one status line, or a message from one would read
    // as if it came from the other.
    expect(html).toContain('setStatus("directory-status"');
    expect(html).toContain('setStatus("map-status"');
  });
});
