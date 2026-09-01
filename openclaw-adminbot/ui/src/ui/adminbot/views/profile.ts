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
  adminBotMemberFieldVisibility,
  adminBotSlackActivityOf,
  adminBotSlackActivityThreshold,
  adminBotSlackActivityWindowDays,
  adminBotTimelineEntryTarget,
  isAdminBotFullMember,
} from "../../../../../extensions/adminbot/src/contracts/actions.js";
import { t } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../external-link.ts";
import { icons } from "../../icons.ts";
import type {
  AssignedBadge,
  BadgeDefinition,
  BadgeNominationView,
  LabMember,
  MemberProfileUpdate,
} from "../auth/session.ts";
import {
  joinPhoneNumber,
  resolvePhoneDial,
  splitPhoneNumber,
} from "../data/phone-country-codes.ts";
import { timezoneForLocation } from "../data/timezone-for-location.ts";
import {
  isOptionalMemberField,
  PROFILE_FIELD_GROUPS,
  PROFILE_FIELDS,
  type ProfileField,
  type ProfileFieldGroup,
} from "../member-fields.ts";
import { renderCountrySelect } from "./country-select.ts";
import { checkAccount, isCheckableField } from "./profile-account-check.ts";

export type ProfileProps = {
  onSave: (memberId: string, fields: MemberProfileUpdate) => void;
  onPolishPhoto?: () => void;
  onApplyPolishedPhoto?: (variantId: string) => void;
  onSubmitBadgeNomination?: (badgeId: string, evidence: string) => void;
};

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

