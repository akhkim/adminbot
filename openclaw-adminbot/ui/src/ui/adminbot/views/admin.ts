// oxlint-disable max-lines -- grandfathered at 2224 lines; see docs/adr/0006-deferred-monster-splits.md
// Control UI view renders the AdminBot dashboard.
import { html, nothing } from "lit";
import { adminBotMemberRoles } from "../../../../../extensions/adminbot/src/contracts/actions.js";
import { formatRelativeTimestamp } from "../../format.ts";
import { icons } from "../../icons.ts";
import type { MemberNudgeChannel, MemberProfileUpdate } from "../auth/session.ts";
import type {
  AdminBotActionProposal,
  AdminBotDashboardData,
  AdminBotExternalCollaboratorSubgroup,
  AdminBotLabMember,
  AdminBotLabMemberSaveInput,
  AdminBotMemberNudgeState,
  AdminBotPaperNudge,
  AdminBotPaperRecord,
  AdminBotPaperSaveInput,
  AdminBotPaperStep,
  AdminBotPrivilegeLevel,
  AdminBotSensitiveInfoRecord,
  AdminBotReimbursementState,
  AdminBotSettings,
  AdminBotSettingsSaveInput,
} from "../controllers/admin.ts";
import { renderAvailabilitySchedule, renderAvailabilityStrip } from "../data/availability.js";
import { buildMemberNotes, noteField, parseMemberNotes } from "../data/member-notes.ts";
import { renderAdminBotReimbursements } from "./reimbursements.ts";

export type AdminBotProps = {
  panel: AdminBotPanel;
  mode?: "admin" | "general";
  // Roster id of the signed-in member, so their own row sorts first and gets a
  // self-edit affordance. Null in break-glass gateway-token-only access, where no
  // member is signed in and therefore no row is "mine".
  signedInMemberId?: string | null;
  connected: boolean;
  loading: boolean;
  error: string | null;
  data: AdminBotDashboardData;
  busyActionId: string | null;
  notice: { kind: "success" | "error"; text: string } | null;
  onRefresh: () => void;
  onApprove: (proposal: AdminBotActionProposal) => void;
  onRemove: (proposal: AdminBotActionProposal) => void;
  onExecute: (proposal: AdminBotActionProposal) => void;
  onSaveMember: (member: AdminBotLabMemberSaveInput) => void;
  onSaveOwnProfile: (memberId: string, fields: MemberProfileUpdate) => void;
  // Reopens the post-login onboarding welcome screen on demand. Omitted (or a no-op) when the
  // signed-in member has no onboarding checklist to show.
  onShowOnboardingWelcome?: () => void;
  onSavePaper: (paper: AdminBotPaperSaveInput) => void;
  onDeletePaper: (paper: AdminBotPaperRecord) => void;
  onSaveSettings: (settings: AdminBotSettingsSaveInput) => void;
  onSaveSensitiveInfo: (markdown: string) => void;
  reimbursement: AdminBotReimbursementState;
  onReimbursementMessage: (message: string, files: File[]) => void;
  onGenerateReimbursement: () => void;
  onResetReimbursement: () => void;
  memberNudge: AdminBotMemberNudgeState;
  onNudgeChannelChange: (channel: MemberNudgeChannel) => void;
  onNudgeMessageChange: (message: string) => void;
  onNudgeSubjectChange: (subject: string) => void;
  onNudgeToggleRecipient: (memberId: string) => void;
  onNudgeSetRecipients: (memberIds: string[]) => void;
  onSendNudge: () => void;
};

export type AdminBotPanel =
  | "actions"
  | "reimbursements"
  | "settings"
  | "members"
  | "papers"
  | "announcements";

// Exported so My Projects & Papers advances a paper through the same named steps this page shows;
// two step vocabularies would let the pages disagree about where a paper is.
export const stepLabels: Record<string, string> = {
  brainstorming_docs: "Brainstorming docs",
  overleaf_writing: "Overleaf writing",
  submission: "Submission",
  google_drive_pdf: "Drive PDF",
  arxiv_polish: "arXiv polish",
  social_posts: "Social posts",
  slide_making: "Slides",
  poster_making: "Poster",
};

export const paperSteps: AdminBotPaperStep[] = [
  "brainstorming_docs",
  "overleaf_writing",
  "submission",
  "google_drive_pdf",
  "arxiv_polish",
  "social_posts",
  "slide_making",
  "poster_making",
];

const privilegeLabels: Record<string, string> = {
  external_collaborator: "External Collaborator",
  trial: "Trial",
  member: "Member",
  admin: "Admin",
};

const privilegeLevels: AdminBotPrivilegeLevel[] = [
  "external_collaborator",
  "trial",
  "member",
  "admin",
];

// Ordered least- to most-engaged, matching the service list. Labels come from `friendly()` so the
// vocabulary lives in one place instead of a second hand-written label map.
const collaboratorSubgroups: AdminBotExternalCollaboratorSubgroup[] = [
  "interviewee",
  "slightly_better_than_emails",
  "acquaintance",
  "alumni",
  "coauthor_minor",
  "coauthor_major",
  "disappearing_coauthor",
  "external_prof",
];

const memberStatusOptions: Array<{ value: string; label: string }> = [
  { value: "active", label: "Full time" },
  { value: "part_time", label: "Part-time" },
  { value: "on_leave", label: "On leave" },
  { value: "external", label: "External" },
  { value: "alumni", label: "Alumni" },
];

