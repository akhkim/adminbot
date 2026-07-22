// Control UI view renders the AdminBot dashboard.
import { html, nothing } from "lit";
import type {
  AdminBotActionProposal,
  AdminBotDashboardData,
  AdminBotLabMember,
  AdminBotLabMemberSaveInput,
  AdminBotPaperNudge,
  AdminBotPaperRecord,
  AdminBotPaperSaveInput,
  AdminBotPaperStep,
  AdminBotPrivilegeLevel,
  AdminBotSensitiveInfoRecord,
  AdminBotReimbursementState,
  AdminBotSettings,
  AdminBotSettingsSaveInput,
} from "../controllers/adminbot.ts";
import { formatRelativeTimestamp } from "../format.ts";
import { icons } from "../icons.ts";
import { renderAdminBotReimbursements } from "./adminbot-reimbursements.ts";

export type AdminBotProps = {
  panel: AdminBotPanel;
  mode?: "admin" | "general";
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
  onSavePaper: (paper: AdminBotPaperSaveInput) => void;
  onDeletePaper: (paper: AdminBotPaperRecord) => void;
  onSaveSettings: (settings: AdminBotSettingsSaveInput) => void;
  onSaveSensitiveInfo: (markdown: string) => void;
  reimbursement: AdminBotReimbursementState;
  onReimbursementMessage: (message: string, files: File[]) => void;
  onGenerateReimbursement: () => void;
  onResetReimbursement: () => void;
};

export type AdminBotPanel =
  | "actions"
  | "reimbursements"
  | "settings"
  | "members"
  | "papers"
  | "nudges";

const stepLabels: Record<string, string> = {
  brainstorming_docs: "Brainstorming docs",
  overleaf_writing: "Overleaf writing",
  submission: "Submission",
  google_drive_pdf: "Drive PDF",
  arxiv_polish: "arXiv polish",
  social_posts: "Social posts",
  slide_making: "Slides",
  poster_making: "Poster",
};

const paperSteps: AdminBotPaperStep[] = [
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
  core_member: "Core Member",
  admin: "Admin",
};

const privilegeLevels: AdminBotPrivilegeLevel[] = [
  "external_collaborator",
  "trial",
  "member",
  "core_member",
  "admin",
];

type MemberNoteDraft = {
  location: string;
  joinedMonth: string;
  researchInterests: string;
  calendarEmail: string;
  whatsapp: string;
  github: string;
  website: string;
  notes: string;
};

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

