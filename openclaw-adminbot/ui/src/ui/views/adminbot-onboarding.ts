// The Onboarding tab: pick who this is, type a name and email, fill what the template needs, and
// send them their guide.
//
// The form is driven by the template's own `required` list rather than a fixed field set, so a
// template that gains a placeholder gains a field here with no edit. Preview is the default
// affordance and Send is deliberately the second button: this sends real mail and provisions a
// real Drive folder and Slack invite, none of which can be taken back.
import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state.ts";

export type OnboardingTemplateOption = {
  id: string;
  label: string;
  group: string;
  required: readonly string[];
};

// Grouped the way an admin thinks about it, not the way the matrix stores it.
export const ONBOARDING_TEMPLATE_OPTIONS: readonly OnboardingTemplateOption[] = [
  {
    id: "interview_invite",
    label: "Interview invite",
    group: "Candidate",
    required: ["first_name"],
  },
  {
    id: "trial_phase",
    label: "Trial phase begins",
    group: "Candidate",
    required: ["first_name", "drive_folder_link", "slack_connect_link"],
  },
  { id: "rejection", label: "Interview rejection", group: "Candidate", required: ["first_name"] },
  {
    id: "member",
    label: "Full member — onboarding steps",
    group: "Member",
    required: ["first_name"],
  },
  {
    id: "member_what_to_expect",
    label: "Direct mentee — what to expect",
    group: "Member",
    required: ["zhijing_whatsapp"],
  },
  {
    id: "member_rejection",
    label: "Membership declined",
    group: "Member",
    required: ["first_name"],
  },
  {
    id: "interviewee",
    label: "After an interview",
    group: "External collaborator",
    required: [
      "first_name",
      "project_or_context",
      "sender_name",
      "drive_folder_link",
      "slack_connect_link",
    ],
  },
  {
    id: "slightly_better_than_emails",
    label: "Single project, minimal access",
    group: "External collaborator",
    required: [
      "first_name",
      "project_or_context",
      "project_channel_or_meeting",
      "contact_name",
      "deliverable",
      "timeline",
      "slack_connect_link",
    ],
  },
  {
    id: "acquaintance",
    label: "Acquaintance",
    group: "External collaborator",
    required: [
      "first_name",
      "project_or_context",
      "sender_name",
      "drive_folder_link",
      "slack_connect_link",
    ],
  },
  {
    id: "alumni",
    label: "Alumni",
    group: "External collaborator",
    required: ["first_name", "sender_name", "dashboard_url", "slack_connect_link"],
  },
  {
    id: "coauthor_minor",
    label: "Coauthor, 5-10 h/week",
    group: "External collaborator",
    required: [
      "first_name",
      "project_or_context",
      "meeting_cadence",
      "contact_name",
      "discussion_channel",
      "next_steps",
      "drive_folder_link",
      "slack_connect_link",
    ],
  },
  {
    id: "coauthor_major",
    label: "Coauthor, 20-40 h/week",
    group: "External collaborator",
    required: [
      "first_name",
      "project_or_context",
      "meeting_names",
      "core_meetings",
      "contact_name",
      "next_steps",
      "slack_connect_link",
    ],
  },
  {
    id: "disappearing_coauthor",
    label: "Intermittent coauthor",
    group: "External collaborator",
    required: ["first_name", "project_or_context", "sender_name", "slack_connect_link"],
  },
  {
    id: "external_prof",
    label: "Senior collaborator / professor",
    group: "External collaborator",
    required: [
      "first_name",
      "project_or_context",
      "update_cadence",
      "contact_name",
      "next_steps",
      "sender_name",
      "slack_connect_link",
    ],
  },
  {
    id: "collaboration_rhythm_reminder",
    label: "Rhythm reminder (mid-project)",
    group: "Other",
    required: ["first_name", "project_or_context", "update_due_date"],
  },
];

// Generated during the send, so the form never asks for them.
const GENERATED = new Set(["drive_folder_link", "slack_connect_link"]);
// Derived from the name field and the lab's settings respectively.
const DERIVED = new Set(["first_name", "zhijing_whatsapp", "dashboard_url"]);

const FIELD_LABELS: Record<string, string> = {
  project_or_context: "Project or context",
  contact_name: "Day-to-day contact",
  next_steps: "Immediate next steps",
  update_cadence: "Update cadence",
  update_due_date: "Next update due",
  meeting_cadence: "Meeting cadence and channel",
  meeting_names: "Meetings they join",
  core_meetings: "Meetings attendance is expected at",
  deliverable: "Expected scope",
  timeline: "Rough timeline",
  project_channel_or_meeting: "The one channel or meeting they join",
  discussion_channel: "Discussion channel",
  sender_name: "Sending as",
};