function friendly(value: string | undefined | null): string {
  if (!value) {
    return "n/a";
  }
  return value
    .split(/[._-]+/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function formatTime(value: string | undefined | null): string {
  if (!value) {
    return "n/a";
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? formatRelativeTimestamp(ms) : value;
}
function paperConference(paper: AdminBotPaperRecord): string {
  const artifacts = paper.artifacts ?? {};
  const conference =
    artifacts.conference ??
    artifacts.conference_name ??
    artifacts.venue ??
    artifacts.target_venue ??
    noteField(paper.notes, "Conference") ??
    noteField(paper.notes, "Venue");
  return conference?.trim() || "Unspecified";
}

function paperTopic(paper: AdminBotPaperRecord): string {
  const artifacts = paper.artifacts ?? {};
  const topic = artifacts.topic ?? artifacts.research_topic ?? noteField(paper.notes, "Topic");
  return topic?.trim() || "Unspecified";
}

function paperProgressBucket(progress: number): string {
  if (progress >= 100) return "complete";
  if (progress >= 67) return "late";
  if (progress >= 34) return "middle";
  if (progress > 0) return "early";
  return "not-started";
}
type PaperTimelineItem = NonNullable<AdminBotPaperRecord["timeline"]>["items"][number];

/**
 * Pack the schedule into as few rows as possible without two bars overlapping in time.
 *
 * The flow is a graph, not a line - slides branch off the submission and run alongside the
 * arXiv/announcement chain - so items no longer tile left to right, and drawing them in one track
 * would overlap them. Greedy first-fit gives the main chain one row and each concurrent branch its
 * own, which is what makes the branch legible.
 */
function packPaperTimelineLanes(items: readonly PaperTimelineItem[]): PaperTimelineItem[][] {
  const lanes: PaperTimelineItem[][] = [];
  const ordered = items.toSorted(
    (left, right) => left.offset_start_business_day - right.offset_start_business_day,
  );
  for (const item of ordered) {
    const lane = lanes.find(
      (candidate) =>
        (candidate.at(-1)?.offset_end_business_day ?? 0) <= item.offset_start_business_day,
    );
    if (lane) {
      lane.push(item);
    } else {
      lanes.push([item]);
    }
  }
  return lanes;
}

function paperTimelineBarStyle(
  item: NonNullable<AdminBotPaperRecord["timeline"]>["items"][number],
  total: number,
): string {
  const start = Math.max(0, item.offset_start_business_day);
  const duration = Math.max(1, item.duration_business_days);
  const left = Math.round((start / total) * 1000) / 10;
  const width = Math.max(5, Math.round((duration / total) * 1000) / 10);
  return `left: ${left}%; width: ${width}%; --adminbot-paper-timeline-color: ${item.color};`;
}

function filterPaperOverview(event: Event): void {
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) return;
  const overview = form.closest<HTMLElement>(".adminbot-paper-overview");
  if (!overview) return;
  const data = new FormData(form);
  const search = getFormValue(data, "search").toLocaleLowerCase();
  const conference = getFormValue(data, "conference");
  const progress = getFormValue(data, "progress");
  const step = getFormValue(data, "step");
  const topic = getFormValue(data, "topic");
  let visible = 0;
  for (const row of overview.querySelectorAll<HTMLElement>(".adminbot-paper-gantt__row")) {
    const matches =
      (!search || (row.dataset.search ?? "").includes(search)) &&
      (!conference || row.dataset.conference === conference) &&
      (!progress || row.dataset.progress === progress) &&
      (!step || row.dataset.step === step) &&
      (!topic || row.dataset.topic === topic);
    row.hidden = !matches;
    if (matches) visible += 1;
  }
  const count = overview.querySelector<HTMLElement>("[data-paper-result-count]");
  if (count) count.textContent = `${visible} ${visible === 1 ? "paper" : "papers"}`;
  const empty = overview.querySelector<HTMLElement>(".adminbot-paper-gantt__empty");
  if (empty) empty.hidden = visible !== 0;
}

function renderPaperOverview(props: AdminBotProps, papers: AdminBotPaperRecord[]) {
  const viewer = signedInMember(props);
  const timelinePapers = papers.filter((paper) => paper.timeline?.items.length);
  const conferences = [...new Set(papers.map(paperConference))].sort((a, b) => a.localeCompare(b));
  const topics = [...new Set(papers.map(paperTopic))].sort((a, b) => a.localeCompare(b));
  const maxTotal = Math.max(
    1,
    ...timelinePapers.map((paper) => paper.timeline?.total_estimated_business_days ?? 1),
  );
  const renderRow = (paper: AdminBotPaperRecord, index: number) => {
    const timeline = paper.timeline;
    const conference = paperConference(paper);
    const topic = paperTopic(paper);
    const progress = timeline?.progress_percent ?? 0;
    const currentItem = timeline?.items.find((item) => item.status === "current");
    const nextItem = timeline?.items.find((item) => item.status === "upcoming");
    // Admins edit the whole board; an author edits their own paper. Deleting stays admin-only
    // either way, so an author cannot remove a record other people's work depends on.
    const canEdit = props.mode !== "general" || memberOwnsPaper(paper, viewer, props.data.members);
    return html`
      <div
        class="adminbot-paper-gantt__row"
        data-search=${`${paper.title} ${paper.authors.join(" ")} ${conference} ${topic}`.toLocaleLowerCase()}
        data-conference=${conference}
        data-topic=${topic}
        data-progress=${paperProgressBucket(progress)}
        data-step=${paper.current_step}
      >
        <div class="adminbot-paper-gantt__label">
          <strong title=${paper.title}>${paper.title}</strong>
          <span class="adminbot-paper-gantt__authors" title=${paper.authors.join(", ")}
            >${paper.authors.join(", ") || "No authors"}</span
          >
          <span class="adminbot-paper-gantt__facets">
            <span class="adminbot-tag">${conference}</span>
            <span class="adminbot-tag">${topic}</span>
          </span>
          <span class="adminbot-paper-gantt__status">
            <span
              class="adminbot-paper-gantt__meter adminbot-paper-gantt__meter--${paperProgressBucket(
                progress,
              )}"
              role="img"
              aria-label=${`${progress}% complete`}
            >
              <span style=${`width: ${progress}%`}></span>
            </span>
            <small
              >${progress}% ·
              ${currentItem
                ? `now: ${currentItem.label}`
                : nextItem
                  ? `next: ${nextItem.label}`
                  : "complete"}</small
            >
          </span>
          <span class="adminbot-paper-gantt__actions">
            ${canEdit
              ? html`<button
                  class="btn btn--sm"
                  type="button"
                  popovertarget=${`adminbot-edit-paper-${index}`}
                >
                  Edit
                </button>`
              : nothing}
            ${props.mode === "general"
              ? nothing
              : html`<button
                  class="btn btn--sm btn--ghost danger"
                  type="button"
                  ?disabled=${props.busyActionId === paper.id}
                  @click=${() => {
                    if (globalThis.confirm(`Delete active paper "${paper.title}"?`)) {
                      props.onDeletePaper(paper);
                    }
                  }}
                >
                  ${props.busyActionId === paper.id ? "Deleting..." : "Delete"}
                </button>`}
          </span>
          ${canEdit ? renderPaperEditPopover(paper, index, props) : nothing}
        </div>
        ${timeline?.items.length
          ? html`<div
              class="adminbot-paper-timeline"
              aria-label=${`${paper.title}, ${progress}% complete`}
            >
              ${packPaperTimelineLanes(timeline.items).map(
                (lane) =>
                  html`<div class="adminbot-paper-timeline__track">
                    ${lane.map(
                      (item) =>
                        html`<div
                          class="adminbot-paper-timeline__bar adminbot-paper-timeline__bar--${item.status}"
                          style=${paperTimelineBarStyle(item, maxTotal)}
                          title=${`${item.label}: ${item.duration_business_days} business day estimate${
                            item.depends_on.length
                              ? `, after ${item.depends_on
                                  .map((step) => stepLabels[step] ?? friendly(step))
                                  .join(" and ")}`
                              : ", starts the flow"
                          }`}
                        >
                          <span>${item.label}</span>
                        </div>`,
                    )}
                  </div>`,
              )}
            </div>`
          : html`<div class="adminbot-paper-gantt__missing">Timeline unavailable</div>`}
      </div>
    `;
  };
  return html`
    <section class="adminbot-paper-overview" aria-labelledby="adminbot-paper-overview-title">
      <div class="adminbot-paper-overview__header">
        <div>
          <div class="card-title" id="adminbot-paper-overview-title">Paper timeline overview</div>
          <div class="card-sub">
            Shared scale in estimated business days from each paper's start.
          </div>
        </div>
        <span class="pill" data-paper-result-count>${papers.length} papers</span>
      </div>
      <form
        class="adminbot-paper-filters"
        @input=${filterPaperOverview}
        @change=${filterPaperOverview}
      >
        <label
          ><span>Search</span><input name="search" type="search" placeholder="Title or author"
        /></label>
        <label
          ><span>Conference</span
          ><select name="conference">
            <option value="">All conferences</option>
            ${conferences.map((value) => html`<option value=${value}>${value}</option>`)}
          </select></label
        >
        <label
          ><span>Topic</span
          ><select name="topic">
            <option value="">All topics</option>
            ${topics.map((value) => html`<option value=${value}>${value}</option>`)}
          </select></label
        >
        <label
          ><span>Progress</span
          ><select name="progress">
            <option value="">All progress</option>
            <option value="not-started">Not started</option>
            <option value="early">1-33%</option>
            <option value="middle">34-66%</option>
            <option value="late">67-99%</option>
            <option value="complete">Complete</option>
          </select></label
        >
        <label
          ><span>Current step</span
          ><select name="step">
            <option value="">All steps</option>
            ${paperSteps.map(
              (value) =>
                html`<option value=${value}>${stepLabels[value] ?? friendly(value)}</option>`,
            )}
          </select></label
        >
      </form>
      <div class="adminbot-paper-gantt__legend" aria-hidden="true">
        ${(["complete", "current", "upcoming", "blocked"] as const).map(
          (status) =>
            html`<span class="adminbot-paper-gantt__legend-item"
              ><i class="adminbot-paper-timeline__bar--${status}"></i>${friendly(status)}</span
            >`,
        )}
      </div>
      <div class="adminbot-paper-gantt">
        <div class="adminbot-paper-gantt__axis" aria-hidden="true">
          <span>Paper</span>
          <div>
            <span>Day 0</span><span>Day ${Math.round(maxTotal / 2)}</span
            ><span>Day ${maxTotal}</span>
          </div>
        </div>
        ${papers.map((paper, index) => renderRow(paper, index))}
        <div class="adminbot-paper-gantt__empty" hidden>No papers match these filters.</div>
      </div>
    </section>
  `;
}

function renderMetric(label: string, value: string | number, detail?: string) {
  return html`
    <div class="adminbot-metric">
      <div class="adminbot-metric__label">${label}</div>
      <div class="adminbot-metric__value">${value}</div>
      ${detail ? html`<div class="adminbot-metric__detail">${detail}</div>` : nothing}
    </div>
  `;
}

function getFormValue(formData: FormData, key: string): string {
  const raw = formData.get(key);
  return typeof raw === "string" ? raw.trim() : "";
}

function submitMemberForm(event: Event, props: AdminBotProps): void {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }
  const data = new FormData(form);
  const id = getFormValue(data, "id");
  const name = getFormValue(data, "name");
  if (!id || !name) {
    return;
  }
  const splitCsv = (key: string) =>
    getFormValue(data, key)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  const hoursPerWeek = Number(getFormValue(data, "hoursPerWeek"));
  const notes = buildMemberNotes({
    location: getFormValue(data, "location"),
    joinedMonth: getFormValue(data, "joinedMonth"),
    researchInterests: getFormValue(data, "researchInterests"),
    calendarEmail: getFormValue(data, "calendarEmail"),
    whatsapp: getFormValue(data, "whatsapp"),
    github: getFormValue(data, "github"),
    website: getFormValue(data, "website"),
    notes: getFormValue(data, "notes"),
  });
  props.onSaveMember({
    id,
    name,
    ...(getFormValue(data, "email") ? { email: getFormValue(data, "email") } : {}),
    ...(getFormValue(data, "slackUserId")
      ? { slackUserId: getFormValue(data, "slackUserId") }
      : {}),
    ...(getFormValue(data, "privilegeLevel")
      ? { privilegeLevel: getFormValue(data, "privilegeLevel") as AdminBotPrivilegeLevel }
      : {}),
    // The hidden field still submits, so the privilege check is what keeps a subgroup out of the
    // payload for a non-collaborator — the service rejects the pair outright.
    ...(getFormValue(data, "privilegeLevel") === "external_collaborator" &&
    getFormValue(data, "collaboratorSubgroup")
      ? {
          collaboratorSubgroup: getFormValue(
            data,
            "collaboratorSubgroup",
          ) as AdminBotExternalCollaboratorSubgroup,
        }
      : {}),
    ...(getFormValue(data, "role") ? { role: getFormValue(data, "role") } : {}),
    ...(getFormValue(data, "status")
      ? { status: getFormValue(data, "status") as AdminBotLabMemberSaveInput["status"] }
      : {}),
    ...(splitCsv("researchTopics").length ? { researchTopics: splitCsv("researchTopics") } : {}),
    ...(splitCsv("projects").length ? { projects: splitCsv("projects") } : {}),
    ...(getFormValue(data, "hoursPerWeek") && Number.isFinite(hoursPerWeek)
      ? { hoursPerWeek }
      : {}),
    availability: getFormValue(data, "availability"),
    ...(getFormValue(data, "location") ? { location: getFormValue(data, "location") } : {}),
    ...(getFormValue(data, "affiliation")
      ? { affiliation: getFormValue(data, "affiliation") }
      : {}),
    ...(getFormValue(data, "timezone") ? { timezone: getFormValue(data, "timezone") } : {}),
    ...(getFormValue(data, "website") ? { personalWebsite: getFormValue(data, "website") } : {}),
    ...(notes ? { notes } : {}),
  });
  form.closest<HTMLElement>("[popover]")?.hidePopover();
}

// A subgroup only means something on an external collaborator, so the field follows the privilege
// select. Cosmetic only: the service is what rejects the field on any other level.
function syncCollaboratorSubgroupField(event: Event): void {
  const select = event.currentTarget;
  if (!(select instanceof HTMLSelectElement)) {
    return;
  }
  const field = select
    .closest("form")
    ?.querySelector<HTMLElement>("[data-collaborator-subgroup-field]");
  if (field) {
    field.hidden = select.value !== "external_collaborator";
  }
}

// Whitelisted self-editable fields, matching what the AdminBot service accepts from a
// non-admin member editing their own row. Governance fields (id, email, privilege_level,
// status) are absent by construction, not merely hidden. Joined month / research interests
// / calendar email / WhatsApp / GitHub / website have no column of their own and are
// reassembled into `notes` with the same encoding the admin editor uses.
function collectSelfProfileFields(form: HTMLFormElement): MemberProfileUpdate {
  const data = new FormData(form);
  const splitCsv = (key: string) =>
    getFormValue(data, key)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  const hoursPerWeek = Number(getFormValue(data, "hoursPerWeek"));
  const location = getFormValue(data, "location");
  const personalWebsite = getFormValue(data, "website");
  const notes = buildMemberNotes({
    location,
    joinedMonth: getFormValue(data, "joinedMonth"),
    researchInterests: getFormValue(data, "researchInterests"),
    calendarEmail: getFormValue(data, "calendarEmail"),
    whatsapp: getFormValue(data, "whatsapp"),
    github: getFormValue(data, "github"),
    website: personalWebsite,
    notes: getFormValue(data, "notes"),
  });
  return {
    name: getFormValue(data, "name"),
    slack_user_id: getFormValue(data, "slackUserId"),
    role: getFormValue(data, "role"),
    research_topics: splitCsv("researchTopics"),
    projects: splitCsv("projects"),
    ...(getFormValue(data, "hoursPerWeek") && Number.isFinite(hoursPerWeek)
      ? { hours_per_week: hoursPerWeek }
      : {}),
    availability: getFormValue(data, "availability"),
    location,
    affiliation: getFormValue(data, "affiliation"),
    timezone: getFormValue(data, "timezone"),
    personal_website: personalWebsite,
    notes: notes ?? "",
  };
}

function submitSelfProfileForm(event: Event, memberId: string, props: AdminBotProps): void {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }
  props.onSaveOwnProfile(memberId, collectSelfProfileFields(form));
  form.closest<HTMLElement>("[popover]")?.hidePopover();
}

