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
import { adminBotMemberRoles } from "../../../../../extensions/adminbot/src/contracts/actions.js";
import { t } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../external-link.ts";
import { icons } from "../../icons.ts";
import type { LabMember, MemberProfileUpdate } from "../auth/session.ts";
import { checkAccount, isCheckableField } from "./profile-account-check.ts";

export type ProfileProps = {
  onSave: (memberId: string, fields: MemberProfileUpdate) => void;
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
  | "image";

// Purely presentational clustering -- same fields, same keys, same validation -- so someone
// scanning 18 inputs meets four short, labeled groups instead of one wall of text boxes.
type ProfileFieldGroup = "identity" | "work" | "research" | "links";

const PROFILE_FIELD_GROUPS: Array<{
  id: ProfileFieldGroup;
  labelKey: string;
  icon: keyof typeof icons;
}> = [
  { id: "identity", labelKey: "profile.groups.identity", icon: "user" },
  { id: "work", labelKey: "profile.groups.work", icon: "clock" },
  { id: "research", labelKey: "profile.groups.research", icon: "brain" },
  { id: "links", labelKey: "profile.groups.links", icon: "link" },
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
  // Keeps a field out of the blanks count, the fill-in form, and the "profile complete" badge.
  // Not everyone has a Twitter, and a checklist that can never reach zero stops being a
  // checklist -- it just nags.
  optional?: boolean;
  group: ProfileFieldGroup;
};

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
    example: "Ada Lovelace",
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
    example: "ada.lovelace@gmail.com",
    type: "short_text",
    optional: true,
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
    key: "location",
    labelKey: "profile.fields.location",
    example: "Toronto, ON",
    type: "short_text",
    group: "work",
  },
  {
    key: "timezone",
    labelKey: "profile.fields.timezone",
    example: "America/Toronto",
    type: "dropdown",
    options: timezoneOptions(),
    group: "work",
  },
  {
    key: "hours_per_week",
    labelKey: "profile.fields.hoursPerWeek",
    example: "20",
    type: "numeric",
    group: "work",
  },
  {
    key: "slack_user_id",
    labelKey: "profile.fields.slackUserId",
    example: "U0123ABC456",
    type: "short_text",
    group: "work",
  },
  {
    key: "research_topics",
    labelKey: "profile.fields.researchTopics",
    example: "reasoning, alignment",
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
    key: "notes",
    labelKey: "profile.fields.notes",
    example: "Prefers async check-ins on Fridays.",
    type: "paragraph",
    optional: true,
    group: "research",
  },
  {
    key: "avatar_url",
    labelKey: "profile.fields.avatarUrl",
    example: "",
    type: "image",
    optional: true,
    group: "identity",
  },
  {
    key: "personal_website",
    labelKey: "profile.fields.personalWebsite",
    example: "https://ada.dev",
    type: "link",
    optional: true,
    group: "links",
  },
  {
    key: "github_url",
    labelKey: "profile.fields.github",
    example: "https://github.com/ada",
    type: "link",
    optional: true,
    group: "links",
  },
  {
    key: "linkedin_url",
    labelKey: "profile.fields.linkedin",
    example: "https://www.linkedin.com/in/ada",
    type: "link",
    optional: true,
    group: "links",
  },
  {
    key: "cv_url",
    labelKey: "profile.fields.cvUrl",
    example: "https://ada.dev/cv.pdf",
    type: "link",
    optional: true,
    group: "links",
  },
  {
    key: "scholar_url",
    labelKey: "profile.fields.scholar",
    example: "https://scholar.google.com/citations?user=abc123",
    type: "link",
    optional: true,
    group: "links",
  },
  {
    key: "openreview_id",
    labelKey: "profile.fields.openreviewId",
    example: "~Ada_Lovelace1",
    type: "short_text",
    optional: true,
    group: "links",
  },
  {
    key: "twitter_url",
    labelKey: "profile.fields.twitter",
    example: "https://x.com/ada",
    type: "link",
    optional: true,
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

function flushAutosave(
  timer: ReturnType<typeof setTimeout> | undefined,
  set: (next: ReturnType<typeof setTimeout> | undefined) => void,
  commit: () => void,
): void {
  if (timer) {
    clearTimeout(timer);
    set(undefined);
  }
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
let accountCheckAbort: AbortController | undefined;

function runAccountChecks(form: HTMLFormElement, state: AppViewState): void {
  accountCheckAbort?.abort();
  const controller = new AbortController();
  accountCheckAbort = controller;
  const data = new FormData(form);
  for (const field of ["github_url", "openreview_id"] as const) {
    if (!data.has(field)) {
      continue;
    }
    const value = String(data.get(field) ?? "").trim();
    if (!value) {
      if (state.profileAccountChecks[field]) {
        const next = { ...state.profileAccountChecks };
        delete next[field];
        state.profileAccountChecks = next;
      }
      continue;
    }
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

export function findOwnMember(state: AppViewState): LabMember | null {
  const memberId = state.memberId;
  if (!memberId) {
    return null;
  }
  return (state.adminBotData?.members ?? []).find((member) => member.id === memberId) ?? null;
}

function valueOf(member: LabMember, field: EditableField): string {
  const raw = member[field.key];
  if (field.type === "list") {
    return Array.isArray(raw) ? raw.filter(Boolean).join(", ") : "";
  }
  return raw === null || raw === undefined ? "" : String(raw);
}

export function blankFields(member: LabMember): EditableField[] {
  return EDITABLE_FIELDS.filter((field) => !field.optional && !valueOf(member, field).trim());
}

// Everything a member may set, blank or not -- what the full editor offers.
export function requiredFieldCount(): number {
  return EDITABLE_FIELDS.filter((field) => !field.optional).length;
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
  if (member.role?.trim()) {
    badges.push(member.role.trim());
  }
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
    if (field.type === "list") {
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

function renderAvatarUpload(state: AppViewState, member: LabMember, props: ProfileProps) {
  const current = String(member.avatar_url ?? "").trim();
  return html`
    <div class="profile__upload">
      <span class="profile__form-label">${labelFor("avatar_url")}</span>
      <div class="profile__upload-row">
        ${current
          ? html`<img class="profile__upload-preview" src=${current} alt="" />`
          : html`<span class="profile__upload-preview profile__upload-preview--empty"></span>`}
        <label class="btn btn--sm profile__upload-button">
          ${current ? t("profile.picture.replace") : t("profile.picture.choose")}
          <input
            class="sr-only"
            type="file"
            accept="image/*"
            data-testid="profile-avatar-upload-field"
            @change=${(event: Event) => void acceptAvatarFile(state, member, props, event)}
          />
        </label>
        ${current
          ? html`
              <button
                type="button"
                class="btn btn--sm"
                data-testid="profile-avatar-remove"
                @click=${() => member.id && props.onSave(member.id, { avatar_url: "" })}
              >
                ${t("profile.picture.remove")}
              </button>
            `
          : nothing}
      </div>
      <p class="profile__upload-hint">${t("profile.picture.hint")}</p>
    </div>
  `;
}

const SHORT_TEXT_MAX_LENGTH = 200;
const PARAGRAPH_MAX_LENGTH = 2000;

// One control per answer type, so the shape a field expects is enforced by what you can
// physically type into it -- a dropdown can't hold a value off its own list, a numeric input
// can't hold letters, a date input can't hold "next Tuesday". The server re-validates all of it
// regardless (a form is a UI convenience, never the trust boundary), but the earlier and more
// specific the feedback, the less a bad save ever gets that far.
function renderFieldInput(field: EditableField, currentValue: string) {
  switch (field.type) {
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
          placeholder=${field.example}
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
          placeholder=${field.example}
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
          placeholder=${field.example}
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
          placeholder=${field.example}
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
          placeholder=${field.example}
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
// A dot rather than a red asterisk: nothing on this page rejects a blank, so borrowing the error
// color to say "required" claimed a consequence the form does not have. The dot carries the same
// mark in the accent the rest of the page already uses for "the lab is waiting on this".
function renderMandatoryMark(field: EditableField) {
  if (field.optional) {
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
                        ${labelFor(field.key)}${renderMandatoryMark(field)}
                        ${field.optional
                          ? html`<span class="profile__optional"
                              >${t("profile.basics.optional")}</span
                            >`
                          : nothing}
                      </span>
                      ${renderFieldInput(field, valueOf(member, field))}
                      ${renderAccountCheckStatus(state, field)}
                    </label>
                  `,
                )}
              </div>
            </div>
          `,
        )}
        ${renderAvatarUpload(state, member, props)}
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
  const groups = PROFILE_FIELD_GROUPS.map((group) => ({
    id: group.id,
    fields: EDITABLE_FIELDS.filter((field) => !field.optional && field.group === group.id),
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

// What is still outstanding for this person, in one place: the onboarding steps they have not
// finished, then the guidebook pointers derived from what their record is missing.
//
// The onboarding steps come first because they are the lab actually waiting on someone, where a
// guidebook pointer is only advice. Their labels, detail and links all come from the checklist the
// service generated for this member, so this list and the checklist itself can never drift.
function renderSuggestions(state: AppViewState, member: LabMember) {
  const blanks = new Set(blankFields(member).map((field) => field.key));
  const suggestions: Array<{
    id: string;
    title: string;
    body: string;
    label: string;
    href: string;
    // Present only on an onboarding step: the checklist's own word for where the step stands.
    status?: string;
  }> = [];

  const onboarding = state.adminBotOnboarding;
  // `remaining` is everything not yet done; `current_step` is the one the checklist points at
  // first and is not repeated inside it, so both are needed to list all of the outstanding work.
  const outstanding = [
    ...(onboarding?.current_step ? [onboarding.current_step] : []),
    ...(onboarding?.remaining ?? []),
  ].filter(
    (step, index, all) =>
      step.status !== "complete" && all.findIndex((other) => other.id === step.id) === index,
  );
  for (const step of outstanding) {
    const link = step.links?.[0];
    suggestions.push({
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

  // A guidebook pointer that repeats an outstanding onboarding step is noise: the step is the lab
  // actually asking, and the pointer is advice about the same thing. Whatever onboarding already
  // covers, the static suggestions below stay quiet about.
  const coveredByOnboarding = outstanding
    .map((step) => `${step.id} ${step.label}`.toLowerCase())
    .join(" ");

  const topics = (member.research_topics ?? []).join(" ").toLowerCase();
  if (
    !coveredByOnboarding.includes("gpu") &&
    !topics.includes("gpu") &&
    !String(member.notes ?? "")
      .toLowerCase()
      .includes("gpu")
  ) {
    suggestions.push({
      id: "gpu",
      title: t("profile.suggestions.gpuTitle"),
      body: t("profile.suggestions.gpuBody"),
      label: t("profile.suggestions.gpuLink"),
      href: "https://github.com/akhkim/openclaw-adminbot-lab#gpu-onboarding",
    });
  }
  if (blanks.has("personal_website") && !coveredByOnboarding.includes("website")) {
    suggestions.push({
      id: "website",
      title: t("profile.suggestions.websiteTitle"),
      body: t("profile.suggestions.websiteBody"),
      label: t("profile.suggestions.websiteLink"),
      href: "https://github.com/akhkim/openclaw-adminbot-lab#member-pages",
    });
  }
  if (!suggestions.length) {
    return nothing;
  }
  return html`
    <section class="profile__section" data-testid="profile-suggestions">
      <h2 class="profile__section-title">${t("profile.suggestions.title")}</h2>
      <div class="profile__suggestions">
        ${suggestions.map(
          (suggestion) => html`
            <article class="profile-suggestion" data-testid=${`suggestion-${suggestion.id}`}>
              <h3 class="profile-suggestion__title">
                ${suggestion.title}
                ${suggestion.status
                  ? html`<span class="ab-chip profile-suggestion__status"
                      >${suggestion.status}</span
                    >`
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
          `,
        )}
      </div>
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
    }
    toastDismissTimer = setTimeout(() => {
      toastDismissTimer = undefined;
      if (state.adminBotNotice?.text === notice.text) {
        state.adminBotNotice = null;
      }
    }, SAVE_TOAST_MS);
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
          </div>
          <span class="profile__email">${member.email?.trim() ?? ""}</span>
          ${renderLinks(member)} ${renderBadges(state, member)}
        </div>
        ${renderCompletionLedger(member)}
      </header>
      ${renderBasics(state, member, props)} ${renderSuggestions(state, member)}
    </div>
  `;
}
