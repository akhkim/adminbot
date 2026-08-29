import { describe, expect, it } from "vitest";
import { findOnboardingTemplate } from "../workflows/onboarding/emails.js";
import { composeOnboardingGuide } from "../workflows/onboarding/guide.js";
import { renderEmailBodyHtml } from "./email-html.js";

describe("renderEmailBodyHtml", () => {
  it("makes each blank-line-separated block a paragraph, keeping internal breaks", () => {
    expect(
      renderEmailBodyHtml("Hi Ada,\n\nOne line.\n\nBest regards,\nJinesis AI Research Lab"),
    ).toBe("<p>Hi Ada,</p><p>One line.</p><p>Best regards,<br />Jinesis AI Research Lab</p>");
  });

  it("nests bullets by two-space indent, closing each level inside its parent item", () => {
    const html = renderEmailBodyHtml(
      ["- Top", "  - Middle", "    - Deep one", "    - Deep two", "- Back out"].join("\n"),
    );
    expect(html).toBe(
      "<ul><li>Top<ul><li>Middle<ul><li>Deep one</li><li>Deep two</li></ul></li></ul></li>" +
        "<li>Back out</li></ul>",
    );
  });

  it("linkifies bare URLs without swallowing the sentence's punctuation", () => {
    expect(renderEmailBodyHtml("Sign up at https://example.com/signup and follow the guide.")).toBe(
      '<p>Sign up at <a href="https://example.com/signup">https://example.com/signup</a> and ' +
        "follow the guide.</p>",
    );
    // A URL ending a sentence keeps its full stop as text, not as part of the href.
    expect(renderEmailBodyHtml("See https://example.com/a.")).toBe(
      '<p>See <a href="https://example.com/a">https://example.com/a</a>.</p>',
    );
  });

  it("escapes everything else, including inside a link and a bullet", () => {
    expect(renderEmailBodyHtml('Ada & <b>Bob</b> said "hi".')).toBe(
      "<p>Ada &amp; &lt;b&gt;Bob&lt;/b&gt; said &quot;hi&quot;.</p>",
    );
    // The `&` of a query string must survive as a URL character and still be escaped in the
    // attribute -- escaping before linkifying would break one or the other.
    expect(renderEmailBodyHtml("- Open https://example.com/x?a=1&b=2")).toBe(
      '<ul><li>Open <a href="https://example.com/x?a=1&amp;b=2">' +
        "https://example.com/x?a=1&amp;b=2</a></li></ul>",
    );
  });

  it("renders nothing for an empty body, so a caller can skip the html part", () => {
    expect(renderEmailBodyHtml("")).toBe("");
    expect(renderEmailBodyHtml("\n\n  \n")).toBe("");
  });

  // The whole point of the html alternative: no output line is long enough for a client to be
  // tempted to wrap it, and no *source* line was ever wrapped either.
  it("carries the member template's copy with its structure intact", () => {
    const composed = composeOnboardingGuide("member", { first_name: "Ada" }, {});
    expect(composed.ok).toBe(true);
    if (!composed.ok) {
      return;
    }
    const html = renderEmailBodyHtml(composed.guide.body);
    expect(html.startsWith("<p>Hi Ada,</p>")).toBe(true);
    // Prose paragraphs now, not a nested bullet tree: both routes to an account read as sentences.
    expect(html).toContain("<p>If you already have an @cs.toronto.edu email");
    expect(html).toContain("<p>If you do not have an @cs.toronto.edu email yet");
    expect(html).toContain(
      '<a href="https://jinesis-admin.vercel.app">https://jinesis-admin.vercel.app</a>',
    );
    // The literal example braces are copy, so they must survive escaping as text.
    expect(html).toContain("{first_letter_of_first_name}{full_last_name}");
    expect(html.endsWith("<p>Best regards,<br />Jinesis Lab</p>")).toBe(true);
    // Balanced structure: every list and item this body opened is closed again.
    expect(html.split("<ul>").length).toBe(html.split("</ul>").length);
    expect(html.split("<li>").length).toBe(html.split("</li>").length);
  });

  it("renders every onboarding template without leaving a tag unbalanced", () => {
    for (const id of ["interviewee", "alumni", "coauthor_minor", "member_what_to_expect"]) {
      const template = findOnboardingTemplate(id);
      const html = renderEmailBodyHtml(template?.body ?? "");
      expect(html.split("<ul>").length, id).toBe(html.split("</ul>").length);
      expect(html.split("<li>").length, id).toBe(html.split("</li>").length);
      expect(html.split("<p>").length, id).toBe(html.split("</p>").length);
    }
  });
});
