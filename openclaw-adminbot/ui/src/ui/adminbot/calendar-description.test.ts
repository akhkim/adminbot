import { describe, expect, it } from "vitest";
import { looksLikeHtml, sanitizeEventDescription } from "./calendar-description.ts";

// The description that started this: Google's own markup, rendered as text, put raw tags on screen.
const REAL_DESCRIPTION =
  '<p>Causality Zoom link: <a href="https://utoronto.zoom.us/j/86980483593"><u>https://utoronto.zoom.us/j/86980483593</u></a></p>' +
  'Google Docs Link: <a href="https://docs.google.com/document/d/1Wupzd/edit?usp=sharing" target="_blank">https://docs.google.com/document/d/1Wupzd/edit?usp=sharing</a><br>' +
  'Overleaf link: <a href="https://www.overleaf.com/3244733635khwhbbssswqj#0b530c" target="_blank">https://www.overleaf.com/3244733635khwhbbssswqj#0b530c</a>';

describe("sanitizeEventDescription", () => {
  it("keeps the text and the links from a real Google description", () => {
    const html = sanitizeEventDescription(REAL_DESCRIPTION);
    expect(html).toContain("Causality Zoom link:");
    expect(html).toContain('href="https://utoronto.zoom.us/j/86980483593"');
    expect(html).toContain('href="https://www.overleaf.com/3244733635khwhbbssswqj#0b530c"');
    // The markup is markup now, not something the reader has to look at.
    expect(html).not.toContain("&lt;p&gt;");
    expect(html).toContain("<p>");
    expect(html).toContain("<br>");
  });

  it("opens every link in a new tab, safely", () => {
    const html = sanitizeEventDescription('<a href="https://example.com">x</a>');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
  });

  // This string is controlled by anyone who can put an event on the lab calendar, including an
  // outside guest whose invitation lands there.
  it.each([
    ["a script tag", "<script>alert(1)</script><p>after</p>", "alert(1)"],
    ["an inline handler", '<p onclick="alert(1)">click</p>', "onclick"],
    ["an image error handler", '<img src=x onerror="alert(1)">', "onerror"],
    ["an iframe", '<iframe src="https://evil.example"></iframe>', "iframe"],
    ["a style attribute", '<p style="position:fixed">x</p>', "style"],
  ])("strips %s", (_label, input, forbidden) => {
    expect(sanitizeEventDescription(input)).not.toContain(forbidden);
  });

  it.each([
    ["javascript:", '<a href="javascript:alert(1)">x</a>'],
    ["data:", '<a href="data:text/html,<script>alert(1)</script>">x</a>'],
  ])("drops a %s href but keeps the text", (_label, input) => {
    const html = sanitizeEventDescription(input);
    expect(html).not.toContain("href");
    expect(html).toContain("x");
  });

  it("keeps a mailto link, which is a normal thing to put in an invitation", () => {
    expect(sanitizeEventDescription('<a href="mailto:ada@cs.toronto.edu">mail</a>')).toContain(
      'href="mailto:ada@cs.toronto.edu"',
    );
  });

  // Plain descriptions are still the common case and must not lose their shape.
  it("keeps the line breaks of a plain-text description", () => {
    expect(sanitizeEventDescription("First line\nSecond line")).toBe("First line<br>Second line");
  });

  // Doing the newline conversion after sanitizing is what stops the newlines *between* Google's
  // block tags becoming visible blank lines.
  it("does not add breaks for the newlines inside real markup", () => {
    expect(sanitizeEventDescription("<p>One</p>\n<p>Two</p>")).not.toContain("<br>");
  });

  it("returns nothing for nothing", () => {
    expect(sanitizeEventDescription(undefined)).toBe("");
    expect(sanitizeEventDescription("   ")).toBe("");
  });

  it("caps a pathological description rather than rendering all of it", () => {
    const html = sanitizeEventDescription("x".repeat(30_000));
    expect(html.length).toBeLessThan(21_000);
    expect(html.endsWith("…")).toBe(true);
  });
});

describe("looksLikeHtml", () => {
  it("tells markup from text that merely contains punctuation", () => {
    expect(looksLikeHtml("<p>hi</p>")).toBe(true);
    expect(looksLikeHtml("a < b and c > d")).toBe(false);
    expect(looksLikeHtml("plain\nlines")).toBe(false);
  });
});