function submitPaperForm(event: Event, props: AdminBotProps): void {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }
  const data = new FormData(form);
  const id = getFormValue(data, "id");
  const title = getFormValue(data, "title");
  const authors = getFormValue(data, "authors")
    .split(",")
    .map((author) => author.trim())
    .filter(Boolean);
  const currentStep = getFormValue(data, "currentStep") as AdminBotPaperStep;
  if (!id || !title || authors.length === 0 || !paperSteps.includes(currentStep)) {
    return;
  }
  props.onSavePaper({
    id,
    title,
    authors,
    currentStep,
    ...(getFormValue(data, "overleafEditUrl")
      ? { overleafEditUrl: getFormValue(data, "overleafEditUrl") }
      : {}),
    ...(getFormValue(data, "googleDrivePdfUrl")
      ? { googleDrivePdfUrl: getFormValue(data, "googleDrivePdfUrl") }
      : {}),
    ...(getFormValue(data, "conference") ? { conference: getFormValue(data, "conference") } : {}),
    ...(getFormValue(data, "topic") ? { topic: getFormValue(data, "topic") } : {}),
    ...(getFormValue(data, "reminderStatus")
      ? {
          reminderStatus: getFormValue(
            data,
            "reminderStatus",
          ) as AdminBotPaperSaveInput["reminderStatus"],
        }
      : {}),
  });
  form.reset();
  form.closest<HTMLElement>("[popover]")?.hidePopover();
}

function submitSettingsForm(event: Event, props: AdminBotProps): void {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }
  const data = new FormData(form);
  const escalation = Number(getFormValue(data, "paperEscalationBusinessDays") || "0");
  props.onSaveSettings({
    ...(Number.isInteger(escalation) && escalation > 0
      ? { paper_escalation_business_days: escalation }
      : {}),
    head_professor_member_id: getFormValue(data, "headProfessorMemberId"),
    head_professor_whatsapp: getFormValue(data, "headProfessorWhatsapp"),
    applicant_sheet_id: getFormValue(data, "applicantSheetId"),
    applicant_last_reviewed_at: getFormValue(data, "applicantLastReviewedAt"),
  });
}

function submitSensitiveInfoForm(event: Event, props: AdminBotProps): void {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }
  const data = new FormData(form);
  const markdown = getFormValue(data, "markdown");
  if (!markdown) {
    return;
  }
  props.onSaveSensitiveInfo(markdown.endsWith("\n") ? markdown : `${markdown}\n`);
}

function renderSettings(
  props: AdminBotProps,
  settings: AdminBotSettings | null,
  sensitiveInfo: AdminBotSensitiveInfoRecord | null,
) {
  if (!settings) {
    return html`<div class="muted">Settings have not loaded yet.</div>`;
  }
  return html`
    <div class="adminbot-editor-grid">
      <article class="adminbot-editor-card">
        <div class="card-title">Policy defaults</div>
        <div class="card-sub">Edit the roster and reminder defaults AdminBot applies.</div>
        <form class="adminbot-form" @submit=${(event: Event) => submitSettingsForm(event, props)}>
          <div class="form-grid adminbot-form__grid">
            <label class="adminbot-form__field">
              <span>Paper escalation business days</span>
              <input
                name="paperEscalationBusinessDays"
                type="number"
                min="1"
                step="1"
                .value=${String(settings.paper_escalation_business_days)}
              />
            </label>
            <label class="adminbot-form__field">
              <span>Head professor member id</span>
              <input
                name="headProfessorMemberId"
                .value=${settings.head_professor_member_id ?? ""}
              />
            </label>
            <label class="adminbot-form__field">
              <span>Head professor WhatsApp</span>
              <input
                name="headProfessorWhatsapp"
                .value=${settings.head_professor_whatsapp ?? ""}
              />
            </label>
            <label class="adminbot-form__field">
              <span>Applicant response sheet id</span>
              <input name="applicantSheetId" .value=${settings.applicant_sheet_id ?? ""} />
            </label>
            <label class="adminbot-form__field">
              <span>Applicants last reviewed at</span>
              <input
                name="applicantLastReviewedAt"
                placeholder="2026-07-24T00:00:00.000Z"
                .value=${settings.applicant_last_reviewed_at ?? ""}
              />
            </label>
          </div>
          <div class="adminbot-form__actions">
            <button class="btn btn--sm primary" type="submit">Save settings</button>
          </div>
        </form>
        <div class="adminbot-kv">
          <div>
            <span>Updated</span>
            <strong>${formatTime(settings.updated_at)}</strong>
          </div>
        </div>
      </article>

      <article class="adminbot-editor-card">
        <div class="card-title">Sensitive information markdown</div>
        <div class="card-sub">
          Edit the privacy guidance AdminBot uses for default private routing.
        </div>
        <form
          class="adminbot-form"
          @submit=${(event: Event) => submitSensitiveInfoForm(event, props)}
        >
          <label class="adminbot-form__field">
            <span>Markdown</span>
            <textarea name="markdown" rows="18">${sensitiveInfo?.markdown ?? ""}</textarea>
          </label>
          <div class="adminbot-form__actions">
            <button class="btn btn--sm primary" type="submit">Save markdown</button>
          </div>
        </form>
        <div class="adminbot-kv">
          <div>
            <span>File</span>
            <strong>${sensitiveInfo?.path ?? "Stored by AdminBot service"}</strong>
          </div>
        </div>
      </article>
    </div>
  `;
}

function renderPendingActions(props: AdminBotProps) {
  const proposals = props.data.proposals;
  if (proposals.length === 0) {
    return html`
      <div class="adminbot-empty">
        <div class="adminbot-empty__icon">${icons.check}</div>
        <div>
          <strong>No pending actions</strong>
          <span>Approval-gated work will appear here when AdminBot proposes it.</span>
        </div>
      </div>
    `;
  }
  return html`
    <div class="adminbot-action-list">
      ${proposals.map((proposal) => {
        const busy = props.busyActionId === proposal.id;
        const approvals = proposal.approvals.length;
        const required = proposal.approval_requirement.min_approvals;
        return html`
          <article class="adminbot-action">
            <div class="adminbot-action__main">
              <div class="adminbot-action__title-row">
                <span class="pill adminbot-risk adminbot-risk--${proposal.risk_tier}"
                  >${proposal.risk_tier}</span
                >
                <strong>${proposal.summary}</strong>
              </div>
              <div class="adminbot-action__meta">
                <span>${friendly(proposal.type)}</span>
                <span>${approvals}/${required} approvals</span>
                <span>${formatTime(proposal.updated_at)}</span>
              </div>
              <code class="adminbot-hash">${proposal.payload_hash}</code>
            </div>
            <div class="adminbot-action__actions">
              <button
                class="btn btn--sm primary"
                ?disabled=${busy || !props.connected}
                @click=${() => props.onApprove(proposal)}
              >
                ${busy ? "Executing..." : "Execute"}
              </button>
              <button
                class="btn btn--sm"
                ?disabled=${busy || !props.connected}
                @click=${() => props.onRemove(proposal)}
              >
                ${busy ? "Working..." : "Remove"}
              </button>
            </div>
          </article>
        `;
      })}
    </div>
  `;
}

