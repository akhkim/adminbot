// The requester's "my letter went in" answer, and how the record of it reads.
//
// A professor often submits a letter straight to the school and never comes back to mark it, so
// the student, who hears from the school, can settle the request themselves. These helpers decide
// when that answer is on offer and how the confirmation is shown afterwards; the service enforces
// the same rules, so a button drawn here by mistake is refused, never obeyed.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import type { LogisticsRequest } from "../api/logistics.ts";

/** A letter request still open past its typed deadline. */
export function isLetterOverdue(request: LogisticsRequest, now: Date = new Date()): boolean {
  if (request.kind !== "recommendation_letters" || !request.deadline_at) {
    return false;
  }
  const at = Date.parse(request.deadline_at);
  return Number.isFinite(at) && now.getTime() > at && isOpen(request);
}

/** The requester may say their own open letter request went in. */
export function canConfirmLetter(
  request: LogisticsRequest,
  viewerMemberId: string | null,
): boolean {
  return (
    request.kind === "recommendation_letters" &&
    viewerMemberId !== null &&
    request.member_id === viewerMemberId &&
    isOpen(request)
  );
}

/** Only the student's own confirmation can be taken back; an admin's answer is the admin's. */
export function canUndoLetterConfirmation(
  request: LogisticsRequest,
  viewerMemberId: string | null,
): boolean {
  return (
    request.kind === "recommendation_letters" &&
    request.status === "completed" &&
    viewerMemberId !== null &&
    request.confirmed_by === viewerMemberId &&
    (request.confirmed_via === "member" || request.confirmed_via === "member_after_reminder")
  );
}

/** "Submitted, confirmed by Ada Lovelace on Dec 10, 2026", or "" when nobody is on record. */
export function letterConfirmationText(request: LogisticsRequest): string {
  if (request.status !== "completed" || !request.confirmed_at || !request.confirmed_via) {
    return "";
  }
  const name = request.confirmed_by_name || request.confirmed_by || "";
  const date = formatDate(request.confirmed_at);
  switch (request.confirmed_via) {
    case "member_after_reminder":
      return t("logistics.requests.letterConfirm.byMemberAfterReminder", { name, date });
    case "member":
      return t("logistics.requests.letterConfirm.byMember", { name, date });
    case "admin":
      return t("logistics.requests.letterConfirm.byAdmin", { name, date });
  }
  return "";
}

export function renderLetterConfirmation(request: LogisticsRequest) {
  const text = letterConfirmationText(request);
  return text
    ? html`<span class="logistics-confirmation muted" data-testid="letter-confirmation"
        >${text}</span
      >`
    : nothing;
}

function isOpen(request: LogisticsRequest): boolean {
  return request.status === "submitted" || request.status === "in_progress";
}

function formatDate(instant: string): string {
  const parsed = new Date(instant);
  return Number.isNaN(parsed.getTime())
    ? instant
    : parsed.toLocaleDateString([], { dateStyle: "medium" });
}
