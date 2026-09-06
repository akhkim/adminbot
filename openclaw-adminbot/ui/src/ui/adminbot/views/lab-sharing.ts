import "./lab-sharing-member-search.ts";
import "./lab-sharing-directory.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";
// Lab Sharing tab: five panels --
//   1. Director status strip (availability, timezone, progress, a way to flag a blocker)
//   2. Seek help -- pick a project, describe what's needed, tag it, then post a general call or
//      search members to invite
//   3. Your invites -- collaboration invites sent to you, respond to the owner
//   4. Your requests -- help calls you sent out, deletable
//   5. Open projects -- a wrap-around deck of projects looking for hands
//   6. Announcements -- a lab-wide comms feed with an in-page compose dialog
//
// FRONTEND-ONLY for now: all data below is mock/static. Search `MOCK` for every spot that needs
// wiring to real state/controllers once the backend exists. State lives on AppViewState under the
// `labSharing*` fields (see the bottom of this file for the shape expected there) -- add those
// fields to AppViewState the same way onboarding/profile fields were added.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";

// ---------------------------------------------------------------------------
// Types (shape guesses -- adjust once a real API contract exists)
// ---------------------------------------------------------------------------

type DirectorStatus = {
  name: string;
  availability: "available" | "busy" | "away";
  timezone: string;
  localTime: string;
  progressLabel: string;
  progressPercent: number;
};

type LabMemberSummary = {
  id: string;
  name: string;
  role: string;
  projects: string[];
  interests: string[];
};

type OwnedProject = {
  id: string;
  title: string;
  tags: string[];
};

type OpenProject = {
  id: string;
  title: string;
  owner: string;
  summary: string;
  tags: string[];
  membersNeeded: number;
  hoursPerWeek: number;
};

type CollabInvite = {
  id: string;
  fromName: string;
  projectId: string;
  note: string;
  receivedAt: string;
};

type HelpRequest = {
  id: string;
  projectId: string;
  comment: string;
  members: number;
  hours: number;
  tags: string[];
  sentAt: string;
};

type Announcement = {
  id: string;
  authorName: string;
  body: string;
  postedAt: string;
};

// ---------------------------------------------------------------------------
// MOCK DATA -- replace with real fetch/state once backend exists
// ---------------------------------------------------------------------------

const MOCK_DIRECTOR: DirectorStatus = {
  name: "Zhijing Jin",
  availability: "available",
  timezone: "America/Toronto",
  localTime: "2:14 PM",
  progressLabel: "Q3 paper deadlines",
  progressPercent: 62,
};

// Projects the current member owns/leads -- populates the "which project" picker in Seek Help.
const MOCK_OWNED_PROJECTS: OwnedProject[] = [
  { id: "proj-adminbot", title: "AdminBot", tags: ["general tools"] },
  { id: "proj-scm", title: "Causal Tutor", tags: ["visualization", "causality"] },
];

// The fixed tag vocabulary for the frontend prototype -- swap for a real managed tag list later.
const AVAILABLE_TAGS = [
  "causality",
  "multi-agent",
  "writing",
  "QA",
  "UI/UX feedback",
  "data collection",
  "visualization",
  "reasoning",
  "alignment",
  "annotation",
];

const MOCK_MEMBERS: LabMemberSummary[] = [
  {
    id: "m1",
    name: "Ada Lovelace",
    role: "External Collaborator",
    projects: ["AdminBot", "Causal Tutor"],
    interests: ["reasoning", "alignment"],
  },
];

const MOCK_OPEN_PROJECTS: OpenProject[] = [
  {
    id: "p1",
    title: "AdminBot",
    owner: "Ada Lovelace",
    summary: "Need a second set of eyes labeling ~400  traces for error type.",
    tags: ["annotators", "general tools"],
    membersNeeded: 2,
    hoursPerWeek: 3,
  },
  {
    id: "p2",
    title: "Causal Tutor",
    owner: "Ada Lovelace",
    summary: "Click through the SCM playground and file bugs on anything that feels off.",
    tags: ["causality", "UI/UX feedback"],
    membersNeeded: 1,
    hoursPerWeek: 1,
  },
];

const MOCK_INVITES: CollabInvite[] = [
  {
    id: "inv1",
    fromName: "Ada Lovelace",
    projectId: "p1",
    note: "Would love a hand on this from you if you're available.",
    receivedAt: "2 days ago",
  },
];

// Help requests the member has sent out -- the general-call posts become rows here once a backend
// exists; two seeded examples keep the panel visible in the frontend prototype.
const MOCK_REQUESTS: HelpRequest[] = [
  {
    id: "req1",
    projectId: "proj-scm",
    comment: "Looking for a second pair of eyes on the SCM playground before the next demo.",
    members: 1,
    hours: 2,
    tags: ["causality", "visualization"],
    sentAt: "3 days ago",
  },
  {
    id: "req2",
    projectId: "proj-adminbot",
    comment: "Need help getting feedback from onboarded members.",
    members: 2,
    hours: 1,
    tags: ["QA", "general tools"],
    sentAt: "yesterday",
  },
];

