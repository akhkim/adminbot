// The signed-in member's own record: what the lab knows about them, what it does not yet, and
// what they might do about it.
//
// Three jobs, in the order a person meets them:
//   1. Basic info and badges  -- what is on file.
//   2. Fill in the blanks     -- a form containing only the fields still empty, so completing a
//                                profile is a short task rather than a hunt through a full editor.
//   3. Suggestions            -- guidebook pointers derived from what is missing, so the advice is
//                                about this person rather than a generic welcome.
//
// Saving goes through the same self-edit path the Lab Members table uses, whose server-side
// whitelist drops governance fields. Nothing here can write privilege_level, status, or email.
import { html, nothing } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import {
  adminBotMandatoryProfileFields,
  adminBotMemberRoles,
  adminBotSlackActivityOf,
  adminBotSlackActivityThreshold,
  adminBotSlackActivityWindowDays,
} from "../../../../../extensions/adminbot/src/contracts/actions.js";
import { t } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../external-link.ts";
import { icons } from "../../icons.ts";
import type { LabMember, MemberProfileUpdate } from "../auth/session.ts";
import {
  joinPhoneNumber,
  resolvePhoneDial,
  splitPhoneNumber,
} from "../data/phone-country-codes.ts";
import { timezoneForLocation } from "../data/timezone-for-location.ts";
import { renderCountrySelect } from "./country-select.ts";
import { checkAccount, isCheckableField } from "./profile-account-check.ts";

export type ProfileProps = {
  onSave: (memberId: string, fields: MemberProfileUpdate) => void;
  onPolishPhoto: () => void;
  onApplyPolishedPhoto: (variantId: string) => void;
};

// The answer type a field takes, which decides both which control renders it (select vs
// textarea vs a typed input) and how it is parsed on save. "list" and "image" are not among the
// six answer types asked for -- there is no clean way to fit a multi-value tag field or a file
// picker into {dropdown, date, link, short text, paragraph, numeric} -- so they stay as
// deliberate, documented extensions of the same scheme rather than being forced into one.
type ProfileFieldType =
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
type ProfileFieldGroup = "identity" | "work" | "research" | "links";

const PROFILE_FIELD_GROUPS: Array<{
  id: ProfileFieldGroup;
  labelKey: string;
  icon: keyof typeof icons;
}> = [
  // Order is the reading order of the page: who the account is, who the person is, what they work
  // on, where to find them, and last the scheduling detail -- which is the part a member revisits
  // least often and the only group whose answers go stale on their own.
  { id: "identity", labelKey: "profile.groups.identity", icon: "user" },
  { id: "research", labelKey: "profile.groups.research", icon: "brain" },
  { id: "links", labelKey: "profile.groups.links", icon: "link" },
  { id: "work", labelKey: "profile.groups.work", icon: "clock" },
];

