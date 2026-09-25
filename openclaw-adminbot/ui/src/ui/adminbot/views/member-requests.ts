/**
 * Member requests on the Lab Members tab: a non-admin's Add member form, which files a request
 * instead of writing the roster, and the list of requests -- every pending one for an admin to
 * decide, or the viewer's own for anyone else.
 */
import { html, nothing } from "lit";
import { adminBotMemberTypes } from "../../../../../extensions/adminbot/src/contracts/actions.js";
import { formatRelativeTimestamp } from "../../format.ts";
import type { MemberRequestInput, MemberRequestView } from "../auth/session.ts";
import type { AdminBotMemberRequestsState } from "../controllers/member-requests.ts";
import { multiSelectOptionsFor, renderMultiSelectField } from "../multi-select-field.ts";

export type MemberRequestsProps = {
  isAdmin: boolean;
  state: AdminBotMemberRequestsState | undefined;
  onSubmit?: (input: MemberRequestInput) => Promise<boolean>;
  onApprove?: (request: MemberRequestView, options: { onboard: boolean }) => void;
  onReject?: (request: MemberRequestView, note: string) => void;
  onWithdraw?: (request: MemberRequestView) => void;
};

export const MEMBER_REQUEST_POPOVER_ID = "adminbot-request-member";

function when(iso: string | undefined): string {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) ? formatRelativeTimestamp(ms) : "";
}

function text(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value.trim() : "";
}

async function submitRequest(event: Event, props: MemberRequestsProps): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement) || !props.onSubmit) {
    return;
  }
  const data = new FormData(form);
  const memberType = data
    .getAll("memberType")
    .map((value) => String(value).trim())
    .filter(Boolean)
    .join(", ");
  const optional = {
    member_type: memberType,
    affiliation: text(data, "affiliation"),
    research_topics: text(data, "research_topics"),
    personal_website: text(data, "personal_website"),
    note: text(data, "note"),
  };
  const sent = await props.onSubmit({
    name: text(data, "name"),
    email: text(data, "email"),
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== "")),
  });
  // Kept on a refusal so a duplicate or a typo can be fixed without typing the person in again.
  if (sent) {
    form.reset();
    form.closest<HTMLElement>("[popover]")?.hidePopover();
  }
}

/**
 * The Add member form a non-admin sees. Short on purpose: who the person is and why they belong
 * here. Access, contact consent and the calendar are the admin's to set, and the admin's own
 * editor has every other field once the record exists.
 */
export function renderMemberRequestForm(props: MemberRequestsProps) {
  if (props.isAdmin || !props.onSubmit) {
    return nothing;
  }
  return html`<article
    class="adminbot-editor-card adminbot-popover"
    id=${MEMBER_REQUEST_POPOVER_ID}
    popover
    data-testid="member-request-form"
  >
    <button
      class="btn btn--sm adminbot-popover__close"
      type="button"
      popovertarget=${MEMBER_REQUEST_POPOVER_ID}
      popovertargetaction="hide"
    >
      Close
    </button>
    <div class="card-title">Add member</div>
    <div class="card-sub">
      An admin reviews this before they are added to the roster. Nothing is sent to them until then.
    </div>
    <form class="adminbot-form" @submit=${(event: Event) => void submitRequest(event, props)}>
      <div class="form-grid adminbot-form__grid">
        <label class="adminbot-form__field"
          ><span>Name</span><input name="name" required placeholder="Ada Lovelace"
        /></label>
        <label class="adminbot-form__field"
          ><span>Email</span
          ><input name="email" type="email" required placeholder="ada@example.org"
        /></label>
        <div class="adminbot-form__field">
          <span>Member type</span>
          ${renderMultiSelectField({
            name: "memberType",
            label: "Member type",
            placeholder: "Not sure",
            options: multiSelectOptionsFor(adminBotMemberTypes, []),
            selected: new Set<string>(),
            rootClass: "adminbot-form__multi",
            optionClass: "adminbot-form__multi-option",
            testId: "member-request-member-type",
          })}
          <small>Your best guess. The admin who approves confirms it, since it sets access.</small>
        </div>
        <label class="adminbot-form__field"
          ><span>Affiliation</span><input name="affiliation" placeholder="University, company"
        /></label>
        <label class="adminbot-form__field"
          ><span>Research topics</span><input name="research_topics"
        /></label>
        <label class="adminbot-form__field"
          ><span>Website</span><input name="personal_website" type="url" placeholder="https://"
        /></label>
        <label class="adminbot-form__field adminbot-form__field--wide"
          ><span>Note for the admins</span
          ><textarea
            name="note"
            rows="3"
            placeholder="How they are joining the lab, who they work with"
          ></textarea>
        </label>
      </div>
      <div class="adminbot-form__actions">
        <button class="btn btn--sm primary" type="submit">Send for review</button>
      </div>
    </form>
  </article>`;
}