const MOCK_ANNOUNCEMENTS: Announcement[] = [
  {
    id: "a1",
    authorName: "Zhijing Jin",
    body: "Reminder: Monday group meeting moves to 3pm this week only.",
    postedAt: "1 day ago",
  },
  {
    id: "a2",
    authorName: "Andrew Kim",
    body: "GPU cluster maintenance window Friday night -- expect downtime 11pm-2am ET.",
    postedAt: "3 days ago",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function availabilityLabel(status: DirectorStatus["availability"]): string {
  if (status === "available") {
    return t("labSharing.director.availabilityAvailable");
  }
  if (status === "busy") {
    return t("labSharing.director.availabilityBusy");
  }
  return t("labSharing.director.availabilityAway");
}

function matchesQuery(member: LabMemberSummary, query: string): boolean {
  if (!query.trim()) {
    return true;
  }
  const haystack = [member.name, member.role, ...member.projects, ...member.interests]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query.trim().toLowerCase());
}

function requestUpdate(state: AppViewState): void {
  (state as AppViewState & { requestUpdate?: () => void }).requestUpdate?.();
}

// The inline "add a tag" chip and the announcement compose dialog keep their transient UI state
// here rather than on AppViewState: typing state and an open flag are not things a re-render or a
// future backend sync should care about.
let addingTag = false;
let tagDraft = "";
let announcements: Announcement[] = [...MOCK_ANNOUNCEMENTS];
let sentRequests: HelpRequest[] = [...MOCK_REQUESTS];
let composingAnnouncement = false;
let announcementDraft = "";
let viewingInviteId: string | null = null;
// Member-specific ask: which member the dialog is open for (null = closed), plus the draft of the
// optional "special message" just for them. Draft lives here so a re-render does not wipe typing.
let askingMemberId: string | null = null;
let askSpecialMessage = "";
// Whether the general-call confirmation dialog is open.
let confirmingGeneralCall = false;
// Which "Your requests" row is asking for a second, confirming click before it is deleted.
let confirmingDeleteRequestId: string | null = null;

// ---------------------------------------------------------------------------
// 1. Director status strip
// ---------------------------------------------------------------------------

function renderDirectorPanel() {
  const director = MOCK_DIRECTOR;
  return html`
    <section class="lab-sharing-director" data-testid="lab-sharing-director">
      <div class="lab-sharing-director__identity">
        <div class="lab-sharing-director__name-row">
          <span
            class="lab-sharing-director__dot"
            data-availability=${director.availability}
            aria-hidden="true"
          ></span>
          <div class="lab-sharing-director__name">${director.name}</div>
        </div>
        <div class="lab-sharing-director__meta">
          ${availabilityLabel(director.availability)} · ${director.timezone} · ${director.localTime}
        </div>
      </div>

      <div class="lab-sharing-director__progress">
        <div class="lab-sharing-director__progress-label">
          <span>${director.progressLabel}</span>
          <span>${director.progressPercent}%</span>
        </div>
        <div class="lab-sharing-director__progress-track">
          <div
            class="lab-sharing-director__progress-fill"
            style=${`width: ${director.progressPercent}%`}
          ></div>
        </div>
      </div>

      <button
        type="button"
        class="btn lab-sharing-director__blocker"
        data-testid="lab-sharing-contact-blocker"
        @click=${() => {
          // MOCK: wire to a real contact/blocker flow once backend exists.
          console.log("contact about blocker clicked");
        }}
      >
        ${t("labSharing.director.contactBlocker")}
      </button>
    </section>
  `;
}

// ---------------------------------------------------------------------------
// 2. Seek help -- project picker + ask details + tags, then search/invite or general call
// ---------------------------------------------------------------------------

function renderTagPicker(state: AppViewState) {
  const selected = new Set(state.labSharingAskTags ?? []);
  const known = new Set(AVAILABLE_TAGS);
  const allTags = [...AVAILABLE_TAGS, ...[...selected].filter((tag) => !known.has(tag))];
  const commitDraft = () => {
    const value = tagDraft.trim();
    tagDraft = "";
    addingTag = false;
    if (value && !selected.has(value)) {
      state.labSharingAskTags = [...selected, value];
      requestUpdate(state);
    }
  };
  return html`
    <div class="lab-sharing-tags" role="group" aria-label=${t("labSharing.seekHelp.tags")}>
      ${allTags.map((tag) => {
        const active = selected.has(tag);
        return html`
          <button
            type="button"
            class="lab-sharing-tag ${active ? "lab-sharing-tag--active" : ""}"
            aria-pressed=${active}
            @click=${() => {
              const next = new Set(selected);
              if (active) {
                next.delete(tag);
              } else {
                next.add(tag);
              }
              state.labSharingAskTags = [...next];
              requestUpdate(state);
            }}
          >
            ${tag}
          </button>
        `;
      })}
      ${addingTag
        ? html`
            <input
              type="text"
              class="lab-sharing-tag lab-sharing-tag--input"
              placeholder=${t("labSharing.seekHelp.addTagPlaceholder")}
              .value=${tagDraft}
              @input=${(event: Event) => {
                tagDraft = (event.target as HTMLInputElement).value;
              }}
              @keydown=${(event: KeyboardEvent) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitDraft();
                } else if (event.key === "Escape") {
                  tagDraft = "";
                  addingTag = false;
                  requestUpdate(state);
                }
              }}
              @blur=${() => {
                commitDraft();
              }}
            />
          `
        : html`
            <button
              type="button"
              class="lab-sharing-tag lab-sharing-tag--add"
              aria-label=${t("labSharing.seekHelp.addTag")}
              @click=${() => {
                addingTag = true;
                requestUpdate(state);
              }}
            >
              + ${t("labSharing.seekHelp.addTag")}
            </button>
          `}
    </div>
  `;
}