type ProfileField = {
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
const MANDATORY_FIELD_KEYS = new Set<string>(adminBotMandatoryProfileFields);

function isOptional(field: EditableField): boolean {
  return !MANDATORY_FIELD_KEYS.has(field.key);
}

function timezoneOptions(): readonly string[] {
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
const PROFILE_FIELDS: ProfileField[] = [
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
    key: "hours_per_week",
    labelKey: "profile.fields.hoursPerWeek",
    example: "20",
    type: "numeric",
    group: "work",
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
    // informational: the timezone suggestion and the member map stay keyed on `location`.
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
    key: "joined_month",
    labelKey: "profile.fields.joinedMonth",
    example: "2026-03",
    type: "short_text",
    hintKey: "profile.hints.month",
    group: "work",
  },
  {
    // Empty for every row on the sheet today; it is the column alumni will eventually be aged out
    // by, which is why it is off the mandatory list -- a current member has no answer for it.
    key: "graduated_month",
    labelKey: "profile.fields.graduatedMonth",
    example: "2027-06",
    type: "short_text",
    hintKey: "profile.hints.month",
    group: "work",
  },
  {
    // The only paragraph field on the page, and the only confidential one: the service strips it
    // from every /lab/members reader but this member and admins (adminBotConfidentialMemberFields).
    // It sits last in its group because it is the one field a person may want to think before
    // answering, and optional because "nothing to declare" must never be something the form makes
    // someone say out loud.
    key: "personal_circumstances",
    labelKey: "profile.fields.personalCircumstances",
    example: "",
    type: "paragraph",
    group: "identity",
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
    adminOnly: true,
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
    key: "lesswrong_url",
    labelKey: "profile.fields.lesswrong",
    example: "https://www.lesswrong.com/users/zhijing-jin",
    type: "link",
    group: "links",
  },
];

const EDITABLE_FIELDS = PROFILE_FIELDS;

// Rendered as a row of links under the name rather than as rows in the field table -- they are
// somewhere to go, not facts to read.
const SOCIAL_FIELDS = [
  { key: "linkedin_url", labelKey: "profile.social.linkedin" },
  { key: "twitter_url", labelKey: "profile.social.twitter" },
  { key: "github_url", labelKey: "profile.social.github" },
  { key: "scholar_url", labelKey: "profile.social.scholar" },
] as const;

type EditableField = ProfileField;

// Buckets a field list under PROFILE_FIELD_GROUPS' fixed order, dropping any group that has no
// fields to show (relevant to the blanks form, where most groups are usually already complete).
function groupFields(fields: EditableField[]): Array<{
  id: ProfileFieldGroup;
  labelKey: string;
  icon: keyof typeof icons;
  fields: EditableField[];
}> {
  return PROFILE_FIELD_GROUPS.map((group) => ({
    ...group,
    fields: fields.filter((field) => field.group === group.id),
  })).filter((group) => group.fields.length > 0);
}

// Autosave: a section commits itself a beat after the member stops typing anywhere in its form,
// or immediately on leaving it (focus moving outside the form). One shared timer per section --
// not per field -- so a pause commits every field together in one request instead of racing one
// PUT per keystroke-field.
const AUTOSAVE_DEBOUNCE_MS = 900;
let basicsSaveTimer: ReturnType<typeof setTimeout> | undefined;

// PROFILE_FIELDS carries its keys as plain `string` (it is data, not a `const`-narrowed
// tuple -- the whole point of the schema is that it's one editable table, not a union type
// enumerated at compile time), so writing through them needs an explicit escape from
// MemberProfileUpdate's closed key set. The server is the actual gate on which keys are
// accepted; this only exists to satisfy the compiler about a key that's already known-dynamic.
function setField(fields: MemberProfileUpdate, key: string, value: unknown): void {
  (fields as Record<string, unknown>)[key] = value;
}

function scheduleAutosave(
  timer: ReturnType<typeof setTimeout> | undefined,
  set: (next: ReturnType<typeof setTimeout> | undefined) => void,
  commit: () => void,
): void {
  if (timer) {
    clearTimeout(timer);
  }
  set(
    setTimeout(() => {
      set(undefined);
      commit();
    }, AUTOSAVE_DEBOUNCE_MS),
  );
}

// Commits an edit that is still inside its debounce window, because focus leaving the form means
// the member is done with it. With no timer pending there is nothing to flush: leaving a form
// nobody typed in used to fire a full-record PUT, a "saved" toast for a save that changed nothing,
// and an outbound account check per checkable field -- so merely tabbing through the page burned
// GitHub's 60-request unauthenticated hourly budget, which a whole lab shares behind one campus IP.
function flushAutosave(
  timer: ReturnType<typeof setTimeout> | undefined,
  set: (next: ReturnType<typeof setTimeout> | undefined) => void,
  commit: () => void,
): void {
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  set(undefined);
  commit();
}

// True once focus has actually left the form -- not merely moved between two fields inside it.
function focusLeftForm(form: HTMLFormElement, event: FocusEvent): boolean {
  const next = event.relatedTarget as Node | null;
  return !next || !form.contains(next);
}

// Fires alongside every autosave commit for the fields that have a real "does this account
// exist" check (see profile-account-check.ts). A superseded check aborts its own in-flight
// fetch, so typing a second GitHub handle before the first lookup returns can never let the
// first response land after the second and show a stale result.
// One controller per field, not one per run: a shared controller made an edit to either field
// cancel the other's in-flight lookup, so the two checks superseded each other rather than only
// themselves.
const accountCheckAborts = new Map<string, AbortController>();

// The last value each field was actually looked up with. A commit sends the whole record, so
// without this every save re-checked both accounts whether or not they had changed -- and GitHub
// allows 60 unauthenticated requests an hour per IP, which a lab shares behind one campus address.
const accountCheckedValues = new Map<string, string>();

function runAccountChecks(form: HTMLFormElement, state: AppViewState): void {
  const data = new FormData(form);
  for (const field of ["github_url", "openreview_id"] as const) {
    if (!data.has(field)) {
      continue;
    }
    const value = String(data.get(field) ?? "").trim();
    if (!value) {
      accountCheckAborts.get(field)?.abort();
      accountCheckAborts.delete(field);
      accountCheckedValues.delete(field);
      if (state.profileAccountChecks[field]) {
        const next = { ...state.profileAccountChecks };
        delete next[field];
        state.profileAccountChecks = next;
      }
      continue;
    }
    // Already answered for this exact value, and not still in flight.
    if (
      accountCheckedValues.get(field) === value &&
      state.profileAccountChecks[field]?.status !== "checking"
    ) {
      continue;
    }
    accountCheckAborts.get(field)?.abort();
    const controller = new AbortController();
    accountCheckAborts.set(field, controller);
    accountCheckedValues.set(field, value);
    state.profileAccountChecks = {
      ...state.profileAccountChecks,
      [field]: { status: "checking" },
    };
    void checkAccount(field, value, controller.signal).then((result) => {
      if (controller.signal.aborted) {
        return;
      }
      state.profileAccountChecks = { ...state.profileAccountChecks, [field]: result };
    });
  }
}

function renderAccountCheckStatus(state: AppViewState, field: EditableField) {
  if (!isCheckableField(field.key)) {
    return nothing;
  }
  const check = state.profileAccountChecks[field.key];
  if (!check || check.status === "unknown") {
    return nothing;
  }
  return html`
    <span
      class="profile__account-check profile__account-check--${check.status}"
      data-testid="profile-account-check-${field.key}"
    >
      ${check.status === "checking"
        ? t("profile.accountCheck.checking")
        : check.status === "verified"
          ? t("profile.accountCheck.verified")
          : check.message}
    </span>
  `;
}

// Read-only context the lab owns rather than the member. Just the directory email now -- status
// and privilege level are governance bookkeeping a member has no action to take on, so showing
// them here was signal only an admin could use, not the member reading their own page.
const GOVERNED_FIELDS = ["email"] as const;

const FIELD_LABEL_KEYS: Record<string, string> = {
  email: "profile.fields.email",
  ...Object.fromEntries(PROFILE_FIELDS.map((field) => [field.key, field.labelKey])),
};

function labelFor(key: string): string {
  return t(FIELD_LABEL_KEYS[key] ?? key);
}

/** The on-screen name of a field, for surfaces outside this page that list fields by key. */
export function fieldLabel(key: string): string {
  return labelFor(key);
}

export function findOwnMember(state: AppViewState): LabMember | null {
  const memberId = state.memberId;
  if (!memberId) {
    return null;
  }
  const member = (state.adminBotData?.members ?? []).find((entry) => entry.id === memberId);
  return (member as unknown as LabMember | undefined) ?? null;
}

function valueOf(member: LabMember, field: EditableField): string {
  const raw = member[field.key];
  if (field.type === "list") {
    return Array.isArray(raw) ? raw.filter(Boolean).join(", ") : "";
  }
  return raw === null || raw === undefined ? "" : String(raw);
}

// What the control shows, which is the stored value except when there is a prefill to offer.
//
// Only timezone has one: it is the single field on this page that is derivable from another field
// the member already filled in, so making them restate it in a 400-entry dropdown was pure
// friction. The suggestion is shown selected but is not stored until an autosave commits the form
// like any other edit -- see renderPrefillHint, which says where the value came from so a wrong
// guess is visible before it is saved.
function displayValue(member: LabMember, field: EditableField): string {
  const stored = valueOf(member, field);
  if (stored || field.key !== "timezone") {
    return stored;
  }
  return prefilledTimezone(member) ?? "";
}

function prefilledTimezone(member: LabMember): string | null {
  if (String(member.timezone ?? "").trim()) {
    return null;
  }
  return timezoneForLocation(String(member.location ?? ""));
}

/**
 * Says a WhatsApp number is missing its country code.
 *
 * Advisory, not a save-blocker. Most of the 87 numbers already on the roster were imported without
 * one, and this form PUTs every field on each autosave — so rejecting the value would make those
 * members unable to save *any* profile edit until they fixed a field they may not have thought
 * about. The nudge is visible, the correction is theirs to make.
 */
/**
 * Fields whose name cannot carry their whole meaning, mapped to an i18n key explaining them.
 *
 * Two of them ask for something a member has no reason to have heard of — a LinkedIn URN is not a
 * thing LinkedIn's own UI ever names, and "application form answers" is a link only the applicant
 * can produce. Both used to be explained in the suggestions stack at the bottom of the page, which
 * meant reading the explanation and filling the field were separated by the whole form, and the
 * explanation disappeared the moment the field was filled — so anyone correcting a wrong value had
 * nothing left to check against.
 */
const FIELD_HELP: Record<string, string> = {
  personal_circumstances: "profile.help.personalCircumstances",
  linkedin_urn: "profile.help.linkedinUrn",
  intake_form_url: "profile.help.intakeFormUrl",
  cv_url: "profile.help.cvUrl",
};

// Hover or focus reveals it; `aria-describedby` is what makes it reachable without a pointer.
// The trigger cancels its own click because this whole row is a <label>, and a click inside a label
// is forwarded to the control it wraps -- without this, reading the help would retarget the caret
// into the input underneath.
function renderFieldHelp(field: EditableField) {
  const helpKey = FIELD_HELP[field.key];
  if (!helpKey) {
    return nothing;
  }
  const id = `profile-help-${field.key}`;
  return html`
    <span class="profile__help">
      <button
        type="button"
        class="profile__help-trigger"
        data-testid=${`profile-help-${field.key}`}
        aria-describedby=${id}
        aria-label=${t("profile.help.trigger", { field: t(field.labelKey) })}
        @click=${(event: Event) => event.preventDefault()}
      >
        i
      </button>
      <span class="profile__help-bubble" id=${id} role="tooltip">${t(helpKey)}</span>
    </span>
  `;
}



// The member cannot type this one in, so the only thing they need from it is whether it is on
// file yet -- and, while it is not, the collector link that produces it (renderFieldAction).
function renderUrnStatus(member: LabMember, field: EditableField) {
  if (field.key !== "linkedin_urn") {
    return nothing;
  }
  const isSet = Boolean(String(member.linkedin_urn ?? "").trim());
  return html`
    <span
      class=${`profile__urn-status ${isSet ? "profile__urn-status--set" : "profile__urn-status--unset"}`}
      data-testid="profile-urn-status"
    >
      ${isSet ? t("profile.urn.set") : t("profile.urn.unset")}
    </span>
  `;
}

function renderWhatsappHint(member: LabMember, field: EditableField) {
  if (field.key !== "whatsapp") {
    return nothing;
  }
  const value = String(member.whatsapp ?? "").trim();
  if (!value || value.startsWith("+")) {
    return nothing;
  }
  return html`
    <span class="profile__prefill" data-testid="profile-whatsapp-hint">
      ${t("profile.whatsapp.needsCountryCode")}
    </span>
  `;
}

// The one field nobody can fill in from what they already know: LinkedIn publishes no mapping from
// a vanity URL to a URN, so the value only exists once the member reads it off the collector. That
// hand-off belongs against the input it feeds, not in a card elsewhere on the page.
const LINKEDIN_URN_COLLECTOR_URL = "https://linkedin-urn-collector.vercel.app";

function renderFieldAction(field: EditableField) {
  if (field.key !== "linkedin_urn") {
    return nothing;
  }
  return html`
    <a
      class="profile__field-action"
      href=${LINKEDIN_URN_COLLECTOR_URL}
      target=${EXTERNAL_LINK_TARGET}
      rel=${buildExternalLinkRel()}
      data-testid="profile-urn-collector"
    >
      ${t("profile.suggestions.urnLink")}
      <span class="profile__field-action-icon" aria-hidden="true">${icons.externalLink}</span>
    </a>
  `;
}

// The shape rule for fields that have one, stated where the answer is typed. The service refuses a
// link whose host or path is wrong, and until now that rule only ever reached the member as a
// rejected save naming a field they had to go find.
function renderFieldHint(field: EditableField) {
  if (!field.hintKey) {
    return nothing;
  }
  return html`<span class="profile__field-hint" data-testid=${`profile-hint-${field.key}`}
    >${t(field.hintKey)}</span
  >`;}

function renderPrefillHint(member: LabMember, field: EditableField) {
  if (field.key !== "timezone") {
    return nothing;
  }
  const suggestion = prefilledTimezone(member);
  if (!suggestion) {
    return nothing;
  }
  return html`
    <span class="profile__prefill" data-testid="profile-timezone-prefill">
      ${t("profile.timezone.prefilled", {
        zone: suggestion,
        location: String(member.location ?? "").trim(),
      })}
    </span>
  `;
}

// What the lab is still waiting on *from this member*. Admin-owned fields are required of the
// record but not answerable here, so they stay out of the blanks list, the dashboard card that
// chases it, and the denominator below -- otherwise the ledger could never reach complete and the
// card would name a field whose control is disabled.
function isMemberAnswerable(field: EditableField): boolean {
  return !isOptional(field) && !field.adminOnly;
}

export function blankFields(member: LabMember): EditableField[] {
  return EDITABLE_FIELDS.filter(
    (field) => isMemberAnswerable(field) && !valueOf(member, field).trim(),
  );
}

// Everything a member may set, blank or not -- what the full editor offers.
export function requiredFieldCount(): number {
  return EDITABLE_FIELDS.filter(isMemberAnswerable).length;
}

// A one-shot hand-off from the dashboard: it names the field a member clicked, and the profile
// page focuses that control on its next render. Kept as module state rather than on AppViewState
// because it is consumed immediately and never re-read -- it must not survive into a later render
// and steal focus from whatever the member is typing in by then.
let pendingFocusFieldKey: string | null = null;

export function focusProfileField(key: string): void {
  pendingFocusFieldKey = key;
}

function consumePendingFieldFocus(): void {
  const key = pendingFocusFieldKey;
  pendingFocusFieldKey = null;
  if (!key || typeof document === "undefined") {
    return;
  }
  // After paint: the control this names is rendered by the same template that is running now.
  requestAnimationFrame(() => {
    const control = document.querySelector<HTMLElement>(
      `.profile__form-row [name="${CSS.escape(key)}"]`,
    );
    control?.scrollIntoView({ block: "center" });
    control?.focus();
  });
}

// Badges are earned, so each one is derived from a fact on the record rather than stored. A badge
// nobody can explain is worse than no badge.
export function badgesFor(state: AppViewState, member: LabMember): string[] {
  const badges: string[] = [];
  const onboarding = state.adminBotOnboarding;
  if (onboarding && !(onboarding.remaining ?? []).length && (onboarding.steps ?? []).length) {
    badges.push(t("profile.badges.onboarded"));
  }
  if (!blankFields(member).length) {
    badges.push(t("profile.badges.profileComplete"));
  }
  const papers = state.adminBotData?.papers ?? [];
  const memberName = (member.name ?? "").trim().toLowerCase();
  const authored = papers.filter(
    (paper) =>
      paper.submitted_by_member_id === member.id ||
      (memberName &&
        (paper.authors ?? []).some((author) => author.trim().toLowerCase() === memberName)),
  );
  if (authored.length) {
    badges.push(`${t("profile.badges.author")} · ${authored.length}`);
  }
  if (papers.some((paper) => paper.mentor_member_id === member.id)) {
    badges.push(t("profile.badges.mentor"));
  }
  // Role is deliberately absent: the header already states it in the pill beside the name, and a
  // badge is meant to be something earned from the record rather than a second copy of a field the
  // member picked from a dropdown.
  return badges;
}

// Collects whatever the basics form holds. Governed fields have no input to read, so they cannot
// be submitted even by hand-editing the DOM -- the same reason the service whitelists them.
function collectBasics(form: HTMLFormElement): MemberProfileUpdate {
  const data = new FormData(form);
  const fields: MemberProfileUpdate = {};
  for (const field of EDITABLE_FIELDS) {
    if (field.type === "image") {
      // Owned by the upload control, which saves on its own; no input to read here.
      continue;
    }
    const value = String(data.get(field.key) ?? "").trim();
    if (field.type === "phone") {
      // The two controls are a country box and a number box; the record keeps one string. The
      // country box is free text with a suggestion list, so what it holds is resolved back to a
      // dial code rather than trusted as one.
      setField(
        fields,
        field.key,
        joinPhoneNumber(
          resolvePhoneDial(String(data.get(`${field.key}${PHONE_CODE_SUFFIX}`) ?? "")),
          value,
        ),
      );
    } else if (field.type === "list") {
      setField(
        fields,
        field.key,
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
      );
    } else if (field.type === "numeric") {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && value) {
        fields.hours_per_week = parsed;
      }
    } else {
      setField(fields, field.key, value);
    }
  }
  return fields;
}