function renderCompactSummary(rows: Array<{ title: string; meta: string; detail: string }>) {
  if (rows.length === 0)
    return html`<div class="adminbot-empty adminbot-empty--compact">No records yet.</div>`;
  return html`<div class="adminbot-summary-list">
    ${rows.map(
      (row) =>
        html`<div class="adminbot-summary-list__row">
          <strong>${row.title}</strong><span>${row.meta}</span><span>${row.detail}</span>
        </div>`,
    )}
  </div>`;
}

function papersForMember(
  member: AdminBotLabMember,
  papers: AdminBotPaperRecord[],
): AdminBotPaperRecord[] {
  const identities = [member.id, member.name, member.email]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLocaleLowerCase());
  return papers.filter((paper) =>
    paper.authors.some((author) => identities.includes(author.toLocaleLowerCase())),
  );
}

/**
 * A paper still moving through the pipeline. Explicitly marked complete, or a timeline that has
 * run to 100%, both mean the work is done and its venue is no longer something to announce about.
 * Kept separate from `conferencesForMember` so the members sheet keeps listing every conference a
 * person has touched, while announcements only offer the ones with live work behind them.
 */
function isOngoingPaper(paper: AdminBotPaperRecord): boolean {
  if (paper.reminder?.status === "complete") return false;
  return (paper.timeline?.progress_percent ?? 0) < 100;
}

// Conferences a member has *ongoing* papers for, which is what makes them worth announcing to.
function ongoingConferencesForMember(
  member: AdminBotLabMember,
  papers: AdminBotPaperRecord[],
): string[] {
  return [
    ...new Set(papersForMember(member, papers).filter(isOngoingPaper).map(paperConference)),
  ].toSorted((left, right) => left.localeCompare(right));
}

// Conferences a member is submitting to, derived from the papers they author. There is no
// conference field on a member record, so the active papers are the only source for this filter.
function conferencesForMember(member: AdminBotLabMember, papers: AdminBotPaperRecord[]): string[] {
  return [...new Set(papersForMember(member, papers).map(paperConference))].toSorted(
    (left, right) => left.localeCompare(right),
  );
}

// Mirrors the service's ownership rule (upsertOwnPaper) so the UI only offers an edit form the
// server will accept: the member filed the paper, or is named in its authors -- by id or email
// outright, by bare name only when that name is unambiguous on the roster.
function memberOwnsPaper(
  paper: AdminBotPaperRecord,
  member: AdminBotLabMember | undefined,
  members: AdminBotLabMember[],
): boolean {
  if (!member) {
    return false;
  }
  if (paper.submitted_by_member_id === member.id) {
    return true;
  }
  const authors = paper.authors.map((author) => author.trim().toLocaleLowerCase());
  if (
    [member.id, member.email]
      .flatMap((value) => (value ? [value.toLocaleLowerCase()] : []))
      .some((value) => authors.includes(value))
  ) {
    return true;
  }
  const name = member.name.trim().toLocaleLowerCase();
  if (!name || !authors.includes(name)) {
    return false;
  }
  return members.filter((entry) => entry.name.trim().toLocaleLowerCase() === name).length === 1;
}

function signedInMember(props: AdminBotProps): AdminBotLabMember | undefined {
  return props.signedInMemberId
    ? props.data.members.find((member) => member.id === props.signedInMemberId)
    : undefined;
}

function filterMemberSpreadsheet(event: Event): void {
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) return;
  const sheet = form.closest<HTMLElement>(".adminbot-member-sheet");
  if (!sheet) return;
  const data = new FormData(form);
  const search = getFormValue(data, "search").toLocaleLowerCase();
  const status = getFormValue(data, "status");
  const project = getFormValue(data, "project");
  const paper = getFormValue(data, "paper");
  const conference = getFormValue(data, "conference");
  let visible = 0;
  for (const row of sheet.querySelectorAll<HTMLTableRowElement>("tbody tr")) {
    const matches =
      (!search || (row.dataset.search ?? "").includes(search)) &&
      (!status || row.dataset.status === status) &&
      (!project || (row.dataset.projects ?? "").split("|").includes(project)) &&
      (!paper || (row.dataset.papers ?? "").split("|").includes(paper)) &&
      (!conference || (row.dataset.conferences ?? "").split("|").includes(conference));
    row.hidden = !matches;
    if (matches) visible += 1;
  }
  const count = sheet.querySelector<HTMLElement>("[data-member-result-count]");
  if (count) count.textContent = `${visible} ${visible === 1 ? "person" : "people"}`;
}

// Shared roster fields for the admin add/edit-member popovers. When a member is
// supplied the fields are prefilled and the id is locked, so the same
// submitMemberForm/onSaveMember upsert path edits the existing record (PUT is an
// id-keyed merge) instead of creating a new one.
function renderMemberFormFields(member?: AdminBotLabMember) {
  const noteDraft = parseMemberNotes(member?.notes);
  const editing = member !== undefined;
  const numeric = (value: number | undefined) =>
    value === undefined || value === null ? "" : String(value);
  return html`
    <div class="form-grid adminbot-form__grid">
      <label class="adminbot-form__field"
        ><span>Member id</span
        ><input
          name="id"
          placeholder="pat"
          .value=${member?.id ?? ""}
          ?readonly=${editing}
          required
      /></label>
      <label class="adminbot-form__field"
        ><span>Name</span
        ><input name="name" placeholder="Pat" .value=${member?.name ?? ""} required
      /></label>
      <label class="adminbot-form__field"
        ><span>Email</span
        ><input
          name="email"
          type="email"
          placeholder="pat@example.test"
          .value=${member?.email ?? ""}
      /></label>
      <label class="adminbot-form__field"
        ><span>Slack user id</span
        ><input name="slackUserId" placeholder="U0123456789" .value=${member?.slack_user_id ?? ""}
      /></label>
      <label class="adminbot-form__field">
        <span>Privilege</span>
        <select name="privilegeLevel" @change=${syncCollaboratorSubgroupField}>
          ${privilegeLevels.map(
            (level) =>
              html`<option
                value=${level}
                ?selected=${level === (member?.privilege_level ?? "external_collaborator")}
              >
                ${privilegeLabels[level] ?? friendly(level)}
              </option>`,
          )}
        </select>
      </label>
      <label
        class="adminbot-form__field"
        data-collaborator-subgroup-field
        ?hidden=${(member?.privilege_level ?? "external_collaborator") !== "external_collaborator"}
      >
        <span>Collaborator subgroup</span>
        <select name="collaboratorSubgroup">
          <option value="" ?selected=${!member?.collaborator_subgroup}>Not set</option>
          ${collaboratorSubgroups.map(
            (subgroup) =>
              html`<option
                value=${subgroup}
                ?selected=${member?.collaborator_subgroup === subgroup}
              >
                ${friendly(subgroup)}
              </option>`,
          )}
        </select>
      </label>
      <label class="adminbot-form__field"
        ><span>Role</span
        ><select name="role">
          <option value="" ?selected=${!member?.role}>Not set</option>
          ${adminBotMemberRoles.map(
            (role) =>
              html`<option value=${role} ?selected=${member?.role === role}>${role}</option>`,
          )}
        </select>
      </label>
      <label class="adminbot-form__field"
        ><span>Status</span
        ><select name="status">
          ${memberStatusOptions.map(
            (option) =>
              html`<option
                value=${option.value}
                ?selected=${option.value === (member?.status ?? "active")}
              >
                ${option.label}
              </option>`,
          )}
        </select></label
      >
      <label class="adminbot-form__field"
        ><span>Research topics</span
        ><input
          name="researchTopics"
          placeholder="robotics, world models"
          .value=${(member?.research_topics ?? []).join(", ")}
      /></label>
      <label class="adminbot-form__field"
        ><span>Projects</span
        ><input
          name="projects"
          placeholder="Project Atlas, Data Engine"
          .value=${(member?.projects ?? []).join(", ")}
      /></label>
      <label class="adminbot-form__field"
        ><span>Hours / week</span
        ><input
          name="hoursPerWeek"
          type="number"
          min="0"
          max="168"
          .value=${numeric(member?.hours_per_week)}
      /></label>
      <label class="adminbot-form__field"
        ><span>Affiliation</span><input name="affiliation" .value=${member?.affiliation ?? ""}
      /></label>
      <label class="adminbot-form__field"
        ><span>Timezone</span
        ><input name="timezone" placeholder="America/New_York" .value=${member?.timezone ?? ""}
      /></label>
      <label class="adminbot-form__field"
        ><span>Location</span
        ><input name="location" .value=${member?.location ?? noteDraft.location}
      /></label>
      <label class="adminbot-form__field"
        ><span>Joined month</span
        ><input name="joinedMonth" placeholder="2026-06" .value=${noteDraft.joinedMonth}
      /></label>
      <label class="adminbot-form__field"
        ><span>Research interests</span
        ><input name="researchInterests" .value=${noteDraft.researchInterests}
      /></label>
      <label class="adminbot-form__field"
        ><span>Calendar email</span><input name="calendarEmail" .value=${noteDraft.calendarEmail}
      /></label>
      <label class="adminbot-form__field"
        ><span>WhatsApp</span><input name="whatsapp" .value=${noteDraft.whatsapp}
      /></label>
      <label class="adminbot-form__field"
        ><span>GitHub</span><input name="github" .value=${noteDraft.github}
      /></label>
      <label class="adminbot-form__field"
        ><span>Website</span><input name="website" .value=${noteDraft.website}
      /></label>
    </div>
    <label class="adminbot-form__field"
      ><span>Additional notes</span><textarea name="notes" rows="4">${noteDraft.notes}</textarea>
    </label>
  `;
}

