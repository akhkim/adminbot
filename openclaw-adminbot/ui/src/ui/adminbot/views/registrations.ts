// Control UI view renders the admin "Member requests" approval queue.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import { renderSkeleton } from "../../loading/skeleton.ts";
import type { MemberRegistration } from "../auth/session.ts";
import type { RegistrationDecision, RegistrationsLoadError } from "../data/registrations.ts";

export type AdminBotRegistrationsProps = {
  registrations: MemberRegistration[];
  loading: boolean;
  error: RegistrationsLoadError | null;
  busyId: string | null;
  notice: { kind: "success" | "error"; text: string } | null;
  onDecide: (registrationId: string, decision: RegistrationDecision) => void;
  onRefresh: () => void;
};

// Signup applicants submit a free-form profile; surface the fields the AdminBot
// signup form collects, skipping blanks so a sparse request stays readable. Resident location is
// the exception and is rendered apart from this list: see renderResidentLocation.
const SIGNUP_FIELDS: Array<[string, string]> = [
  ["affiliation", "adminbotRegistrations.field.affiliation"],
  ["research_branch", "adminbotRegistrations.field.researchBranch"],
  ["research_topics", "adminbotRegistrations.field.researchTopics"],
  ["timezone", "adminbotRegistrations.field.timezone"],
  ["personal_website", "adminbotRegistrations.field.website"],
  ["notes", "adminbotRegistrations.field.notes"],
];

// Signup profiles are applicant-supplied JSON, so only primitives (and lists of
// them) are renderable; anything else is dropped rather than shown as [object Object].
function scalarText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  return typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

function profileText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(scalarText).filter(Boolean).join(", ");
  }
  return scalarText(value);
}

function submittedAt(createdAt: string): string {
  const parsed = new Date(createdAt);
  return Number.isNaN(parsed.getTime()) ? createdAt : parsed.toLocaleString();
}

function errorSummaryKey(error: RegistrationsLoadError): string {
  switch (error) {
    case "unreachable":
      return "adminbotRegistrations.empty.unreachable";
    case "expired":
      return "adminbotRegistrations.empty.expired";
    case "forbidden":
      return "adminbotRegistrations.empty.forbidden";
    case "failed":
      return "adminbotRegistrations.empty.failed";
    default:
      return "adminbotRegistrations.empty.noSession";
  }
}

function renderErrorState(props: AdminBotRegistrationsProps, error: RegistrationsLoadError) {
  const retryable = error === "unreachable" || error === "failed";
  return html`
    <p class="adminbot-registrations__status muted">
      ${t(errorSummaryKey(error))}
      ${retryable
        ? html`<button class="btn btn--sm btn--ghost" type="button" @click=${props.onRefresh}>
            ${t("adminbotRegistrations.retry")}
          </button>`
        : nothing}
    </p>
  `;
}

/**
 * Where the person lives, always shown and always first.
 *
 * The approver decides membership tier and which city's lunches and channels someone joins on
 * this, so a missing answer has to be visible as missing. The field is optional on the signup form
 * and absent from many roster records; skipping the row when blank, as the other fields do, left
 * the approver unable to tell "not given" from "not shown here".
 */
function renderResidentLocation(location: string) {
  return html`<div class="adminbot-registration__field">
    <dt>${t("adminbotRegistrations.field.location")}</dt>
    <dd>
      ${location ||
      html`<span class="adminbot-form__meta"
        >${t("adminbotRegistrations.field.locationMissing")}</span
      >`}
    </dd>
  </div>`;
}

function renderClaimDetails(registration: MemberRegistration) {
  const memberLabel =
    registration.member_name ?? registration.member_id ?? t("adminbotRegistrations.rosterMember");
  return html`
    <div class="adminbot-registration__member">${memberLabel}</div>
    ${registration.member_id
      ? html`<div class="adminbot-form__meta">
          ${t("adminbotRegistrations.field.memberId")}: ${registration.member_id}
        </div>`
      : nothing}
    ${
      // An older service does not send the field at all; say nothing rather than "Not provided".
      registration.member_location === undefined
        ? nothing
        : html`<dl class="adminbot-registration__fields">
            ${renderResidentLocation(registration.member_location.trim())}
          </dl>`
    }
  `;
}