// The lab has no file storage behind this UI, so an upload is read in the browser and stored as a
// data URL on the member record. That keeps the picture with the profile and needs no bucket, at
// the cost of a size ceiling -- hence the limit and the explicit error rather than a silent
// failure at save time.
const MAX_AVATAR_BYTES = 512 * 1024;

async function acceptAvatarFile(
  state: AppViewState,
  member: LabMember,
  props: ProfileProps,
  event: Event,
): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !member.id) {
    return;
  }
  if (file.size > MAX_AVATAR_BYTES) {
    state.adminBotNotice = { kind: "error", text: t("profile.picture.tooLarge") };
    input.value = "";
    return;
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  props.onSave(member.id, { avatar_url: dataUrl });
  input.value = "";
}

// Every example answer is prefixed on the way into a placeholder. A bare "zhijing@cs.toronto.edu"
// sitting in an empty box reads as somebody else's address already saved to the profile; "ex."
// says the box is empty and this is only the shape of the answer.
// Returns undefined rather than "" for a field with no example, so the control renders no
// placeholder attribute at all instead of an empty one that reads as an unlabeled example.
function exampleFor(field: EditableField): string | undefined {
  return field.example ? t("profile.basics.example", { example: field.example }) : undefined;
}

const SHORT_TEXT_MAX_LENGTH = 200;
const PARAGRAPH_MAX_LENGTH = 2000;
// The country picker that accompanies a phone field. Suffixed rather than named after the record
// key, because the record has no column for it -- collectBasics folds it back into the number.
const PHONE_CODE_SUFFIX = "__dial";