function renderAskForm(state: AppViewState) {
  const projectId = state.labSharingAskProjectId ?? MOCK_OWNED_PROJECTS[0]?.id ?? "";
  return html`
    <div class="lab-sharing-ask">
      <label class="lab-sharing-ask__field">
        <span class="lab-sharing-ask__label">${t("labSharing.seekHelp.projectLabel")}</span>
        <select
          class="lab-sharing-ask__select"
          .value=${projectId}
          @change=${(event: Event) => {
            state.labSharingAskProjectId = (event.target as HTMLSelectElement).value;
          }}
        >
          ${MOCK_OWNED_PROJECTS.map(
            (project) => html`<option value=${project.id}>${project.title}</option>`,
          )}
        </select>
      </label>

      <label class="lab-sharing-ask__field">
        <span class="lab-sharing-ask__label">${t("labSharing.seekHelp.commentLabel")}</span>
        <textarea
          class="lab-sharing-ask__textarea"
          rows="3"
          placeholder=${t("labSharing.seekHelp.commentPlaceholder")}
          .value=${state.labSharingAskComment ?? ""}
          @input=${(event: Event) => {
            state.labSharingAskComment = (event.target as HTMLTextAreaElement).value;
            requestUpdate(state);
          }}
        ></textarea>
      </label>

      <div class="lab-sharing-ask__row">
        <label class="lab-sharing-ask__field lab-sharing-ask__field--narrow">
          <span class="lab-sharing-ask__label">${t("labSharing.seekHelp.membersLabel")}</span>
          <input
            class="lab-sharing-ask__input"
            type="number"
            min="1"
            .value=${String(state.labSharingAskMembers ?? 1)}
            @input=${(event: Event) => {
              state.labSharingAskMembers = Number((event.target as HTMLInputElement).value);
            }}
          />
        </label>
        <label class="lab-sharing-ask__field lab-sharing-ask__field--narrow">
          <span class="lab-sharing-ask__label">${t("labSharing.seekHelp.hoursLabel")}</span>
          <input
            class="lab-sharing-ask__input"
            type="number"
            min="0"
            .value=${String(state.labSharingAskHours ?? 1)}
            @input=${(event: Event) => {
              state.labSharingAskHours = Number((event.target as HTMLInputElement).value);
            }}
          />
        </label>
      </div>

      <div class="lab-sharing-ask__field">
        <span class="lab-sharing-ask__label">${t("labSharing.seekHelp.tags")}</span>
        ${renderTagPicker(state)}
      </div>
    </div>
  `;
}

function renderMemberCard(state: AppViewState, member: LabMemberSummary) {
  const invited = (state.labSharingInvitedMemberIds ?? []).includes(member.id);
  return html`
    <article class="lab-sharing-member" data-testid=${`lab-sharing-member-${member.id}`}>
      <div class="lab-sharing-member__header">
        <span class="lab-sharing-member__name">${member.name}</span>
        <span class="lab-sharing-member__role">${member.role}</span>
      </div>
      ${member.projects.length
        ? html`<p class="lab-sharing-member__line">
            <span class="lab-sharing-member__line-label">${t("labSharing.seekHelp.projects")}</span>
            ${member.projects.join(", ")}
          </p>`
        : nothing}
      ${member.interests.length
        ? html`<p class="lab-sharing-member__line">
            <span class="lab-sharing-member__line-label"
              >${t("labSharing.seekHelp.interests")}</span
            >
            ${member.interests.join(", ")}
          </p>`
        : nothing}
      <button
        type="button"
        class="btn ${invited ? "" : "primary"} lab-sharing-member__invite"
        ?disabled=${invited}
        @click=${() => {
          askingMemberId = member.id;
          askSpecialMessage = "";
          requestUpdate(state);
        }}
      >
        ${invited ? t("labSharing.seekHelp.invited") : t("labSharing.seekHelp.invite")}
      </button>
    </article>
  `;
}