function renderSignupDetails(registration: MemberRegistration) {
  const profile = registration.profile ?? {};
  const name = profileText(profile.name);
  const fields = SIGNUP_FIELDS.map(
    ([key, labelKey]) => [t(labelKey), profileText(profile[key])] as const,
  ).filter(([, value]) => value);
  return html`
    <div class="adminbot-registration__member">
      ${name || t("adminbotRegistrations.unnamedApplicant")}
    </div>
    <dl class="adminbot-registration__fields">
      ${renderResidentLocation(profileText(profile.location))}
      ${fields.map(
        ([label, value]) => html`<div class="adminbot-registration__field">
          <dt>${label}</dt>
          <dd>${value}</dd>
        </div>`,
      )}
    </dl>
  `;
}

function renderRegistration(props: AdminBotRegistrationsProps, registration: MemberRegistration) {
  // Any in-flight decision disables the whole queue: approving mints a member and
  // the list refetches right after, so a second click would race a stale row.
  const busy = props.busyId !== null;
  const kindLabel =
    registration.kind === "claim"
      ? t("adminbotRegistrations.kind.claim")
      : t("adminbotRegistrations.kind.signup");
  return html`
    <li class="adminbot-registration">
      <div class="adminbot-registration__head">
        <span class="ab-chip">${kindLabel}</span>
        <span class="adminbot-form__meta ab-num">
          ${t("adminbotRegistrations.submitted")}: ${submittedAt(registration.created_at)}
        </span>
      </div>
      ${registration.kind === "claim"
        ? renderClaimDetails(registration)
        : renderSignupDetails(registration)}
      <div class="adminbot-registration__email">${registration.email}</div>
      ${registration.can_decide === false
        ? html`<div class="adminbot-form__meta">${t("adminbotRegistrations.piOnly")}</div>`
        : renderDecisionButtons(props, registration, busy)}
    </li>
  `;
}

// Undefined `can_decide` is an older service that still let any admin decide; the service is the
// gate either way and answers a non-PI's click with a 403.
function renderDecisionButtons(
  props: AdminBotRegistrationsProps,
  registration: MemberRegistration,
  busy: boolean,
) {
  return html`
    <div class="adminbot-form__actions">
      <button
        class="btn primary"
        type="button"
        ?disabled=${busy}
        aria-busy=${props.busyId === registration.id}
        @click=${() => props.onDecide(registration.id, "approve")}
      >
        ${t("adminbotRegistrations.approve")}
      </button>
      <button
        class="btn danger"
        type="button"
        ?disabled=${busy}
        @click=${() => props.onDecide(registration.id, "reject")}
      >
        ${t("adminbotRegistrations.reject")}
      </button>
    </div>
  `;
}

export function renderAdminBotRegistrations(props: AdminBotRegistrationsProps) {
  if (props.loading && props.registrations.length === 0) {
    return html`<section class="adminbot-shell">
      ${renderSkeleton({
        count: 4,
        label: t("adminbotRegistrations.loading"),
        testId: "registrations-loading",
      })}
    </section>`;
  }
  if (props.error) {
    return html`<section class="adminbot-shell">${renderErrorState(props, props.error)}</section>`;
  }
  return html`
    <section class="adminbot-shell adminbot-registrations-page">
      ${props.notice
        ? html`<div
            class="callout ${props.notice.kind === "error" ? "danger" : "success"}"
            role="status"
          >
            ${props.notice.text}
          </div>`
        : nothing}
      ${props.registrations.length === 0
        ? html`<p class="adminbot-registrations__status muted">
            ${t("adminbotRegistrations.empty.none")}
          </p>`
        : html`<ul class="adminbot-registrations">
            ${props.registrations.map((registration) => renderRegistration(props, registration))}
          </ul>`}
    </section>
  `;
}