// One control per answer type, so the shape a field expects is enforced by what you can
// physically type into it -- a dropdown can't hold a value off its own list, a numeric input
// can't hold letters, a date input can't hold "next Tuesday". The server re-validates all of it
// regardless (a form is a UI convenience, never the trust boundary), but the earlier and more
// specific the feedback, the less a bad save ever gets that far.
function renderFieldInput(field: EditableField, currentValue: string) {
  // An admin-owned answer is shown, never offered for editing. `disabled` also keeps the key out
  // of the form's own collection, so an autosave cannot carry a value the service would drop.
  if (field.adminOnly) {
    return html`
      <input
        class="input"
        name=${field.key}
        type="text"
        .value=${currentValue}
        disabled
        data-testid=${`profile-admin-only-${field.key}`}
      />
    `;
  }
  switch (field.type) {
    case "phone": {
      // Country first, then the local number: the prefix is the part people cannot recall, and a
      // list they pick from also spares the roster the four spellings of "+1 (416)".
      const { dial, local } = splitPhoneNumber(currentValue);
      return html`
        <span class="profile__phone">
          ${renderCountrySelect({ name: `${field.key}${PHONE_CODE_SUFFIX}`, value: dial })}
          <input
            class="input profile__phone-number"
            name=${field.key}
            type="tel"
            maxlength=${SHORT_TEXT_MAX_LENGTH}
            placeholder=${ifDefined(exampleFor(field))}
            .value=${local}
            autocomplete="off"
          />
        </span>
      `;
    }
    case "dropdown":
      return html`
        <select class="input" name=${field.key}>
          <option value="" ?selected=${!currentValue}></option>
          ${(field.options ?? []).map(
            (option) => html`
              <option value=${option} ?selected=${option === currentValue}>${option}</option>
            `,
          )}
        </select>
      `;
    case "paragraph":
      return html`
        <textarea
          class="input"
          name=${field.key}
          rows="3"
          maxlength=${PARAGRAPH_MAX_LENGTH}
          placeholder=${ifDefined(exampleFor(field))}
          .value=${currentValue}
        ></textarea>
      `;
    case "date":
      return html` <input class="input" name=${field.key} type="date" .value=${currentValue} /> `;
    case "link":
      return html`
        <input
          class="input"
          name=${field.key}
          type="url"
          placeholder=${ifDefined(exampleFor(field))}
          .value=${currentValue}
          autocomplete="off"
        />
      `;
    case "numeric":
      return html`
        <input
          class="input"
          name=${field.key}
          type="number"
          placeholder=${ifDefined(exampleFor(field))}
          .value=${currentValue}
        />
      `;
    case "list":
      // Comma-separated, so it needs more room than a single short answer.
      return html`
        <input
          class="input"
          name=${field.key}
          type="text"
          maxlength=${PARAGRAPH_MAX_LENGTH}
          placeholder=${ifDefined(exampleFor(field))}
          .value=${currentValue}
          autocomplete="off"
        />
      `;
    case "short_text":
    default:
      return html`
        <input
          class="input"
          name=${field.key}
          type="text"
          maxlength=${SHORT_TEXT_MAX_LENGTH}
          placeholder=${ifDefined(exampleFor(field))}
          .value=${currentValue}
          autocomplete="off"
        />
      `;
  }
}

