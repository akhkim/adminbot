// The venue guide is a verbatim port of a page that carries its own JS template literals, wrapped
// in a template literal. That is the whole risk: an unescaped backtick truncates the page and an
// unescaped `${` silently interpolates lab state into somebody's decision guide. Both would
// typecheck, and neither would be obvious by eye in 59KB of markup.
import { describe, expect, it } from "vitest";
import { renderVenuePickerWebUi } from "./index.js";

const html = renderVenuePickerWebUi();

describe("renderVenuePickerWebUi", () => {
  it("returns a complete document", () => {
    expect(html.startsWith("<!doctype html>") || html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
    // Truncation at the first stray backtick would still pass the two checks above only by
    // accident, so assert the page is the size it should be.
    expect(html.length).toBeGreaterThan(50_000);
  });

  it("keeps the page's own template syntax literal rather than interpolating it", () => {
    // These are written by the page's inline script at runtime. If escaping failed, the build
    // would have substituted them away and they would be missing here.
    expect(html).toContain("${");
    expect(html).toContain('href="${v.url}"');
  });

  it("carries the three views the guide is built around", () => {
    for (const view of ["wizard", "chart", "venues"]) {
      expect(html.toLowerCase()).toContain(view);
    }
  });

  it("asks for no asset this server does not serve", () => {
    // The page shipped beside a logo.png that only existed in its own deployment. There is no
    // static asset route here, so a surviving reference would render as a broken image.
    expect(html).not.toContain("logo.png");
    expect(html).toContain("Jinesis Lab");
  });

  it("is a pure function of nothing, so it cannot leak lab state", () => {
    expect(renderVenuePickerWebUi()).toBe(html);
  });
});