function renderProfileLine(request: MemberRequestView) {
  const { profile } = request;
  const details = [profile.member_type, profile.affiliation, profile.research_topics].filter(
    Boolean,
  );
  return html`<div>
      <strong>${profile.name}</strong>
      <span class="muted">&lt;${profile.email}&gt;</span>
    </div>
    ${details.length ? html`<div class="muted">${details.join(" · ")}</div>` : nothing}
    ${profile.personal_website
      ? html`<div>
          <a href=${profile.personal_website} target="_blank" rel="noreferrer noopener"
            >${profile.personal_website}</a
          >
        </div>`
      : nothing}
    ${request.note ? html`<p class="adminbot-member-request__note">${request.note}</p>` : nothing}`;
}

/**
 * Read at click time from the card's own controls. Held in closure variables instead, a repaint
 * between typing a reason and pressing Decline would reset them while the input still showed the
 * text -- and the decline would go out without it.
 */
function readControls(event: Event): { onboard: boolean; reason: string } {
  const card = (event.currentTarget as Element | null)?.closest(".adminbot-member-request");
  const onboard = card?.querySelector<HTMLInputElement>('input[name="onboard"]');
  const reason = card?.querySelector<HTMLInputElement>('input[name="reason"]');
  return { onboard: onboard?.checked ?? true, reason: reason?.value ?? "" };
}

function renderAdminRequest(request: MemberRequestView, props: MemberRequestsProps) {
  const busy = props.state?.busyId === request.id;
  const grantsAdmin = request.access_level === "admin";
  return html`<li class="adminbot-member-request" data-testid="member-request">
    ${renderProfileLine(request)}
    <div class="muted">
      Requested by ${request.requested_by_name ?? request.requested_by} ${when(request.created_at)}.
      Approving grants
      <strong>${(request.access_level ?? "external_collaborator").replaceAll("_", " ")}</strong>
      access.
    </div>
    ${grantsAdmin
      ? html`<p class="callout danger" role="alert">
          The requested Member Type makes them an AdminBot admin. Check that is intended.
        </p>`
      : nothing}
    <div class="adminbot-form__actions">
      <label class="adminbot-form__field--check">
        <input type="checkbox" name="onboard" checked />
        <span>Start their onboarding</span>
      </label>
      <button
        class="btn btn--sm primary"
        type="button"
        ?disabled=${busy}
        data-testid="member-request-approve"
        @click=${(event: Event) =>
          props.onApprove?.(request, { onboard: readControls(event).onboard })}
      >
        Approve
      </button>
      <input
        class="adminbot-member-request__reason"
        placeholder="Reason (optional, shown to them)"
        name="reason"
        aria-label="Reason for declining"
      />
      <button
        class="btn btn--sm"
        type="button"
        ?disabled=${busy}
        data-testid="member-request-reject"
        @click=${(event: Event) => props.onReject?.(request, readControls(event).reason)}
      >
        Decline
      </button>
    </div>
  </li>`;
}

const STATUS_LABEL: Record<MemberRequestView["status"], string> = {
  pending: "Waiting for an admin",
  approved: "Added to the roster",
  rejected: "Declined",
};

function renderOwnRequest(request: MemberRequestView, props: MemberRequestsProps) {
  return html`<li class="adminbot-member-request" data-testid="member-request">
    ${renderProfileLine(request)}
    <div class="muted">
      ${STATUS_LABEL[request.status]}
      ${request.status === "pending" ? when(request.created_at) : when(request.decided_at)}
    </div>
    ${request.decision_note
      ? html`<p class="adminbot-member-request__note">${request.decision_note}</p>`
      : nothing}
    ${request.status === "pending"
      ? html`<div class="adminbot-form__actions">
          <button
            class="btn btn--sm"
            type="button"
            ?disabled=${props.state?.busyId === request.id}
            @click=${() => props.onWithdraw?.(request)}
          >
            Withdraw
          </button>
        </div>`
      : nothing}
  </li>`;
}

/**
 * The requests section above the roster. An admin sees what is waiting on them and nothing when
 * nothing is; anyone else sees their own requests and what became of them.
 */
export function renderMemberRequests(props: MemberRequestsProps) {
  const state = props.state;
  if (!state) {
    return nothing;
  }
  const requests = props.isAdmin
    ? state.requests.filter((request) => request.status === "pending")
    : state.requests;
  if (requests.length === 0 && !state.error) {
    return nothing;
  }
  return html`<section
    class="adminbot-card adminbot-member-requests-panel"
    data-testid="member-requests"
  >
    <div class="card-title">
      ${props.isAdmin ? `Member requests waiting for review (${requests.length})` : "Your requests"}
    </div>
    <p class="card-sub">
      ${props.isAdmin
        ? "Members who are not admins proposed these people. Approving adds them exactly as your own Add member would."
        : "People you asked to add. They join the roster once an admin approves."}
    </p>
    ${state.error ? html`<p role="alert">${state.error}</p>` : nothing}
    <ul class="adminbot-member-requests">
      ${requests.map((request) =>
        props.isAdmin ? renderAdminRequest(request, props) : renderOwnRequest(request, props),
      )}
    </ul>
  </section>`;
}