// A field left blank never blocks saving or closing the editor -- see the "Done" handler below,
// which flushes and exits regardless of what's filled in. The dashboard warning and the daily
// Slack reminder are what actually follow up on a field that stays blank.
//
// The dot means "this one is required", not "this one is still empty. It therefore stays put once
// the field is answered: a mark that disappears on completion cannot be used to tell, at a glance,
// which fields the lab actually asks for -- and a member correcting an answer would have no way to
// see that the box they are about to clear is one they have to refill. Optional fields say so in
// words instead (see the label below).
function renderMandatoryMark(field: EditableField, _value: string) {
  // An admin-owned field says who fills it instead. Dotting it would chase the member for an
  // answer the form does not let them give.
  if (isOptional(field) || field.adminOnly) {
    return nothing;
  }
  return html`<span class="profile__mandatory" aria-hidden="true"></span
    ><span class="sr-only">${t("profile.basics.mandatory")}</span>`;
}

// The record, always editable. There is no edit button and no read-only mode: this page is one
// person's own row in the roster, they are the only one who writes it, and the extra click only
// ever stood between them and a correction they had already decided to make. Every control commits
// itself a beat after typing stops, so the page holds no draft that can be lost by navigating away.
//
// Two things stay uneditable and say so: the fields the lab governs (email), and the picture,
// which has its own upload control because a file is not a text field.
function renderBasics(state: AppViewState, member: LabMember, props: ProfileProps) {
  const commit = (form: HTMLFormElement) => () => {
    member.id && props.onSave(member.id, collectBasics(form));
    runAccountChecks(form, state);
  };
  return html`
    <section class="profile__section" data-testid="profile-basics">
      <div class="profile__section-head">
        <h2 class="profile__section-title">${t("profile.basics.title")}</h2>
        <span class="profile__autosave-hint">${t("profile.basics.autosaveHint")}</span>
      </div>
      <div class="profile__fields">
        <div class="profile__field-group">
          <h3 class="profile__group-title">
            <span class="profile__group-icon" aria-hidden="true">${icons.lock}</span>
            ${t("profile.groups.account")}
          </h3>
          <div class="profile__field-grid">
            ${GOVERNED_FIELDS.map(
              (key) => html`
                <div class="profile-field profile-field--locked">
                  <dt class="profile-field__label">
                    ${labelFor(key)}
                    <span class="profile-field__lock" aria-hidden="true">${icons.lock}</span>
                  </dt>
                  <dd class="profile-field__value">${String(member[key] ?? "").trim()}</dd>
                </div>
              `,
            )}
          </div>
        </div>
      </div>
      <form
        class="profile__form"
        @submit=${(event: SubmitEvent) => event.preventDefault()}
        @input=${(event: Event) => {
          const form = event.currentTarget as HTMLFormElement;
          scheduleAutosave(
            basicsSaveTimer,
            (next) => {
              basicsSaveTimer = next;
            },
            commit(form),
          );
        }}
        @focusout=${(event: FocusEvent) => {
          const form = event.currentTarget as HTMLFormElement;
          if (!focusLeftForm(form, event)) {
            return;
          }
          // Leaving the form commits immediately rather than waiting out the debounce: the member
          // may be on their way to another tab, and a pending timer would not survive it.
          flushAutosave(
            basicsSaveTimer,
            (next) => {
              basicsSaveTimer = next;
            },
            commit(form),
          );
        }}
      >
        ${groupFields(EDITABLE_FIELDS.filter((field) => field.type !== "image")).map(
          (group) => html`
            <div class="profile__field-group">
              <h3 class="profile__group-title">
                <span class="profile__group-icon" aria-hidden="true">${icons[group.icon]}</span>
                ${t(group.labelKey)}
              </h3>
              <div class="profile__field-grid">
                ${group.fields.map(
                  (field) => html`
                    <label class="profile__form-row">
                      <span class="profile__form-label">
                        ${labelFor(field.key)}${renderMandatoryMark(
                          field,
                          displayValue(member, field),
                        )}${renderFieldHelp(field)}
                        ${field.adminOnly
                          ? html`<span class="profile__optional"
                              >${t("profile.basics.adminFilled")}</span
                            >`
                          : isOptional(field)
                            ? html`<span class="profile__optional"
                                >${t("profile.basics.optional")}</span
                              >`
                            : nothing}
                      </span>
                      ${renderFieldInput(field, displayValue(member, field))}
                      ${renderUrnStatus(member, field)} ${renderFieldAction(field)}
                      ${renderFieldHint(field)}
                      ${renderPrefillHint(member, field)}
                      ${renderWhatsappHint(member, field)} ${renderAccountCheckStatus(state, field)}
                    </label>
                  `,
                )}
              </div>
            </div>
          `,
        )}
        <p class="profile__managed">
          ${t("profile.basics.managed", {
            fields: GOVERNED_FIELDS.map((key) => labelFor(key)).join(", "),
          })}
        </p>
      </form>
    </section>
  `;
}

