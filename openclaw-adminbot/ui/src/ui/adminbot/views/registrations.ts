// Control UI view renders the admin "Member requests" approval queue.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
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
// signup form collects, skipping blanks so a sparse request stays readable.
const SIGNUP_FIELDS: Array<[string, string]> = [
  ["affiliation", "adminbotRegistrations.field.affiliation"],
  ["research_branch", "adminbotRegistrations.field.researchBranch"],
  ["research_topics", "adminbotRegistrations.field.researchTopics"],
  ["location", "adminbotRegistrations.field.location"],
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
    <div class="card adminbot-card adminbot-card--wide">
      <div class="card-title">${t("adminbotRegistrations.empty.title")}</div>
      <div class="card-sub">${t(errorSummaryKey(error))}</div>
      ${retryable
        ? html`<div class="adminbot-form__actions">
            <button class="btn btn--sm" type="button" @click=${props.onRefresh}>
              ${t("adminbotRegistrations.retry")}
            </button>
          </div>`
        : nothing}
    </div>
  `;
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
    ${fields.length
      ? html`<dl class="adminbot-registration__fields">
          ${fields.map(
            ([label, value]) => html`<div class="adminbot-registration__field">
              <dt>${label}</dt>
              <dd>${value}</dd>
            </div>`,
          )}
        </dl>`
      : nothing}
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
    <li class="card adminbot-card adminbot-card--wide adminbot-registration">
      <div class="adminbot-registration__head">
        <span class="pill">${kindLabel}</span>
        <span class="adminbot-form__meta">
          ${t("adminbotRegistrations.submitted")}: ${submittedAt(registration.created_at)}
        </span>
      </div>
      ${registration.kind === "claim"
        ? renderClaimDetails(registration)
        : renderSignupDetails(registration)}
      <div class="adminbot-form__meta">${registration.email}</div>
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
    </li>
  `;
}

export function renderAdminBotRegistrations(props: AdminBotRegistrationsProps) {
  if (props.loading && props.registrations.length === 0) {
    return html`<section class="adminbot-shell">
      <div class="card adminbot-card adminbot-card--wide">
        <div class="adminbot-form__meta">${t("adminbotRegistrations.loading")}</div>
      </div>
    </section>`;
  }
  if (props.error) {
    return html`<section class="adminbot-shell">${renderErrorState(props, props.error)}</section>`;
  }
  return html`
    <section class="adminbot-shell">
      <div class="card adminbot-card adminbot-card--wide">
        <div class="card-title">${t("adminbotRegistrations.title")}</div>
        <div class="card-sub">${t("adminbotRegistrations.sub")}</div>
        ${props.notice
          ? html`<div
              class="callout ${props.notice.kind === "error" ? "danger" : "success"}"
              role="status"
            >
              ${props.notice.text}
            </div>`
          : nothing}
        <div class="adminbot-form__actions">
          <button
            class="btn btn--sm"
            type="button"
            ?disabled=${props.loading}
            @click=${props.onRefresh}
          >
            ${t("adminbotRegistrations.refresh")}
          </button>
        </div>
      </div>
      ${props.registrations.length === 0
        ? html`<div class="card adminbot-card adminbot-card--wide">
            <div class="adminbot-form__meta">${t("adminbotRegistrations.empty.none")}</div>
          </div>`
        : html`<ul class="adminbot-registrations">
            ${props.registrations.map((registration) => renderRegistration(props, registration))}
          </ul>`}
    </section>
  `;
}