function renderMemberEditPopover(member: AdminBotLabMember, index: number, props: AdminBotProps) {
  const editId = `adminbot-edit-member-${index}`;
  return html`
    <article class="adminbot-editor-card adminbot-popover" id=${editId} popover>
      <button
        class="btn btn--sm adminbot-popover__close"
        type="button"
        popovertarget=${editId}
        popovertargetaction="hide"
      >
        Close
      </button>
      <div class="card-title">Edit member</div>
      <div class="card-sub">${member.name} · ${member.id}</div>
      <form class="adminbot-form" @submit=${(event: Event) => submitMemberForm(event, props)}>
        ${renderMemberFormFields(member)}
        <div class="adminbot-form__actions">
          <button class="btn btn--sm primary" type="submit">Save member</button>
        </div>
      </form>
    </article>
  `;
}

// Restricted self-edit popover for a member's own row. Deliberately a separate field set
// from renderMemberFormFields: no id/email/privilege/status inputs exist here, so the
// non-admin path cannot even express a governance change.
function renderMemberSelfEditPopover(
  member: AdminBotLabMember,
  index: number,
  props: AdminBotProps,
) {
  const editId = `adminbot-self-edit-member-${index}`;
  const noteDraft = parseMemberNotes(member.notes);
  const numeric = (value: number | undefined) =>
    value === undefined || value === null ? "" : String(value);
  return html`
    <article class="adminbot-editor-card adminbot-popover" id=${editId} popover>
      <button
        class="btn btn--sm adminbot-popover__close"
        type="button"
        popovertarget=${editId}
        popovertargetaction="hide"
      >
        Close
      </button>
      <div class="card-title">Edit my profile</div>
      <div class="card-sub">
        Access level, status, and email are managed by admins and cannot be changed here.
      </div>
      <form
        class="adminbot-form"
        @submit=${(event: Event) => submitSelfProfileForm(event, member.id, props)}
      >
        <div class="form-grid adminbot-form__grid">
          <label class="adminbot-form__field"
            ><span>Name</span><input name="name" .value=${member.name ?? ""} required
          /></label>
          <label class="adminbot-form__field"
            ><span>Slack user id</span
            ><input name="slackUserId" .value=${member.slack_user_id ?? ""}
          /></label>
          <label class="adminbot-form__field"
            ><span>Role</span
            ><select name="role">
              <option value="" ?selected=${!member.role}>Not set</option>
              ${adminBotMemberRoles.map(
                (role) =>
                  html`<option value=${role} ?selected=${member.role === role}>${role}</option>`,
              )}
            </select>
          </label>
          <label class="adminbot-form__field"
            ><span>Research topics</span
            ><input
              name="researchTopics"
              placeholder="Comma-separated"
              .value=${(member.research_topics ?? []).join(", ")}
          /></label>
          <label class="adminbot-form__field"
            ><span>Projects</span
            ><input
              name="projects"
              placeholder="Comma-separated"
              .value=${(member.projects ?? []).join(", ")}
          /></label>
          <label class="adminbot-form__field"
            ><span>Hours / week</span
            ><input
              name="hoursPerWeek"
              type="number"
              min="0"
              max="168"
              .value=${numeric(member.hours_per_week)}
          /></label>
          <label class="adminbot-form__field"
            ><span>Location</span
            ><input name="location" .value=${member.location ?? noteDraft.location}
          /></label>
          <label class="adminbot-form__field"
            ><span>Affiliation</span><input name="affiliation" .value=${member.affiliation ?? ""}
          /></label>
          <label class="adminbot-form__field"
            ><span>Timezone</span
            ><input name="timezone" placeholder="America/New_York" .value=${member.timezone ?? ""}
          /></label>
          <label class="adminbot-form__field"
            ><span>Website</span><input name="website" .value=${noteDraft.website}
          /></label>
          <label class="adminbot-form__field"
            ><span>Joined month</span
            ><input name="joinedMonth" placeholder="2026-06" .value=${noteDraft.joinedMonth}
          /></label>
          <label class="adminbot-form__field"
            ><span>Research interests</span
            ><input name="researchInterests" .value=${noteDraft.researchInterests}
          /></label>
          <label class="adminbot-form__field"
            ><span>Calendar email</span
            ><input name="calendarEmail" .value=${noteDraft.calendarEmail}
          /></label>
          <label class="adminbot-form__field"
            ><span>WhatsApp</span><input name="whatsapp" .value=${noteDraft.whatsapp}
          /></label>
          <label class="adminbot-form__field"
            ><span>GitHub</span><input name="github" .value=${noteDraft.github}
          /></label>
        </div>
        <label class="adminbot-form__field"
          ><span>Additional notes</span
          ><textarea name="notes" rows="4">${noteDraft.notes}</textarea>
        </label>
        <div class="adminbot-form__actions">
          <button class="btn btn--sm primary" type="submit">Save my profile</button>
        </div>
      </form>
      ${renderAvailabilitySchedule(member.availability, member.time_off, member.name ?? member.id)}
    </article>
  `;
}

// Row edit affordance. Admins get the full governance field set on every row; anyone else
// gets the restricted self-edit form on their own row only, and nothing on other rows.
type MemberRowEdit = "admin" | "self" | "none";

function memberRowEdit(member: AdminBotLabMember, props: AdminBotProps): MemberRowEdit {
  if (props.mode === "admin") {
    return "admin";
  }
  return props.signedInMemberId && member.id === props.signedInMemberId ? "self" : "none";
}

// Signed-in member's own row floats to the top; everyone else keeps the roster's fetch order
// so the table does not silently reshuffle. No signed-in member (break-glass gateway-token
// access) leaves the order untouched.
function sortSignedInMemberFirst(
  members: AdminBotLabMember[],
  signedInMemberId: string | null | undefined,
): AdminBotLabMember[] {
  if (!signedInMemberId) {
    return members;
  }
  const own = members.filter((member) => member.id === signedInMemberId);
  return own.length === 0 ? members : [...own, ...members.filter((m) => m.id !== signedInMemberId)];
}

// Click-and-drag horizontal panning for the roster scroller. The window listeners are
// installed on drag start and removed on drag end, so the handler stays a stable module-level
// reference and Lit re-renders never accumulate listeners. Drags starting on an interactive
// element are ignored so Edit buttons, inputs, and links keep working.
function startMemberSheetPan(event: MouseEvent): void {
  const scroller = event.currentTarget;
  if (!(scroller instanceof HTMLElement) || event.button !== 0) {
    return;
  }
  const target = event.target;
  if (
    target instanceof Element &&
    target.closest("button, input, select, textarea, a, label, [popover]")
  ) {
    return;
  }
  const startX = event.pageX;
  const startScrollLeft = scroller.scrollLeft;
  scroller.classList.add("adminbot-member-sheet__scroll--panning");
  const onMove = (move: MouseEvent) => {
    scroller.scrollLeft = startScrollLeft - (move.pageX - startX);
  };
  const onUp = () => {
    scroller.classList.remove("adminbot-member-sheet__scroll--panning");
    globalThis.removeEventListener("mousemove", onMove);
    globalThis.removeEventListener("mouseup", onUp);
  };
  globalThis.addEventListener("mousemove", onMove);
  globalThis.addEventListener("mouseup", onUp);
}

