// The doc-to-code drift checker. What is pinned here is the parsing contract against the markdown
// that guidebook/docs-json.ts produces -- headings as "### text", blocks separated by a blank line,
// soft line breaks inside a block as real newlines -- because that renderer is what the script
// actually reads, not a Drive markdown export.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyTokens,
  compareTemplates,
  normalizeDocText,
  parseTemplateDoc,
  renderReport,
  type TemplateMap,
} from "../../scripts/adminbot-email-templates-sync.js";
import { ADMINBOT_ONBOARDING_TEMPLATES } from "../../extensions/adminbot/src/workflows/onboarding/emails.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const SIGNATURE = "Warmly,\nAdmin Team\nJinesis Lab by Prof. Zhijing Jin";

function doc(...blocks: string[]): string {
  return blocks.join("\n\n");
}

const MAP: TemplateMap = {
  documentId: "doc-1",
  templates: { "top1-30min-zhijing": "interview_invite" },
  tokens: { "akim@cs.toronto.edu": "{contact_emails}" },
  docOnly: {},
  codeOnly: {},
};

describe("parseTemplateDoc", () => {
  it("reads a template keyed by its slug line", () => {
    const parsed = parseTemplateDoc(
      doc(
        "### Interview invite",
        "Status: approved · Sender: AdminBot",
        "top1-30min-zhijing",
        "Subject: Interview with the Jinesis Lab",
        "Hi!",
        SIGNATURE,
      ),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe("top1-30min-zhijing");
    expect(parsed[0]?.heading).toBe("Interview invite");
    expect(parsed[0]?.subject).toBe("Interview with the Jinesis Lab");
    expect(parsed[0]?.body).toBe(`Hi!\n\n${SIGNATURE}`);
  });

  // Only three sections carry a slug. The rest have to be keyed by heading, which is why a rename
  // surfaces as an unmapped section rather than as a template quietly stopping being watched.
  it("falls back to the nearest heading when there is no slug", () => {
    const parsed = parseTemplateDoc(
      doc(
        "## F. Alumni",
        "### Alumni",
        "Subject: Staying Connected",
        "Hi!",
        SIGNATURE,
      ),
    );
    expect(parsed[0]?.id).toBe("Alumni");
  });

  it("keeps several templates under one heading apart", () => {
    const parsed = parseTemplateDoc(
      doc(
        "### Interview invite",
        "top1-30min-zhijing",
        "Subject: One",
        "First body.",
        SIGNATURE,
        "top2-only-invite-to-theme-meeting-and-slack",
        "Subject: Two",
        "Second body.",
        SIGNATURE,
      ),
    );
    expect(parsed.map((entry) => entry.id)).toEqual([
      "top1-30min-zhijing",
      "top2-only-invite-to-theme-meeting-and-slack",
    ]);
    expect(parsed[1]?.body).toBe(`Second body.\n\n${SIGNATURE}`);
  });

  // Commentary after the signature is about the template, not part of it. The doc really does this:
  // a note on the editable-calendar behaviour sits under the interview invite.
  it("stops the body at the signature", () => {
    const parsed = parseTemplateDoc(
      doc(
        "### Interview invite",
        "Subject: One",
        "Hi!",
        SIGNATURE,
        "The editable-calendar behavior is intentional.",
      ),
    );
    expect(parsed[0]?.body).toBe(`Hi!\n\n${SIGNATURE}`);
  });

  it("drops the annotation lines that describe a template", () => {
    const parsed = parseTemplateDoc(
      doc(
        "### Interview invite",
        "Subject: One",
        "Hi!",
        "reply-to: akim@cs.toronto.edu",
        "Body continues.",
      ),
    );
    expect(parsed[0]?.body).toBe("Hi!\n\nBody continues.");
  });
});

describe("normalizeDocText", () => {
  // A checker that reports an apostrophe every run is a checker people stop reading.
  it("folds what a word processor produces into what a source file contains", () => {
    expect(normalizeDocText("Zhijing’s “lab” — here")).toBe(
      `Zhijing's "lab" -- here`,
    );
  });

  it("strips the trailing spaces a soft break leaves behind", () => {
    expect(normalizeDocText("Warmly,  \nAdmin Team")).toBe(
      "Warmly,\nAdmin Team",
    );
  });
});

describe("applyTokens", () => {
  it("puts the placeholder back where the doc spells the value out", () => {
    expect(applyTokens("email akim@cs.toronto.edu now", MAP.tokens)).toBe(
      "email {contact_emails} now",
    );
  });

  // A short literal that is a prefix of a longer one must not eat it.
  it("replaces the longest literal first", () => {
    expect(
      applyTokens("[PAPER_SHORT_TITLE_2]", {
        "[PAPER_SHORT_TITLE]": "{paper_title}",
        "[PAPER_SHORT_TITLE_2]": "{second_paper_title}",
      }),
    ).toBe("{second_paper_title}");
  });
});

describe("compareTemplates", () => {
  const code = [
    {
      id: "interview_invite",
      subject: "Interview with the Jinesis Lab",
      body: "Hi!",
    },
  ];

  it("says nothing when they agree", () => {
    const drift = compareTemplates({
      docTemplates: [
        {
          id: "top1-30min-zhijing",
          heading: "Interview invite",
          subject: "Interview with the Jinesis Lab",
          body: "Hi!",
        },
      ],
      codeTemplates: code,
      map: MAP,
    });
    expect(drift).toEqual([]);
    expect(renderReport(drift)).toContain("agree");
  });

  it("reports a changed body", () => {
    const drift = compareTemplates({
      docTemplates: [
        {
          id: "top1-30min-zhijing",
          heading: "Interview invite",
          subject: "Interview with the Jinesis Lab",
          body: "Hi there!",
        },
      ],
      codeTemplates: code,
      map: MAP,
    });
    expect(drift).toEqual([
      {
        kind: "body",
        id: "top1-30min-zhijing",
        templateId: "interview_invite",
        doc: "Hi there!",
        code: "Hi!",
      },
    ]);
  });

  // The failure emails.ts opens by warning about: a literal placeholder reaching a recipient.
  it("flags a bracket the token map did not resolve", () => {
    const drift = compareTemplates({
      docTemplates: [
        {
          id: "top1-30min-zhijing",
          heading: "Interview invite",
          subject: "Interview with the Jinesis Lab",
          body: "Hi! See ([LINK]).",
        },
      ],
      codeTemplates: code,
      map: MAP,
    });
    expect(drift.some((item) => item.kind === "unfilled-token")).toBe(true);
    expect(renderReport(drift)).toContain("[LINK]");
  });

  // A renamed heading must not silently stop a template being watched.
  it("treats an unmapped section as drift", () => {
    const drift = compareTemplates({
      docTemplates: [
        {
          id: "Brand new section",
          heading: "Brand new section",
          subject: "S",
          body: "B",
        },
      ],
      codeTemplates: code,
      map: MAP,
    });
    // Also reports interview_invite as missing, which is correct: this fixture's doc has no
    // section for it. The finding under test is the unmapped one.
    expect(drift).toContainEqual({
      kind: "unmapped-doc",
      id: "Brand new section",
      heading: "Brand new section",
    });
  });

  it("stays quiet about a section the map documents as doc-only", () => {
    const drift = compareTemplates({
      docTemplates: [
        {
          id: "G. Acquaintance",
          heading: "G. Acquaintance",
          subject: "S",
          body: "B",
        },
      ],
      codeTemplates: code,
      map: {
        templates: {},
        tokens: {},
        codeOnly: { interview_invite: "not under test" },
        documentId: "doc-1",
        docOnly: { "G. Acquaintance": "needs no email" },
      },
    });
    expect(drift).toEqual([]);
  });

  it("reports a mapped template the doc no longer contains", () => {
    const drift = compareTemplates({
      docTemplates: [],
      codeTemplates: code,
      map: MAP,
    });
    expect(drift).toEqual([
      { kind: "missing-doc", templateId: "interview_invite" },
    ]);
  });
});

// The map is only useful while it names things that exist. A template id that has been renamed in
// emails.ts would otherwise sit in the map pointing at nothing, and the checker would report the
// section as missing forever.
describe("config/email-template-map.json", () => {
  const map = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, "config/email-template-map.json"),
      "utf8",
    ),
  ) as TemplateMap;
  const ids = new Set(
    ADMINBOT_ONBOARDING_TEMPLATES.map((template) => template.id),
  );

  it("names only templates that exist", () => {
    const unknown = Object.values(map.templates).filter((id) => !ids.has(id));
    expect(unknown).toEqual([]);
  });

  it("accounts for every shipped template, as mapped or as a documented exception", () => {
    const mapped = new Set(Object.values(map.templates));
    const unaccounted = [...ids].filter(
      (id) => !mapped.has(id) && !(id in map.codeOnly),
    );
    expect(unaccounted).toEqual([]);
  });

  it("maps each doc section to a different template", () => {
    const values = Object.values(map.templates);
    expect(values.length).toBe(new Set(values).size);
  });
});