// There is no read-only "Account" group any more. It held one row -- the directory email -- which
// the hero already prints under the member's name, so the group was a second copy of a fact three
// lines above it, under a heading whose only content was that copy. Status and privilege level had
// already gone the same way: governance bookkeeping a member has no action to take on.
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
  current_city: "profile.help.currentCity",
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
  >`;
}

/**
 * Who reads this answer.
 *
 * Only drawn on the private ones. A badge on all twenty-eight would be noise nobody reads and would
 * make the four that matter harder to find, and "the lab can see this" is already what a member
 * assumes about a roster -- the surprise worth printing is the exception.
 *
 * The list comes from the same contract the service redacts on, so the label cannot promise
 * something the boundary does not do.
 */
function renderFieldVisibility(field: EditableField) {
  if (adminBotMemberFieldVisibility(field.key) !== "self") {
    return nothing;
  }
  return html`<span
    class="profile__field-visibility"
    data-testid=${`profile-visibility-${field.key}`}
    >${icons.lock}${t("profile.visibility.self")}</span
  >`;
}

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
  return !isOptionalMemberField(field) && !field.adminOnly;
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

function assignedBadgeLabel(badge: Pick<AssignedBadge, "name" | "tier">): string {
  return badge.tier ? `${badge.name} · ${badge.tier}` : badge.name;
}

function nominationBadgeLabel(nomination: BadgeNominationView): string {
  return nomination.badge_tier
    ? `${nomination.badge_name} · ${nomination.badge_tier}`
    : nomination.badge_name;
}

function availableBadgeDefinitions(state: AppViewState, member: LabMember): BadgeDefinition[] {
  const assignedFamilies = new Set(
    ((member.assigned_badges ?? []) as AssignedBadge[]).map((badge) => badge.family_key),
  );
  const pendingFamilies = new Set(
    (state.profileBadgeNominations ?? [])
      .filter((nomination) => nomination.status === "pending")
      .map((nomination) => nomination.family_key),
  );
  return (state.adminBotBadgeDefinitions ?? []).filter(
    (badge) => !assignedFamilies.has(badge.family_key) && !pendingFamilies.has(badge.family_key),
  );
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
      // A blank or unparseable number is left off the update rather than sent as 0 -- the record
      // has no way to tell a real zero from a box nobody filled in.
      const parsed = Number(value);
      if (value && Number.isFinite(parsed)) {
        setField(fields, field.key, parsed);
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
  // An admin-owned answer the member may still supply. It was `disabled`, which is why this is
  // worth explaining: a disabled input cannot be focused, selected, or pasted into, so a member
  // who had looked their URN up in the collector tool the field's own help text points them at had
  // nowhere to put it -- and could not copy the stored one out either. Read-only would fix the
  // copy half and not the paste half, so it is an ordinary input.
  //
  // What has *not* changed is who is chased for it. The field stays on
  // adminBotAdminOwnedProfileFields, so it is still outside the reminder's set and outside the
  // completion denominator. One member of 199 has a URN; counting it would drop fifty profiles off
  // 100% overnight and chase every one of them for a value they have never heard of, which is the
  // incident that list exists to prevent.
  if (field.adminOnly) {
    return html`
      <input
        class="input"
        name=${field.key}
        type="text"
        maxlength=${SHORT_TEXT_MAX_LENGTH}
        placeholder=${ifDefined(exampleFor(field))}
        .value=${currentValue}
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
          min=${ifDefined(field.min)}
          max=${ifDefined(field.max)}
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
  if (isOptionalMemberField(field) || field.adminOnly) {
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
// Two things stay uneditable: the login email, which the lab governs and the closing line says so
// rather than a locked row nobody can act on, and the picture, which has its own upload control
// because a file is not a text field.
function renderBasics(state: AppViewState, member: LabMember, props: ProfileProps) {
  const commit = (form: HTMLFormElement) => () => {
    member.id && props.onSave(member.id, collectBasics(form));
    runAccountChecks(form, state);
  };
  // The explicit save. Autosave still does the work -- this button changes nothing about what is
  // written, only about when the member gets to decide it happened. A form that only ever saves
  // itself gives someone who has just corrected their phone number no way to *finish*: they either
  // wait out a debounce they cannot see or navigate away and hope. Pressing this cancels the
  // pending timer and commits immediately, so the toast is an answer to a deliberate act.
  const saveNow = (form: HTMLFormElement) => {
    if (basicsSaveTimer) {
      clearTimeout(basicsSaveTimer);
      basicsSaveTimer = undefined;
    }
    // Unconditional, unlike flushAutosave: with no pending timer that helper does nothing, and a
    // Save button that silently no-ops because the debounce already fired is the one outcome a
    // person pressing it cannot tell apart from a broken button.
    commit(form)();
  };
  return html`
    <section class="profile__section" data-testid="profile-basics">
      <div class="profile__section-head">
        <h2 class="profile__section-title">${t("profile.basics.title")}</h2>
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
                          : isOptionalMemberField(field)
                            ? html`<span class="profile__optional"
                                >${t("profile.basics.optional")}</span
                              >`
                            : nothing}
                      </span>
                      ${renderFieldInput(field, displayValue(member, field))}
                      ${renderUrnStatus(member, field)} ${renderFieldAction(field)}
                      ${renderFieldHint(field)} ${renderFieldVisibility(field)}
                      ${renderPrefillHint(member, field)} ${renderWhatsappHint(member, field)}
                      ${renderAccountCheckStatus(state, field)}
                    </label>
                  `,
                )}
              </div>
            </div>
          `,
        )}
        <div class="profile__form-actions">
          <span class="profile__autosave-hint">${t("profile.basics.autosaveHint")}</span>
          <button
            type="button"
            class="btn primary"
            data-testid="profile-basics-save"
            @click=${(event: Event) => {
              const button = event.currentTarget as HTMLButtonElement;
              const form = button.closest("form");
              if (form instanceof HTMLFormElement) {
                saveNow(form);
              }
            }}
          >
            ${t("profile.basics.save")}
          </button>
        </div>
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
/**
 * Whether the lab is still waiting on this member's term timeline.
 *
 * The same rule the service's reminder applies (membersNeedingProfileAttention), read here so the
 * page cannot claim somebody is finished while the sweep still has a reason to write to them.
 */
function timelineStillShort(member: LabMember): boolean {
  const entries =
    (member.availability?.length ?? 0) +
    (member.time_off?.length ?? 0) +
    (member.milestones?.length ?? 0) +
    (member.trips?.length ?? 0);
  return isAdminBotFullMember(member as never) && entries < adminBotTimelineEntryTarget;
}

function renderCompletionLedger(member: LabMember, state?: AppViewState) {
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
    ${percent === 100 && timelineStillShort(member)
      ? html`<p class="profile__completeness-pending" data-testid="profile-timeline-pending">
          ${t("profile.completeness.timelinePending")}
          ${state
            ? html`<button
                type="button"
                class="btn btn--sm"
                @click=${() => state.setTab("adminbotTimeAvailability")}
              >
                ${t("profile.completeness.timelineAction")}
              </button>`
            : nothing}
        </p>`
      : nothing}
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
  const computed = badgesFor(state, member);
  const assigned = ((member.assigned_badges ?? []) as AssignedBadge[]).toSorted(
    (left, right) =>
      left.sort_order - right.sort_order ||
      left.category.localeCompare(right.category) ||
      left.name.localeCompare(right.name),
  );
  if (!assigned.length && !computed.length) {
    return html`<p class="profile__badges-empty">${t("profile.badges.empty")}</p>`;
  }
  return html`
    <div class="profile__badges" data-testid="profile-badges">
      ${assigned.map(
        (badge) => html`<span class="profile-badge profile-badge--managed" tabindex="0">
          <span class="profile-badge__icon" aria-hidden="true">${icons.spark}</span>
          <span>${assignedBadgeLabel(badge)}</span>
          <span class="profile-badge__popover" role="tooltip">
            <strong>${badge.category}</strong>
            <span>${badge.description}</span>
            ${badge.criteria_url
              ? html`<a
                  class="profile-badge__link"
                  href=${badge.criteria_url}
                  target=${EXTERNAL_LINK_TARGET}
                  rel=${buildExternalLinkRel()}
                  >${t("profile.badges.criteriaLink")}</a
                >`
              : nothing}
          </span>
        </span>`,
      )}
      ${computed.map(
        (badge) => html`<span class="profile-badge">
          <span class="profile-badge__icon" aria-hidden="true">${icons.spark}</span>
          ${badge}
        </span>`,
      )}
    </div>
  `;
}

/**
 * The member's own badges, as a section rather than a strip of chips in the header.
 *
 * They were rendered inline beside the name, which made them decoration: the hover popover carrying
 * the category, the description and the criteria link was the only way to read what a badge
 * actually meant, and a popover is not something anyone opens for each of five chips. The admin
 * badges tab has always shown the full picture; this is the same thing scoped to one person, and it
 * sits directly above the nomination form so "what I have" and "what I could ask for" read as one
 * subject rather than two halves at opposite ends of the page.
 *
 * Not duplicated back into the header. Stating the same fact twice on one page is how the two
 * copies eventually disagree.
 */
function renderBadgesSection(state: AppViewState, member: LabMember) {
  return html`
    <section class="profile__section" data-testid="profile-badges-section">
      <h2 class="profile__section-title">${t("profile.badges.title")}</h2>
      <p class="profile__section-subtitle">${t("profile.badges.subtitle")}</p>
      ${renderBadges(state, member)}
    </section>
  `;
}

function nominationMeta(labelKey: "submittedAt" | "decidedAt", value: string | undefined) {
  if (!value) {
    return nothing;
  }
  const parsed = new Date(value);
  const text = Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
  return html`<span>${t(`profile.badges.${labelKey}`, { date: text })}</span>`;
}

function renderBadgeSelfNomination(state: AppViewState, member: LabMember, props: ProfileProps) {
  const available = availableBadgeDefinitions(state, member);
  const nominations = state.profileBadgeNominations ?? [];
  return html`
    <section class="profile__section" data-testid="profile-badge-nominations">
      <h2 class="profile__section-title">${t("profile.badges.nominateTitle")}</h2>
      <p class="profile__section-subtitle">${t("profile.badges.nominateHint")}</p>
      ${state.profileBadgeNotice
        ? html`<div
            class="callout ${state.profileBadgeNotice.kind === "error" ? "danger" : "success"}"
            role="status"
          >
            ${state.profileBadgeNotice.text}
          </div>`
        : nothing}
      ${available.length
        ? html`<form
            class="profile-badge-form"
            @submit=${(event: Event) => {
              event.preventDefault();
              const form = event.currentTarget as HTMLFormElement;
              props.onSubmitBadgeNomination?.(
                String(new FormData(form).get("badge_id") ?? ""),
                String(new FormData(form).get("evidence") ?? ""),
              );
            }}
          >
            <div class="profile__form-row">
              <span class="profile__form-label">${t("profile.badges.nominateSelect")}</span>
              <div class="profile-badge-picker">
                ${available.map(
                  (badge) => html`
                    <label
                      class="profile-badge-picker__card"
                      data-testid="profile-badge-picker-card"
                    >
                      <input
                        type="radio"
                        name="badge_id"
                        class="sr-only"
                        value=${badge.id}
                        ?disabled=${state.profileBadgeBusy}
                        required
                      />
                      <span class="profile-badge-picker__title">
                        ${assignedBadgeLabel(badge)}
                        ${badge.category
                          ? html`<span class="ab-chip">${badge.category}</span>`
                          : nothing}
                      </span>
                      <p class="profile-badge-picker__description">${badge.description}</p>
                    </label>
                  `,
                )}
              </div>
            </div>
            <label class="profile__form-row">
              <span class="profile__form-label"
                >${t("profile.badges.nominateEvidence")}
                <span class="profile__mandatory" aria-hidden="true"></span
                ><span class="sr-only">${t("profile.basics.mandatory")}</span></span
              >
              <textarea
                class="input adminbot-badge-textarea--compact"
                name="evidence"
                rows="1"
                ?disabled=${state.profileBadgeBusy}
                required
              ></textarea>
            </label>
            <div class="profile__form-actions">
              <button class="btn primary" type="submit" ?disabled=${state.profileBadgeBusy}>
                ${t("profile.badges.nominateButton")}
              </button>
            </div>
          </form>`
        : html`<p class="profile__badges-empty">${t("profile.badges.nominateNoneAvailable")}</p>`}
      <div class="profile-badge-nominations">
        <h3 class="profile__group-title">${t("profile.badges.nominationsTitle")}</h3>
        ${nominations.length
          ? html`<ul class="profile-badge-nominations__list">
              ${nominations.map(
                (nomination) => html`<li class="profile-badge-nominations__item">
                  <div class="profile-badge-nominations__head">
                    <span class="profile-badge">
                      <span class="profile-badge__icon" aria-hidden="true">${icons.spark}</span>
                      ${nominationBadgeLabel(nomination)}
                    </span>
                    <span class=${`ab-chip ab-chip--${nomination.status}`}>
                      ${t(`profile.badges.status.${nomination.status}`)}
                    </span>
                  </div>
                  <p class="profile-badge-nominations__description">
                    ${nomination.badge_description}
                  </p>
                  ${nomination.evidence
                    ? html`<p class="profile-badge-nominations__description">
                        <strong>${t("adminbotBadges.field.evidence")}:</strong>
                        ${nomination.evidence}
                      </p>`
                    : nothing}
                  <div class="profile-badge-nominations__meta">
                    ${nominationMeta("submittedAt", nomination.created_at)}
                    ${nominationMeta("decidedAt", nomination.decided_at)}
                  </div>
                </li>`,
              )}
            </ul>`
          : html`<p class="profile__badges-empty">${t("adminbotBadges.emptyNominations")}</p>`}
      </div>
    </section>
  `;
}

// The Slack photo rules and the polish controls that act on them.
//
// Its own section, directly after the record: the rules are reference a member reads once and the
// polish controls are a real action, which is more than a card in the suggestions stack carries.
// It sits after the fields rather than before them so the thing people came to this page to do is
// still the first thing they meet.
//
// A note, not a warning. There is a photo review pass on the service
// (`/profile-photo/review/run`) that can DM members whose photo misses the guidelines, and it is
// deliberately left off the cron manifest: a headshot is not a deadline, and chasing people about
// how they look is a worse trade than letting them read the rules when they are already on the
// page that changes them. So a member meets these guidelines by visiting their own profile, and
// the assessment block below renders only when a review actually ran -- its absence is the normal
// case and says nothing, rather than reading as a check still pending.
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
        <a
          href="https://www.remove.bg/"
          target=${EXTERNAL_LINK_TARGET}
          rel=${buildExternalLinkRel()}
          >remove.bg</a
        >. Chest-up framing with shoulders usually works best.
      </p>
      ${assessment
        ? html`
            <p>
              <strong>Last look at your photo:</strong>
              ${assessment.compliant ? "matches the guidelines" : "could be improved"}
              (${assessment.source})${assessment.summary ? ` - ${assessment.summary}` : ""}
            </p>
            ${assessment.issues.length
              ? html`<p><strong>What stood out:</strong> ${assessment.issues.join(", ")}</p>`
              : nothing}
          `
        : nothing}
      <div class="profile__form-actions">
        <button
          type="button"
          class="btn"
          ?disabled=${state.adminBotPhotoPolishBusy}
          @click=${() => props.onPolishPhoto?.()}
        >
          ${state.adminBotPhotoPolishBusy
            ? "Polishing..."
            : "Polish my current Slack photo with AI"}
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
                          <img
                            class="profile__upload-preview"
                            src=${variant.image_data_url}
                            alt=""
                          />
                          <div class="profile__form-actions">
                            <button
                              type="button"
                              class="btn btn--sm primary"
                              ?disabled=${state.adminBotPhotoApplyBusy || variant.id === selectedId}
                              @click=${() => props.onApplyPolishedPhoto?.(variant.id)}
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
// service generated for this member, so this list and the checklist itself can never drift. The
// section is named for them, not for the advice underneath: "Suggested for you" over a stack whose
// top half is a list of things somebody is waiting on read as optional, which they are not.
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
  // No GPU card. Cluster access is granted on the admin side, so a member could not act on this
  // one even when it was right -- and it was shown to anyone whose topics and notes did not happen
  // to contain the string "gpu", which is most of the lab. A suggestion nobody can complete is how
  // a stack that means "still outstanding" gets read past.
  if (blanks.has("personal_website") && !coveredByOnboarding.includes("website")) {
    otherSuggestions.push({
      id: "website",
      title: t("profile.suggestions.websiteTitle"),
      body: t("profile.suggestions.websiteBody"),
      label: t("profile.suggestions.websiteLink"),
      href: "https://github.com/akhkim/openclaw-adminbot-lab#member-pages",
    });
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
              <div class="profile__suggestions">${onboardingSuggestions.map(renderCard)}</div>
            </div>
          `
        : nothing}
      <div class="profile__suggestions-group">
        <h3 class="profile__suggestions-group-title">${t("profile.suggestions.other")}</h3>
        <div class="profile__suggestions">${otherSuggestions.map(renderCard)}</div>
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
          ${renderLinks(member)}
        </div>
        ${renderCompletionLedger(member, state)}
      </header>
      ${renderBasics(state, member, props)} ${renderPhotoCompliance(state, member, props)}
      ${renderBadgesSection(state, member)} ${renderBadgeSelfNomination(state, member, props)}
      ${renderSuggestions(state, member)}
    </div>
  `;
}