function renderMemberSpreadsheet(props: AdminBotProps, allMembers: AdminBotLabMember[]) {
  const papers = props.data.papers;
  const members = sortSignedInMemberFirst(allMembers, props.signedInMemberId);
  const statuses = [...new Set(members.map((member) => member.status ?? "active"))].sort();
  const projects = [...new Set(members.flatMap((member) => member.projects ?? []))].sort();
  const paperTitles = [...new Set(papers.map((paper) => paper.title))].sort();
  // Only conferences someone on the roster is actually submitting to, so the options match what
  // selecting one can return.
  const conferences = [
    ...new Set(members.flatMap((member) => conferencesForMember(member, papers))),
  ].toSorted((left, right) => left.localeCompare(right));
  return html`
    <section class="adminbot-member-sheet">
      <div class="adminbot-member-sheet__heading">
        <div>
          <strong>People database</strong>
          <span>Research, staffing, and publication context</span>
        </div>
        <span class="pill" data-member-result-count>${members.length} people</span>
      </div>
      <form
        class="adminbot-member-filters"
        @input=${filterMemberSpreadsheet}
        @change=${filterMemberSpreadsheet}
      >
        <label
          ><span>Search</span
          ><input name="search" type="search" placeholder="Name, topic, project…"
        /></label>
        <label
          ><span>Status</span
          ><select name="status">
            <option value="">All statuses</option>
            ${statuses.map((value) => html`<option value=${value}>${friendly(value)}</option>`)}
          </select></label
        >
        <label
          ><span>Project</span
          ><select name="project">
            <option value="">All projects</option>
            ${projects.map((value) => html`<option value=${value}>${value}</option>`)}
          </select></label
        >
        <label
          ><span>Paper</span
          ><select name="paper">
            <option value="">All papers</option>
            ${paperTitles.map((value) => html`<option value=${value}>${value}</option>`)}
          </select></label
        >
        <label
          ><span>Conference</span
          ><select name="conference">
            <option value="">All conferences</option>
            ${conferences.map((value) => html`<option value=${value}>${value}</option>`)}
          </select></label
        >
      </form>
      <div class="adminbot-member-sheet__scroll" @mousedown=${startMemberSheetPan}>
        <table>
          <thead>
            <tr>
              <th>Person</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Topics</th>
              <th>Projects</th>
              <th>Active papers</th>
              <th>Availability</th>
              <th>Location</th>
              <th>Timezone</th>
              <th>Affiliation</th>
              <th>Joined</th>
              <th>Contact</th>
              <th>Access</th>
            </tr>
          </thead>
          <tbody>
            ${members.map((member, index) => {
              const rowEdit = memberRowEdit(member, props);
              const memberPapers = papersForMember(member, papers);
              const noteDraft = parseMemberNotes(member.notes);
              const search = [
                member.name,
                member.email,
                member.role,
                member.affiliation,
                member.location,
                member.timezone,
                member.slack_user_id,
                noteDraft.joinedMonth,
                noteDraft.calendarEmail,
                noteDraft.whatsapp,
                noteDraft.github,
                noteDraft.website,
                ...(member.research_topics ?? []),
                ...(member.projects ?? []),
                ...memberPapers.map((entry) => entry.title),
                ...memberPapers.map(paperConference),
              ]
                .filter(Boolean)
                .join(" ")
                .toLocaleLowerCase();
              return html`<tr
                data-search=${search}
                data-status=${member.status ?? "active"}
                data-projects=${(member.projects ?? []).join("|")}
                data-papers=${memberPapers.map((entry) => entry.title).join("|")}
                data-conferences=${[...new Set(memberPapers.map(paperConference))].join("|")}
              >
                <td>
                  <strong>${member.name}</strong><small>${member.id}</small>
                  ${memberPapers.length
                    ? html`<span
                        class="adminbot-member-sheet__papers"
                        title=${memberPapers.map((entry) => entry.title).join("\n")}
                      >
                        ${memberPapers.map(
                          (entry) =>
                            html`<span class="adminbot-tag adminbot-tag--paper"
                              >${entry.title}</span
                            >`,
                        )}
                      </span>`
                    : nothing}
                  ${rowEdit === "none"
                    ? nothing
                    : html`<button
                        class="btn btn--sm adminbot-member-sheet__edit"
                        type="button"
                        popovertarget=${rowEdit === "admin"
                          ? `adminbot-edit-member-${index}`
                          : `adminbot-self-edit-member-${index}`}
                      >
                        ${rowEdit === "admin" ? "Edit" : "Edit my profile"}
                      </button>`}
                  ${member.id === props.signedInMemberId && props.onShowOnboardingWelcome
                    ? html`<button
                        class="btn btn--sm btn--ghost adminbot-member-sheet__edit"
                        type="button"
                        @click=${() => props.onShowOnboardingWelcome?.()}
                      >
                        View onboarding checklist
                      </button>`
                    : nothing}
                </td>
                <td>${member.email ?? "—"}</td>
                <td>
                  ${member.role ??
                  privilegeLabels[member.privilege_level] ??
                  friendly(member.privilege_level)}
                </td>
                <td>
                  <span class="adminbot-status adminbot-status--${member.status ?? "active"}"
                    >${friendly(member.status ?? "active")}</span
                  >
                </td>
                <td>
                  ${(member.research_topics ?? []).map(
                    (value) => html`<span class="adminbot-tag">${value}</span>`,
                  )}
                </td>
                <td>
                  ${(member.projects ?? []).map(
                    (value) => html`<span class="adminbot-tag">${value}</span>`,
                  )}
                </td>
                <td>
                  ${memberPapers.map(
                    (entry) =>
                      html`<span class="adminbot-tag adminbot-tag--paper">${entry.title}</span>`,
                  )}
                </td>
                <td>
                  ${renderAvailabilityStrip(member.availability, member.time_off)}
                  <small
                    >${member.hours_per_week === undefined
                      ? "Hours not set"
                      : `${member.hours_per_week} h/week`}</small
                  >
                </td>
                <td>${member.location ?? noteDraft.location ?? "—"}</td>
                <td>${member.timezone ?? "—"}</td>
                <td>${member.affiliation ?? "—"}</td>
                <td>${noteDraft.joinedMonth || "—"}</td>
                <td>
                  ${noteDraft.calendarEmail
                    ? html`<span class="adminbot-contact-item"
                        >Calendar: ${noteDraft.calendarEmail}</span
                      >`
                    : nothing}
                  ${noteDraft.whatsapp
                    ? html`<span class="adminbot-contact-item"
                        >WhatsApp: ${noteDraft.whatsapp}</span
                      >`
                    : nothing}
                  ${noteDraft.github
                    ? html`<span class="adminbot-contact-item">GitHub: ${noteDraft.github}</span>`
                    : nothing}
                  ${noteDraft.website
                    ? html`<span class="adminbot-contact-item">Website: ${noteDraft.website}</span>`
                    : nothing}
                  ${member.slack_user_id
                    ? html`<span class="adminbot-contact-item"
                        >Slack: ${member.slack_user_id}</span
                      >`
                    : nothing}
                  ${!noteDraft.calendarEmail &&
                  !noteDraft.whatsapp &&
                  !noteDraft.github &&
                  !noteDraft.website &&
                  !member.slack_user_id
                    ? "—"
                    : nothing}
                </td>
                <td>
                  ${privilegeLabels[member.privilege_level] ?? friendly(member.privilege_level)}
                  ${member.privilege_level === "external_collaborator" &&
                  member.collaborator_subgroup
                    ? html`<span class="adminbot-tag"
                        >${friendly(member.collaborator_subgroup)}</span
                      >`
                    : nothing}
                </td>
              </tr>`;
            })}
          </tbody>
        </table>
        ${members.length === 0
          ? html`<div class="adminbot-empty adminbot-empty--compact">No lab members yet.</div>`
          : nothing}
      </div>
      ${members.map((member, index) => {
        const rowEdit = memberRowEdit(member, props);
        if (rowEdit === "admin") {
          return renderMemberEditPopover(member, index, props);
        }
        return rowEdit === "self" ? renderMemberSelfEditPopover(member, index, props) : nothing;
      })}
    </section>
  `;
}

function renderMembers(props: AdminBotProps, members: AdminBotLabMember[]) {
  const spreadsheet = renderMemberSpreadsheet(props, members);
  // The spreadsheet is the single roster view for every mode: admins edit any row, members
  // edit their own row inline, everyone else reads. Only the Add-member popover is admin-only.
  if (props.mode === "general") {
    return spreadsheet;
  }
  return html`${spreadsheet}
    <div class="adminbot-editor-grid">
      <article class="adminbot-editor-card adminbot-popover" id="adminbot-add-member" popover>
        <button
          class="btn btn--sm adminbot-popover__close"
          type="button"
          popovertarget="adminbot-add-member"
          popovertargetaction="hide"
        >
          Close
        </button>
        <div class="card-title">Add member</div>
        <div class="card-sub">Create a roster entry and seed its privilege-derived access.</div>
        <form class="adminbot-form" @submit=${(event: Event) => submitMemberForm(event, props)}>
          ${renderMemberFormFields()}
          <div class="adminbot-form__actions">
            <button class="btn btn--sm primary" type="submit">Add member</button>
          </div>
        </form>
      </article>
    </div> `;
}

/**
 * Editable fields for one paper. Shared by the row popover and kept separate from the record so a
 * member-scoped caller can compose the same inputs without the governance ones.
 */
function renderPaperFormFields(paper: AdminBotPaperRecord) {
  return html`
    <div class="form-grid adminbot-form__grid">
      <label class="adminbot-form__field"
        ><span>Paper id</span><input name="id" .value=${paper.id} readonly
      /></label>
      <label class="adminbot-form__field"
        ><span>Title</span><input name="title" .value=${paper.title} required
      /></label>
      <label class="adminbot-form__field"
        ><span>Conference</span
        ><input
          name="conference"
          .value=${paperConference(paper) === "Unspecified" ? "" : paperConference(paper)}
      /></label>
      <label class="adminbot-form__field"
        ><span>Topic</span
        ><input name="topic" .value=${paperTopic(paper) === "Unspecified" ? "" : paperTopic(paper)}
      /></label>
      <label class="adminbot-form__field"
        ><span>Authors</span><input name="authors" .value=${paper.authors.join(", ")} required
      /></label>
      <label class="adminbot-form__field"
        ><span>Current step</span
        ><select name="currentStep">
          ${paperSteps.map(
            (step) =>
              html`<option value=${step} ?selected=${step === paper.current_step}>
                ${stepLabels[step] ?? friendly(step)}
              </option>`,
          )}
        </select></label
      >
      <label class="adminbot-form__field"
        ><span>Overleaf edit URL</span
        ><input
          name="overleafEditUrl"
          type="url"
          .value=${paper.artifacts?.overleaf_edit_url ?? ""}
      /></label>
      <label class="adminbot-form__field"
        ><span>Google Drive PDF</span
        ><input
          name="googleDrivePdfUrl"
          type="url"
          .value=${paper.artifacts?.google_drive_pdf_url ?? ""}
      /></label>
    </div>
  `;
}

/**
 * Edit surface for one paper, anchored to its own row in the timeline. This mirrors how a lab
 * member is edited from their row rather than from a second list underneath, so the timeline is
 * the single place a paper is both read and changed.
 */
function renderPaperEditPopover(paper: AdminBotPaperRecord, index: number, props: AdminBotProps) {
  const editId = `adminbot-edit-paper-${index}`;
  return html`
    <article class="adminbot-editor-card adminbot-popover" id=${editId} popover>
      <button
        class="btn btn--sm adminbot-popover__close"
        type="button"
        popovertarget=${editId}
        popovertargetaction="hide"
      >
        Close
      </button>
      <div class="card-title">Edit paper</div>
      <div class="card-sub">
        ${paper.title} · ${paper.authors.join(", ") || "No authors"} ·
        ${formatTime(paper.updated_at)}
      </div>
      <form class="adminbot-form" @submit=${(event: Event) => submitPaperForm(event, props)}>
        ${renderPaperFormFields(paper)}
        <div class="adminbot-form__actions">
          <button class="btn btn--sm primary" type="submit">Save paper</button>
        </div>
      </form>
    </article>
  `;
}

