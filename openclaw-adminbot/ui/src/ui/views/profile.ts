// The signed-in member's own record: what the lab knows about them, what it does not yet, and
// what they might do about it.
//
// Three jobs, in the order a person meets them:
//   1. Basic info and badges  -- what is on file.
//   2. Fill in the blanks     -- a form containing only the fields still empty, so completing a
//                                profile is a short task rather than a hunt through a full editor.
//   3. Suggestions            -- guidebook pointers derived from what is missing, so the advice is
//                                about this person rather than a generic welcome.
//
// Saving goes through the same self-edit path the Lab Members table uses, whose server-side
// whitelist drops governance fields. Nothing here can write privilege_level, status, or email.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { LabMember, MemberProfileUpdate } from "../adminbot-auth.ts";
import type { AppViewState } from "../app-view-state.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../external-link.ts";
import { icons } from "../icons.ts";

export type ProfileProps = {
  onSave: (memberId: string, fields: MemberProfileUpdate) => void;
};

// Self-editable fields only, in the order they appear on the page. Governance-owned fields
// (email, status, privilege_level) are displayed but never offered as blanks.
// `optional: true` keeps a field out of the blanks count, the fill-in form, and the "profile
// complete" badge. Not everyone has a Twitter, and a checklist that can never reach zero stops
// being a checklist -- it just nags.
const EDITABLE_FIELDS = [
  { key: "name", kind: "text" },
  { key: "role", kind: "text" },
  { key: "affiliation", kind: "text" },
  { key: "location", kind: "text" },
  { key: "timezone", kind: "text" },
  { key: "slack_user_id", kind: "text" },
  { key: "hours_per_week", kind: "number" },
  { key: "research_topics", kind: "list" },
  { key: "projects", kind: "list" },
  { key: "personal_website", kind: "text", optional: true },
  { key: "avatar_url", kind: "image", optional: true },
  { key: "cv_url", kind: "text", optional: true },
  { key: "linkedin_url", kind: "text", optional: true },
  { key: "twitter_url", kind: "text", optional: true },
  { key: "github_url", kind: "text", optional: true },
  { key: "scholar_url", kind: "text", optional: true },
] as const;

// Rendered as a row of links under the name rather than as rows in the field table -- they are
// somewhere to go, not facts to read.
const SOCIAL_FIELDS = [
  { key: "linkedin_url", labelKey: "profile.social.linkedin" },
  { key: "twitter_url", labelKey: "profile.social.twitter" },
  { key: "github_url", labelKey: "profile.social.github" },
  { key: "scholar_url", labelKey: "profile.social.scholar" },
] as const;

type EditableField = (typeof EDITABLE_FIELDS)[number];

// Read-only context the lab owns rather than the member.
const GOVERNED_FIELDS = ["email", "status", "privilege_level"] as const;

const FIELD_LABEL_KEYS: Record<string, string> = {
  name: "profile.fields.name",
  email: "profile.fields.email",
  role: "profile.fields.role",
  status: "profile.fields.status",
  privilege_level: "profile.fields.privilegeLevel",
  affiliation: "profile.fields.affiliation",
  location: "profile.fields.location",
  timezone: "profile.fields.timezone",
  slack_user_id: "profile.fields.slackUserId",
  personal_website: "profile.fields.personalWebsite",
  hours_per_week: "profile.fields.hoursPerWeek",
  avatar_url: "profile.fields.avatarUrl",
  cv_url: "profile.fields.cvUrl",
  linkedin_url: "profile.fields.linkedin",
  twitter_url: "profile.fields.twitter",
  github_url: "profile.fields.github",
  scholar_url: "profile.fields.scholar",
  research_topics: "profile.fields.researchTopics",
  projects: "profile.fields.projects",
};

function labelFor(key: string): string {
  return t(FIELD_LABEL_KEYS[key] ?? key);
}

