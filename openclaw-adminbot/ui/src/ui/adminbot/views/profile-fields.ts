// What the profile page knows about a member's fields, without the page itself: labels, which
// fields are still blank, and the dashboard's focus hand-off. The dashboard, Getting Started and
// My Projects read these on the first screen; keeping them here lets the profile page load lazily.

import { t } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import type { LabMember } from "../auth/session.ts";
import { isOptionalMemberField, PROFILE_FIELDS, type ProfileField } from "../member-fields.ts";

type EditableField = ProfileField;

export const EDITABLE_FIELDS: ProfileField[] = [
  ...PROFILE_FIELDS,
  {
    key: "arr_reviewer_qualified",
    labelKey: "profile.arrReviewer.label",
    example: "",
    type: "dropdown",
    group: "work",
  },
  {
    key: "arr_review_capacity",
    labelKey: "profile.arrReviewer.capacity",
    example: "",
    type: "numeric",
    min: 0,
    group: "work",
  },
];

// There is no read-only "Account" group any more. It held one row -- the directory email -- which
// the hero already prints under the member's name, so the group was a second copy of a fact three
// lines above it, under a heading whose only content was that copy. Status and privilege level had
// already gone the same way: governance bookkeeping a member has no action to take on.
const FIELD_LABEL_KEYS: Record<string, string> = {
  email: "profile.fields.email",
  ...Object.fromEntries(PROFILE_FIELDS.map((field) => [field.key, field.labelKey])),
};

/** The on-screen name of a field, for surfaces outside this page that list fields by key. */
export function fieldLabel(key: string): string {
  return t(FIELD_LABEL_KEYS[key] ?? key);
}

export function findOwnMember(state: AppViewState): LabMember | null {
  const memberId = state.memberId;
  if (!memberId) {
    return null;
  }
  const member = (state.adminBotData?.members ?? []).find((entry) => entry.id === memberId);
  return (member as unknown as LabMember | undefined) ?? null;
}

export function valueOf(member: LabMember, field: EditableField): string {
  const raw = member[field.key];
  if (field.type === "list") {
    return Array.isArray(raw) ? raw.filter(Boolean).join(", ") : "";
  }
  return raw === null || raw === undefined ? "" : String(raw);
}

// What the lab is still waiting on *from this member*. Admin-owned fields are required of the
// record but not answerable here, so they stay out of the blanks list, the dashboard card that
// chases it, and the denominator below -- otherwise the ledger could never reach complete and the
// card would name a field whose control is disabled.
export function isMemberAnswerable(field: EditableField): boolean {
  return !isOptionalMemberField(field) && !field.adminOnly;
}

export function blankFields(member: LabMember): EditableField[] {
  return EDITABLE_FIELDS.filter(
    (field) =>
      isMemberAnswerable(field) &&
      !(field.key === "arr_review_capacity" && member.arr_reviewer_qualified !== true) &&
      !(field.key === "intake_form_url" && member.intake_form_unavailable === true) &&
      !valueOf(member, field).trim(),
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

/** Reads and clears the hand-off, so exactly one render consumes it. */
export function takePendingFieldFocus(): string | null {
  const key = pendingFocusFieldKey;
  pendingFocusFieldKey = null;
  return key;
}