// One instrument for "what does the lab still need from me".
//
// This page used to state that fact twice -- a percentage ring up here and a progress bar down in
// the blanks card -- computed in two places from the same numbers, so the two could disagree for
// the beat an autosave was in flight, and neither told you anything the other did not. The ring
// won because it sits with the identity, and it now carries the detail the bar never had: one tick
// per required field, in the order the groups appear below, split by group. A run of empty ticks
// says *which* part of the record is thin, not just how thin it is.
//
// The ticks are decoration to a screen reader on purpose. The accessible read is the same
// "{count} of {total}" sentence the bar used to carry, and the fields themselves -- with their
// required marks -- are the real interface for acting on it.
function renderCompletionLedger(member: LabMember) {
  const blanks = new Set(blankFields(member).map((field) => field.key));
  const total = requiredFieldCount();
  const done = total - blanks.size;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  // Same filter as `total` above. Ticking every non-optional field instead drew one tick more than
  // the count claimed, and the extra was the admin-owned URN -- which, never being in `blanks`,
  // always drew as filled whether or not the lab had supplied it.
  const groups = PROFILE_FIELD_GROUPS.map((group) => ({
    id: group.id,
    fields: EDITABLE_FIELDS.filter(
      (field) => isMemberAnswerable(field) && field.group === group.id,
    ),
  })).filter((group) => group.fields.length > 0);
  return html`
    <div
      class=${`profile__completeness ${percent === 100 ? "profile__completeness--done" : ""}`}
      role="img"
      aria-label=${t("profile.blanks.summary", { count: String(done), total: String(total) })}
      title=${t("profile.completeness.hint")}
    >
      <div class="profile__completeness-copy">
        <span class="profile__completeness-percent">${percent}%</span>
        <span class="profile__completeness-label">${t("profile.completeness.label")}</span>
      </div>
      <div class="profile__ledger" aria-hidden="true" data-testid="profile-ledger">
        ${groups.map(
          (group) => html`
            <span class="profile__ledger-group">
              ${group.fields.map(
                (field) => html`<span
                  class=${`profile__tick ${
                    blanks.has(field.key) ? "profile__tick--blank" : "profile__tick--filled"
                  }`}
                  title=${labelFor(field.key)}
                ></span>`,
              )}
            </span>
          `,
        )}
      </div>
    </div>
  `;
}

// Lives in the identity card rather than its own section -- badges are a fact about the person
// the header is already introducing, the same way a LinkedIn/GitHub header shows them inline
// rather than in a separate scroll-to section.
/**
 * Whether the member has been active in Slack lately, beside their name.
 *
 * Three states, not two. "Unknown" is the honest answer before the sweep has ever measured this
 * member -- and for anyone whose Slack account the roster has not linked -- so it renders nothing
 * at all. Showing "Inactive" there would be an accusation drawn from missing data rather than from
 * silence, and on a page whose whole job is telling you what the lab knows about you, that is the
 * one thing it must not get wrong.
 */
function renderSlackActivity(member: LabMember) {
  const activity = adminBotSlackActivityOf({
    slack_user_id: member.slack_user_id as string | undefined,
    slack_messages_7d: member.slack_messages_7d as number | undefined,
    slack_activity_checked_at: member.slack_activity_checked_at as string | undefined,
  });
  if (activity === "unknown") {
    return nothing;
  }
  const count = Number(member.slack_messages_7d ?? 0);
  return html`
    <span
      class="profile__activity"
      data-activity=${activity}
      data-testid="profile-slack-activity"
      title=${t(`profile.activity.${activity}Detail`, {
        count: String(count),
        days: String(adminBotSlackActivityWindowDays),
        threshold: String(adminBotSlackActivityThreshold),
      })}
    >
      <span class="profile__activity-dot" aria-hidden="true"></span>
      ${t(`profile.activity.${activity}`)}
    </span>
  `;
}

function renderBadges(state: AppViewState, member: LabMember) {
  const badges = badgesFor(state, member);
  if (!badges.length) {
    return html`<p class="profile__badges-empty">${t("profile.badges.empty")}</p>`;
  }
  return html`
    <div class="profile__badges" data-testid="profile-badges">
      ${badges.map(
        (badge) => html`<span class="profile-badge">
          <span class="profile-badge__icon" aria-hidden="true">${icons.spark}</span>
          ${badge}
        </span>`,
      )}
    </div>
  `;
}