export function findOwnMember(state: AppViewState): LabMember | null {
  const memberId = state.memberId;
  if (!memberId) {
    return null;
  }
  return (state.adminBotData?.members ?? []).find((member) => member.id === memberId) ?? null;
}

function valueOf(member: LabMember, field: EditableField): string {
  const raw = member[field.key];
  if (field.kind === "list") {
    return Array.isArray(raw) ? raw.filter(Boolean).join(", ") : "";
  }
  return raw === null || raw === undefined ? "" : String(raw);
}

export function blankFields(member: LabMember): EditableField[] {
  return EDITABLE_FIELDS.filter(
    (field) => !("optional" in field && field.optional) && !valueOf(member, field).trim(),
  );
}

// Everything a member may set, blank or not -- what the full editor offers.
export function requiredFieldCount(): number {
  return EDITABLE_FIELDS.filter((field) => !("optional" in field && field.optional)).length;
}

// Badges are earned, so each one is derived from a fact on the record rather than stored. A badge
// nobody can explain is worse than no badge.
export function badgesFor(state: AppViewState, member: LabMember): string[] {
  const badges: string[] = [];
  const onboarding = state.adminBotOnboarding;
  if (onboarding && !(onboarding.remaining ?? []).length && (onboarding.steps ?? []).length) {
    badges.push(t("profile.badges.onboarded"));
  }
  if (!blankFields(member).length) {
    badges.push(t("profile.badges.profileComplete"));
  }
  const papers = state.adminBotData?.papers ?? [];
  const memberName = (member.name ?? "").trim().toLowerCase();
  const authored = papers.filter(
    (paper) =>
      paper.submitted_by_member_id === member.id ||
      (memberName &&
        (paper.authors ?? []).some((author) => author.trim().toLowerCase() === memberName)),
  );
  if (authored.length) {
    badges.push(`${t("profile.badges.author")} · ${authored.length}`);
  }
  if (papers.some((paper) => paper.mentor_member_id === member.id)) {
    badges.push(t("profile.badges.mentor"));
  }
  if (member.role?.trim()) {
    badges.push(member.role.trim());
  }
  return badges;
}

function renderFieldRow(member: LabMember, key: string, value: string) {
  return html`
    <div class="profile-field">
      <dt class="profile-field__label">${labelFor(key)}</dt>
      <dd class=${`profile-field__value ${value ? "" : "profile-field__value--empty"}`}>
        ${value || t("profile.basics.empty")}
      </dd>
    </div>
  `;
}

// Collects whatever the basics form holds. Governed fields have no input to read, so they cannot
// be submitted even by hand-editing the DOM -- the same reason the service whitelists them.
function collectBasics(form: HTMLFormElement): MemberProfileUpdate {
  const data = new FormData(form);
  const fields: MemberProfileUpdate = {};
  for (const field of EDITABLE_FIELDS) {
    if (field.kind === "image") {
      // Owned by the upload control, which saves on its own; no input to read here.
      continue;
    }
    const value = String(data.get(field.key) ?? "").trim();
    if (field.kind === "list") {
      fields[field.key] = value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    } else if (field.kind === "number") {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && value) {
        fields.hours_per_week = parsed;
      }
    } else {
      fields[field.key] = value;
    }
  }
  return fields;
}

// The lab has no file storage behind this UI, so an upload is read in the browser and stored as a
// data URL on the member record. That keeps the picture with the profile and needs no bucket, at
// the cost of a size ceiling -- hence the limit and the explicit error rather than a silent
// failure at save time.
const MAX_AVATAR_BYTES = 512 * 1024;

async function acceptAvatarFile(
  state: AppViewState,
  member: LabMember,
  props: ProfileProps,
  event: Event,
): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !member.id) {
    return;
  }
  if (file.size > MAX_AVATAR_BYTES) {
    state.adminBotNotice = { kind: "error", text: t("profile.picture.tooLarge") };
    input.value = "";
    return;
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  props.onSave(member.id, { avatar_url: dataUrl });
  input.value = "";
}