function renderAddPaperCard(props: AdminBotProps, options: { governance: boolean }) {
  const viewer = signedInMember(props);
  return html`
    <article class="adminbot-editor-card adminbot-popover" id="adminbot-add-paper" popover>
      <button
        class="btn btn--sm adminbot-popover__close"
        type="button"
        popovertarget="adminbot-add-paper"
        popovertargetaction="hide"
      >
        Close
      </button>
      <div class="card-title">Add active paper</div>
      <div class="card-sub">
        ${options.governance
          ? "Create a PaperPublish record in the shared AdminBot ledger."
          : "File your own submission. You stay able to edit the papers you author."}
      </div>
      <form class="adminbot-form" @submit=${(event: Event) => submitPaperForm(event, props)}>
        <div class="form-grid adminbot-form__grid">
          <label class="adminbot-form__field"
            ><span>Paper id</span><input name="id" placeholder="paper-2026-example" required
          /></label>
          <label class="adminbot-form__field"
            ><span>Title</span><input name="title" required
          /></label>
          <label class="adminbot-form__field"
            ><span>Authors</span
            ><input
              name="authors"
              placeholder="Alice, Bob"
              .value=${options.governance ? "" : (viewer?.name ?? "")}
              required
          /></label>
          <label class="adminbot-form__field">
            <span>Current step</span>
            <select name="currentStep">
              ${paperSteps.map(
                (step) =>
                  html`<option value=${step}>${stepLabels[step] ?? friendly(step)}</option>`,
              )}
            </select>
          </label>
          <label class="adminbot-form__field"
            ><span>Overleaf edit URL</span><input name="overleafEditUrl" type="url"
          /></label>
          <label class="adminbot-form__field"
            ><span>Google Drive PDF</span><input name="googleDrivePdfUrl" type="url"
          /></label>
          <label class="adminbot-form__field"
            ><span>Conference</span><input name="conference" placeholder="NeurIPS 2026"
          /></label>
          <label class="adminbot-form__field"
            ><span>Topic</span><input name="topic" placeholder="World models"
          /></label>
          ${options.governance
            ? html`<label class="adminbot-form__field">
                <span>Reminder status</span>
                <select name="reminderStatus">
                  <option value="idle">Idle</option>
                  <option value="waiting_on_authors">Waiting on authors</option>
                  <option value="blocked">Blocked</option>
                  <option value="complete">Complete</option>
                </select>
              </label>`
            : nothing}
        </div>
        <div class="adminbot-form__actions">
          <button class="btn btn--sm primary" type="submit">Add paper</button>
        </div>
      </form>
    </article>
  `;
}

function renderPapers(props: AdminBotProps, papers: AdminBotPaperRecord[]) {
  if (props.mode === "general") {
    // Members file their own submissions here. The popover carries no reminder-status field: that
    // is paper-flow governance the service rejects from a member write.
    return html`${renderPaperOverview(props, papers)}
    ${props.signedInMemberId ? renderAddPaperCard(props, { governance: false }) : nothing}`;
  }
  return html`
    ${renderPaperOverview(props, papers)}
    <article class="adminbot-editor-card">
      <div class="card-title">Paper nudges</div>
      <div class="card-sub">Due reminders and head professor escalations.</div>
      ${renderNudges(props.data.nudges)}
    </article>
    ${renderAddPaperCard(props, { governance: true })}
  `;
}

function renderNudges(nudges: AdminBotPaperNudge[]) {
  if (nudges.length === 0) {
    return html`<div class="adminbot-empty adminbot-empty--compact">No due paper nudges.</div>`;
  }
  return html`
    <div class="adminbot-nudge-list">
      ${nudges.map(
        (nudge) => html`
          <article class="adminbot-nudge adminbot-nudge--${nudge.type}">
            <div class="adminbot-nudge__header">
              <strong>${nudge.title}</strong>
              <span>${nudge.type === "head_professor_escalation" ? "Escalate" : "Nudge"}</span>
            </div>
            <p>${nudge.message}</p>
            <div class="adminbot-action__meta">
              <span>${stepLabels[nudge.step] ?? friendly(nudge.step)}</span>
              <span>${nudge.recipients.join(", ") || "No recipients"}</span>
            </div>
          </article>
        `,
      )}
    </div>
  `;
}

function announceChannelHasContact(
  member: AdminBotLabMember,
  channel: MemberNudgeChannel,
): boolean {
  return channel === "slack" ? Boolean(member.slack_user_id) : Boolean(member.email);
}

function filterAnnouncementRecipients(event: Event): void {
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) return;
  const sheet = form.closest<HTMLElement>(".adminbot-nudge-recipients");
  if (!sheet) return;
  const data = new FormData(form);
  const search = getFormValue(data, "search").toLocaleLowerCase();
  const status = getFormValue(data, "status");
  const branch = getFormValue(data, "branch");
  const privilege = getFormValue(data, "privilege");
  const project = getFormValue(data, "project");
  const conference = getFormValue(data, "conference");
  let visible = 0;
  for (const row of sheet.querySelectorAll<HTMLTableRowElement>("tbody tr")) {
    const matches =
      (!search || (row.dataset.search ?? "").includes(search)) &&
      (!status || row.dataset.status === status) &&
      (!branch || row.dataset.branch === branch) &&
      (!privilege || row.dataset.privilege === privilege) &&
      (!project || (row.dataset.projects ?? "").split("|").includes(project)) &&
      (!conference || (row.dataset.conferences ?? "").split("|").includes(conference));
    row.hidden = !matches;
    if (matches) visible += 1;
  }
  const count = sheet.querySelector<HTMLElement>("[data-recipient-result-count]");
  if (count) count.textContent = `${visible} ${visible === 1 ? "person" : "people"} visible`;
}

// Adds every currently-visible (unhidden by the filter form) row to the existing selection,
// rather than replacing it, so switching filters to build up a recipient list across several
// passes ("NLP members" then separately "trial members") doesn't drop earlier picks.
function selectAllVisibleRecipients(event: Event, props: AdminBotProps): void {
  const button = event.currentTarget;
  if (!(button instanceof HTMLElement)) return;
  const sheet = button.closest<HTMLElement>(".adminbot-nudge-recipients");
  if (!sheet) return;
  const visibleIds = [...sheet.querySelectorAll<HTMLTableRowElement>("tbody tr")]
    .filter((row) => !row.hidden)
    .map((row) => row.dataset.memberId)
    .filter((id): id is string => Boolean(id));
  props.onNudgeSetRecipients([...new Set([...props.memberNudge.selectedMemberIds, ...visibleIds])]);
}

// LinkedIn membership cannot be observed (LinkedIn has no API that reports whether a person
// follows or works at an organization), so "hasn't joined" means the member has not marked the
// checklist step done on their welcome screen.
function hasCompletedOnboardingStep(member: AdminBotLabMember, stepId: string): boolean {
  return (member.onboarding?.steps ?? []).some(
    (step) => step.id === stepId && step.status === "complete",
  );
}

// Additive, like selectAllVisibleRecipients: adds the laggards to whatever is already picked.
function selectOnboardingLaggards(
  props: AdminBotProps,
  members: AdminBotLabMember[],
  stepId: string,
): void {
  const laggards = members
    .filter((member) => member.status !== "alumni" && member.status !== "external")
    .filter((member) => !hasCompletedOnboardingStep(member, stepId))
    .map((member) => member.id);
  props.onNudgeSetRecipients([...new Set([...props.memberNudge.selectedMemberIds, ...laggards])]);
}

