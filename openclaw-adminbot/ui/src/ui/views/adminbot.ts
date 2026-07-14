// Control UI view renders the AdminBot dashboard.
import { html, nothing } from "lit";
import type {
  AdminBotActionProposal,
  AdminBotDashboardData,
  AdminBotLabMember,
  AdminBotLabMemberSaveInput,
  AdminBotPaperNudge,
  AdminBotPaperRecord,
  AdminBotPrivilegeLevel,
  AdminBotSensitiveInfoRecord,
  AdminBotSettings,
  AdminBotSettingsSaveInput,
} from "../controllers/adminbot.ts";
import { formatRelativeTimestamp } from "../format.ts";
import { icons } from "../icons.ts";

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
  onExecute: (proposal: AdminBotActionProposal) => void;
  onSaveMember: (member: AdminBotLabMemberSaveInput) => void;
  onSaveSettings: (settings: AdminBotSettingsSaveInput) => void;
  onSaveSensitiveInfo: (markdown: string) => void;
};

export type AdminBotPanel = "actions" | "settings" | "members" | "papers" | "nudges";

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

function renderPaperTimeline(paper: AdminBotPaperRecord) {
  const timeline = paper.timeline;
  if (!timeline || timeline.items.length === 0) {
    return nothing;
  }
  const total = Math.max(1, timeline.total_estimated_business_days);
  return html`
    <div
      class="adminbot-paper-timeline"
      aria-label=${`Estimated paper timeline, ${timeline.progress_percent}% complete`}
    >
      <div class="adminbot-paper-timeline__track">
        ${timeline.items.map(
          (item) => html`
            <div
              class="adminbot-paper-timeline__bar adminbot-paper-timeline__bar--${item.status}"
              style=${paperTimelineBarStyle(item, total)}
              title=${`${item.label}: ${item.duration_business_days} business day estimate`}
            >
              <span>${item.label}</span>
            </div>
          `,
        )}
      </div>
      <div class="adminbot-paper-timeline__legend">
        <span>${timeline.progress_percent}% complete</span>
        ${timeline.items
          .filter((item) => item.status === "current" || item.status === "blocked")
          .slice(0, 1)
          .map(
            (item) => html` <span class="adminbot-paper-timeline__current">${item.label}</span> `,
          )}
      </div>
    </div>
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
    ...(notes ? { notes } : {}),
  });
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
        const canExecute = proposal.status === "approved" || approvals >= required;
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
                class="btn btn--sm"
                ?disabled=${busy || !props.connected}
                @click=${() => props.onApprove(proposal)}
              >
                ${busy ? "Working..." : "Approve"}
              </button>
              <button
                class="btn btn--sm primary"
                ?disabled=${busy || !props.connected || !canExecute}
                @click=${() => props.onExecute(proposal)}
              >
                ${busy ? "Working..." : "Execute"}
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
    </article>
  `;
}
function renderMembers(props: AdminBotProps, members: AdminBotLabMember[]) {
  if (props.mode === "general") {
    return html`
      <div class="adminbot-editor-list adminbot-editor-list--readonly">
        ${members.length > 0
          ? members.map((member) => renderMemberReadOnlyCard(member))
          : html`<div class="adminbot-empty adminbot-empty--compact">No lab members yet.</div>`}
      </div>
    `;
  }
  return html`
    <div class="adminbot-editor-grid">
      <article class="adminbot-editor-card">
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
    </div>
  `;
}

function renderPapers(papers: AdminBotPaperRecord[]) {
  if (papers.length === 0) {
    return html`<div class="adminbot-empty adminbot-empty--compact">No active papers yet.</div>`;
  }
  return html`
    <div class="adminbot-paper-list">
      ${papers.map(
        (paper) => html`
          <article class="adminbot-paper">
            <div class="adminbot-paper__main">
              <div class="adminbot-paper__header">
                <div>
                  <strong>${paper.title}</strong>
                  <div class="adminbot-paper__meta">
                    ${paper.authors.join(", ") || "No authors"} - ${formatTime(paper.updated_at)}
                  </div>
                </div>
                <span class="pill"
                  >${stepLabels[paper.current_step] ?? friendly(paper.current_step)}</span
                >
              </div>
              ${renderPaperTimeline(paper)}
            </div>
          </article>
        `,
      )}
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
          ${renderPapers(props.data.papers)}
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
        <button class="btn btn--sm" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? "Refreshing..." : "Refresh"}
        </button>
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