function renderSeekHelpPanel(state: AppViewState) {
  const query = state.labSharingSearchQuery ?? "";
  const trimmed = query.trim();
  // Members stay hidden until the member actually searches -- no directory dump, just results.
  const results = trimmed
    ? MOCK_MEMBERS.filter((member) => matchesQuery(member, query))
    : [];

  return html`
    <section class="lab-sharing-seek" data-testid="lab-sharing-seek-help">
      <div class="lab-sharing-seek__header">
        <h2 class="lab-sharing-seek__title">${t("labSharing.seekHelp.title")}</h2>
        <p class="lab-sharing-seek__sub">${t("labSharing.seekHelp.subtitle")}</p>
      </div>

      ${renderAskForm(state)}

      <div class="lab-sharing-seek__divider">
        <span>${t("labSharing.seekHelp.searchHeading")}</span>
      </div>

      <div class="lab-sharing-seek__search-row">
        <input
          type="text"
          class="lab-sharing-seek__search"
          placeholder=${t("labSharing.seekHelp.searchPlaceholder")}
          .value=${query}
          @input=${(event: Event) => {
            state.labSharingSearchQuery = (event.target as HTMLInputElement).value;
            requestUpdate(state);
          }}
        />
      </div>

      <div class="lab-sharing-seek__results">
        ${trimmed
          ? results.length
            ? results.map((member) => renderMemberCard(state, member))
            : html`<p class="lab-sharing-seek__empty">${t("labSharing.seekHelp.empty")}</p>`
          : html`<p class="lab-sharing-seek__hint">${t("labSharing.seekHelp.searchPrompt")}</p>`}
      </div>

      ${askingMemberId
        ? renderMemberAskDialog(state, MOCK_MEMBERS.find((member) => member.id === askingMemberId) ?? null)
        : nothing}

      <div class="lab-sharing-seek__or">
        <span class="lab-sharing-seek__or-line"></span>
        <span class="lab-sharing-seek__or-label">${t("labSharing.seekHelp.or")}</span>
        <span class="lab-sharing-seek__or-line"></span>
      </div>

      <button
        type="button"
        class="btn primary lab-sharing-seek__call"
        data-testid="lab-sharing-general-call"
        @click=${() => {
          confirmingGeneralCall = true;
          requestUpdate(state);
        }}
      >
        ${t("labSharing.seekHelp.generalCall")}
      </button>

      ${confirmingGeneralCall ? renderGeneralCallDialog(state) : nothing}
    </section>
  `;
}

