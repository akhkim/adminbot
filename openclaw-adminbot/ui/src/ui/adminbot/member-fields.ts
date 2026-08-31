// The lab's member record as one table of fields: what a person is asked, what shape each answer
// takes, and which of them only the lab may fill in.
//
// One registry, two surfaces. The member's own Profile page and the admin Lab Members editor both
// render from this list, which is the whole reason it is a module rather than a const inside
// profile.ts. They had drifted: the roster editor offered twenty fields to the profile page's
// twenty-seven, so preferred name, correspondence email, current city, graduated month, the CV and
// intake links, LinkedIn, OpenReview, Twitter, Scholar and the other socials could be filled in by
// the person and not by an admin looking at the same record -- and four of the roster editor's
// inputs were still writing "Label: value" lines into `notes` for facts that had owned real
// columns since migrateMemberNotesToFields.
//
// Adding a field here adds it to both surfaces and to nothing else: `key` is the wire name the
// service already validates against (SELF_PROFILE_EDITABLE_FIELDS in kernel/service.ts), so this
// file describes the form, never the permission.
import {
  adminBotAdminOwnedProfileFields,
  adminBotMandatoryProfileFields,
  adminBotMemberRoles,
} from "../../../../extensions/adminbot/src/contracts/actions.js";
import type { icons } from "../icons.ts";

// The answer type a field takes, which decides both which control renders it (select vs
// textarea vs a typed input) and how it is parsed on save. "list" and "image" are not among the
// six answer types asked for -- there is no clean way to fit a multi-value tag field or a file
// picker into {dropdown, date, link, short text, paragraph, numeric} -- so they stay as
// deliberate, documented extensions of the same scheme rather than being forced into one.
export type ProfileFieldType =
  | "short_text"
  | "paragraph"
  | "dropdown"
  | "date"
  | "link"
  | "numeric"
  | "list"
  // A country code picked from a list, plus the local number typed alongside it. Stored as the
  // one joined string the roster column already holds.
  | "phone"
  | "image";

// Purely presentational clustering -- same fields, same keys, same validation -- so someone
// scanning 18 inputs meets four short, labeled groups instead of one wall of text boxes.
export type ProfileFieldGroup = "identity" | "work" | "research" | "links";

export const PROFILE_FIELD_GROUPS: Array<{
  id: ProfileFieldGroup;
  labelKey: string;
  icon: keyof typeof icons;
}> = [
  // Order is the reading order of the page: who the person is, what they work on, where to find
  // them, and last the scheduling detail -- the part a member revisits least often, and the group
  // that ends with the one field somebody may want to think before answering.
  { id: "identity", labelKey: "profile.groups.identity", icon: "user" },
  { id: "research", labelKey: "profile.groups.research", icon: "brain" },
  { id: "links", labelKey: "profile.groups.links", icon: "link" },
  { id: "work", labelKey: "profile.groups.work", icon: "clock" },
];

export type ProfileField = {
  // Name: the field's identity -- the member-record key it reads/writes, and (via labelKey)
  // what it is called on screen.
  key: string;
  labelKey: string;
  // Text: an example answer, shown as the input's placeholder so the expected shape is visible
  // before anyone types.
  example: string;
  type: ProfileFieldType;
  // Dropdown-only: the closed set of values the control (and the server) accept.
  options?: readonly string[];
  // An answer only the lab can give. The control renders disabled and says who fills it, and the
  // service leaves the key off the self-edit whitelist -- this flag is the label, never the
  // enforcement.
  adminOnly?: true;
  // A persistent line under the control, for the fields whose accepted shape is not guessable from
  // the label. The service enforces these shapes exactly (SOCIAL_URL_FIELDS and
  // validateOpenReviewId in kernel/service.ts); without the hint a member only ever meets the rule
  // as a rejected save. Kept off the fields whose format is obvious -- a hint on every row is a
  // page nobody reads.
  hintKey?: string;
  // Numeric-only bounds, mirroring what the service accepts, so an out-of-range answer is refused by
  // the control instead of coming back as a rejected save the member has to interpret.
  min?: number;
  max?: number;
  group: ProfileFieldGroup;
};

// Which fields are required is not declared here. It comes from adminBotMandatoryProfileFields in
// the contracts module, which the service's reminder reads from too -- so the required marks on
// this page, the completion ledger, and what the lab actually chases people about are one list
// rather than three that agree by hand. They did not agree: the reminder used to name five fields
// this page called optional, and this page marked eight the reminder never mentioned.
//
// Everything not on that list is optional, and being optional keeps a field out of the blanks
// count, the fill-in prompt and the "profile complete" badge. Not everyone has a Twitter, and a
// checklist that can never reach zero stops being a checklist -- it just nags.
export const MANDATORY_FIELD_KEYS = new Set<string>(adminBotMandatoryProfileFields);