function renderAvatarUpload(state: AppViewState, member: LabMember, props: ProfileProps) {
  const current = String(member.avatar_url ?? "").trim();
  return html`
    <div class="profile__upload">
      <span class="profile__form-label">${labelFor("avatar_url")}</span>
      <div class="profile__upload-row">
        ${current
          ? html`<img class="profile__upload-preview" src=${current} alt="" />`
          : html`<span class="profile__upload-preview profile__upload-preview--empty"></span>`}
        <label class="btn btn--sm profile__upload-button">
          ${current ? t("profile.picture.replace") : t("profile.picture.choose")}
          <input
            class="sr-only"
            type="file"
            accept="image/*"
            data-testid="profile-avatar-upload-field"
            @change=${(event: Event) => void acceptAvatarFile(state, member, props, event)}
          />
        </label>
        ${current
          ? html`
              <button
                type="button"
                class="btn btn--sm"
                data-testid="profile-avatar-remove"
                @click=${() => member.id && props.onSave(member.id, { avatar_url: "" })}
              >
                ${t("profile.picture.remove")}
              </button>
            `
          : nothing}
      </div>
      <p class="profile__upload-hint">${t("profile.picture.hint")}</p>
    </div>
  `;
}

function renderBasics(state: AppViewState, member: LabMember, props: ProfileProps) {
  const editing = state.profileEditingSection === "basics";
  return html`
    <section class="profile__section" data-testid="profile-basics">
      <div class="profile__section-head">
        <h2 class="profile__section-title">${t("profile.basics.title")}</h2>
        ${editing
          ? nothing
          : html`
              <button
                type="button"
                class="btn btn--sm profile__edit"
                data-testid="profile-basics-edit"
                @click=${() => {
                  state.profileEditingSection = "basics";
                }}
              >
                <span class="profile__edit-icon" aria-hidden="true">${icons.penLine}</span>
                ${t("profile.basics.edit")}
              </button>
            `}
      </div>
      ${editing
        ? html`
            <form
              class="profile__form"
              @submit=${(event: SubmitEvent) => {
                event.preventDefault();
                if (member.id) {
                  props.onSave(member.id, collectBasics(event.currentTarget as HTMLFormElement));
                }
                state.profileEditingSection = null;
              }}
            >
              ${EDITABLE_FIELDS.filter((field) => field.kind !== "image").map(
                (field) => html`
                  <label class="profile__form-row">
                    <span class="profile__form-label">
                      ${labelFor(field.key)}
                      ${"optional" in field && field.optional
                        ? html`<span class="profile__optional"
                            >${t("profile.basics.optional")}</span
                          >`
                        : nothing}
                    </span>
                    <input
                      class="input"
                      name=${field.key}
                      type=${field.kind === "number" ? "number" : "text"}
                      .value=${valueOf(member, field)}
                      autocomplete="off"
                    />
                  </label>
                `,
              )}
              ${renderAvatarUpload(state, member, props)}
              <div class="profile__form-actions">
                <button type="submit" class="btn primary">${t("profile.basics.save")}</button>
                <button
                  type="button"
                  class="btn"
                  @click=${() => {
                    state.profileEditingSection = null;
                  }}
                >
                  ${t("profile.basics.cancel")}
                </button>
              </div>
              <p class="profile__managed">
                ${t("profile.basics.managed", {
                  fields: GOVERNED_FIELDS.map((key) => labelFor(key)).join(", "),
                })}
              </p>
            </form>
          `
        : html`
            <dl class="profile__fields">
              ${GOVERNED_FIELDS.map(
                (key) => html`
                  <div class="profile-field profile-field--locked">
                    <dt class="profile-field__label">
                      ${labelFor(key)}
                      <span class="profile-field__lock" aria-hidden="true">${icons.lock}</span>
                    </dt>
                    <dd class="profile-field__value">${String(member[key] ?? "").trim()}</dd>
                  </div>
                `,
              )}
              ${EDITABLE_FIELDS.map((field) =>
                renderFieldRow(member, field.key, valueOf(member, field)),
              )}
            </dl>
          `}
    </section>
  `;
}

