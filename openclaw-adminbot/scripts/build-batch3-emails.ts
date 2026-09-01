// One-off generator for the batch-3 test-onboarding email drafts.
//
// Renders through composeOnboardingGuide rather than copying strings, so a draft can never describe
// copy the service no longer ships: change emails.ts, re-run this, and the two agree by
// construction. That is the whole reason it exists as a script rather than as a hand-built file.
//
// Tokens the send path mints itself -- the Drive folder and the Slack Connect invite -- are left in
// the draft unresolved, exactly as the 2026-08-29 file left {slack_connect_link}. They do not exist
// until a send provisions them, and writing a guess into a draft somebody may paste is worse than
// leaving the placeholder visible.
import { writeFileSync } from "node:fs";

import {
  ADMINBOT_ONBOARDING_TEMPLATES,
  type AdminBotOnboardingTemplate,
} from "../extensions/adminbot/src/workflows/onboarding/emails.js";
import { composeOnboardingGuide } from "../extensions/adminbot/src/workflows/onboarding/guide.js";

const ENV = {
  ADMINBOT_DASHBOARD_URL: "https://jinesis-admin.vercel.app/",
  ADMINBOT_SEEDED_PORTAL_PASSWORD: "jinesis",
  ADMINBOT_SLACK_INVITE_URL:
    "https://join.slack.com/t/jinesis/shared_invite/zt-3d5p5t0nl-dsxvIZW3DJuC0b5lMkk3Vg",
  ADMINBOT_CONTACT_EMAILS: "akim@cs.toronto.edu",
  ADMINBOT_BOT_EMAIL: "adminbot@jinesis.org",
} as NodeJS.ProcessEnv;

// AdminBot sends from a mailbox no person reads, so every draft points replies at a human.
const REPLY_TO = "akim@cs.toronto.edu";

/** Tokens the send path provisions. Left as placeholders; never something an operator types. */
const GENERATED = new Set(["drive_folder_link", "slack_connect_link"]);

/** Stand-in wrapper that survives composition, so the placeholder can be put back afterwards. */
const HOLD_OPEN = "⸤";
const HOLD_CLOSE = "⸥";

type Person = {
  sheet_row: number;
  name: string;
  first_name: string;
  email: string;
  other_addresses?: string[];
  template_id: string;
  member_type: string;
  cc?: string[];
  values?: Record<string, string>;
  needs?: string[];
};

// Roster and addressing carried over from interview-emails.json (2026-08-29). That file is newer
// than the roster snapshot and was curated by hand -- primary address plus the alternates each
// person actually reads -- so it, not the database, is the source for who is in this batch.
const PEOPLE: Person[] = [
  {
    sheet_row: 3,
    name: "Yuen Chen",
    first_name: "Yuen",
    email: "yuenc2@illinois.edu",
    other_addresses: ["yuenc2@cs.toronto.edu"],
    template_id: "alumni",
    member_type: "alumni",
  },
  {
    sheet_row: 11,
    name: "Isabel Dahlgren",
    first_name: "Isabel",
    email: "isabel.dahlgren@gmail.com",
    other_addresses: ["isabeld@cs.toronto.edu"],
    template_id: "alumni",
    member_type: "alumni",
  },
  {
    sheet_row: 85,
    name: "David Jenny",
    first_name: "David",
    email: "davjenny@cs.toronto.edu",
    other_addresses: ["davjenny@student.ethz.ch"],
    template_id: "alumni",
    member_type: "alumni, coauthor-discussant-or-designer",
    needs: [
      "also coauthor-discussant-or-designer, which sends no mail of its own; this draft is the alumni one",
    ],
  },
  {
    sheet_row: 68,
    name: "Yann Billeter",
    first_name: "Yann",
    email: "ybilleter@ethz.ch",
    other_addresses: ["ybilleter@cs.toronto.edu"],
    template_id: "coauthor_major",
    member_type: "coauthor-major",
    values: { member_email: "ybilleter@cs.toronto.edu" },
  },
  {
    sheet_row: 69,
    name: "Kem Nguyen-Le",
    first_name: "Kem",
    email: "nlpa@umd.edu",
    template_id: "coauthor_major",
    member_type: "coauthor-major",
    values: { member_email: "nlpa@umd.edu" },
  },
  {
    sheet_row: 100,
    name: "Korinna Fragkia",
    first_name: "Korinna",
    email: "korinna@cmu.edu",
    template_id: "coauthor_minor",
    member_type: "coauthor-minor",
    values: { project_or_context: "alg-circuit" },
  },
  {
    sheet_row: 133,
    name: "Yannick",
    first_name: "Yannick",
    email: "yanickz@student.ethz.ch",
    template_id: "coauthor_minor",
    member_type: "coauthor-minor",
    cc: ["rahulbs@cs.toronto.edu"],
    values: { project_or_context: "causal-tutor" },
  },
  {
    sheet_row: 144,
    name: "Shuhui Zhu",
    first_name: "Shuhui",
    email: "shuhui.zhu@uwaterloo.ca",
    template_id: "coauthor_minor",
    member_type: "coauthor-minor",
    values: {
      project_or_context: "#proj-mechanism-design",
      record_role: "invite to Wed meeting",
    },
  },
];

function templateFor(id: string): AdminBotOnboardingTemplate {
  const template = ADMINBOT_ONBOARDING_TEMPLATES.find(
    (entry) => entry.id === id,
  );
  if (!template) {
    throw new Error(`unknown template ${id}`);
  }
  return template;
}

const drafts = PEOPLE.map((person) => {
  const template = templateFor(person.template_id);
  const values: Record<string, string> = {
    first_name: person.first_name,
    portal_password: "jinesis",
    ...person.values,
  };
  // Two kinds of token still have no value: ones the send mints, and ones a human still owes us.
  // Both are held open through composition and restored below, so the draft shows the placeholder
  // rather than a blank -- and `needs` says which kind each one is.
  const minted = template.required.filter((token) => GENERATED.has(token));
  const owed = template.required.filter(
    (token) => !GENERATED.has(token) && !values[token]?.trim(),
  );
  for (const token of [...minted, ...owed]) {
    values[token] = `${HOLD_OPEN}${token}${HOLD_CLOSE}`;
  }
  const result = composeOnboardingGuide(person.template_id, values, ENV);
  if (!result.ok) {
    throw new Error(
      `${person.name}: ${result.reason ?? `missing ${result.missing.join(", ")}`}`,
    );
  }
  const restore = (text: string): string =>
    text.split(HOLD_OPEN).join("{").split(HOLD_CLOSE).join("}");
  return {
    sheet_row: person.sheet_row,
    name: person.name,
    email: person.email,
    other_addresses: person.other_addresses ?? [],
    template_id: person.template_id,
    member_type: person.member_type,
    cc: person.cc ?? [],
    values: { portal_password: "jinesis", ...person.values },
    needs: [
      ...(person.needs ?? []),
      ...owed.map((token) => `{${token}}: supply before sending`),
      ...minted.map(
        (token) => `{${token}}: minted by the send, not typed here`,
      ),
    ],
    subject: restore(result.guide.subject ?? ""),
    body: restore(result.guide.body),
    reply_to: REPLY_TO,
  };
});

const out = {
  generated_at: new Date().toISOString(),
  source:
    "20260807 _ AdminBot Email Templates.pdf, rendered through extensions/adminbot/src/workflows/onboarding/emails.ts",
  roster_source: "interview-emails.json (2026-08-29), test_onboard_3",
  test_onboard_3: drafts,
};

const target = process.argv[2] ?? "batch3-emails.json";
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${drafts.length} drafts to ${target}`);