function renderPaperOverview(papers: AdminBotPaperRecord[]) {
  const timelinePapers = papers.filter((paper) => paper.timeline?.items.length);
  const conferences = [...new Set(papers.map(paperConference))].sort((a, b) => a.localeCompare(b));
  const topics = [...new Set(papers.map(paperTopic))].sort((a, b) => a.localeCompare(b));
  const maxTotal = Math.max(
    1,
    ...timelinePapers.map((paper) => paper.timeline?.total_estimated_business_days ?? 1),
  );
  const renderRow = (paper: AdminBotPaperRecord) => {
    const timeline = paper.timeline;
    const conference = paperConference(paper);
    const topic = paperTopic(paper);
    const progress = timeline?.progress_percent ?? 0;
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
          <strong title=${paper.title}>${paper.title}</strong
          ><span>${conference} · ${topic} · ${progress}%</span>
        </div>
        ${timeline?.items.length
          ? html`<div
              class="adminbot-paper-timeline__track"
              aria-label=${`${paper.title}, ${progress}% complete`}
            >
              ${timeline.items.map(
                (item) =>
                  html`<div
                    class="adminbot-paper-timeline__bar adminbot-paper-timeline__bar--${item.status}"
                    style=${paperTimelineBarStyle(item, maxTotal)}
                    title=${`${item.label}: ${item.duration_business_days} business day estimate`}
                  >
                    <span>${item.label}</span>
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
      <div class="adminbot-paper-gantt">
        <div class="adminbot-paper-gantt__axis" aria-hidden="true">
          <span>Paper</span>
          <div>
            <span>Day 0</span><span>Day ${Math.round(maxTotal / 2)}</span
            ><span>Day ${maxTotal}</span>
          </div>
        </div>
        ${papers.map(renderRow)}
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

function noteField(notes: string | undefined, key: string): string {
  const expected = key.toLowerCase();
  for (const line of (notes ?? "").split("\n")) {
    const [rawKey, ...rest] = line.trim().split(":");
    if (rawKey?.trim().toLowerCase() === expected) {
      return rest.join(":").trim();
    }
  }
  return "";
}

function memberProfileDetails(member: AdminBotLabMember): string[] {
  const fields = [
    ["Career", noteField(member.notes, "Career stage")],
    ["Affiliation", noteField(member.notes, "Affiliation")],
    ["Major", noteField(member.notes, "Major")],
    ["Research topic", noteField(member.notes, "Research topic")],
    ["Next", noteField(member.notes, "Next career stage")],
  ];
  return fields.filter(([, value]) => value).map(([label, value]) => label + ": " + value);
}

function parseMemberNotes(notes: string | undefined): MemberNoteDraft {
  const draft: MemberNoteDraft = {
    location: "",
    joinedMonth: "",
    researchInterests: "",
    calendarEmail: "",
    whatsapp: "",
    github: "",
    website: "",
    notes: "",
  };
  const leftovers: string[] = [];
  for (const line of (notes ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const [rawKey, ...rest] = trimmed.split(":");
    const value = rest.join(":").trim();
    switch (rawKey.toLowerCase()) {
      case "location":
        draft.location = value;
        break;
      case "joined month":
        draft.joinedMonth = value;
        break;
      case "research interests":
        draft.researchInterests = value;
        break;
      case "gmail for calendar":
        draft.calendarEmail = value;
        break;
      case "whatsapp":
        draft.whatsapp = value;
        break;
      case "github":
        draft.github = value;
        break;
      case "personal website":
        draft.website = value;
        break;
      default:
        leftovers.push(trimmed);
        break;
    }
  }
  draft.notes = leftovers.join("\n");
  return draft;
}

function buildMemberNotes(draft: MemberNoteDraft): string | undefined {
  const lines = [
    ["Location", draft.location],
    ["Joined month", draft.joinedMonth],
    ["Research interests", draft.researchInterests],
    ["Gmail for calendar", draft.calendarEmail],
    ["WhatsApp", draft.whatsapp],
    ["GitHub", draft.github],
    ["Personal website", draft.website],
  ]
    .filter(([, value]) => value.trim())
    .map(([label, value]) => `${label}: ${value.trim()}`);
  if (draft.notes.trim()) {
    lines.push(draft.notes.trim());
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
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
  const capacityPercent = Number(getFormValue(data, "capacityPercent"));
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
    ...(getFormValue(data, "role") ? { role: getFormValue(data, "role") } : {}),
    ...(getFormValue(data, "status")
      ? { status: getFormValue(data, "status") as AdminBotLabMemberSaveInput["status"] }
      : {}),
    ...(getFormValue(data, "researchBranch")
      ? { researchBranch: getFormValue(data, "researchBranch") }
      : {}),
    ...(splitCsv("researchTopics").length ? { researchTopics: splitCsv("researchTopics") } : {}),
    ...(splitCsv("projects").length ? { projects: splitCsv("projects") } : {}),
    ...(getFormValue(data, "hoursPerWeek") && Number.isFinite(hoursPerWeek)
      ? { hoursPerWeek }
      : {}),
    ...(getFormValue(data, "capacityPercent") && Number.isFinite(capacityPercent)
      ? { capacityPercent }
      : {}),
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
    ...(getFormValue(data, "defaultPrivilegeLevel")
      ? {
          default_privilege_level: getFormValue(
            data,
            "defaultPrivilegeLevel",
          ) as AdminBotPrivilegeLevel,
        }
      : {}),
    ...(Number.isInteger(escalation) && escalation > 0
      ? { paper_escalation_business_days: escalation }
      : {}),
    head_professor_member_id: getFormValue(data, "headProfessorMemberId"),
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
              <span>Default privilege</span>
              <select name="defaultPrivilegeLevel">
                ${privilegeLevels.map(
                  (level) => html`
                    <option value=${level} ?selected=${level === settings.default_privilege_level}>
                      ${privilegeLabels[level] ?? friendly(level)}
                    </option>
                  `,
                )}
              </select>
            </label>
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

function renderMemberCard(member: AdminBotLabMember, props: AdminBotProps) {
  const noteDraft = parseMemberNotes(member.notes);
  return html`
    <article class="adminbot-editor-card adminbot-editor-card--member">
      <details class="adminbot-expandable">
        <summary>
          ${member.name} ·
          ${privilegeLabels[member.privilege_level] ?? friendly(member.privilege_level)}
        </summary>
        <div class="adminbot-editor-card__header">
          <div>
            <strong>${member.name}</strong>
            <div class="card-sub">${member.id} - updated ${formatTime(member.updated_at)}</div>
          </div>
          <span class="pill"
            >${privilegeLabels[member.privilege_level] ?? friendly(member.privilege_level)}</span
          >
        </div>
        <form class="adminbot-form" @submit=${(event: Event) => submitMemberForm(event, props)}>
          <div class="form-grid adminbot-form__grid">
            <label class="adminbot-form__field"
              ><span>Member id</span><input name="id" .value=${member.id} readonly
            /></label>
            <label class="adminbot-form__field"
              ><span>Name</span><input name="name" .value=${member.name} required
            /></label>
            <label class="adminbot-form__field"
              ><span>Email</span><input name="email" type="email" .value=${member.email ?? ""}
            /></label>
            <label class="adminbot-form__field"
              ><span>Slack user id</span
              ><input name="slackUserId" .value=${member.slack_user_id ?? ""}
            /></label>
            <label class="adminbot-form__field">
              <span>Privilege</span>
              <select name="privilegeLevel">
                ${privilegeLevels.map(
                  (level) => html`
                    <option value=${level} ?selected=${level === member.privilege_level}>
                      ${privilegeLabels[level] ?? friendly(level)}
                    </option>
                  `,
                )}
              </select>
            </label>
            <label class="adminbot-form__field"
              ><span>Location</span><input name="location" .value=${noteDraft.location}
            /></label>
            <label class="adminbot-form__field"
              ><span>Joined month</span><input name="joinedMonth" .value=${noteDraft.joinedMonth}
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
            <label class="adminbot-form__field"
              ><span>Website</span><input name="website" .value=${noteDraft.website}
            /></label>
          </div>
          <label class="adminbot-form__field"
            ><span>Additional notes</span
            ><textarea name="notes" rows="4">${noteDraft.notes}</textarea>
          </label>
          <div class="adminbot-form__meta">
            ${member.access
              .map((entry) => (entry.scope ? `${entry.service}: ${entry.scope}` : entry.service))
              .join(", ") || "n/a"}
          </div>
          <div class="adminbot-form__actions">
            <button class="btn btn--sm primary" type="submit">Save member</button>
          </div>
        </form>
      </details>
    </article>
  `;
}

function renderMemberReadOnlyCard(member: AdminBotLabMember) {
  const noteDraft = parseMemberNotes(member.notes);
  const profileDetails = memberProfileDetails(member);
  const detailItems = [
    member.email ? `Email: ${member.email}` : "",
    member.slack_user_id ? `Slack: ${member.slack_user_id}` : "",
    noteDraft.location ? `Location: ${noteDraft.location}` : "",
    noteDraft.researchInterests ? `Research: ${noteDraft.researchInterests}` : "",
    noteDraft.website ? `Website: ${noteDraft.website}` : "",
  ].filter(Boolean);
  detailItems.push(...profileDetails);
  return html`
    <article
      class="adminbot-editor-card adminbot-editor-card--member adminbot-editor-card--readonly"
    >
      <details class="adminbot-expandable">
        <summary>
          ${member.name} ·
          ${privilegeLabels[member.privilege_level] ?? friendly(member.privilege_level)}
        </summary>
        <div class="adminbot-editor-card__header">
          <div>
            <strong>${member.name}</strong>
            <div class="card-sub">${member.id} - updated ${formatTime(member.updated_at)}</div>
          </div>
          <span class="pill"
            >${privilegeLabels[member.privilege_level] ?? friendly(member.privilege_level)}</span
          >
        </div>
        <div class="adminbot-readonly-list">
          ${detailItems.length > 0
            ? detailItems.map((item) => html`<span>${item}</span>`)
            : html`<span>No public details yet.</span>`}
        </div>
      </details>
    </article>
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

function filterMemberSpreadsheet(event: Event): void {
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) return;
  const sheet = form.closest<HTMLElement>(".adminbot-member-sheet");
  if (!sheet) return;
  const data = new FormData(form);
  const search = getFormValue(data, "search").toLocaleLowerCase();
  const branch = getFormValue(data, "branch");
  const status = getFormValue(data, "status");
  const project = getFormValue(data, "project");
  const paper = getFormValue(data, "paper");
  let visible = 0;
  for (const row of sheet.querySelectorAll<HTMLTableRowElement>("tbody tr")) {
    const matches =
      (!search || (row.dataset.search ?? "").includes(search)) &&
      (!branch || row.dataset.branch === branch) &&
      (!status || row.dataset.status === status) &&
      (!project || (row.dataset.projects ?? "").split("|").includes(project)) &&
      (!paper || (row.dataset.papers ?? "").split("|").includes(paper));
    row.hidden = !matches;
    if (matches) visible += 1;
  }
  const count = sheet.querySelector<HTMLElement>("[data-member-result-count]");
  if (count) count.textContent = `${visible} ${visible === 1 ? "person" : "people"}`;
}

function renderMemberSpreadsheet(members: AdminBotLabMember[], papers: AdminBotPaperRecord[]) {
  const branches = [
    ...new Set(members.map((member) => member.research_branch).filter(Boolean)),
  ].sort((a, b) => String(a).localeCompare(String(b)));
  const statuses = [...new Set(members.map((member) => member.status ?? "active"))].sort();
  const projects = [...new Set(members.flatMap((member) => member.projects ?? []))].sort();
  const paperTitles = [...new Set(papers.map((paper) => paper.title))].sort();
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
          ><span>Branch</span
          ><select name="branch">
            <option value="">All branches</option>
            ${branches.map((value) => html`<option value=${value}>${value}</option>`)}
          </select></label
        >
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
      </form>
      <div class="adminbot-member-sheet__scroll">
        <table>
          <thead>
            <tr>
              <th>Person</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Research branch</th>
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
            ${members.map((member) => {
              const memberPapers = papersForMember(member, papers);
              const noteDraft = parseMemberNotes(member.notes);
              const search = [
                member.name,
                member.email,
                member.role,
                member.research_branch,
                member.affiliation,
                member.location,
                member.timezone,
                noteDraft.joinedMonth,
                noteDraft.calendarEmail,
                noteDraft.whatsapp,
                noteDraft.github,
                noteDraft.website,
                ...(member.research_topics ?? []),
                ...(member.projects ?? []),
                ...memberPapers.map((entry) => entry.title),
              ]
                .filter(Boolean)
                .join(" ")
                .toLocaleLowerCase();
              return html`<tr
                data-search=${search}
                data-branch=${member.research_branch ?? ""}
                data-status=${member.status ?? "active"}
                data-projects=${(member.projects ?? []).join("|")}
                data-papers=${memberPapers.map((entry) => entry.title).join("|")}
              >
                <td><strong>${member.name}</strong><small>${member.id}</small></td>
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
                  ${memberPapers.map(
                    (entry) =>
                      html`<span class="adminbot-tag adminbot-tag--paper">${entry.title}</span>`,
                  )}
                </td>
                <td>
                  <strong
                    >${member.capacity_percent === undefined
                      ? "—"
                      : `${member.capacity_percent}%`}</strong
                  ><small
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
                  ${!noteDraft.calendarEmail &&
                  !noteDraft.whatsapp &&
                  !noteDraft.github &&
                  !noteDraft.website
                    ? "—"
                    : nothing}
                </td>
                <td>
                  ${privilegeLabels[member.privilege_level] ?? friendly(member.privilege_level)}
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

function renderMembers(props: AdminBotProps, members: AdminBotLabMember[]) {
  const spreadsheet = renderMemberSpreadsheet(members, props.data.papers);
  if (props.mode === "general") {
    return html`${spreadsheet}
      <div class="adminbot-editor-list adminbot-editor-list--readonly">
        ${members.length > 0
          ? members.map((member) => renderMemberReadOnlyCard(member))
          : html`<div class="adminbot-empty adminbot-empty--compact">No lab members yet.</div>`}
      </div> `;
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
          <div class="form-grid adminbot-form__grid">
            <label class="adminbot-form__field"
              ><span>Member id</span><input name="id" placeholder="pat" required
            /></label>
            <label class="adminbot-form__field"
              ><span>Name</span><input name="name" placeholder="Pat" required
            /></label>
            <label class="adminbot-form__field"
              ><span>Email</span><input name="email" type="email" placeholder="pat@example.test"
            /></label>
            <label class="adminbot-form__field"
              ><span>Slack user id</span><input name="slackUserId" placeholder="U0123456789"
            /></label>
            <label class="adminbot-form__field">
              <span>Privilege</span>
              <select name="privilegeLevel">
                <option value="">Use AdminBot default</option>
                ${privilegeLevels.map(
                  (level) =>
                    html`<option value=${level}>
                      ${privilegeLabels[level] ?? friendly(level)}
                    </option>`,
                )}
              </select>
            </label>
            <label class="adminbot-form__field"
              ><span>Role</span><input name="role" placeholder="Research scientist"
            /></label>
            <label class="adminbot-form__field"
              ><span>Status</span
              ><select name="status">
                <option value="active">Full time</option>
                <option value="part_time">Part-time</option>
                <option value="on_leave">On leave</option>
                <option value="external">External</option>
                <option value="alumni">Alumni</option>
              </select></label
            >
            <label class="adminbot-form__field"
              ><span>Research branch</span
              ><input name="researchBranch" placeholder="Embodied intelligence"
            /></label>
            <label class="adminbot-form__field"
              ><span>Research topics</span
              ><input name="researchTopics" placeholder="robotics, world models"
            /></label>
            <label class="adminbot-form__field"
              ><span>Projects</span><input name="projects" placeholder="Project Atlas, Data Engine"
            /></label>
            <label class="adminbot-form__field"
              ><span>Hours / week</span><input name="hoursPerWeek" type="number" min="0" max="168"
            /></label>
            <label class="adminbot-form__field"
              ><span>Capacity %</span><input name="capacityPercent" type="number" min="0" max="100"
            /></label>
            <label class="adminbot-form__field"
              ><span>Affiliation</span><input name="affiliation"
            /></label>
            <label class="adminbot-form__field"
              ><span>Timezone</span><input name="timezone" placeholder="America/New_York"
            /></label>
            <label class="adminbot-form__field"
              ><span>Location</span><input name="location"
            /></label>
            <label class="adminbot-form__field"
              ><span>Joined month</span><input name="joinedMonth" placeholder="2026-06"
            /></label>
            <label class="adminbot-form__field"
              ><span>Research interests</span><input name="researchInterests"
            /></label>
            <label class="adminbot-form__field"
              ><span>Calendar email</span><input name="calendarEmail"
            /></label>
            <label class="adminbot-form__field"
              ><span>WhatsApp</span><input name="whatsapp"
            /></label>
            <label class="adminbot-form__field"><span>GitHub</span><input name="github" /></label>
            <label class="adminbot-form__field"><span>Website</span><input name="website" /></label>
          </div>
          <label class="adminbot-form__field"
            ><span>Additional notes</span><textarea name="notes" rows="4"></textarea>
          </label>
          <div class="adminbot-form__actions">
            <button class="btn btn--sm primary" type="submit">Add member</button>
          </div>
        </form>
      </article>

      <div class="adminbot-editor-list">
        ${members.length > 0
          ? members.map((member) => renderMemberCard(member, props))
          : html`<div class="adminbot-empty adminbot-empty--compact">No lab members yet.</div>`}
      </div>
    </div> `;
}

function renderPaperList(props: AdminBotProps, papers: AdminBotPaperRecord[]) {
  if (papers.length === 0) {
    return html`<div class="adminbot-empty adminbot-empty--compact">No active papers yet.</div>`;
  }
  return html`
    <div class="adminbot-paper-list">
      ${papers.map(
        (paper) => html`
          <article class="adminbot-paper">
            <details class="adminbot-expandable">
              <summary>
                ${paper.title} · ${stepLabels[paper.current_step] ?? friendly(paper.current_step)}
              </summary>
              <div class="adminbot-paper__main">
                <div class="adminbot-paper__header">
                  <div>
                    <strong>${paper.title}</strong>
                    <div class="adminbot-paper__meta">
                      ${paper.authors.join(", ") || "No authors"} - ${formatTime(paper.updated_at)}
                    </div>
                  </div>
                  <div class="adminbot-form__actions">
                    <span class="pill"
                      >${stepLabels[paper.current_step] ?? friendly(paper.current_step)}</span
                    >
                    ${props.mode === "general"
                      ? nothing
                      : html`<button
                          class="btn btn--sm danger"
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
                  </div>
                </div>
                ${props.mode === "general"
                  ? nothing
                  : html`
                      <form
                        class="adminbot-form"
                        @submit=${(event: Event) => submitPaperForm(event, props)}
                      >
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
                              .value=${paperConference(paper) === "Unspecified"
                                ? ""
                                : paperConference(paper)}
                          /></label>
                          <label class="adminbot-form__field"
                            ><span>Topic</span
                            ><input
                              name="topic"
                              .value=${paperTopic(paper) === "Unspecified"
                                ? ""
                                : paperTopic(paper)}
                          /></label>
                          <label class="adminbot-form__field"
                            ><span>Authors</span
                            ><input name="authors" .value=${paper.authors.join(", ")} required
                          /></label>
                          <label class="adminbot-form__field"
                            ><span>Current step</span
                            ><select name="currentStep">
                              ${paperSteps.map(
                                (step) =>
                                  html`<option
                                    value=${step}
                                    ?selected=${step === paper.current_step}
                                  >
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
                        <div class="adminbot-form__actions">
                          <button class="btn btn--sm primary" type="submit">Save paper</button>
                        </div>
                      </form>
                    `}
              </div>
            </details>
          </article>
        `,
      )}
    </div>
  `;
}

function renderPapers(props: AdminBotProps, papers: AdminBotPaperRecord[]) {
  if (props.mode === "general") {
    return html`${renderPaperOverview(papers)}${renderPaperList(props, papers)}`;
  }
  return html`
    ${renderPaperOverview(papers)}
    <div class="adminbot-editor-grid">
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
        <div class="card-sub">Create a PaperPublish record in the shared AdminBot ledger.</div>
        <form class="adminbot-form" @submit=${(event: Event) => submitPaperForm(event, props)}>
          <div class="form-grid adminbot-form__grid">
            <label class="adminbot-form__field"
              ><span>Paper id</span><input name="id" placeholder="paper-2026-example" required
            /></label>
            <label class="adminbot-form__field"
              ><span>Title</span><input name="title" required
            /></label>
            <label class="adminbot-form__field"
              ><span>Authors</span><input name="authors" placeholder="Alice, Bob" required
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
            <label class="adminbot-form__field">
              <span>Reminder status</span>
              <select name="reminderStatus">
                <option value="idle">Idle</option>
                <option value="waiting_on_authors">Waiting on authors</option>
                <option value="blocked">Blocked</option>
                <option value="complete">Complete</option>
              </select>
            </label>
          </div>
          <div class="adminbot-form__actions">
            <button class="btn btn--sm primary" type="submit">Add paper</button>
          </div>
        </form>
      </article>
      <div>${renderPaperList(props, papers)}</div>
    </div>
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

function renderPanel(props: AdminBotProps) {
  const general = props.mode === "general";
  switch (props.panel) {
    case "reimbursements":
      return html`<div class="card adminbot-card adminbot-card--wide">
        ${renderAdminBotReimbursements({
          connected: props.connected,
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
    case "nudges":
      if (general) {
        return renderPanel({ ...props, panel: "papers" });
      }
      return html`
        <div class="card adminbot-card adminbot-card--wide">
          <div class="card-title">Paper nudges</div>
          <div class="card-sub">Due reminders and head professor escalations.</div>
          ${renderNudges(props.data.nudges)}
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
          ${!general && props.panel === "papers"
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