function renderAnnouncementRecipients(
  props: AdminBotProps,
  members: AdminBotLabMember[],
  papers: AdminBotPaperRecord[],
) {
  const channel = props.memberNudge.channel;
  const selected = new Set(props.memberNudge.selectedMemberIds);
  const statuses = [...new Set(members.map((member) => member.status ?? "active"))].sort();
  const branches = [
    ...new Set(
      members.flatMap((member) => (member.research_branch ? [member.research_branch] : [])),
    ),
  ].sort();
  const privileges = [...new Set(members.map((member) => member.privilege_level))].sort();
  const projects = [...new Set(members.flatMap((member) => member.projects ?? []))].sort();
  // Only venues someone on the roster still has live work for: announcing about a conference
  // whose papers are all finished has no audience.
  // Taken from the active papers themselves, not from the roster. Deriving it per member meant a
  // paper whose authors do not resolve to a member record contributed no venue at all, so real
  // ongoing conferences went missing from the list.
  const conferences = [...new Set(papers.filter(isOngoingPaper).map(paperConference))].sort(
    (left, right) => left.localeCompare(right),
  );
  return html`
    <section class="adminbot-nudge-recipients">
      <div class="adminbot-member-sheet__heading">
        <div>
          <strong>Recipients</strong>
          <span>${selected.size} selected</span>
        </div>
        <span class="pill" data-recipient-result-count>${members.length} people visible</span>
      </div>
      <form
        class="adminbot-member-filters"
        @input=${filterAnnouncementRecipients}
        @change=${filterAnnouncementRecipients}
      >
        <label
          ><span>Search</span
          ><input name="search" type="search" placeholder="Name, topic, project…"
        /></label>
        <label
          ><span>Status</span
          ><select name="status">
            <option value="">All statuses</option>
            ${statuses.map((value) => html`<option value=${value}>${friendly(value)}</option>`)}
          </select></label
        >
        <label
          ><span>Research branch</span
          ><select name="branch">
            <option value="">All branches</option>
            ${branches.map((value) => html`<option value=${value}>${value}</option>`)}
          </select></label
        >
        <label
          ><span>Privilege</span
          ><select name="privilege">
            <option value="">All levels</option>
            ${privileges.map(
              (value) =>
                html`<option value=${value}>${privilegeLabels[value] ?? friendly(value)}</option>`,
            )}
          </select></label
        >
        <label
          ><span>Project</span
          ><select name="project">
            <option value="">All projects</option>
            ${projects.map((value) => html`<option value=${value}>${value}</option>`)}
          </select></label
        >
        <label
          ><span>Ongoing conference</span
          ><select name="conference">
            <option value="">All conferences</option>
            ${conferences.map((value) => html`<option value=${value}>${value}</option>`)}
          </select></label
        >
      </form>
      <div class="adminbot-nudge-recipients__actions">
        <button
          type="button"
          class="btn btn--sm"
          @click=${(event: Event) => selectAllVisibleRecipients(event, props)}
        >
          Select all visible
        </button>
        <button
          type="button"
          class="btn btn--sm"
          title="Members (excluding alumni/external) who haven't marked the LinkedIn onboarding step done"
          @click=${() => selectOnboardingLaggards(props, members, "linkedin")}
        >
          Select: LinkedIn not joined
        </button>
        <button type="button" class="btn btn--sm" @click=${() => props.onNudgeSetRecipients([])}>
          Clear selection
        </button>
      </div>
      <div class="adminbot-member-sheet__scroll">
        <table>
          <thead>
            <tr>
              <th></th>
              <th>Person</th>
              <th>Contact</th>
              <th>Status</th>
              <th>Research branch</th>
              <th>Topics</th>
              <th>Projects</th>
              <th>Ongoing conferences</th>
            </tr>
          </thead>
          <tbody>
            ${members.map((member) => {
              const memberConferences = ongoingConferencesForMember(member, papers);
              const search = [
                member.name,
                member.email,
                member.slack_user_id,
                member.research_branch,
                ...(member.research_topics ?? []),
                ...(member.projects ?? []),
                ...memberConferences,
              ]
                .filter(Boolean)
                .join(" ")
                .toLocaleLowerCase();
              const hasContact = announceChannelHasContact(member, channel);
              return html`<tr
                data-search=${search}
                data-status=${member.status ?? "active"}
                data-branch=${member.research_branch ?? ""}
                data-privilege=${member.privilege_level}
                data-projects=${(member.projects ?? []).join("|")}
                data-conferences=${memberConferences.join("|")}
                data-member-id=${member.id}
              >
                <td>
                  <input
                    type="checkbox"
                    ?checked=${selected.has(member.id)}
                    ?disabled=${!hasContact}
                    title=${hasContact
                      ? ""
                      : channel === "slack"
                        ? "No slack_user_id on file"
                        : "No email on file"}
                    @change=${() => props.onNudgeToggleRecipient(member.id)}
                  />
                </td>
                <td><strong>${member.name}</strong><small>${member.id}</small></td>
                <td>
                  ${channel === "slack"
                    ? (member.slack_user_id ??
                      html`<span class="adminbot-nudge-recipients__missing">no Slack ID</span>`)
                    : (member.email ??
                      html`<span class="adminbot-nudge-recipients__missing">no email</span>`)}
                </td>
                <td>
                  <span class="adminbot-status adminbot-status--${member.status ?? "active"}"
                    >${friendly(member.status ?? "active")}</span
                  >
                </td>
                <td>${member.research_branch ?? "—"}</td>
                <td>
                  ${(member.research_topics ?? []).map(
                    (value) => html`<span class="adminbot-tag">${value}</span>`,
                  )}
                </td>
                <td>
                  ${(member.projects ?? []).map(
                    (value) => html`<span class="adminbot-tag">${value}</span>`,
                  )}
                </td>
                <td>
                  ${memberConferences.length
                    ? memberConferences.map(
                        (value) => html`<span class="adminbot-tag">${value}</span>`,
                      )
                    : html`<span class="adminbot-nudge-recipients__missing">none</span>`}
                </td>
              </tr>`;
            })}
          </tbody>
        </table>
        ${members.length === 0
          ? html`<div class="adminbot-empty adminbot-empty--compact">No lab members yet.</div>`
          : nothing}
      </div>
    </section>
  `;
}

function renderAnnouncements(props: AdminBotProps) {
  const draft = props.memberNudge;
  const recipientCount = draft.selectedMemberIds.length;
  return html`
    <div class="adminbot-announce">
      <div class="adminbot-announce__compose">
        <label class="adminbot-form__field">
          <span>Channel</span>
          <select
            .value=${draft.channel}
            @change=${(event: Event) =>
              props.onNudgeChannelChange(
                (event.target as HTMLSelectElement).value as MemberNudgeChannel,
              )}
          >
            <option value="slack">Slack</option>
            <option value="email">Email</option>
          </select>
        </label>
        ${draft.channel === "email"
          ? html`<label class="adminbot-form__field">
              <span>Subject</span>
              <input
                .value=${draft.subject}
                @input=${(event: Event) =>
                  props.onNudgeSubjectChange((event.target as HTMLInputElement).value)}
                placeholder="Lab announcement"
              />
            </label>`
          : nothing}
        <label class="adminbot-form__field adminbot-announce__message">
          <span>Message</span>
          <textarea
            rows="5"
            .value=${draft.message}
            @input=${(event: Event) =>
              props.onNudgeMessageChange((event.target as HTMLTextAreaElement).value)}
            placeholder="Write your announcement or nudge…"
          ></textarea>
        </label>
        <div class="adminbot-form__actions">
          <button
            class="btn primary"
            type="button"
            ?disabled=${draft.busy}
            @click=${() => props.onSendNudge()}
          >
            ${draft.busy
              ? "Sending…"
              : `Send to ${recipientCount} recipient${recipientCount === 1 ? "" : "s"}`}
          </button>
        </div>
        <p class="adminbot-announce__hint">
          Sends immediately to each selected recipient — there's no separate approval step.
        </p>
      </div>
      ${renderAnnouncementRecipients(props, props.data.members, props.data.papers)}
    </div>
  `;
}

function renderPanel(props: AdminBotProps) {
  const general = props.mode === "general";
  switch (props.panel) {
    case "reimbursements":
      return html`<div class="card adminbot-card adminbot-card--wide">
        ${renderAdminBotReimbursements({
          canSubmit: props.connected,
          state: props.reimbursement,
          onMessage: props.onReimbursementMessage,
          onGenerate: props.onGenerateReimbursement,
          onReset: props.onResetReimbursement,
        })}
      </div>`;
    case "actions":
      if (general) {
        return renderPanel({ ...props, panel: "papers" });
      }
      return html`
        <div class="card adminbot-card adminbot-card--wide">
          <div class="card-title">Pending actions</div>
          <div class="card-sub">Immutable proposals from AdminBot's action broker.</div>
          ${renderPendingActions(props)}
        </div>
      `;
    case "settings":
      if (general) {
        return renderPanel({ ...props, panel: "papers" });
      }
      return html`
        <div class="card adminbot-card adminbot-card--wide">
          <div class="card-title">Settings</div>
          <div class="card-sub">Lab defaults and private-routing policy used by AdminBot.</div>
          ${renderSettings(props, props.data.settings, props.data.sensitiveInfo)}
        </div>
      `;
    case "members":
      return html`
        <div class="card adminbot-card adminbot-card--wide">
          <div class="card-title">Lab members</div>
          <div class="card-sub">
            ${general
              ? "Read-only lab roster."
              : "Edit roster details, member information, and access defaults."}
          </div>
          ${renderMembers(props, props.data.members)}
        </div>
      `;
    case "papers":
      return html`
        <div class="card adminbot-card adminbot-card--wide">
          <div class="card-title">Active papers</div>
          <div class="card-sub">PaperPublish records, current steps, and estimated timelines.</div>
          ${renderPapers(props, props.data.papers)}
        </div>
      `;
    case "announcements":
      if (general) {
        return renderPanel({ ...props, panel: "papers" });
      }
      return html`
        <div class="card adminbot-card adminbot-card--wide">
          <div class="card-title">Announcements</div>
          <div class="card-sub">
            Nudge selected members or send a general announcement over Slack or email.
          </div>
          ${renderAnnouncements(props)}
        </div>
      `;
  }
}

export function renderAdminBot(props: AdminBotProps) {
  const loadedAt = props.data.loadedAt ? formatRelativeTimestamp(props.data.loadedAt) : "not yet";
  const general = props.mode === "general";
  return html`
    <section class="adminbot-shell">
      <div class="adminbot-toolbar">
        <div class="adminbot-toolbar__copy">
          <strong>${general ? "Lab publication view" : "Proposal-first lab operations"}</strong>
          <span
            >${general
              ? "Read paper timelines and lab roster details."
              : "Review AdminBot state and edit roster, policy, and privacy settings without leaving Control UI."}</span
          >
        </div>
        <div class="adminbot-toolbar__actions">
          ${!general && props.panel === "members"
            ? html`<button
                class="btn btn--sm primary"
                type="button"
                popovertarget="adminbot-add-member"
              >
                Add member
              </button>`
            : nothing}
          ${props.panel === "papers" && (!general || props.signedInMemberId)
            ? html`<button
                class="btn btn--sm primary"
                type="button"
                popovertarget="adminbot-add-paper"
              >
                Add paper
              </button>`
            : nothing}
          <button class="btn btn--sm" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      ${props.notice
        ? html`<div class="callout ${props.notice.kind === "error" ? "danger" : "success"}">
            ${props.notice.text}
          </div>`
        : nothing}
      ${props.error ? html`<div class="callout danger">${props.error}</div>` : nothing}

      <div class="adminbot-metrics">
        ${general
          ? nothing
          : renderMetric("Pending", props.data.proposals.length, "approval queue")}
        ${renderMetric(
          "Members",
          props.data.members.length,
          general ? "read-only roster" : "editable roster",
        )}
        ${renderMetric("Papers", props.data.papers.length, "publication pipeline")}
        ${general
          ? renderMetric("Updated", loadedAt, "read-only view")
          : renderMetric("Nudges", props.data.nudges.length, `loaded ${loadedAt}`)}
      </div>

      <section class="grid grid-cols-2 adminbot-grid">${renderPanel(props)}</section>
    </section>
  `;
}