function renderPhotoCompliance(state: AppViewState, member: LabMember, props: ProfileProps) {
  const review = member.profile_photo_review;
  const assessment = review?.assessment;
  const variants = review?.variants ?? [];
  const selectedId = review?.selected_variant_id;
  return html`
    <section class="profile__section" data-testid="profile-photo-guidelines">
      <h2 class="profile__section-title">Slack profile photo guidelines</h2>
      <p>
        We directly link member photos from Slack on team/collaborator pages and the lab public
        website, so a professional profile photo is strongly recommended.
      </p>
      <ul>
        <li>Big enough headshot.</li>
        <li>Face clearly visible, preferably front-facing.</li>
        <li>
          Clean background (blurred, single color, or at least easy to convert with a background
          remover).
        </li>
      </ul>
      <p>
        How-To: use portrait mode with a high-quality back camera and have someone take the photo.
        You can blur/change the background in phone editors, or use
        <a href="https://www.remove.bg/" target=${EXTERNAL_LINK_TARGET} rel=${buildExternalLinkRel()}
          >remove.bg</a
        >. Chest-up framing with shoulders usually works best.
      </p>
      ${assessment
        ? html`
            <p>
              <strong>Latest check:</strong>
              ${assessment.compliant ? "Compliant" : "Needs update"} (${assessment.source})
              ${assessment.summary ? `- ${assessment.summary}` : ""}
            </p>
            ${assessment.issues.length
              ? html`<p><strong>Issues:</strong> ${assessment.issues.join(", ")}</p>`
              : nothing}
          `
        : html`<p>No automated check result is available yet.</p>`}
      <div class="profile__form-actions">
        <button
          type="button"
          class="btn"
          ?disabled=${state.adminBotPhotoPolishBusy}
          @click=${() => props.onPolishPhoto()}
        >
          ${state.adminBotPhotoPolishBusy ? "Polishing..." : "Polish my current Slack photo with AI"}
        </button>
      </div>
      ${variants.length
        ? html`
            <div class="profile__field-group">
              <h3 class="profile__group-title">AI polished options</h3>
              <div class="profile__field-grid">
                ${variants
                  .slice()
                  .reverse()
                  .map(
                    (variant) => html`
                      <div class="profile-field">
                        <dt class="profile-field__label">
                          ${variant.id === selectedId ? "Selected for Slack" : "Candidate"}
                        </dt>
                        <dd class="profile-field__value">
                          <img class="profile__upload-preview" src=${variant.image_data_url} alt="" />
                          <div class="profile__form-actions">
                            <button
                              type="button"
                              class="btn btn--sm primary"
                              ?disabled=${state.adminBotPhotoApplyBusy || variant.id === selectedId}
                              @click=${() => props.onApplyPolishedPhoto(variant.id)}
                            >
                              ${variant.id === selectedId
                                ? "Applied"
                                : state.adminBotPhotoApplyBusy
                                  ? "Applying..."
                                  : "Use this photo for Slack"}
                            </button>
                          </div>
                          ${variant.note ? html`<p>${variant.note}</p>` : nothing}
                        </dd>
                      </div>
                    `,
                  )}
              </div>
            </div>
          `
        : nothing}
    </section>
  `;
}

// What is still outstanding for this person, in one place: the onboarding steps they have not
// finished, then the guidebook pointers derived from what their record is missing.
//
// The onboarding steps come first because they are the lab actually waiting on someone, where a
// guidebook pointer is only advice. Their labels, detail and links all come from the checklist the
// service generated for this member, so this list and the checklist itself can never drift.
function renderSuggestions(state: AppViewState, member: LabMember) {
  const blanks = new Set(blankFields(member).map((field) => field.key));

  type Suggestion = {
    id: string;
    title: string;
    body: string;
    label: string;
    href: string;
    status?: string;
  };

  const onboardingSuggestions: Suggestion[] = [];
  const otherSuggestions: Suggestion[] = [];

  const onboarding = state.adminBotOnboarding;
  const outstanding = [
    ...(onboarding?.current_step ? [onboarding.current_step] : []),
    ...(onboarding?.remaining ?? []),
  ].filter(
    (step, index, all) =>
      step.status !== "complete" && all.findIndex((other) => other.id === step.id) === index,
  );
  for (const step of outstanding) {
    const link = step.links?.[0];
    onboardingSuggestions.push({
      id: `onboarding-${step.id}`,
      title: step.label,
      body: step.detail ?? "",
      label: link?.label ?? "",
      href: link?.url ?? "",
      status:
        step.status === "current"
          ? t("adminbotWelcome.status.current")
          : t("adminbotWelcome.status.remaining"),
    });
  }

  const coveredByOnboarding = outstanding
    .map((step) => `${step.id} ${step.label}`.toLowerCase())
    .join(" ");

  // No URN card here any more: the collector hand-off sits on the field it feeds (see
  // renderFieldAction), where it stays reachable after the field is filled.

  // The intake form used to be pushed here unconditionally. It never had a "done" state, so it sat
  // permanently in a stack whose whole meaning is "still outstanding" and quietly taught people to
  // read past it. It lives with the links now, where a permanent destination belongs.
  const topics = (member.research_topics ?? []).join(" ").toLowerCase();
  if (
    !coveredByOnboarding.includes("gpu") &&
    !topics.includes("gpu") &&
    !String(member.notes ?? "")
      .toLowerCase()
      .includes("gpu")
  ) {
    otherSuggestions.push({
      id: "gpu",
      title: t("profile.suggestions.gpuTitle"),
      body: t("profile.suggestions.gpuBody"),
      label: t("profile.suggestions.gpuLink"),
      href: "https://github.com/akhkim/openclaw-adminbot-lab#gpu-onboarding",
    });
  }
  if (blanks.has("personal_website") && !coveredByOnboarding.includes("website")) {
    otherSuggestions.push({
      id: "website",
      title: t("profile.suggestions.websiteTitle"),
      body: t("profile.suggestions.websiteBody"),
      label: t("profile.suggestions.websiteLink"),
      href: "https://github.com/akhkim/openclaw-adminbot-lab#member-pages",
    });
  }

  if (!onboardingSuggestions.length && !otherSuggestions.length) {
    return nothing;
  }

  const renderCard = (suggestion: Suggestion) => html`
    <article class="profile-suggestion" data-testid=${`suggestion-${suggestion.id}`}>
      <h3 class="profile-suggestion__title">
        ${suggestion.title}
        ${suggestion.status
          ? html`<span class="ab-chip profile-suggestion__status">${suggestion.status}</span>`
          : nothing}
      </h3>
      ${suggestion.body
        ? html`<p class="profile-suggestion__body">${suggestion.body}</p>`
        : nothing}
      ${suggestion.href
        ? html`
            <a
              class="profile-suggestion__link"
              href=${suggestion.href}
              target=${EXTERNAL_LINK_TARGET}
              rel=${buildExternalLinkRel()}
            >
              ${suggestion.label}
              <span class="profile-suggestion__icon" aria-hidden="true">
                ${icons.externalLink}
              </span>
            </a>
          `
        : nothing}
    </article>
  `;

  return html`
    <section class="profile__section" data-testid="profile-suggestions">
      <h2 class="profile__section-title">${t("profile.suggestions.title")}</h2>
      ${onboardingSuggestions.length
        ? html`
            <div class="profile__suggestions-group">
              <h3 class="profile__suggestions-group-title">
                ${t("profile.suggestions.fromOnboarding")}
              </h3>
              <div class="profile__suggestions">
                ${onboardingSuggestions.map(renderCard)}
              </div>
            </div>
          `
        : nothing}
      ${otherSuggestions.length
        ? html`
            <div class="profile__suggestions-group">
              <h3 class="profile__suggestions-group-title">
                ${t("profile.suggestions.other")}
              </h3>
              <div class="profile__suggestions">
                ${otherSuggestions.map(renderCard)}
              </div>
            </div>
          `
        : nothing}
    </section>
  `;
}


