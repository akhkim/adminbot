// Meeting Recordings: what was recorded, who was there, and what the local model made of it.
//
// The tab is a catch-up surface first. Someone who missed Tuesday opens it to watch the recording
// and read the summary, so those are what a card leads with; attendance is secondary and folded
// into a <details>. Two audiences share one view -- a member sees their own attendance line and a
// headcount, an admin sees the roster and can correct it -- and the difference comes from what the
// service returned, not from a branch here. `viewerIsAdmin` only decides whether the editing
// affordances render; it is never what keeps a roster off a member's screen.
//
// The forms are uncontrolled and read through FormData on submit. Every other draft in this UI is
// held in AppViewState so a re-render cannot wipe half-typed input, but that rule exists for
// surfaces that re-render underneath the typist (a roster reloading, a notice arriving). Nothing
// polls here: the list is fetched once when the tab opens, so the DOM is a safe place for the two
// fields of an admin's recovery form.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import type { MeetingAttendee, MeetingRecord } from "../auth/session.ts";

export type MeetingsRosterMember = { id: string; name: string };

export type AdminBotMeetingsProps = {
  meetings: MeetingRecord[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  viewerIsAdmin: boolean;
  viewerMemberId: string | null;
  /** The lab roster, for the admin attendance editor. Empty for a member, who never sees one. */
  members: MeetingsRosterMember[];
  onToggleAttendance: (meetingId: string, attendee: MeetingAttendee) => void;
  onFileMeeting: (draft: {
    topic: string;
    started_at: string;
    share_url: string;
    passcode?: string;
  }) => void;
};

function formatStart(startedAt: string): string {
  const parsed = new Date(startedAt);
  return Number.isNaN(parsed.getTime())
    ? startedAt
    : parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function formatDuration(meeting: MeetingRecord): string | undefined {
  const minutes =
    meeting.duration_minutes ??
    (meeting.transcript?.duration_seconds
      ? Math.round(meeting.transcript.duration_seconds / 60)
      : undefined);
  return minutes ? t("adminbotMeetings.minutes", { minutes: String(minutes) }) : undefined;
}

/**
 * The passcode, rendered as text next to the link rather than appended to it.
 *
 * Zoom's own share mail puts them side by side, and a passcode pasted into the URL only works for
 * some link shapes. Showing it plainly is the version that works every time -- and it is already
 * behind a member session, so nothing is being revealed here that the page has not already earned.
 */
function renderRecordingLinks(meeting: MeetingRecord) {
  return html`
    <div class="meetings__links">
      ${meeting.recording.share_url
        ? html`<a
            class="btn btn--sm"
            href=${meeting.recording.share_url}
            target="_blank"
            rel="noreferrer noopener"
            >${t("adminbotMeetings.openZoom")}</a
          >`
        : nothing}
      ${meeting.recording.drive_url
        ? html`<a
            class="btn btn--sm"
            href=${meeting.recording.drive_url}
            target="_blank"
            rel="noreferrer noopener"
            >${t("adminbotMeetings.openDrive")}</a
          >`
        : nothing}
      ${meeting.recording.passcode
        ? html`<span class="muted"
            >${t("adminbotMeetings.passcode")}
            <code class="ab-num">${meeting.recording.passcode}</code></span
          >`
        : nothing}
    </div>
  `;
}

function renderSummary(meeting: MeetingRecord) {
  if (!meeting.summary) {
    return html`<p class="muted">
      ${meeting.transcript
        ? t("adminbotMeetings.summaryPending")
        : t("adminbotMeetings.noTranscript")}
    </p>`;
  }
  const summary = meeting.summary;
  return html`
    <p class="meetings__overview">${summary.overview}</p>
    ${summary.decisions.length
      ? html`
          <h4 class="meetings__subhead">${t("adminbotMeetings.decisions")}</h4>
          <ul class="meetings__list">
            ${summary.decisions.map((decision) => html`<li>${decision}</li>`)}
          </ul>
        `
      : nothing}
    ${summary.action_items.length
      ? html`
          <h4 class="meetings__subhead">${t("adminbotMeetings.actionItems")}</h4>
          <ul class="meetings__list">
            ${summary.action_items.map(
              (item) => html`
                <li>
                  ${item.text}
                  ${item.owner_name
                    ? html`<span class="muted"> — ${item.owner_name}</span>`
                    : nothing}
                </li>
              `,
            )}
          </ul>
        `
      : nothing}
    <!-- Said plainly, every time. A reader who does not know a summary is machine-written will
         take a transcription error for a quote from a colleague. -->
    <p class="muted meetings__provenance">
      ${t("adminbotMeetings.generatedBy", { model: summary.model })}
    </p>
  `;
}

function attendanceSourceLabel(source: MeetingAttendee["source"]): string {
  if (source === "participant_report") {
    return t("adminbotMeetings.sourceReport");
  }
  return source === "transcript"
    ? t("adminbotMeetings.sourceTranscript")
    : t("adminbotMeetings.sourceManual");
}

/** The member's own view: were you there, and how many people were. */
function renderOwnAttendance(meeting: MeetingRecord) {
  const own = meeting.attendees?.find((attendee) => attendee.present);
  const count = meeting.attendee_count;
  return html`
    <p class="muted">
      ${own ? t("adminbotMeetings.youAttended") : t("adminbotMeetings.youDidNotAttend")}
      ${typeof count === "number"
        ? html` · ${t("adminbotMeetings.headcount", { count: String(count) })}`
        : nothing}
    </p>
  `;
}

/**
 * The admin roster editor.
 *
 * Every member is listed, not only the ones an import found: the whole point of the editor is the
 * person who was there and whom nothing detected, and a list that only shows detected attendees
 * cannot express them. The source tag beside each tick is what tells an admin which lines are worth
 * checking -- a transcript-sourced roster is a list of who talked, nothing more.
 */
function renderRosterEditor(props: AdminBotMeetingsProps, meeting: MeetingRecord) {
  const byMember = new Map(
    (meeting.attendees ?? [])
      .filter((attendee) => attendee.member_id)
      .map((attendee) => [attendee.member_id as string, attendee]),
  );
  const guests = (meeting.attendees ?? []).filter((attendee) => !attendee.member_id);
  return html`
    <table class="meetings__roster">
      <tbody>
        ${props.members.map((member) => {
          const attendee = byMember.get(member.id);
          const present = Boolean(attendee?.present);
          return html`
            <tr>
              <td>
                <label class="meetings__tick">
                  <input
                    type="checkbox"
                    .checked=${present}
                    ?disabled=${props.saving}
                    @change=${() =>
                      props.onToggleAttendance(meeting.id, {
                        member_id: member.id,
                        display_name: attendee?.display_name ?? member.name,
                        source: "manual",
                        present: !present,
                      })}
                  />
                  ${member.name}
                </label>
              </td>
              <td class="muted">
                ${attendee ? attendanceSourceLabel(attendee.source) : nothing}
                ${attendee?.minutes
                  ? html` · ${t("adminbotMeetings.minutes", { minutes: String(attendee.minutes) })}`
                  : nothing}
              </td>
            </tr>
          `;
        })}
      </tbody>
    </table>
    ${guests.length
      ? html`<p class="muted">
          ${t("adminbotMeetings.guests", {
            names: guests.map((guest) => guest.display_name).join(", "),
          })}
        </p>`
      : nothing}
  `;
}

function renderMeeting(props: AdminBotMeetingsProps, meeting: MeetingRecord) {
  const duration = formatDuration(meeting);
  return html`
    <article class="card adminbot-card adminbot-card--wide meetings__card">
      <h3 class="card-title">${meeting.topic}</h3>
      <p class="card-sub">
        ${formatStart(meeting.started_at)}${duration ? html` · ${duration}` : nothing}
      </p>
      ${renderRecordingLinks(meeting)} ${renderSummary(meeting)}
      <details class="meetings__attendance">
        <summary>${t("adminbotMeetings.attendance")}</summary>
        ${props.viewerIsAdmin
          ? renderRosterEditor(props, meeting)
          : renderOwnAttendance(meeting)}
      </details>
      ${meeting.notes ? html`<p class="muted">${meeting.notes}</p>` : nothing}
    </article>
  `;
}

/**
 * The admin's recovery form.
 *
 * Present because the automatic path has one failure mode nobody can fix from inside the system: a
 * host whose account never forwarded the notice. Without this the meeting is simply missing from
 * the lab's record, and there is nothing an admin can do about it from here.
 */
function renderFileForm(props: AdminBotMeetingsProps) {
  const submit = (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    // FormData yields File as well as string; a text field never produces one, but reading it as
    // a string regardless is what turns "[object File]" into an empty field instead of a value.
    const field = (name: string): string => {
      const value = data.get(name);
      return typeof value === "string" ? value.trim() : "";
    };
    const topic = field("topic");
    const startedAt = field("started_at");
    const shareUrl = field("share_url");
    const passcode = field("passcode");
    if (!topic || !startedAt || !shareUrl) {
      return;
    }
    props.onFileMeeting({
      topic,
      // A datetime-local field is wall-clock in the reader's own zone, which is where the meeting
      // happened; converting through Date is what turns it into the instant the record stores.
      started_at: new Date(startedAt).toISOString(),
      share_url: shareUrl,
      ...(passcode ? { passcode } : {}),
    });
    form.reset();
  };
  return html`
    <details class="card adminbot-card adminbot-card--wide meetings__file">
      <summary>${t("adminbotMeetings.fileManually")}</summary>
      <p class="card-sub">${t("adminbotMeetings.fileManuallyHint")}</p>
      <form @submit=${submit}>
        <label>${t("adminbotMeetings.topic")} <input name="topic" required /></label>
        <label>
          ${t("adminbotMeetings.startedAt")}
          <input name="started_at" type="datetime-local" required />
        </label>
        <label>
          ${t("adminbotMeetings.shareUrl")}
          <input name="share_url" type="url" required />
        </label>
        <label>${t("adminbotMeetings.passcode")} <input name="passcode" /></label>
        <button class="btn btn--sm" type="submit" ?disabled=${props.saving}>
          ${t("adminbotMeetings.file")}
        </button>
      </form>
    </details>
  `;
}

export function renderAdminBotMeetings(props: AdminBotMeetingsProps) {
  return html`
    <section class="meetings">
      ${props.error ? html`<p class="notice notice--error">${props.error}</p>` : nothing}
      ${props.viewerIsAdmin ? renderFileForm(props) : nothing}
      ${props.loading && props.meetings.length === 0
        ? html`<p class="muted">${t("adminbotMeetings.loading")}</p>`
        : nothing}
      ${!props.loading && props.meetings.length === 0
        ? html`<p class="muted">${t("adminbotMeetings.empty")}</p>`
        : nothing}
      ${props.meetings.map((meeting) => renderMeeting(props, meeting))}
    </section>
  `;
}
