/** Admin console body markup: the auth gate, the shell, and one section per panel. */
import { ADMINBOT_BOT_EMAIL_ENV, resolveAdminBotDriveAccount } from "../../contracts/actions.js";

// The importer account the callout tells members to share their planning doc with. Resolved here
// rather than baked into the copy so the page can never name an account this deployment does not
// actually read as; unconfigured, it says what to set instead of naming a stranger's mailbox.
function driveShareCallout(): string {
  const account = resolveAdminBotDriveAccount();
  return account
    ? `<p class="callout">Remember to share the doc with <code>${account}</code> — Viewer access is enough. Without it AdminBot cannot open the doc and the import will find nothing.</p>`
    : `<p class="callout">Planning-doc import is not configured on this deployment: set <code>${ADMINBOT_BOT_EMAIL_ENV}</code> to the Google account AdminBot reads as, then share the doc with it.</p>`;
}

export function adminBotConsoleMarkup(): string {
  return `<body>
  <div class="auth-gate" id="auth-gate" hidden>
    <div class="auth-card">
      <div class="brand"><span class="mark">A</span><span>AdminBot</span></div>
      <h1 id="auth-title">Sign in</h1>
      <p class="subtle" id="auth-subtitle">Use your lab email and password.</p>
      <form id="auth-form" autocomplete="on">
        <div id="claim-picker" hidden>
          <label>Find your profile<input id="claim-filter" type="search" autocomplete="off" placeholder="Search your name…"></label>
          <div class="roster-list" id="claim-list" role="listbox" aria-label="Unclaimed roster members"></div>
          <input type="hidden" name="member_id" id="claim-member-id">
        </div>
        <div id="signup-fields" hidden>
          <label>Name<input name="name" autocomplete="name" placeholder="Zhijing"></label>
          <label>Role<select name="role" id="signup-role"></select></label>
          <label>Affiliation<input name="affiliation" placeholder="Jinesis / MIT"></label>
          <label>Research branch<input name="research_branch" placeholder="Embodied intelligence"></label>
          <label>Research topics<input name="research_topics" placeholder="robot learning, world models"></label>
        </div>
        <label>Email<input name="email" type="email" required autocomplete="username" placeholder="name@example.edu"></label>
        <label>Password<input name="password" type="password" required autocomplete="current-password" placeholder="••••••••••"></label>
        <label id="auth-confirm-label" hidden>Confirm password<input name="confirm_password" type="password" autocomplete="new-password" placeholder="••••••••••"></label>
        <button class="button primary" type="submit" id="auth-submit">Sign in</button>
        <button class="link-button" type="button" id="auth-to-claim">First time here? Claim your profile</button>
        <button class="link-button" type="button" id="auth-to-signup">I'm not on the list — sign up</button>
        <button class="link-button" type="button" id="auth-to-login" hidden>Back to sign in</button>
        <div class="status" id="auth-status"></div>
      </form>
      <div class="auth-notice" id="auth-notice" hidden>
        <p class="subtle" id="auth-notice-text"></p>
        <button class="button primary" type="button" id="auth-notice-back">Back to sign in</button>
      </div>
    </div>
  </div>
  <div class="shell" id="app-shell" hidden>
    <aside>
      <div class="brand"><span class="mark">A</span><span>AdminBot</span></div>
      <nav aria-label="AdminBot console sections">
        <button class="tab" data-tab="deadlines">Deadlines</button>
        <button class="tab" data-tab="reimbursements">Reimbursement</button>
        <button class="tab" data-tab="members" aria-selected="true">Members</button>
        <button class="tab" data-tab="capacity">Capacity</button>
        <button class="tab" data-tab="papers">Papers</button>
        <button class="tab" data-tab="profile">My profile</button>
        <button class="tab" data-tab="actions">Actions</button>
        <button class="tab" data-tab="approvals">Approvals</button>
        <button class="tab" data-tab="settings">Settings</button>
        <button class="tab" data-tab="reviewing">Reviewing</button>
        <button class="tab" data-tab="map">Map</button>
        <button class="tab" data-tab="audit">Audit</button>
      </nav>
    </aside>
    <main>
      <header>
        <div>
          <h1 id="page-title">Members</h1>
          <p class="subtle" id="page-subtitle">Manage lab roster and privilege-derived access.</p>
        </div>
        <div class="toolbar">
          <span class="pill" id="session-identity" hidden></span>
          <button class="button" id="refresh-button" type="button">Refresh</button>
          <button class="button primary" id="signin-button" type="button" hidden>Sign in</button>
          <button class="button danger" id="signout-button" type="button">Sign out</button>
        </div>
      </header>

      <section class="section active" id="members">
        <div class="people-workspace">
          <div class="people-summary">
            <div class="people-summary-intro">
              <span class="eyebrow">Jinesis lab directory</span>
              <h2>People intelligence</h2>
              <p>Research focus, collaboration load, and active work in one living roster.</p>
            </div>
            <div class="metric"><strong id="metric-members">0</strong><span>People</span></div>
            <div class="metric"><strong id="metric-active">0</strong><span>Active</span></div>
            <div class="metric"><strong id="metric-branches">0</strong><span>Branches</span></div>
            <div class="metric"><strong id="metric-papers">0</strong><span>Live papers</span></div>
          </div>

          <div class="panel directory-panel">
            <div class="directory-heading">
              <div>
                <h2>Lab directory</h2>
                <p class="subtle">Filter by any research, project, or publication relationship.</p>
              </div>
              <span class="count" id="member-count"></span>
            </div>
            <div class="filter-bar">
              <div class="search-field"><input id="member-search" type="search" placeholder="Search people, topics, projects…" aria-label="Search members"></div>
              <select id="member-branch-filter" aria-label="Filter by research branch"></select>
              <select id="member-status-filter" aria-label="Filter by member status"></select>
              <select id="member-project-filter" aria-label="Filter by project"></select>
              <select id="member-paper-filter" aria-label="Filter by paper"></select>
              <button class="button clear-filters" id="member-clear-filters" type="button">Clear filters</button>
            </div>
            <div id="members-table"></div>
          </div>

          <details class="panel member-editor">
            <summary>Add or edit a person <span>Structured lab profile fields</span></summary>
            <form id="member-form">
              <label>Member id<input name="id" required placeholder="zhijing"></label>
              <label>Name<input name="name" required placeholder="Zhijing"></label>
              <label>Role<select name="role" id="member-role-select"></select></label>
              <label>Status<select name="status" id="member-status-select"></select></label>
              <label>Research branch<input name="research_branch" placeholder="Embodied intelligence"></label>
              <label class="wide">Research topics<input name="research_topics" placeholder="robot learning, world models"></label>
              <label>Projects<input name="projects" placeholder="Project Atlas, HomeLab"></label>
              <label>Hours / week<input name="hours_per_week" type="number" min="0" max="168" step="1" placeholder="40"></label>
              <label>Affiliation<input name="affiliation" placeholder="Jinesis / MIT"></label>
              <label>Location<input name="location" placeholder="Cambridge, MA"></label>
              <label>Timezone<input name="timezone" placeholder="America/New_York"></label>
              <label>Personal website<input name="personal_website" type="url" placeholder="https://…"></label>
              <label>Email<input name="email" type="email" placeholder="name@example.edu"></label>
              <label>Slack user id<input name="slack_user_id" placeholder="U0123456789"></label>
              <label>Privilege
                <select name="privilege_level" id="member-privilege"></select>
              </label>
              <label id="member-subgroup-field" hidden>Collaborator subgroup
                <select name="collaborator_subgroup" id="member-subgroup"></select>
              </label>
              <div class="full subgroup-access" id="member-subgroup-access" hidden></div>
              <label>OpenReview id<input name="openreview_id" placeholder="~Jane_Doe1"></label>
              <label class="checkbox-field"
                ><input type="checkbox" name="reviewer_exempt"> Never assign as an emergency reviewer
                <span class="field-hint">Standing exemption; overrides any topic match.</span>
              </label>
              <label class="full">Notes<textarea name="notes" placeholder="Free-form details and temporary access exceptions"></textarea></label>
              <div class="form-actions">
                <button class="button primary" type="submit">Save person</button>
                <button class="button" id="member-form-reset" type="reset">Clear editor</button>
                <div class="status" id="member-status"></div>
              </div>
            </form>
          </details>
        </div>
      </section>

      <section class="section" id="capacity">
        <div class="panel viz">
          <div class="viz-head">
            <h2 class="viz-title">Lab capacity</h2>
            <span class="count" id="capacity-week"></span>
          </div>
          <div class="viz-stats">
            <div class="metric"><strong id="cap-people">0</strong><span>People scheduled</span></div>
            <div class="metric"><strong id="cap-committed">0</strong><span>Committed h/wk</span></div>
            <div class="metric"><strong id="cap-open">0</strong><span>Open h/wk</span></div>
            <div class="metric"><strong id="cap-away">0</strong><span>Away this week</span></div>
          </div>
          <div class="viz-legend" id="capacity-legend"></div>
          <div class="timeline-scroll">
            <div class="timeline" id="capacity-timeline"></div>
          </div>
          <div class="viz-empty" id="capacity-empty" hidden>
            Nobody has recorded availability yet. Members add theirs under My profile.
          </div>
          <p class="viz-source" id="capacity-note"></p>
        </div>
        <div class="grid">
          <div class="panel">
            <h2>Project staffing</h2>
            <p class="subtle">Who is on what this week, and how far each commitment runs.</p>
            <div class="table-wrap">
              <table class="compact-table">
                <thead><tr><th>Project</th><th>h/wk now</th><th>People</th><th>Through</th></tr></thead>
                <tbody id="capacity-projects"></tbody>
              </table>
            </div>
          </div>
          <div class="panel">
            <h2>Capabilities</h2>
            <p class="subtle">Research expertise across the lab, from member branches and topics.</p>
            <div class="table-wrap">
              <table class="compact-table">
                <thead><tr><th>Expertise</th><th>People</th><th>Who</th></tr></thead>
                <tbody id="capacity-skills"></tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
      <section class="section" id="papers">
        <div class="grid">
          <div class="panel">
            <h2>Paper Record</h2>
            <form id="paper-form">
              <label>Paper id<input name="id" required placeholder="paper-2026-causal-planning"></label>
              <label>Title<input name="title" required placeholder="Causal Garden Planning"></label>
              <label>Authors<input name="authors" required placeholder="alice, bob"></label>
              <label>Current step<select name="current_step" id="paper-step"></select></label>
              <label>Overleaf edit URL<input name="overleaf_edit_url" placeholder="https://www.overleaf.com/..."></label>
              <label>Google Drive PDF<input name="google_drive_pdf_url" placeholder="https://drive.google.com/..."></label>
              <label>Reminder status
                <select name="reminder_status">
                  <option value="idle">idle</option>
                  <option value="waiting_on_authors">waiting_on_authors</option>
                  <option value="blocked">blocked</option>
                  <option value="complete">complete</option>
                </select>
              </label>
              <label>Last author DM at<input name="last_author_dm_at" placeholder="2026-06-09T12:00:00.000Z"></label>
              <button class="button primary" type="submit">Save paper</button>
              <div class="status" id="paper-status"></div>
            </form>
          </div>
          <div class="stack">
            <div class="panel">
              <h2>Active Paper List</h2>
              <div class="list-toolbar">
                <input id="paper-search" type="search" placeholder="Search papers or authors" aria-label="Search papers">
                <label class="inline-check"><input type="checkbox" id="paper-relevant-toggle"> Relevant to my research</label>
                <span class="count" id="paper-count"></span>
              </div>
              <div id="papers-table"></div>
            </div>
            <div class="panel">
              <h2>Due Nudges</h2>
              <div id="nudges-list"></div>
            </div>
          </div>
        </div>
      </section>

      <section class="section" id="actions">
        <div class="panel">
          <h2>Pending Actions</h2>
          <div id="actions-list"></div>
        </div>
      </section>

      <section class="section" id="settings">
        <div class="grid">
          <div class="panel">
            <h2>Defaults</h2>
            <form id="settings-form">
              <label>Paper escalation business days
                <input name="paper_escalation_business_days" type="number" min="1" step="1" required>
              </label>
              <label>Head professor member id
                <input name="head_professor_member_id" placeholder="zhijing">
              </label>
              <label>Head professor WhatsApp
                <input name="head_professor_whatsapp" placeholder="+00 0000 0000 000">
              </label>
              <label>Applicant response sheet id
                <input name="applicant_sheet_id" placeholder="1AbC...">
              </label>
              <label>Applicants last reviewed at
                <input name="applicant_last_reviewed_at" placeholder="2026-07-24T00:00:00.000Z">
              </label>
              <button class="button primary" type="submit">Save settings</button>
              <div class="status" id="settings-status"></div>
            </form>
          </div>
          <div class="panel">
            <h2>Current Settings</h2>
            <pre id="settings-json"></pre>
          </div>
        </div>
      </section>

      <section class="section" id="approvals">
        <div class="panel">
          <h2>Pending account requests</h2>
          <div class="list-toolbar">
            <span class="subtle">Approve to grant access, or reject to decline the request.</span>
            <span class="count" id="approvals-count"></span>
          </div>
          <div id="approvals-list"></div>
        </div>
      </section>

      <section class="section" id="reviewing">
        <div class="panel">
          <h2>Reviewing cycles</h2>
          <div class="list-toolbar">
            <span class="subtle">Venues discovered from OpenReview, with the reminder ladder fired so far. A run is a dry run unless you tick send.</span>
            <span class="count" id="reviewing-count"></span>
          </div>
          <div class="toolbar">
            <label class="inline"><input type="checkbox" id="reviewing-send"> Actually send due reminders</label>
            <button type="button" id="reviewing-run">Run cycle now</button>
          </div>
          <div id="reviewing-status" class="subtle"></div>
          <div id="reviewing-list"></div>
        </div>
      </section>

      <section class="section" id="map">
        <!-- The interactive map (pan/zoom, hover tooltips, real tiles) lives at its own URL so it
             can be linked to directly; embedded here rather than reimplemented so the console and
             the standalone page never drift into two different maps. It carries its own heading
             and toolbar (including both Slack actions), so this tab adds no chrome of its own
             around it. -->
        <div class="panel panel-flush">
          <iframe id="map-frame" src="/lab_stats/member_map" title="Lab member map"></iframe>
        </div>
      </section>

      <section class="section" id="audit">
        <div class="panel">
          <h2>Audit Events</h2>
          <pre id="audit-json"></pre>
        </div>
      </section>

      <section class="section" id="profile">
        <div class="panel viz">
          <div class="viz-head">
            <h2 class="viz-title" id="availability-title">Time Availability</h2>
            <div class="toggle-view">
              <button class="button" type="button" id="availability-view-timeline" aria-pressed="true">Timeline</button>
              <button class="button" type="button" id="availability-view-table" aria-pressed="false">Table</button>
            </div>
          </div>
          <p class="subtle" id="availability-updated"></p>
          <div class="viz-legend" id="availability-legend"></div>
          <div class="timeline-scroll" id="availability-timeline-wrap">
            <div class="timeline" id="availability-timeline"></div>
          </div>
          <div class="table-wrap" id="availability-table-wrap" hidden>
            <table class="compact-table">
              <thead><tr><th>From</th><th>To</th><th>Commitment</th><th>Hours / week</th><th>Note</th></tr></thead>
              <tbody id="availability-tbody"></tbody>
            </table>
          </div>
          <div class="viz-empty" id="availability-empty" hidden>
            No availability recorded yet. Add a commitment below, or import it from your planning doc in Drive.
          </div>
          <form id="schedule-form" class="sched-editor">
            <div>
              <h2>Planning doc</h2>
              <p class="subtle">Link your own availability doc in Google Drive and AdminBot can read it to prefill the rows below. Whatever it gets wrong, edit here — your edits win.</p>
              ${driveShareCallout()}
              <label>Availability doc URL
                <input name="availability_doc_url" type="url" id="availability-doc-url"
                  placeholder="https://docs.google.com/document/d/…"
                  pattern="https://(docs|drive)\\.google\\.com/.*">
              </label>
              <p class="viz-source" id="availability-doc-hint"></p>
            </div>
            <div>
              <h2>Commitments</h2>
              <p class="subtle">Weekly hours per project over a date range. Leave the project blank for a whole-term baseline, or pick “Open capacity” to declare spare hours.</p>
              <div class="sched-rows" id="availability-rows"></div>
              <button class="button" type="button" id="availability-add">Add commitment</button>
            </div>
            <div>
              <h2>Time off</h2>
              <p class="subtle">Holidays and time away from the lab for another career arrangement — a busy semester, an internship, a conference. “Partial” still counts toward capacity at a reduced rate; “none” zeroes the week.</p>
              <div class="sched-rows" id="time-off-rows"></div>
              <button class="button" type="button" id="time-off-add">Add time off</button>
            </div>
            <div>
              <button class="button primary" type="submit">Save schedule</button>
              <div class="status" id="schedule-status"></div>
            </div>
          </form>
        </div>
        <div class="grid">
          <div class="panel">
            <h2>My profile</h2>
            <form id="profile-form">
              <label>Name<input name="name" placeholder="Zhijing"></label>
              <label>Research branch<input name="research_branch" placeholder="Embodied intelligence"></label>
              <label>Research topics<input name="research_topics" placeholder="robot learning, world models"></label>
              <label>Projects<input name="projects" placeholder="Project Atlas, HomeLab"></label>
              <label>Hours / week<input name="hours_per_week" type="number" min="0" max="168" step="1" placeholder="40"></label>
              <label>Affiliation<input name="affiliation" placeholder="Jinesis / MIT"></label>
              <label>Location<input name="location" placeholder="Cambridge, MA"></label>
              <label>Timezone<input name="timezone" placeholder="America/New_York"></label>
              <label>Personal website<input name="personal_website" type="url" placeholder="https://…"></label>
              <label>Slack user id<input name="slack_user_id" placeholder="U0123456789"></label>
              <label>Notes<textarea name="notes" placeholder="Free-form details"></textarea></label>
              <button class="button primary" type="submit">Save profile</button>
              <div class="status" id="profile-status"></div>
            </form>
          </div>
          <div class="panel">
            <h2>Change password</h2>
            <form id="password-form">
              <label>Current password<input name="current_password" type="password" required autocomplete="current-password"></label>
              <label>New password<input name="new_password" type="password" required autocomplete="new-password"></label>
              <label>Confirm new password<input name="confirm_password" type="password" required autocomplete="new-password"></label>
              <button class="button primary" type="submit">Change password</button>
              <div class="status" id="password-status"></div>
            </form>
          </div>
        </div>
      </section>
      <section class="section" id="deadlines">
        <div class="panel">
          <h2>Upcoming deadlines</h2>
          <p class="subtle">Times are AoE (UTC-12). The same board the lab channel digest reads.</p>
          <iframe class="public-frame" id="deadlines-frame" title="Deadline board" src="/deadlines"></iframe>
        </div>
      </section>

      <section class="section" id="reimbursements">
        <div class="panel">
          <h2>Reimbursement</h2>
          <p class="subtle">
            Describe the expense and AdminBot prepares the packet. Nothing here needs an account,
            and what you type is only used to fill your own forms.
          </p>
          <div class="reimb-log" id="reimb-log" aria-live="polite"></div>
          <form id="reimb-form" class="reimb-form">
            <label class="full">Your message
              <textarea name="message" rows="3" placeholder="I paid 82 CHF for a train to the EMNLP tutorial on 12 May"></textarea>
            </label>
            <div class="form-actions">
              <button class="button primary" type="submit">Send</button>
              <button class="button" type="button" id="reimb-generate">Generate packet</button>
              <button class="button" type="button" id="reimb-reset">Start over</button>
              <div class="status" id="reimb-status"></div>
            </div>
          </form>
        </div>
      </section>

    </main>
  </div>
`;
}