/** Every field not on the mandatory list, which is what keeps the blanks count honest. */
export function isOptionalMemberField(field: { key: string }): boolean {
  return !MANDATORY_FIELD_KEYS.has(field.key);
}

export function timezoneOptions(): readonly string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    // Older engines (or a locked-down test environment) may not implement this -- fall back to
    // free text rather than rendering an empty, unusable dropdown.
    return [];
  }
}

// Priority order: identity and how to reach the person, then work logistics, then what they
// actually work on, then the external links, roughly from most to least commonly filled in for
// a research-lab roster.
const PROFILE_FIELD_DEFINITIONS: ProfileField[] = [
  {
    key: "name",
    labelKey: "profile.fields.name",
    example: "Zhijing Jin",
    type: "short_text",
    group: "identity",
  },
  {
    // What the person actually goes by, when that is not their roster name. Optional on purpose:
    // for most people it is the same string twice, and a required field whose honest answer is
    // "same as above" is a field that teaches people to ignore required marks.
    key: "preferred_name",
    labelKey: "profile.fields.preferredName",
    example: "Ada",
    type: "short_text",
    group: "identity",
  },
  {
    key: "role",
    labelKey: "profile.fields.role",
    example: adminBotMemberRoles[0] ?? "",
    type: "dropdown",
    options: adminBotMemberRoles,
    group: "identity",
  },
  {
    key: "calendar_email",
    labelKey: "profile.fields.calendarEmail",
    example: "zhijing.jin@gmail.com",
    type: "short_text",
    hintKey: "profile.hints.calendarEmail",
    group: "identity",
  },
  {
    key: "affiliation",
    labelKey: "profile.fields.affiliation",
    example: "University of Toronto",
    type: "short_text",
    group: "work",
  },
  {
    // The sheet's correspondence address, deliberately distinct from `email` (the login identity)
    // and `calendar_email` (the Google account invites go to). It is frequently neither.
    key: "correspondence_email",
    labelKey: "profile.fields.correspondenceEmail",
    example: "zhijing@cs.toronto.edu",
    type: "short_text",
    hintKey: "profile.hints.correspondenceEmail",
    group: "identity",
  },
  {
    key: "whatsapp",
    labelKey: "profile.fields.whatsapp",
    example: "555 0100",
    type: "phone",
    group: "identity",
  },
  {
    key: "location",
    labelKey: "profile.fields.location",
    example: "Toronto, ON",
    type: "short_text",
    group: "identity",
  },
  {
    key: "research_topics",
    labelKey: "profile.fields.researchTopics",
    example: "causal inference, NLP",
    type: "list",
    group: "research",
  },
  {
    key: "projects",
    labelKey: "profile.fields.projects",
    example: "AdminBot",
    type: "list",
    group: "research",
  },
  {
    // Where the member currently is, kept distinct from their resident location above. Purely
    // informational: the timezone suggestion and the member map stay keyed on `location`. What it
    // is actually *for* is not guessable from the label, so it carries a help bubble (FIELD_HELP)
    // saying so -- people were reading it as a duplicate of the resident location above.
    key: "current_city",
    labelKey: "profile.fields.currentCity",
    example: "San Francisco, CA",
    type: "short_text",
    group: "identity",
  },
  {
    key: "timezone",
    labelKey: "profile.fields.timezone",
    example: "America/Toronto",
    type: "dropdown",
    options: timezoneOptions(),
    group: "identity",
  },
  {
    // Weekly work capacity: the denominator everything about this member's time is read against.
    // The Time Availability chart draws it as the 100% reference line, and without it that chart
    // falls back to a nominal 40h and says so in a callout -- which is the state most of the roster
    // was left in when this field went missing from the form. Optional, because an honest blank is
    // better than a guessed number that then gets planned against.
    key: "hours_per_week",
    labelKey: "profile.fields.hoursPerWeek",
    example: "40",
    type: "numeric",
    hintKey: "profile.hints.hoursPerWeek",
    // The service's own range (validateMember in extensions/adminbot/src/kernel/service.ts).
    min: 0,
    max: 168,
    group: "work",
  },
  {
    key: "joined_month",
    labelKey: "profile.fields.joinedMonth",
    example: "2026-03",
    type: "short_text",
    hintKey: "profile.hints.month",
    group: "work",
  },
  {
    // Empty for every row on the sheet today; it is the column alumni will eventually be aged out
    // by, which is why it is off the mandatory list -- and why it asks for a *plan* rather than a
    // fact. Nobody can state the month they left before they leave, so the question people can
    // actually answer is when they expect to move on.
    key: "graduated_month",
    labelKey: "profile.fields.graduatedMonth",
    example: "2027-06",
    type: "short_text",
    hintKey: "profile.hints.offboardingMonth",
    group: "work",
  },
  {
    // The only confidential field on the page: the service strips it from every /lab/members
    // reader but this member and admins (adminBotConfidentialMemberFields). Last row of the last
    // group, so it comes after every other answer -- it is the one field a person may want to
    // think before answering, and optional because "nothing to declare" must never be something
    // the form makes someone say out loud on their way to filling in a phone number.
    key: "personal_circumstances",
    labelKey: "profile.fields.personalCircumstances",
    example: "",
    type: "paragraph",
    group: "work",
  },
  {
    key: "avatar_url",
    labelKey: "profile.fields.avatarUrl",
    example: "",
    type: "image",
    group: "identity",
  },
  {
    // The member's own intake answers. Google Forms mails each respondent a link to their single
    // submitted response, so nobody else -- the lab included -- can produce this URL for them;
    // that is why it is a field they paste into rather than a link the profile renders.
    key: "intake_form_url",
    labelKey: "profile.fields.intakeFormUrl",
    example: "https://docs.google.com/forms/d/e/.../viewform?edit2=...",
    type: "link",
    hintKey: "profile.hints.intakeFormUrl",
    group: "links",
  },
  {
    key: "cv_url",
    labelKey: "profile.fields.cvUrl",
    example: "https://zhijing-jin.com/files/CV.pdf",
    type: "link",
    group: "links",
  },
  {
    key: "github_url",
    labelKey: "profile.fields.github",
    example: "https://github.com/zhijing-jin",
    type: "link",
    hintKey: "profile.hints.github",
    group: "links",
  },
  {
    key: "linkedin_url",
    labelKey: "profile.fields.linkedin",
    example: "https://www.linkedin.com/in/zhijing-jin",
    type: "link",
    hintKey: "profile.hints.linkedin",
    group: "links",
  },
  {
    // LinkedIn publishes no mapping from a vanity URL to a URN, so this value cannot be derived
    // from anything else on the page. The lab looks it up and fills it in; a member reading a
    // string of digits off a collector site was a step nobody could be expected to get right.
    key: "linkedin_urn",
    labelKey: "profile.fields.linkedinUrn",
    example: "ACoAAB1234567",
    type: "short_text",
    // Read-only for the member: they see whether it is on file and, if not, follow the collector
    // link that produces it. Typing a 13-digit id off another site was the step that never worked.
    // The flag itself is stamped on below from adminBotAdminOwnedProfileFields, so this page and
    // the service's reminder cannot disagree about who owes the answer.
    group: "links",
  },
  {
    key: "openreview_id",
    labelKey: "profile.fields.openreviewId",
    example: "~Zhijing_Jin1",
    type: "short_text",
    hintKey: "profile.hints.openreviewId",
    group: "links",
  },
  {
    key: "twitter_url",
    labelKey: "profile.fields.twitter",
    example: "https://x.com/ZhijingJin",
    type: "link",
    hintKey: "profile.hints.twitter",
    group: "links",
  },
  {
    key: "personal_website",
    labelKey: "profile.fields.personalWebsite",
    example: "https://zhijing-jin.com",
    type: "link",
    group: "links",
  },
  {
    key: "scholar_url",
    labelKey: "profile.fields.scholar",
    example: "https://scholar.google.com/citations?user=Mdr6wjUAAAAJ",
    type: "link",
    hintKey: "profile.hints.scholar",
    group: "links",
  },
  {
    // Replaces the old single-purpose LessWrong link. One named field per platform only ever fit
    // the platforms someone thought of, so the answer is a paragraph: anywhere else the member
    // posts, in whatever form they keep it. Free text rather than a URL control on purpose -- it
    // holds several links and the labels that say what they are.
    key: "other_socials",
    labelKey: "profile.fields.otherSocials",
    example: "Bluesky: https://bsky.app/profile/zhijing-jin",
    type: "paragraph",
    group: "links",
  },
];

// Who owes each answer is declared once, in the contracts module, and stamped on here -- the same
// list the service's reminder reads. Kept as a flag on the row rather than a lookup at each call
// site because every consumer of this table already has the row in hand.
export const PROFILE_FIELDS: ProfileField[] = PROFILE_FIELD_DEFINITIONS.map((field) =>
  (adminBotAdminOwnedProfileFields as readonly string[]).includes(field.key)
    ? { ...field, adminOnly: true as const }
    : field,
);