export function onboardingFieldsFor(templateId: string): string[] {
  const option = ONBOARDING_TEMPLATE_OPTIONS.find((entry) => entry.id === templateId);
  return (option?.required ?? []).filter((token) => !GENERATED.has(token) && !DERIVED.has(token));
}

function labelFor(token: string): string {
  return FIELD_LABELS[token] ?? token.replaceAll("_", " ");
}

function renderField(state: AppViewState, token: string) {
  return html`
    <label class="adminbot-form__field">
      <span>${labelFor(token)}</span>
      <input
        name=${token}
        .value=${state.onboardingValues?.[token] ?? ""}
        @input=${(event: Event) => {
          const target = event.target as HTMLInputElement;
          state.onboardingValues = { ...state.onboardingValues, [token]: target.value };
        }}
      />
    </label>
  `;
}

function renderResult(state: AppViewState) {
  const result = state.onboardingResult;
  if (!result) {
    return nothing;
  }
  return html`
    <div class="callout ${result.sent ? "success" : ""} adminbot-onboarding__result">
      <div class="adminbot-onboarding__result-title">
        ${result.sent ? "Sent" : "Preview — nothing sent yet"}
      </div>
      <div class="adminbot-onboarding__result-subject">
        <strong>Subject:</strong> ${result.subject}
      </div>
      <pre class="adminbot-onboarding__result-body mono">${result.body}</pre>
      ${result.drive_folder_link
        ? html`<div>
            Drive workspace: <a href=${result.drive_folder_link}>${result.drive_folder_link}</a>
          </div>`
        : nothing}
      ${result.slack_connect_link
        ? html`<div>Slack invite minted (expires in 14 days)</div>`
        : nothing}
    </div>
  `;
}

function renderMissing(state: AppViewState) {
  const missing = state.onboardingMissing ?? [];
  if (missing.length === 0) {
    return nothing;
  }
  return html`
    <div class="callout danger" role="alert">
      <div>Not sent — these are still needed:</div>
      <ul>
        ${missing.map((token) => html`<li>${labelFor(token)}</li>`)}
      </ul>
    </div>
  `;
}

export function renderAdminBotOnboarding(state: AppViewState) {
  const templateId = state.onboardingTemplateId ?? ONBOARDING_TEMPLATE_OPTIONS[0].id;
  const groups = [...new Set(ONBOARDING_TEMPLATE_OPTIONS.map((entry) => entry.group))];
  const fields = onboardingFieldsFor(templateId);
  const busy = Boolean(state.onboardingBusy);

  return html`
    <section class="adminbot-onboarding">
      <form
        class="adminbot-form"
        @submit=${(event: Event) => {
          event.preventDefault();
          void state.sendOnboardingGuide?.({ preview: true });
        }}
      >
        <label class="adminbot-form__field">
          <span>Who is this for</span>
          <select
            name="templateId"
            @change=${(event: Event) => {
              state.onboardingTemplateId = (event.target as HTMLSelectElement).value;
              state.onboardingResult = null;
              state.onboardingMissing = [];
            }}
          >
            ${groups.map(
              (group) => html`
                <optgroup label=${group}>
                  ${ONBOARDING_TEMPLATE_OPTIONS.filter((entry) => entry.group === group).map(
                    (entry) => html`
                      <option value=${entry.id} ?selected=${entry.id === templateId}>
                        ${entry.label}
                      </option>
                    `,
                  )}
                </optgroup>
              `,
            )}
          </select>
        </label>

        <label class="adminbot-form__field">
          <span>Full name</span>
          <input
            name="name"
            .value=${state.onboardingName ?? ""}
            @input=${(event: Event) => {
              state.onboardingName = (event.target as HTMLInputElement).value;
            }}
          />
        </label>

        <label class="adminbot-form__field">
          <span>Email</span>
          <input
            name="email"
            type="email"
            .value=${state.onboardingEmail ?? ""}
            @input=${(event: Event) => {
              state.onboardingEmail = (event.target as HTMLInputElement).value;
            }}
          />
        </label>

        ${fields.map((token) => renderField(state, token))}

        <div class="adminbot-form__actions">
          <button class="btn" type="submit" ?disabled=${busy}>Preview</button>
          <button
            class="btn primary"
            type="button"
            ?disabled=${busy}
            @click=${() => void state.sendOnboardingGuide?.({ preview: false })}
          >
            ${busy ? "Working…" : "Send"}
          </button>
        </div>
        <p class="adminbot-form__hint">
          Sending mints a Slack Connect invite and copies the Drive workspace. Neither can be undone
          from here.
        </p>
      </form>

      ${state.onboardingError
        ? html`<div class="callout danger" role="alert">${state.onboardingError}</div>`
        : nothing}
      ${renderMissing(state)} ${renderResult(state)}
    </section>
  `;
}
