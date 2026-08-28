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

  it("makes '1. ' steps an ordered list, across the blank lines the copy puts between them", () => {
    // The onboarding templates separate every numbered step with a blank line so the plain-text
    // part reads well. That must not split the list into five one-item lists, or five paragraphs.
    expect(renderEmailBodyHtml("1. First step.\n\n2. Second step.\n\n3. Third step.")).toBe(
      "<ol><li>First step.</li><li>Second step.</li><li>Third step.</li></ol>",
    );
  });

  it("nests a run of bullets inside the numbered step that introduces them", () => {
    // "5. Keep updated by following our social media accounts:" and its unindented bullets: the
    // bullets belong to that step, and must not terminate the numbered list.
    expect(
      renderEmailBodyHtml("1. Portal: sign in.\n\n2. Socials:\n\n- LinkedIn\n- X\n\nQuestions?"),
    ).toBe(
      "<ol><li>Portal: sign in.</li><li>Socials:<ul><li>LinkedIn</li><li>X</li></ul></li></ol>" +
        "<p>Questions?</p>",
    );
  });

  it("keeps a list that does not start at one numbered as the copy numbered it", () => {
    expect(renderEmailBodyHtml("3. Third.\n\n4. Fourth.")).toBe(
      '<ol start="3"><li>Third.</li><li>Fourth.</li></ol>',
    );
  });

  it("ends a list at a line of prose, so the next run starts its own list", () => {
    expect(renderEmailBodyHtml("1. One.\n\nThen this.\n\n1. One again.")).toBe(
      "<ol><li>One.</li></ol><p>Then this.</p><ol><li>One again.</li></ol>",
    );
  });

  it("links a bare email address, but leaves quoted and templated examples as text", () => {
    expect(renderEmailBodyHtml("Write to akim@cs.toronto.edu for help.")).toBe(
      '<p>Write to <a href="mailto:akim@cs.toronto.edu">akim@cs.toronto.edu</a> for help.</p>',
    );
    // The member template prints example usernames; those are copy about an address, not one to
    // write to, so neither the quoted nor the placeholder-built form becomes a link.
    expect(renderEmailBodyHtml('Try "firstname@cs.toronto.edu" or {last_name}@cs.toronto.edu.')).toBe(
      "<p>Try &quot;firstname@cs.toronto.edu&quot; or {last_name}@cs.toronto.edu.</p>",
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
    for (const id of ["acquaintance", "alumni", "coauthor_minor", "member_what_to_expect"]) {
      const template = findOnboardingTemplate(id);
      const html = renderEmailBodyHtml(template?.body ?? "");
      expect(html.split("<ul>").length, id).toBe(html.split("</ul>").length);
      // `<ol` rather than `<ol>`, so a list carrying a `start` attribute still counts.
      expect(html.split("<ol").length, id).toBe(html.split("</ol>").length);
      expect(html.split("<li>").length, id).toBe(html.split("</li>").length);
      expect(html.split("<p>").length, id).toBe(html.split("</p>").length);
    }
  });
});