function renderGeneralCallDialog(state: AppViewState) {
  const projectId = state.labSharingAskProjectId ?? MOCK_OWNED_PROJECTS[0]?.id ?? "";
  const project = MOCK_OWNED_PROJECTS.find((p) => p.id === projectId);
  const publish = () => {
    // MOCK: submit the ask form above as a public call once backend exists.
    sentRequests = [
      {
        id: `req-${Date.now()}`,
        projectId,
        comment: state.labSharingAskComment ?? "",
        members: state.labSharingAskMembers ?? 1,
        hours: state.labSharingAskHours ?? 1,
        tags: state.labSharingAskTags ?? [],
        sentAt: "just now",
      },
      ...sentRequests,
    ];
    confirmingGeneralCall = false;
    requestUpdate(state);
  };
  return html`
    <div
      class="lab-sharing-invite-dialog"
      role="dialog"
      aria-modal="true"
      aria-label=${t("labSharing.seekHelp.confirmCallTitle")}
      data-testid="lab-sharing-general-call-dialog"
    >
      <div class="lab-sharing-invite-dialog__panel">
        <div class="lab-sharing-invite-dialog__head">
          <span class="lab-sharing-invite-dialog__from"
            >${t("labSharing.seekHelp.confirmCallTitle")}</span
          >
          <h3 class="lab-sharing-invite-dialog__title">${project?.title ?? projectId}</h3>
        </div>

        ${state.labSharingAskComment
          ? html`<p class="lab-sharing-invite-dialog__summary">${state.labSharingAskComment}</p>`
          : nothing}

        <div class="lab-sharing-invite-dialog__detail">
          <span class="lab-sharing-invite-dialog__label">${t("labSharing.seekHelp.membersLabel")}</span>
          <span class="lab-sharing-invite-dialog__value">${state.labSharingAskMembers ?? 1}</span>
        </div>
        <div class="lab-sharing-invite-dialog__detail">
          <span class="lab-sharing-invite-dialog__label">${t("labSharing.seekHelp.hoursLabel")}</span>
          <span class="lab-sharing-invite-dialog__value">${state.labSharingAskHours ?? 1}</span>
        </div>

        ${(state.labSharingAskTags ?? []).length
          ? html`
              <div class="lab-sharing-invite-dialog__needs">
                ${(state.labSharingAskTags ?? []).map(
                  (tag) => html`<span class="lab-sharing-invite-dialog__need">${tag}</span>`,
                )}
              </div>
            `
          : nothing}

        <div class="lab-sharing-invite-dialog__actions">
          <button
            type="button"
            class="btn lab-sharing-invite-dialog__close"
            @click=${() => {
              confirmingGeneralCall = false;
              requestUpdate(state);
            }}
          >
            ${t("labSharing.seekHelp.cancel")}
          </button>
          <button
            type="button"
            class="btn primary lab-sharing-invite-dialog__respond"
            data-testid="lab-sharing-general-call-send"
            @click=${() => publish()}
          >
            ${t("labSharing.seekHelp.postCall")}
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderMemberAskDialog(state: AppViewState, member: LabMemberSummary | null) {
  if (!member) {
    return nothing;
  }
  const projectId = state.labSharingAskProjectId ?? MOCK_OWNED_PROJECTS[0]?.id ?? "";
  const project = MOCK_OWNED_PROJECTS.find((p) => p.id === projectId);
  const send = () => {
    // MOCK: send a real collaboration invite (comment) once backend exists.
    console.log("invited member to help", {
      to: member.id,
      projectId,
      comment: state.labSharingAskComment,
      specialMessage: askSpecialMessage,
    });
    state.labSharingInvitedMemberIds = [...(state.labSharingInvitedMemberIds ?? []), member.id];
    askingMemberId = null;
    requestUpdate(state);
  };
  return html`
    <div
      class="lab-sharing-invite-dialog"
      role="dialog"
      aria-modal="true"
      aria-label=${t("labSharing.seekHelp.askMemberTitle", { name: member.name })}
      data-testid="lab-sharing-ask-dialog"
    >
      <div class="lab-sharing-invite-dialog__panel">
        <div class="lab-sharing-invite-dialog__head">
          <span class="lab-sharing-invite-dialog__from"
            >${t("labSharing.seekHelp.askMemberTitle", { name: member.name })}</span
          >
          <h3 class="lab-sharing-invite-dialog__title">${project?.title ?? projectId}</h3>
        </div>

        ${state.labSharingAskComment
          ? html`<p class="lab-sharing-invite-dialog__summary">${state.labSharingAskComment}</p>`
          : nothing}

        <div class="lab-sharing-invite-dialog__detail">
          <span class="lab-sharing-invite-dialog__label">${t("labSharing.seekHelp.membersLabel")}</span>
          <span class="lab-sharing-invite-dialog__value">${state.labSharingAskMembers ?? 1}</span>
        </div>
        <div class="lab-sharing-invite-dialog__detail">
          <span class="lab-sharing-invite-dialog__label">${t("labSharing.seekHelp.hoursLabel")}</span>
          <span class="lab-sharing-invite-dialog__value">${state.labSharingAskHours ?? 1}</span>
        </div>

        ${(state.labSharingAskTags ?? []).length
          ? html`
              <div class="lab-sharing-invite-dialog__needs">
                ${(state.labSharingAskTags ?? []).map(
                  (tag) => html`<span class="lab-sharing-invite-dialog__need">${tag}</span>`,
                )}
              </div>
            `
          : nothing}

        <div class="lab-sharing-invite-dialog__field">
          <label class="lab-sharing-invite-dialog__label" for="lab-sharing-ask-special-message"
            >${t("labSharing.seekHelp.specialMessageLabel", { name: member.name })}</label
          >
          <textarea
            id="lab-sharing-ask-special-message"
            class="lab-sharing-invite-dialog__input"
            placeholder=${t("labSharing.seekHelp.specialMessagePlaceholder")}
            .value=${askSpecialMessage}
            @input=${(event: Event) => {
              askSpecialMessage = (event.target as HTMLTextAreaElement).value;
              requestUpdate(state);
            }}
          ></textarea>
        </div>

        <div class="lab-sharing-invite-dialog__actions">
          <button
            type="button"
            class="btn lab-sharing-invite-dialog__close"
            @click=${() => {
              askingMemberId = null;
              requestUpdate(state);
            }}
          >
            ${t("labSharing.seekHelp.cancel")}
          </button>
          <button
            type="button"
            class="btn primary lab-sharing-invite-dialog__respond"
            data-testid="lab-sharing-ask-send"
            @click=${() => send()}
          >
            ${t("labSharing.seekHelp.sendInvite")}
          </button>
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// 3. Your invites -- respond to the owner
// ---------------------------------------------------------------------------

function renderInvitesPanel(state: AppViewState) {
  const responded = new Set(state.labSharingRespondedInviteIds ?? []);
  const invites = MOCK_INVITES.filter((invite) => !responded.has(invite.id));
  const viewingInvite = MOCK_INVITES.find((invite) => invite.id === viewingInviteId) ?? null;

  const respondTo = (invite: CollabInvite) => {
    // MOCK: reach the owner (e.g. a Slack DM) once the backend exists.
    state.labSharingRespondedInviteIds = [...(state.labSharingRespondedInviteIds ?? []), invite.id];
    viewingInviteId = null;
    requestUpdate(state);
  };

  return html`
    <section class="lab-sharing-invites" data-testid="lab-sharing-invites">
      <h2 class="lab-sharing-invites__title">${t("labSharing.invites.title")}</h2>
      <div class="lab-sharing-invites__list">
        ${invites.map(
          (invite) => html`
            <article class="lab-sharing-invite" data-testid=${`lab-sharing-invite-${invite.id}`}>
              <div class="lab-sharing-invite__header">
                <span class="lab-sharing-invite__from">${invite.fromName}</span>
                <span class="lab-sharing-invite__time">${invite.receivedAt}</span>
              </div>
              <p class="lab-sharing-invite__project">
                ${MOCK_OPEN_PROJECTS.find((p) => p.id === invite.projectId)?.title ?? invite.projectId}
              </p>
              <p class="lab-sharing-invite__note">${invite.note}</p>
              <div class="lab-sharing-invite__actions">
                <button
                  type="button"
                  class="btn primary lab-sharing-invite__view"
                  @click=${() => {
                    viewingInviteId = invite.id;
                    requestUpdate(state);
                  }}
                >
                  ${t("labSharing.invites.view")}
                </button>
              </div>
            </article>
          `,
        )}
      </div>

      ${viewingInvite
        ? html`
            <div
              class="lab-sharing-invite-dialog"
              role="dialog"
              aria-modal="true"
              aria-label=${t("labSharing.invites.viewTitle")}
              data-testid="lab-sharing-invite-dialog"
            >
              <div class="lab-sharing-invite-dialog__panel">
                ${renderInviteDetails(viewingInvite)}
                <div class="lab-sharing-invite-dialog__actions">
                  <button
                    type="button"
                    class="btn lab-sharing-invite-dialog__close"
                    @click=${() => {
                      viewingInviteId = null;
                      requestUpdate(state);
                    }}
                  >
                    ${t("labSharing.invites.close")}
                  </button>
                  <button
                    type="button"
                    class="btn primary lab-sharing-invite-dialog__respond"
                    data-testid="lab-sharing-invite-respond"
                    @click=${() => respondTo(viewingInvite)}
                  >
                    ${t("labSharing.invites.respond")}
                  </button>
                </div>
              </div>
            </div>
          `
        : nothing}
    </section>
  `;
}

function renderProjectDetailRows(project: Pick<OpenProject, "summary" | "owner" | "membersNeeded" | "hoursPerWeek" | "tags">) {
  return html`
    <p class="lab-sharing-invite-dialog__summary">${project.summary}</p>
    <div class="lab-sharing-invite-dialog__detail">
      <span class="lab-sharing-invite-dialog__label">${t("labSharing.invites.owner")}</span>
      <span class="lab-sharing-invite-dialog__value">${project.owner}</span>
    </div>
    <div class="lab-sharing-invite-dialog__detail">
      <span class="lab-sharing-invite-dialog__label">${t("labSharing.invites.membersNeeded")}</span>
      <span class="lab-sharing-invite-dialog__value">${project.membersNeeded}</span>
    </div>
    <div class="lab-sharing-invite-dialog__detail">
      <span class="lab-sharing-invite-dialog__label">${t("labSharing.invites.hoursPerWeek")}</span>
      <span class="lab-sharing-invite-dialog__value">${project.hoursPerWeek}</span>
    </div>
    <div class="lab-sharing-invite-dialog__needs">
      ${project.tags.map(
        (tag) => html`<span class="lab-sharing-invite-dialog__need">${tag}</span>`,
      )}
    </div>
  `;
}

function renderInviteDetails(invite: CollabInvite) {
  const project = MOCK_OPEN_PROJECTS.find((p) => p.id === invite.projectId);
  return html`
    <div class="lab-sharing-invite-dialog__head">
      <h3 class="lab-sharing-invite-dialog__title">${project?.title ?? invite.projectId}</h3>
      <span class="lab-sharing-invite-dialog__from">${t("labSharing.invites.from", { name: invite.fromName })}</span>
    </div>
    ${project ? renderProjectDetailRows(project) : nothing}
    <p class="lab-sharing-invite-dialog__note">${invite.note}</p>
  `;
}

// ---------------------------------------------------------------------------
// 4. Your requests -- help calls you sent out, deletable
// ---------------------------------------------------------------------------

function renderYourRequestsPanel(state: AppViewState) {
  return html`
    <section class="lab-sharing-requests" data-testid="lab-sharing-requests">
      <h2 class="lab-sharing-requests__title">${t("labSharing.requests.title")}</h2>
      ${sentRequests.length === 0
        ? html`<p class="lab-sharing-requests__empty">${t("labSharing.requests.empty")}</p>`
        : html`
            <div class="lab-sharing-requests__list">
              ${sentRequests.map(
                (request) => html`
                  <article
                    class="lab-sharing-request"
                    data-testid=${`lab-sharing-request-${request.id}`}
                  >
                    <div class="lab-sharing-request__header">
                      <span class="lab-sharing-request__project">
                        ${MOCK_OWNED_PROJECTS.find((p) => p.id === request.projectId)?.title ??
                        request.projectId}
                      </span>
                      <span class="lab-sharing-request__time">${request.sentAt}</span>
                    </div>
                    <p class="lab-sharing-request__note">${request.comment}</p>
                    <div class="lab-sharing-request__meta">
                      <span class="lab-sharing-request__stats">
                        ${t("labSharing.requests.stats", {
                          members: String(request.members),
                          hours: String(request.hours),
                        })}
                      </span>
                      <div class="lab-sharing-request__needs">
                        ${request.tags.map(
                          (tag) => html`<span class="lab-sharing-request__need">${tag}</span>`,
                        )}
                      </div>
                    </div>
                    <div class="lab-sharing-request__actions">
                      ${confirmingDeleteRequestId === request.id
                        ? html`
                            <button
                              type="button"
                              class="btn lab-sharing-request__cancel"
                              data-testid=${`lab-sharing-request-cancel-${request.id}`}
                              @click=${() => {
                                confirmingDeleteRequestId = null;
                                requestUpdate(state);
                              }}
                            >
                              ${t("labSharing.requests.cancelDelete")}
                            </button>
                            <button
                              type="button"
                              class="btn lab-sharing-request__delete lab-sharing-request__delete--confirm"
                              data-testid=${`lab-sharing-request-delete-${request.id}`}
                              @click=${() => {
                                sentRequests = sentRequests.filter((r) => r.id !== request.id);
                                confirmingDeleteRequestId = null;
                                requestUpdate(state);
                              }}
                            >
                              ${t("labSharing.requests.confirmDelete")}
                            </button>
                          `
                        : html`
                            <button
                              type="button"
                              class="btn lab-sharing-request__delete"
                              data-testid=${`lab-sharing-request-delete-${request.id}`}
                              @click=${() => {
                                confirmingDeleteRequestId = request.id;
                                requestUpdate(state);
                              }}
                            >
                              ${t("labSharing.requests.delete")}
                            </button>
                          `}
                    </div>
                  </article>
                `,
              )}
            </div>
          `}
    </section>
  `;
}

// ---------------------------------------------------------------------------
// 5. Open projects deck
// ---------------------------------------------------------------------------
function renderProjectCard(project: OpenProject) {
  return html`
    <article class="lab-sharing-project" data-testid=${`lab-sharing-project-${project.id}`}>
      <div class="lab-sharing-project__header">
        <h3 class="lab-sharing-project__title">${project.title}</h3>
        <span class="lab-sharing-project__owner">${project.owner}</span>
      </div>
      <p class="lab-sharing-project__summary">${project.summary}</p>
      <div class="lab-sharing-project__needs">
        ${project.tags.map((tag) => html`<span class="lab-sharing-project__need">${tag}</span>`)}
      </div>
      <div class="lab-sharing-project__footer">
        <span class="lab-sharing-project__stats">
          ${t("labSharing.openProjects.stats", {
            members: String(project.membersNeeded),
            hours: String(project.hoursPerWeek),
          })}
        </span>
        <button type="button" class="btn primary lab-sharing-project__offer">
          ${t("labSharing.openProjects.offerHelp")}
        </button>
      </div>
    </article>
  `;
}

function renderOpenProjectsPanel(state: AppViewState) {
  const total = MOCK_OPEN_PROJECTS.length;
  if (total === 0) {
    return html`
      <section class="lab-sharing-projects" data-testid="lab-sharing-open-projects">
        <h2 class="lab-sharing-projects__title">${t("labSharing.openProjects.title")}</h2>
        <p class="lab-sharing-projects__empty">${t("labSharing.openProjects.empty")}</p>
      </section>
    `;
  }
  // Wrap-around deck: `% total` (with a positive-modulo guard) so prev/next cycle forever
  // instead of hitting hard stops at either end.
  const index = (((state.labSharingOpenProjectIndex ?? 0) % total) + total) % total;
  const project = MOCK_OPEN_PROJECTS[index];

  return html`
    <section class="lab-sharing-projects" data-testid="lab-sharing-open-projects">
      <div class="lab-sharing-projects__header">
        <h2 class="lab-sharing-projects__title">${t("labSharing.openProjects.title")}</h2>
        <span class="lab-sharing-projects__count">${index + 1} / ${total}</span>
      </div>

      <div class="lab-sharing-projects__deck">
        <button
          type="button"
          class="lab-sharing-projects__nav lab-sharing-projects__nav--prev"
          aria-label=${t("labSharing.openProjects.previous")}
          @click=${() => {
            state.labSharingOpenProjectIndex = (index - 1 + total) % total;
            requestUpdate(state);
          }}
        >
          <svg
            class="lab-sharing-projects__chevron"
            viewBox="0 0 10 10"
            width="10"
            height="10"
            aria-hidden="true"
          >
            <path
              d="M6.5 2.5L3.5 5L6.5 7.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>

        ${renderProjectCard(project)}

        <button
          type="button"
          class="lab-sharing-projects__nav lab-sharing-projects__nav--next"
          aria-label=${t("labSharing.openProjects.next")}
          @click=${() => {
            state.labSharingOpenProjectIndex = (index + 1) % total;
            requestUpdate(state);
          }}
        >
          <svg
            class="lab-sharing-projects__chevron"
            viewBox="0 0 10 10"
            width="10"
            height="10"
            aria-hidden="true"
          >
            <path
              d="M3.5 2.5L6.5 5L3.5 7.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>
    </section>
  `;
}

// ---------------------------------------------------------------------------
// 6. Announcements -- feed plus an in-page compose dialog
// ---------------------------------------------------------------------------

function renderAnnouncementsPanel(state: AppViewState) {
  return html`
    <section class="lab-sharing-announcements" data-testid="lab-sharing-announcements">
      <div class="lab-sharing-announcements__header">
        <h2 class="lab-sharing-announcements__title">${t("labSharing.announcements.title")}</h2>
        <button
          type="button"
          class="btn lab-sharing-announcements__add"
          data-testid="lab-sharing-announcement-add"
          @click=${() => {
            composingAnnouncement = true;
            announcementDraft = "";
            requestUpdate(state);
            // The compose panel is at the bottom of the page; bring it into view so the member
            // lands on the thing they just asked to write.
            requestAnimationFrame(() => {
              document
                .querySelector<HTMLElement>('[data-testid="lab-sharing-announcement-compose"]')
                ?.scrollIntoView({ behavior: "smooth", block: "center" });
            });
          }}
        >
          + ${t("labSharing.announcements.add")}
        </button>
      </div>

      <div class="lab-sharing-announcements__list">
        ${announcements.map(
          (announcement) => html`
            <article class="lab-sharing-announcement" data-testid=${`lab-sharing-announcement-${announcement.id}`}>
              <div class="lab-sharing-announcement__header">
                <span class="lab-sharing-announcement__author">${announcement.authorName}</span>
                <span class="lab-sharing-announcement__time">${announcement.postedAt}</span>
              </div>
              <p class="lab-sharing-announcement__body">${announcement.body}</p>
            </article>
          `,
        )}
      </div>

      ${composingAnnouncement
        ? html`
            <div class="lab-sharing-compose" role="dialog" aria-modal="true" aria-label=${t("labSharing.announcements.composeTitle")} data-testid="lab-sharing-announcement-compose">
              <h3 class="lab-sharing-compose__title">${t("labSharing.announcements.composeTitle")}</h3>
              <textarea
                class="lab-sharing-compose__input"
                rows="3"
                placeholder=${t("labSharing.announcements.bodyPlaceholder")}
                .value=${announcementDraft}
                @input=${(event: Event) => {
                  announcementDraft = (event.target as HTMLTextAreaElement).value;
                  requestUpdate(state);
                }}
                @keydown=${(event: KeyboardEvent) => {
                  if (event.key === "Escape") {
                    composingAnnouncement = false;
                    announcementDraft = "";
                    requestUpdate(state);
                  }
                }}
              ></textarea>
              <div class="lab-sharing-compose__actions">
                <button
                  type="button"
                  class="btn lab-sharing-compose__cancel"
                  @click=${() => {
                    composingAnnouncement = false;
                    announcementDraft = "";
                    requestUpdate(state);
                  }}
                >
                  ${t("labSharing.announcements.cancel")}
                </button>
                <button
                  type="button"
                  class="btn primary lab-sharing-compose__send"
                  data-testid="lab-sharing-announcement-send"
                  ?disabled=${!announcementDraft.trim()}
                  @click=${() => {
                    // MOCK: send through the real announcement channel once the backend exists.
                    const body = announcementDraft.trim();
                    if (!body) {
                      return;
                    }
                    announcements = [
                      { id: `local-${Date.now()}`, authorName: "You", body, postedAt: "just now" },
                      ...announcements,
                    ];
                    composingAnnouncement = false;
                    announcementDraft = "";
                    requestUpdate(state);
                  }}
                >
                  ${t("labSharing.announcements.send")}
                </button>
              </div>
            </div>
          `
        : nothing}
    </section>
  `;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * The banner that says what this tab is.
 *
 * Every panel below runs on mock data and no control on the page reaches a service (see the MOCK
 * markers throughout this file). Without a banner the tab reads as a working feature whose data
 * happens to be wrong, and the first person to post a help request would discover otherwise by
 * having it vanish. Saying it once, at the top, costs a strip of page and makes the whole tab
 * honest -- which is why the panels themselves are left exactly as they are.
 */
function renderComingSoonBanner() {
  return html`
    <div class="lab-sharing__coming-soon" role="status" data-testid="lab-sharing-coming-soon">
      <span class="pill warn">${t("labSharing.comingSoon.badge")}</span>
      <span class="lab-sharing__coming-soon-copy">
        <strong>${t("labSharing.comingSoon.title")}</strong>
        <span>${t("labSharing.comingSoon.body")}</span>
      </span>
    </div>
  `;
}

export function renderLabSharingPreview(state: AppViewState) {
  return html`
    <div class="lab-sharing" data-testid="lab-sharing" data-preview="true">
      ${renderComingSoonBanner()} ${renderDirectorPanel()} ${renderInvitesPanel(state)}
      ${renderYourRequestsPanel(state)} ${renderSeekHelpPanel(state)}
      ${renderOpenProjectsPanel(state)} ${renderAnnouncementsPanel(state)}
    </div>
  `;
}

export function renderLabSharing(state: AppViewState) {
  const session = loadStoredMemberSession();
  return html`<lab-sharing-directory
      .baseUrl=${resolveAdminBotBaseUrl(state.settings)}
      .sessionToken=${session?.sessionToken ?? ""}
    ></lab-sharing-directory>
    <lab-sharing-member-search .baseUrl=${resolveAdminBotBaseUrl(state.settings)} .sessionToken=${session?.sessionToken ?? ""}></lab-sharing-member-search>
    <details>
      <summary>Preview of upcoming Lab Sharing features (sample data)</summary>
      ${renderLabSharingPreview(state)}
    </details>`;
}