function renderBadges(state: AppViewState, member: LabMember) {
  const badges = badgesFor(state, member);
  return html`
    <section class="profile__section">
      <h2 class="profile__section-title">${t("profile.badges.title")}</h2>
      ${badges.length
        ? html`<div class="profile__badges" data-testid="profile-badges">
            ${badges.map(
              (badge) => html`<span class="profile-badge">
                <span class="profile-badge__icon" aria-hidden="true">${icons.spark}</span>
                ${badge}
              </span>`,
            )}
          </div>`
        : html`<p class="profile__empty">${t("profile.badges.empty")}</p>`}
    </section>
  `;
}

// Only the empty fields appear. A member who has filled everything in sees the done state instead
// of an editor asking them to re-confirm what is already true.
function renderBlanks(state: AppViewState, member: LabMember, props: ProfileProps) {
  const blanks = blankFields(member);
  const total = requiredFieldCount();
  // A finished task should leave the page, not sit there announcing that it is finished. Basic info
  // above already shows every value, and Edit is how you change one.
  if (!blanks.length) {
    return nothing;
  }
  return html`
    <section class="profile__section" data-testid="profile-blanks">
      <h2 class="profile__section-title">${t("profile.blanks.title")}</h2>
      <p class="profile__section-sub">
        ${t("profile.blanks.summary", {
          count: String(total - blanks.length),
          total: String(total),
        })}
      </p>
      <form
        class="profile__form"
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          const form = event.currentTarget as HTMLFormElement;
          const data = new FormData(form);
          const fields: MemberProfileUpdate = {};
          for (const field of blanks) {
            const value = String(data.get(field.key) ?? "").trim();
            if (!value) {
              continue;
            }
            if (field.kind === "list") {
              fields[field.key] = value
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean);
            } else if (field.kind === "number") {
              const parsed = Number(value);
              if (Number.isFinite(parsed)) {
                fields.hours_per_week = parsed;
              }
            } else {
              fields[field.key] = value;
            }
          }
          if (member.id) {
            props.onSave(member.id, fields);
          }
        }}
      >
        ${blanks
          .filter((field) => field.kind !== "image")
          .map(
            (field) => html`
              <label class="profile__form-row">
                <span class="profile__form-label">${labelFor(field.key)}</span>
                <input
                  class="input"
                  name=${field.key}
                  type=${field.kind === "number" ? "number" : "text"}
                  autocomplete="off"
                />
              </label>
            `,
          )}
        <button type="submit" class="btn primary profile__save">${t("profile.blanks.save")}</button>
      </form>
    </section>
  `;
}

// Suggestions read the same blanks the form does, so advice and task never disagree.
function renderSuggestions(member: LabMember) {
  const blanks = new Set(blankFields(member).map((field) => field.key));
  const suggestions: Array<{
    id: string;
    title: string;
    body: string;
    label: string;
    href: string;
  }> = [];
  const topics = (member.research_topics ?? []).join(" ").toLowerCase();
  if (
    !topics.includes("gpu") &&
    !String(member.notes ?? "")
      .toLowerCase()
      .includes("gpu")
  ) {
    suggestions.push({
      id: "gpu",
      title: t("profile.suggestions.gpuTitle"),
      body: t("profile.suggestions.gpuBody"),
      label: t("profile.suggestions.gpuLink"),
      href: "https://github.com/akhkim/openclaw-adminbot-lab#gpu-onboarding",
    });
  }
  if (blanks.has("personal_website")) {
    suggestions.push({
      id: "website",
      title: t("profile.suggestions.websiteTitle"),
      body: t("profile.suggestions.websiteBody"),
      label: t("profile.suggestions.websiteLink"),
      href: "https://github.com/akhkim/openclaw-adminbot-lab#member-pages",
    });
  }
  if (!suggestions.length) {
    return nothing;
  }
  return html`
    <section class="profile__section" data-testid="profile-suggestions">
      <h2 class="profile__section-title">${t("profile.suggestions.title")}</h2>
      <div class="profile__suggestions">
        ${suggestions.map(
          (suggestion) => html`
            <article class="profile-suggestion">
              <h3 class="profile-suggestion__title">${suggestion.title}</h3>
              <p class="profile-suggestion__body">${suggestion.body}</p>
              <a
                class="profile-suggestion__link"
                href=${suggestion.href}
                target=${EXTERNAL_LINK_TARGET}
                rel=${buildExternalLinkRel()}
              >
                ${suggestion.label}
                <span class="profile-suggestion__icon" aria-hidden="true">
                  ${icons.externalLink}
                </span>
              </a>
            </article>
          `,
        )}
      </div>
    </section>
  `;
}

