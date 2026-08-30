// The Onboarding tab: pick who this is, type a name and email, fill what the template needs, read
// the email that is about to go out, edit it if it needs editing, and send it.
//
// The form is driven by the template's own `required` list rather than a fixed field set, so a
// template that gains a placeholder gains a field here with no edit.
//
// Preview is not an option here, it is the only way through: Send exists only once a preview of
// this exact form state is on screen, and any edit to the form takes it away again. This sends real
// mail and provisions a real Drive folder and Slack invite, none of which can be taken back, so an
// operator must have read the words before they leave. The preview is editable, and what they send
// is whatever is in the boxes -- the stored template is the starting draft, not the wire format.
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { renderMemberSheet } from "./member-sheet.ts";

export type OnboardingTemplateOption = {
  id: string;
  label: string;
  group: string;
  required: readonly string[];
};

// Grouped the way an admin thinks about it, not the way the matrix stores it. `required` mirrors
// the template's own list in extensions/adminbot/src/workflows/onboarding/emails.ts -- the service
// is the authority and refuses the send with the real list, so a stale entry here costs a field on
// the form, never a half-filled email.
export const ONBOARDING_TEMPLATE_OPTIONS: readonly OnboardingTemplateOption[] = [
  {
    id: "interview_invite",
    label: "Interview invite — 30 min with Zhijing",
    group: "Candidate",
    required: [],
  },
  {
    id: "interview_invite_theme_meeting",
    label: "Interview invite — themed meeting and Slack instead",
    group: "Candidate",
    required: [],
  },
  {
    id: "interview_invite_project_matching",
    label: "Interview invite — forwarded to a project lead",
    group: "Candidate",
    required: ["application_form_link", "task_recommendation"],
  },
  {
    id: "outreach_reply",
    label: "Cold outreach — point them at the form",
    group: "Candidate",
    required: ["application_form_link", "first_name"],
  },
  {
    id: "trial_phase",
    label: "Trial phase begins",
    group: "Candidate",
    required: ["first_name", "drive_folder_link"],
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
    id: "own_pace_advisee",
    label: "Own-pace advisee — access and setup",
    group: "Advisee",
    required: ["first_name", "drive_folder_link"],
  },
  {
    id: "own_pace_advisee_norms",
    label: "Own-pace advisee — communication and working norms",
    group: "Advisee",
    required: ["first_name", "drive_folder_link"],
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
    id: "alumni",
    label: "Alumni",
    group: "External collaborator",
    required: ["first_name", "slack_connect_link"],
  },
  {
    id: "coauthor_minor",
    label: "Coauthor, 5-10 h/week — access and setup",
    group: "External collaborator",
    required: ["first_name"],
  },
  {
    id: "coauthor_minor_norms",
    label: "Coauthor, 5-10 h/week — supervision and working norms",
    group: "External collaborator",
    required: [
      "first_name",
      "project_or_context",
      "contact_name",
      "team_lead_role",
      "recipient_role",
      "main_doers",
      "guidance_coauthors",
    ],
  },
  {
    id: "coauthor_major",
    label: "Coauthor, 20-40 h/week — access and setup",
    group: "External collaborator",
    required: [
      "first_name",
      "member_email",
      "portal_password",
      "drive_folder_link",
      "drive_guide_link",
    ],
  },
  {
    id: "coauthor_major_norms",
    label: "Coauthor, 20-40 h/week — supervision and working norms",
    group: "External collaborator",
    required: ["first_name", "project_or_context", "contact_name", "team_lead_role"],
  },
  {
    id: "disappearing_coauthor",
    label: "Intermittent coauthor — status check-in",
    group: "External collaborator",
    required: ["first_name", "project_or_context"],
  },
  {
    id: "disappearing_coauthor_paper",
    label: "Intermittent coauthor — unfinished paper",
    group: "External collaborator",
    required: ["first_name", "paper_short_title", "paper_title", "delegate_name", "reply_by_date"],
  },
  {
    id: "disappearing_coauthor_rec_letter",
    label: "Intermittent coauthor — recommendation letter declined",
    group: "External collaborator",
    required: ["first_name"],
  },
  {
    id: "external_prof_slack_connect",
    label: "Senior collaborator — Slack Connect invitation",
    group: "External collaborator",
    required: ["first_name", "project_or_context", "project_channel", "collaborator_names"],
  },
  {
    id: "external_prof_drive_folder",
    label: "Senior collaborator — project folder shared",
    group: "External collaborator",
    required: ["first_name", "project_or_context", "project_folder_link", "folder_contents"],
  },
  {
    id: "external_prof_records_check",
    label: "Senior collaborator — contact record check",
    group: "External collaborator",
    required: ["first_name", "record_name", "record_role", "record_email", "record_projects"],
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
// Derived from the name field and the lab's settings respectively. `dashboard_url` used to be
// listed here, which hid a field that nothing filled -- it is deployment configuration now.
const DERIVED = new Set(["first_name", "zhijing_whatsapp", "member_email"]);

const FIELD_LABELS: Record<string, string> = {
  project_or_context: "Project or context",
  contact_name: "Day-to-day contact",
  primary_contact: "Contact when Zhijing is busy",
  team_lead_role: "That person's role, as the email should say it",
  next_steps: "Immediate next steps",
  update_cadence: "Update cadence",
  update_due_date: "Next update due",
  meeting_cadence: "Meeting cadence and channel",
  meeting_arrangement: "Meetings they are invited to, as a sentence",
  meeting_channel: "Meeting channel",
  meeting_names: "Meetings they join",
  core_meetings: "Meetings attendance is expected at",
  deliverable: "Expected scope",
  timeline: "Rough timeline",
  project_channel: "Project channel",
  project_channel_or_meeting: "The one channel or meeting they join",
  project_folder_link: "Project Drive folder link",
  folder_contents: "What the folder holds",
  collaborator_names: "Who else is in the project channel",
  discussion_channel: "Discussion channel",
  drive_guide_link: "Google file common practice guide link",
  paper_short_title: "Paper short title",
  paper_title: "Paper title, in full",
  delegate_name: "Who takes the paper over",
  reply_by_date: "Reply-by date",
  record_name: "Name we hold",
  record_role: "Role we hold",
  record_email: "Preferred email we hold",
  record_projects: "Projects we have them on",
  sender_name: "Sending as",
  portal_password: "Portal password to send them",
  application_form_link: "Application form link",
  task_doc_link: "Starter task doc link",
  recipient_role: "Their role on the project",
  main_doers: "Who drives the day-to-day work",
  guidance_coauthors: "Who advises rather than implements",
};

export function onboardingFieldsFor(templateId: string): string[] {
  const option = ONBOARDING_TEMPLATE_OPTIONS.find((entry) => entry.id === templateId);
  return (option?.required ?? []).filter((token) => !GENERATED.has(token) && !DERIVED.has(token));
}

function labelFor(token: string): string {
  return FIELD_LABELS[token] ?? token.replaceAll("_", " ");
}

/**
 * Drops a preview that no longer describes the form.
 *
 * Called from every input on the page, because a preview of the previous name is worse than no
 * preview: it reads as confirmation of something that is no longer what Send would deliver. The
 * edited draft goes with it -- edits belong to the preview they were made on.
 */
function invalidatePreview(state: AppViewState): void {
  state.onboardingResult = null;
  state.onboardingDraftSubject = "";
  state.onboardingDraftBody = "";
  state.onboardingMissing = [];
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
          invalidatePreview(state);
        }}
      />
    </label>
  `;
}

/**
 * The preview, as the editable draft it is.
 *
 * Once sent it turns back into a record of what went out: editing a delivered email would only
 * suggest it could be recalled.
 */
function renderResult(state: AppViewState) {
  const result = state.onboardingResult;
  if (!result) {
    return nothing;
  }
  const sent = result.sent;
  const subject = sent ? result.subject : (state.onboardingDraftSubject ?? result.subject);
  const body = sent ? result.body : (state.onboardingDraftBody ?? result.body);
  return html`
    <div class="callout ${sent ? "success" : ""} adminbot-onboarding__result">
      <div class="adminbot-onboarding__result-title">
        ${sent ? "Sent" : "Preview — nothing sent yet. Edit anything below before sending."}
      </div>
      ${sent
        ? html`
            <div class="adminbot-onboarding__result-subject">
              <strong>Subject:</strong> ${result.subject}
            </div>
            <pre class="adminbot-onboarding__result-body mono">${result.body}</pre>
          `
        : html`
            <label class="adminbot-form__field">
              <span>Subject</span>
              <input
                name="draftSubject"
                data-testid="onboarding-draft-subject"
                .value=${subject}
                @input=${(event: Event) => {
                  state.onboardingDraftSubject = (event.target as HTMLInputElement).value;
                }}
              />
            </label>
            <label class="adminbot-form__field">
              <span>Message</span>
              <textarea
                name="draftBody"
                data-testid="onboarding-draft-body"
                rows="24"
                class="adminbot-onboarding__draft mono"
                .value=${body}
                @input=${(event: Event) => {
                  state.onboardingDraftBody = (event.target as HTMLTextAreaElement).value;
                }}
              ></textarea>
            </label>
            <p class="adminbot-form__hint">
              {drive_folder_link} and {slack_connect_link} are filled in with the real links when
              you send. Leave them where you want the links to appear; any other {placeholder} left
              in the text refuses the send.
            </p>
          `}
      ${result.drive_folder_link
        ? html`<div>
            Drive workspace: <a href=${result.drive_folder_link}>${result.drive_folder_link}</a>
          </div>`
        : nothing}
      ${result.slack_connect_link
        ? html`<div>Slack invite minted (expires in 14 days)</div>`
        : nothing}
      ${result.project_channel_invites?.length
        ? html`<div>
            Invited to ${result.project_channel_invites.map((invite) => invite.channel).join(", ")}
          </div>`
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
  // The full-member guide, whose copy tells the reader an account request is coming.
  const DCS_FORM_TEMPLATE_ID = "member";
  const groups = [...new Set(ONBOARDING_TEMPLATE_OPTIONS.map((entry) => entry.group))];
  const fields = onboardingFieldsFor(templateId);
  const busy = Boolean(state.onboardingBusy);
  // Send is reachable only from a preview of this exact form state, and never twice from one.
  const previewed = Boolean(state.onboardingResult && !state.onboardingResult.sent);

  return html`
    <section class="adminbot-onboarding">
      ${renderMemberSheet(state)}
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
              invalidatePreview(state);
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
              invalidatePreview(state);
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
              invalidatePreview(state);
            }}
          />
        </label>

        ${fields.map((token) => renderField(state, token))}

        <!-- Not a template placeholder: the copy says "your project channel", and this is what
             makes that true. Blank invites them nowhere, which is what every send did before. -->
        <label class="adminbot-form__field">
          <span>Project channels to invite them to</span>
          <input
            name="projectChannels"
            data-testid="onboarding-project-channels"
            placeholder="#proj-alg-circuit, #proj-causal-tutor"
            .value=${state.onboardingProjectChannels ?? ""}
            @input=${(event: Event) => {
              state.onboardingProjectChannels = (event.target as HTMLInputElement).value;
            }}
          />
        </label>

        <!-- Only on the guide that promises a CS account. Ticked by default because sending it is
             what files the request; an operator re-sending to someone who already has an account
             unticks it, which is the case that would otherwise file a duplicate. -->
        ${templateId === DCS_FORM_TEMPLATE_ID
          ? html`<label class="adminbot-form__field adminbot-form__field--inline">
              <input
                type="checkbox"
                name="submitDcsForm"
                data-testid="onboarding-submit-dcs-form"
                .checked=${state.onboardingSubmitDcsForm ?? true}
                @change=${(event: Event) => {
                  state.onboardingSubmitDcsForm = (event.target as HTMLInputElement).checked;
                }}
              />
              <span>Also request their CS account (DCS Slack-access form)</span>
            </label>`
          : nothing}

        <div class="adminbot-form__actions">
          <button class="btn ${previewed ? "" : "primary"}" type="submit" ?disabled=${busy}>
            ${previewed ? "Refresh preview" : "Preview"}
          </button>
          ${previewed
            ? html`<button
                class="btn primary"
                type="button"
                data-testid="onboarding-send"
                ?disabled=${busy}
                @click=${() => void state.sendOnboardingGuide?.({ preview: false })}
              >
                ${busy ? "Working…" : "Send this email"}
              </button>`
            : nothing}
        </div>
        <p class="adminbot-form__hint">
          ${previewed
            ? "Sending delivers exactly what is in the boxes above, invites them to any channels listed, and mints whatever the copy references. None of it can be undone from here."
            : "Preview first — the email is editable before it goes out, and Send appears once you have read it."}
        </p>
      </form>

      ${state.onboardingError
        ? html`<div class="callout danger" role="alert">${state.onboardingError}</div>`
        : nothing}
      ${renderMissing(state)} ${renderResult(state)}
    </section>
  `;
}