// A picture when there is one, initials when there is not -- never an empty circle.
// The picture is its own edit control: hovering (or tabbing to) it reveals a pencil, and the whole
// circle is the file picker. Discoverable where the thing being changed already is, rather than in
// a form field somewhere below it.
function renderAvatar(state: AppViewState, member: LabMember, name: string, props: ProfileProps) {
  const src = String(member.avatar_url ?? "").trim();
  return html`
    <label class="profile__avatar-slot" title=${t("profile.picture.edit")}>
      <span class="sr-only">${t("profile.picture.edit")}</span>
      ${src
        ? html`<img class="profile__avatar profile__avatar--photo" src=${src} alt="" />`
        : html`<span class="profile__avatar" aria-hidden="true">
            ${name.slice(0, 1).toUpperCase()}
          </span>`}
      <span class="profile__avatar-overlay" aria-hidden="true">${icons.penLine}</span>
      <input
        class="sr-only"
        type="file"
        accept="image/*"
        data-testid="profile-avatar-upload"
        @change=${(event: Event) => void acceptAvatarFile(state, member, props, event)}
      />
    </label>
  `;
}

function renderLinks(member: LabMember) {
  const cv = String(member.cv_url ?? "").trim();
  const socials = SOCIAL_FIELDS.map((field) => ({
    label: t(field.labelKey),
    href: String(member[field.key] ?? "").trim(),
  })).filter((link) => link.href);
  const site = String(member.personal_website ?? "").trim();
  const openReviewId = String(member.openreview_id ?? "").trim();
  if (!cv && !socials.length && !site && !openReviewId) {
    return nothing;
  }
  const link = (label: string, href: string, strong = false) => html`
    <a
      class=${`profile__link ${strong ? "profile__link--strong" : ""}`}
      href=${href}
      target=${EXTERNAL_LINK_TARGET}
      rel=${buildExternalLinkRel()}
      >${label}</a
    >
  `;
  return html`
    <span class="profile__links" data-testid="profile-links">
      ${cv ? link(t("profile.social.cv"), cv, true) : nothing}
      ${site ? link(t("profile.social.website"), site) : nothing}
      ${socials.map((social) => link(social.label, social.href))}
      ${openReviewId
        ? link(
            t("profile.social.openreview"),
            `https://openreview.net/profile?id=${encodeURIComponent(openReviewId)}`,
          )
        : nothing}
    </span>
  `;
}

// The toast rides the same notice the controller already sets when an autosave request
// resolves (see saveAdminBotOwnProfile), so it reflects a real completed write rather than
// firing optimistically the moment a keystroke schedules one. It self-clears after a beat so a
// page full of autosaving fields doesn't leave a permanent banner sitting on screen.
const SAVE_TOAST_MS = 2600;
let toastNoticeText: string | null = null;
let toastDismissTimer: ReturnType<typeof setTimeout> | undefined;

function renderSaveToast(state: AppViewState) {
  const notice = state.adminBotNotice;
  if (!notice) {
    toastNoticeText = null;
    return nothing;
  }
  if (notice.text !== toastNoticeText) {
    toastNoticeText = notice.text;
    if (toastDismissTimer) {
      clearTimeout(toastDismissTimer);
      toastDismissTimer = undefined;
    }
    // Only a success self-clears. A rejected save leaves the record different from what is on
    // screen, and the message names the field to fix -- a notice that erases itself after a beat
    // is one a member reading another part of the page never sees at all.
    if (notice.kind === "success") {
      toastDismissTimer = setTimeout(() => {
        toastDismissTimer = undefined;
        if (state.adminBotNotice?.text === notice.text) {
          state.adminBotNotice = null;
        }
      }, SAVE_TOAST_MS);
    }
  }
  return html`
    <div
      class="profile__toast profile__toast--${notice.kind}"
      role="status"
      aria-live="polite"
      data-testid="profile-save-toast"
    >
      ${notice.kind === "success" ? t("profile.toast.saved") : notice.text}
    </div>
  `;
}

export function renderProfile(state: AppViewState, props: ProfileProps) {
  const member = findOwnMember(state);
  if (!member) {
    return html`<p class="profile__empty">${t("profile.blanks.signInRequired")}</p>`;
  }
  const name = member.name?.trim() || member.email?.trim() || "";
  consumePendingFieldFocus();
  return html`
    <div class="profile">
      ${renderSaveToast(state)}
      <header class="profile__hero">
        ${renderAvatar(state, member, name, props)}
        <div class="profile__identity-copy">
          <div class="profile__identity-top">
            <span class="profile__name">${name}</span>
            ${member.role?.trim()
              ? html`<span class="profile__role-pill">${member.role.trim()}</span>`
              : nothing}
            ${renderSlackActivity(member)}
          </div>
          <span class="profile__email">${member.email?.trim() ?? ""}</span>
          ${renderLinks(member)} ${renderBadges(state, member)}
        </div>
        ${renderCompletionLedger(member)}
      </header>
      ${renderPhotoCompliance(state, member, props)}
      ${renderBasics(state, member, props)} ${renderSuggestions(state, member)}
    </div>
  `;
}
