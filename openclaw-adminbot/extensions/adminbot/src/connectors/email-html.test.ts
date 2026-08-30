import { describe, expect, it } from "vitest";
import { findOnboardingTemplate } from "../workflows/onboarding/emails.js";
import { composeOnboardingGuide } from "../workflows/onboarding/guide.js";
import { renderEmailBodyHtml, renderEmailBodyText } from "./email-html.js";

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

describe("anchor-text links", () => {
  it("renders [label](url) as an anchor and keeps the label as the text", () => {
    const html = renderEmailBodyHtml(
      "Follow [Zhijing-Jin](https://www.linkedin.com/in/zhijing-jin/) today.",
    );
    expect(html).toContain('<a href="https://www.linkedin.com/in/zhijing-jin/">Zhijing-Jin</a>');
    // The source notation must never survive into the delivered markup.
    expect(html).not.toContain("](");
  });

  it("accepts a mailto: target", () => {
    const html = renderEmailBodyHtml("Write to [our list](mailto:list@example.com).");
    expect(html).toContain('<a href="mailto:list@example.com">our list</a>');
  });

  it("links a bare email address as a mailto, showing the address", () => {
    const html = renderEmailBodyHtml(
      'Email "subscribe" to jinesis+subscribe@googlegroups.com now.',
    );
    expect(html).toContain(
      '<a href="mailto:jinesis+subscribe@googlegroups.com">jinesis+subscribe@googlegroups.com</a>',
    );
  });

  it("does not start an address inside a URL that contains an @", () => {
    const html = renderEmailBodyHtml("See https://example.com/u/ada@example.com/profile here.");
    expect(html).toContain('<a href="https://example.com/u/ada@example.com/profile">');
    expect(html).not.toContain("mailto:");
  });

  it("still linkifies a bare URL, and still trims trailing punctuation", () => {
    const html = renderEmailBodyHtml("Read https://example.com/x.");
    expect(html).toContain('<a href="https://example.com/x">https://example.com/x</a>');
    expect(html).toContain("</a>.");
  });

  it("escapes both halves so neither can close the attribute it sits in", () => {
    const html = renderEmailBodyHtml('[a"b](https://example.com/?q=1&r=2)');
    expect(html).toContain('href="https://example.com/?q=1&amp;r=2"');
    expect(html).toContain("&quot;");
    expect(html).not.toContain('"b"');
  });

  it("leaves a bracket that is not a link alone", () => {
    expect(renderEmailBodyHtml("Fill in [NAME] before sending.")).toContain("[NAME]");
  });
});

describe("renderEmailBodyText", () => {
  it("shows the label and its destination instead of the source notation", () => {
    expect(renderEmailBodyText("Follow [Zhijing-Jin](https://x.com/ZhijingJin) today.")).toBe(
      "Follow Zhijing-Jin (https://x.com/ZhijingJin) today.",
    );
  });

  it("drops the mailto: prefix, because an address is what a person would type", () => {
    expect(renderEmailBodyText("Write to [our list](mailto:list@example.com).")).toBe(
      "Write to our list (list@example.com).",
    );
  });

  it("does not say the same thing twice when the label is already the destination", () => {
    expect(renderEmailBodyText("[list@example.com](mailto:list@example.com)")).toBe(
      "list@example.com",
    );
  });

  it("leaves copy with no links untouched", () => {
    const body = "Hi Ada,\n\nRead https://example.com/x and reply.";
    expect(renderEmailBodyText(body)).toBe(body);
  });
});