// A picture when there is one, initials when there is not -- never an empty circle.
// The picture is its own edit control: hovering (or tabbing to) it reveals a pencil, and the whole
// circle is the file picker. Discoverable where the thing being changed already is, rather than in
// a form field somewhere below it.
function renderAvatar(state: AppViewState, member: LabMember, name: string, props: ProfileProps) {
  const src = String(member.avatar_url ?? "").trim();
  return html`
    <label class="profile__avatar-slot" title=${t("profile.picture.edit")}>
      <span class="sr-only">${t("profile.picture.edit")}</span>
      ${src
        ? html`<img class="profile__avatar profile__avatar--photo" src=${src} alt="" />`
        : html`<span class="profile__avatar" aria-hidden="true">
            ${name.slice(0, 1).toUpperCase()}
          </span>`}
      <span class="profile__avatar-overlay" aria-hidden="true">${icons.penLine}</span>
      <input
        class="sr-only"
        type="file"
        accept="image/*"
        data-testid="profile-avatar-upload"
        @change=${(event: Event) => void acceptAvatarFile(state, member, props, event)}
      />
    </label>
  `;
}

function renderLinks(member: LabMember) {
  const cv = String(member.cv_url ?? "").trim();
  const socials = SOCIAL_FIELDS.map((field) => ({
    label: t(field.labelKey),
    href: String(member[field.key] ?? "").trim(),
  })).filter((link) => link.href);
  const site = String(member.personal_website ?? "").trim();
  if (!cv && !socials.length && !site) {
    return nothing;
  }
  const link = (label: string, href: string, strong = false) => html`
    <a
      class=${`profile__link ${strong ? "profile__link--strong" : ""}`}
      href=${href}
      target=${EXTERNAL_LINK_TARGET}
      rel=${buildExternalLinkRel()}
      >${label}</a
    >
  `;
  return html`
    <span class="profile__links" data-testid="profile-links">
      ${cv ? link(t("profile.social.cv"), cv, true) : nothing}
      ${site ? link(t("profile.social.website"), site) : nothing}
      ${socials.map((social) => link(social.label, social.href))}
    </span>
  `;
}

export function renderProfile(state: AppViewState, props: ProfileProps) {
  const member = findOwnMember(state);
  if (!member) {
    return html`<p class="profile__empty">${t("profile.blanks.signInRequired")}</p>`;
  }
  const name = member.name?.trim() || member.email?.trim() || "";
  return html`
    <div class="profile">
      <header class="profile__identity">
        ${renderAvatar(state, member, name, props)}
        <span class="profile__identity-copy">
          <span class="profile__name">${name}</span>
          <span class="profile__role">${member.role?.trim() || member.email?.trim()}</span>
          ${renderLinks(member)}
        </span>
      </header>
      ${renderBlanks(state, member, props)} ${renderBadges(state, member)}
      ${renderBasics(state, member, props)} ${renderSuggestions(member)}
    </div>
  `;
}
