export function renderAdminBotWebUi(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AdminBot Console</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --panel-alt: #eef2f6;
      --text: #17202a;
      --muted: #66717e;
      --line: #d8dee6;
      --accent: #176b87;
      --accent-strong: #0d4f66;
      --warn: #9f5b12;
      --danger: #a83b38;
      --ok: #31724a;
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.45;
    }
    button, input, select, textarea {
      font: inherit;
    }
    .shell {
      display: grid;
      grid-template-columns: 236px minmax(0, 1fr);
      min-height: 100vh;
    }
    aside {
      border-right: 1px solid var(--line);
      background: #101820;
      color: #edf3f7;
      padding: 24px 18px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 24px;
      font-size: 18px;
      font-weight: 700;
    }
    .mark {
      display: inline-grid;
      place-items: center;
      width: 32px;
      height: 32px;
      border-radius: 8px;
      background: #33a6b8;
      color: #071015;
      font-weight: 800;
    }
    nav {
      display: grid;
      gap: 6px;
    }
    .tab {
      width: 100%;
      border: 0;
      border-radius: 6px;
      padding: 10px 12px;
      background: transparent;
      color: #b9c6cf;
      text-align: left;
      cursor: pointer;
    }
    .tab[aria-selected="true"], .tab:hover {
      background: #22303a;
      color: #ffffff;
    }
    main {
      min-width: 0;
      padding: 24px;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 20px;
    }
    h1 {
      margin: 0;
      font-size: 24px;
      line-height: 1.15;
      letter-spacing: 0;
    }
    .subtle {
      color: var(--muted);
      margin: 4px 0 0;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .button {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel);
      color: var(--text);
      min-height: 36px;
      padding: 8px 12px;
      cursor: pointer;
    }
    .button.primary {
      border-color: var(--accent);
      background: var(--accent);
      color: #ffffff;
    }
    .button.primary:hover {
      background: var(--accent-strong);
    }
    .button.danger {
      border-color: color-mix(in srgb, var(--danger) 45%, var(--line));
      color: var(--danger);
    }
    .button.small {
      min-height: 30px;
      padding: 5px 9px;
      font-size: 12px;
    }
    .grid {
      display: grid;
      grid-template-columns: minmax(280px, 400px) minmax(0, 1fr);
      gap: 16px;
      align-items: start;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
    }
    .panel h2 {
      margin: 0 0 14px;
      font-size: 16px;
      line-height: 1.2;
      letter-spacing: 0;
    }
    form {
      display: grid;
      gap: 12px;
    }
    label {
      display: grid;
      gap: 5px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
    }
    input, select, textarea {
      width: 100%;
      min-height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #ffffff;
      color: var(--text);
      padding: 8px 10px;
    }
    textarea {
      min-height: 72px;
      resize: vertical;
    }
    .row {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 760px;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 10px 8px;
      text-align: left;
      vertical-align: top;
      overflow-wrap: anywhere;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      background: var(--panel-alt);
      position: sticky;
      top: 0;
      z-index: 1;
    }
    .table-wrap {
      max-height: calc(100vh - 190px);
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 6px;
    }
    .list-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
    }
    .list-toolbar input { max-width: 320px; }
    .count { color: var(--muted); white-space: nowrap; }
    .cell-details { color: var(--muted); font-size: 12px; }
    .people-workspace {
      display: grid;
      gap: 14px;
    }
    .people-summary {
      display: grid;
      grid-template-columns: minmax(240px, 1.5fr) repeat(4, minmax(120px, .7fr));
      overflow: hidden;
      border: 1px solid #273240;
      border-radius: 14px;
      background:
        radial-gradient(circle at 12% -20%, rgba(61, 194, 178, .2), transparent 34%),
        linear-gradient(135deg, #111b26, #172330);
      color: #f4f8fa;
      box-shadow: 0 18px 50px rgba(23, 32, 42, .12);
    }
    .people-summary-intro,
    .metric {
      min-height: 112px;
      padding: 20px;
    }
    .people-summary-intro {
      display: grid;
      align-content: center;
      gap: 7px;
      border-right: 1px solid rgba(255, 255, 255, .1);
    }
    .eyebrow {
      color: #73d8cb;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: .13em;
      text-transform: uppercase;
    }
    .people-summary h2 {
      margin: 0;
      font-size: 21px;
      letter-spacing: -.025em;
    }
    .people-summary p {
      margin: 0;
      color: #aebbc6;
      font-size: 12px;
    }
    .metric {
      display: grid;
      align-content: center;
      gap: 4px;
      border-right: 1px solid rgba(255, 255, 255, .08);
    }
    .metric:last-child { border-right: 0; }
    .metric strong {
      font-size: 28px;
      line-height: 1;
      letter-spacing: -.04em;
    }
    .metric span {
      color: #aebbc6;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .04em;
      text-transform: uppercase;
    }
    .directory-panel {
      padding: 0;
      overflow: hidden;
      border-radius: 12px;
    }
    .directory-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 18px 14px;
    }
    .directory-heading h2 { margin-bottom: 4px; }
    .filter-bar {
      display: grid;
      grid-template-columns: minmax(220px, 1.65fr) repeat(4, minmax(130px, 1fr)) auto;
      gap: 8px;
      padding: 0 18px 16px;
    }
    .filter-bar input,
    .filter-bar select {
      min-height: 38px;
      border-color: #ccd4dd;
      background: #f8fafb;
      font-size: 12px;
    }
    .search-field {
      position: relative;
    }
    .search-field input { padding-left: 34px; }
    .search-field::before {
      content: "⌕";
      position: absolute;
      left: 12px;
      top: 6px;
      z-index: 1;
      color: #65717d;
      font-size: 20px;
      line-height: 1;
    }
    .clear-filters { white-space: nowrap; }
    .people-table-wrap {
      max-height: calc(100vh - 350px);
      min-height: 280px;
      overflow: auto;
      border-top: 1px solid #24313b;
      background: #0c1116;
    }
    .people-table {
      width: 1640px;
      min-width: 1440px;
      table-layout: fixed;
      color: #dce5ea;
      font-size: 12px;
    }
    .people-table th {
      top: 0;
      border-color: #33413d;
      background: #aebbb2;
      color: #101714;
      padding: 10px 12px;
      font-size: 11px;
      letter-spacing: .02em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .people-table th:nth-child(1) { width: 210px; }
    .people-table th:nth-child(2) { width: 180px; }
    .people-table th:nth-child(3) { width: 110px; }
    .people-table th:nth-child(4) { width: 190px; }
    .people-table th:nth-child(5) { width: 220px; }
    .people-table th:nth-child(6) { width: 190px; }
    .people-table th:nth-child(7) { width: 260px; }
    .people-table th:nth-child(8) { width: 130px; }
    .people-table th:nth-child(9) { width: 160px; }
    .people-table th:nth-child(10) { width: 110px; }
    .people-table td {
      height: 58px;
      border-color: #1c252c;
      padding: 9px 12px;
      vertical-align: middle;
    }
    .people-table tbody tr:nth-child(even) { background: #0f151b; }
    .people-table tbody tr:hover { background: #162028; }
    .person-cell {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 180px;
    }
    .avatar {
      display: grid;
      place-items: center;
      flex: 0 0 32px;
      width: 32px;
      height: 32px;
      border: 1px solid rgba(255,255,255,.08);
      border-radius: 10px;
      background: linear-gradient(135deg, #295a64, #3a7f76);
      color: #fff;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: .04em;
    }
    .person-meta { min-width: 0; }
    .person-meta strong { color: #fff; }
    .person-meta span {
      display: block;
      overflow: hidden;
      color: #8797a3;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tag-list {
      display: flex;
      align-items: center;
      gap: 5px;
      max-width: 270px;
      overflow: hidden;
    }
    .data-tag {
      display: inline-flex;
      align-items: center;
      max-width: 160px;
      min-height: 23px;
      padding: 3px 8px;
      overflow: hidden;
      border: 1px solid #33414b;
      border-radius: 999px;
      background: #182129;
      color: #c9d5db;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .data-tag.project { border-color: #3e3a58; background: #211e31; color: #c9bdf2; }
    .data-tag.paper { border-color: #254a4c; background: #142b2c; color: #91d9d0; }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      padding: 4px 9px;
      background: #17211e;
      color: #77d1a0;
      font-weight: 700;
      white-space: nowrap;
    }
    .status-pill::before {
      content: "";
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }
    .status-pill.part_time { color: #e5bd62; }
    .status-pill.on_leave { color: #85b8ef; }
    .status-pill.alumni,
    .status-pill.external { color: #9aa8b2; }
    .capacity {
      display: grid;
      grid-template-columns: 42px 72px;
      align-items: center;
      gap: 8px;
      white-space: nowrap;
    }
    .capacity-track {
      height: 5px;
      overflow: hidden;
      border-radius: 99px;
      background: #283139;
    }
    .capacity-track span {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, #49bba9, #78d5aa);
    }
    .empty-row {
      height: 170px !important;
      color: #84949f;
      text-align: center;
    }
    .member-editor {
      padding: 0;
      overflow: hidden;
    }
    .member-editor summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 15px 18px;
      cursor: pointer;
      font-weight: 750;
      list-style: none;
    }
    .member-editor summary::-webkit-details-marker { display: none; }
    .member-editor summary span {
      color: var(--muted);
      font-size: 12px;
      font-weight: 500;
    }
    .member-editor form {
      grid-template-columns: repeat(4, minmax(0, 1fr));
      padding: 0 18px 18px;
    }
    .member-editor .wide { grid-column: span 2; }
    .member-editor .full { grid-column: 1 / -1; }
    .member-editor .form-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      grid-column: 1 / -1;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      border-radius: 999px;
      padding: 3px 8px;
      background: #e6f3f5;
      color: var(--accent-strong);
      font-size: 12px;
      font-weight: 700;
    }
    .status {
      min-height: 22px;
      color: var(--muted);
    }
    .status.error { color: var(--danger); }
    .status.ok { color: var(--ok); }
    .section { display: none; }
    .section.active { display: block; }
    .stack {
      display: grid;
      gap: 12px;
    }
    .action {
      display: grid;
      gap: 8px;
      border-bottom: 1px solid var(--line);
      padding: 12px 0;
    }
    .action:first-child { padding-top: 0; }
    .action:last-child { border-bottom: 0; padding-bottom: 0; }
    code {
      border-radius: 4px;
      background: #edf1f5;
      padding: 2px 4px;
      font-size: 12px;
    }
    pre {
      margin: 0;
      max-height: 360px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #111820;
      color: #dfe8ee;
      padding: 12px;
      white-space: pre-wrap;
    }
    @media (max-width: 860px) {
      .shell { grid-template-columns: 1fr; }
      aside {
        position: sticky;
        top: 0;
        z-index: 1;
        padding: 14px;
      }
      .brand { margin-bottom: 12px; }
      nav {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      .tab {
        text-align: center;
        padding-inline: 8px;
      }
      main { padding: 16px; }
      header { align-items: flex-start; flex-direction: column; }
      .grid { grid-template-columns: 1fr; }
      .row { grid-template-columns: 1fr; }
      .people-summary { grid-template-columns: repeat(2, 1fr); }
      .people-summary-intro { grid-column: 1 / -1; }
      .filter-bar { grid-template-columns: 1fr 1fr; }
      .member-editor form { grid-template-columns: 1fr 1fr; }
    }
    .auth-gate {
      display: grid;
      place-items: center;
      min-height: 100vh;
      padding: 24px;
    }
    .auth-card {
      width: 100%;
      max-width: 380px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 24px;
      box-shadow: 0 18px 50px rgba(23, 32, 42, .12);
    }
    .auth-card .brand { color: var(--text); }
    .auth-card h1 { font-size: 20px; margin: 0 0 4px; }
    .auth-card .subtle { margin: 0 0 16px; }
    .inline-check {
      display: flex;
      align-items: center;
      flex-direction: row;
      gap: 6px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
      white-space: nowrap;
    }
    .inline-check input {
      width: auto;
      min-height: 0;
      margin: 0;
    }
    .link-button {
      border: 0;
      background: transparent;
      color: var(--accent);
      padding: 0;
      cursor: pointer;
      text-align: left;
      font-size: 12px;
      justify-self: start;
    }
    .link-button:hover { text-decoration: underline; }
    .roster-list {
      display: grid;
      gap: 4px;
      max-height: 190px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 6px;
      background: #f8fafb;
    }
    .roster-option {
      width: 100%;
      border: 1px solid transparent;
      border-radius: 5px;
      background: transparent;
      color: var(--text);
      text-align: left;
      padding: 7px 9px;
      cursor: pointer;
    }
    .roster-option:hover { background: #eef2f6; }
    .roster-option.selected {
      border-color: var(--accent);
      background: #e6f3f5;
      color: var(--accent-strong);
      font-weight: 700;
    }
    .roster-empty { color: var(--muted); font-size: 12px; padding: 6px 3px; }
    .auth-notice {
      display: grid;
      gap: 14px;
    }
    .auth-notice .subtle { margin: 0; }
    .approval-request {
      display: grid;
      gap: 6px;
      border-bottom: 1px solid var(--line);
      padding: 14px 0;
    }
    .approval-request:first-child { padding-top: 0; }
    .approval-request:last-child { border-bottom: 0; padding-bottom: 0; }
    .approval-request .req-head {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
  </style>
</head>
<body>
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
        <button class="tab" data-tab="members" aria-selected="true">Members</button>
        <button class="tab" data-tab="papers">Papers</button>
        <button class="tab" data-tab="profile">My profile</button>
        <button class="tab" data-tab="actions">Actions</button>
        <button class="tab" data-tab="approvals">Approvals</button>
        <button class="tab" data-tab="settings">Settings</button>
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
              <label>Role / career stage<input name="role" placeholder="Research scientist"></label>
              <label>Status<select name="status" id="member-status-select"></select></label>
              <label>Research branch<input name="research_branch" placeholder="Embodied intelligence"></label>
              <label class="wide">Research topics<input name="research_topics" placeholder="robot learning, world models"></label>
              <label>Projects<input name="projects" placeholder="Project Atlas, HomeLab"></label>
              <label>Hours / week<input name="hours_per_week" type="number" min="0" max="168" step="1" placeholder="40"></label>
              <label>Capacity %<input name="capacity_percent" type="number" min="0" max="100" step="1" placeholder="80"></label>
              <label>Affiliation<input name="affiliation" placeholder="Jinesis / MIT"></label>
              <label>Location<input name="location" placeholder="Cambridge, MA"></label>
              <label>Timezone<input name="timezone" placeholder="America/New_York"></label>
              <label>Personal website<input name="personal_website" type="url" placeholder="https://…"></label>
              <label>Email<input name="email" type="email" placeholder="name@example.edu"></label>
              <label>Slack user id<input name="slack_user_id" placeholder="U0123456789"></label>
              <label>Privilege
                <select name="privilege_level" id="member-privilege"></select>
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

      <section class="section" id="audit">
        <div class="panel">
          <h2>Audit Events</h2>
          <pre id="audit-json"></pre>
        </div>
      </section>

      <section class="section" id="profile">
        <div class="grid">
          <div class="panel">
            <h2>My profile</h2>
            <form id="profile-form">
              <label>Name<input name="name" placeholder="Zhijing"></label>
              <label>Research branch<input name="research_branch" placeholder="Embodied intelligence"></label>
              <label>Research topics<input name="research_topics" placeholder="robot learning, world models"></label>
              <label>Projects<input name="projects" placeholder="Project Atlas, HomeLab"></label>
              <div class="row">
                <label>Hours / week<input name="hours_per_week" type="number" min="0" max="168" step="1" placeholder="40"></label>
                <label>Capacity %<input name="capacity_percent" type="number" min="0" max="100" step="1" placeholder="80"></label>
              </div>
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
    </main>
  </div>
  <script>
    const privilegeLevels = ["external_collaborator", "trial", "member", "core_member", "admin"];
    const paperSteps = [
      "brainstorming_docs",
      "overleaf_writing",
      "submission",
      "google_drive_pdf",
      "arxiv_polish",
      "social_posts",
      "slide_making",
      "poster_making"
    ];
    const sectionCopy = {
      members: ["Members", "Manage lab roster and privilege-derived access."],
      papers: ["Papers", "Track active paper pipeline state, links, and reminders."],
      profile: ["My profile", "Update your own profile and account password."],
      actions: ["Actions", "Review approval-gated AdminBot proposals."],
      approvals: ["Approvals", "Review and decide pending account requests."],
      settings: ["Settings", "Set roster and paper reminder defaults."],
      audit: ["Audit", "Inspect local AdminBot service events."]
    };
    // Session member is held only in memory for the lifetime of the page; the HttpOnly cookie is
    // the real credential, so no token or gateway secret is placed in JS-accessible web storage.
    let sessionMember = null;
    const state = {
      settings: null,
      members: [],
      papers: [],
      relevantPapers: [],
      papersRelevantOnly: false,
      nudges: [],
      proposals: [],
      audit: [],
      registrations: [],
      roster: [],
      memberQuery: "",
      paperQuery: "",
      memberFilters: {
        branch: "",
        status: "",
        project: "",
        paper: ""
      }
    };

    function optionList(values, selected, blankLabel) {
      const blank = blankLabel ? '<option value="">' + blankLabel + '</option>' : "";
      return blank + values.map((value) =>
        '<option value="' + value + '"' + (value === selected ? " selected" : "") + '>' + value + '</option>'
      ).join("");
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }

    async function api(path, options) {
      const response = await fetch(path, {
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          ...(options?.body ? { "Content-Type": "application/json" } : {})
        },
        ...options
      });
      const text = await response.text();
      const body = text.trim() ? JSON.parse(text) : null;
      if (!response.ok) {
        throw new Error(body?.error?.message || response.statusText);
      }
      return body;
    }

    async function refresh() {
      const [settings, members, papers, nudges, pending, audit] = await Promise.all([
        api("/settings"),
        api("/lab/members"),
        api("/papers"),
        api("/papers/nudges"),
        api("/proposals/pending?limit=50"),
        api("/audit")
      ]);
      state.settings = settings;
      state.members = members.members || [];
      state.papers = papers.papers || [];
      state.nudges = nudges.nudges || [];
      state.proposals = pending.proposals || [];
      state.audit = audit.events || [];
      // Registration review is admin/core_member only; skip the fetch for members who would just 403.
      if (isPrivileged()) {
        try {
          const registrations = await api("/auth/registrations?status=pending");
          state.registrations = registrations.registrations || [];
        } catch {
          state.registrations = [];
        }
      } else {
        state.registrations = [];
      }
      render();
    }

    function render() {
      document.getElementById("member-privilege").innerHTML = optionList(
        privilegeLevels,
        "external_collaborator"
      );
      document.getElementById("member-status-select").innerHTML = optionList(memberStatuses, "active");
      document.getElementById("paper-step").innerHTML = optionList(paperSteps, "brainstorming_docs");
      document.querySelector('[name="paper_escalation_business_days"]').value =
        state.settings?.paper_escalation_business_days || 3;
      document.querySelector('[name="head_professor_member_id"]').value =
        state.settings?.head_professor_member_id || "";
      document.querySelector('[name="applicant_sheet_id"]').value =
        state.settings?.applicant_sheet_id || "";
      document.querySelector('[name="applicant_last_reviewed_at"]').value =
        state.settings?.applicant_last_reviewed_at || "";
      renderMembers();
      renderPapers();
      renderActions();
      renderApprovals();
      document.getElementById("settings-json").textContent = JSON.stringify(state.settings, null, 2);
      document.getElementById("audit-json").textContent = JSON.stringify(state.audit, null, 2);
    }

    function renderMembers() {
      const profiles = state.members.map(memberProfile);
      const branchValues = uniqueValues(profiles.map((profile) => profile.branch));
      const projectValues = uniqueValues(profiles.flatMap((profile) => profile.projects));
      const paperValues = uniqueValues(state.papers.map((paper) => paper.title));
      setFilterOptions("member-branch-filter", branchValues, state.memberFilters.branch, "All branches");
      setFilterOptions("member-status-filter", memberStatuses, state.memberFilters.status, "All statuses", humanize);
      setFilterOptions("member-project-filter", projectValues, state.memberFilters.project, "All projects");
      setFilterOptions("member-paper-filter", paperValues, state.memberFilters.paper, "All papers");

      const query = state.memberQuery.trim().toLowerCase();
      const members = profiles.filter((profile) => {
        const matchesQuery = !query || [
          profile.member.name,
          profile.member.id,
          profile.member.email,
          profile.member.slack_user_id,
          profile.member.privilege_level,
          profile.role,
          profile.branch,
          profile.affiliation,
          profile.location,
          profile.timezone,
          ...profile.topics,
          ...profile.projects,
          ...profile.papers.map((paper) => paper.title)
        ].some((value) => String(value || "").toLowerCase().includes(query));
        return matchesQuery &&
          (!state.memberFilters.branch || profile.branch === state.memberFilters.branch) &&
          (!state.memberFilters.status || profile.status === state.memberFilters.status) &&
          (!state.memberFilters.project || profile.projects.includes(state.memberFilters.project)) &&
          (!state.memberFilters.paper || profile.papers.some((paper) => paper.title === state.memberFilters.paper));
      });

      document.getElementById("metric-members").textContent = String(profiles.length);
      document.getElementById("metric-active").textContent =
        String(profiles.filter((profile) => profile.status === "active").length);
      document.getElementById("metric-branches").textContent = String(branchValues.length);
      document.getElementById("metric-papers").textContent =
        String(state.papers.filter((paper) => paper.reminder?.status !== "complete").length);
      document.getElementById("member-count").textContent =
        members.length === profiles.length ? profiles.length + " people" : members.length + " of " + profiles.length;

      const rows = members.map((profile) => {
        const member = profile.member;
        const topicTags = renderTags(profile.topics, "topic", 2);
        const projectTags = renderTags(profile.projects, "project", 2);
        const paperTags = renderTags(profile.papers.map((paper) => paper.title), "paper", 2);
        const initials = member.name.split(/\\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
        const capacity = profile.capacity === null ? "—" : profile.capacity + "%";
        const capacityWidth = profile.capacity === null ? 0 : Math.max(0, Math.min(100, profile.capacity));
        const hours = profile.hours === null ? "—" : profile.hours + "h";
        return '<tr data-edit-member="' + escapeHtml(member.id) + '">' +
          '<td><div class="person-cell"><span class="avatar">' + escapeHtml(initials) + '</span><div class="person-meta"><strong>' + escapeHtml(member.name) + '</strong><span>' + escapeHtml(member.email || member.id) + '</span></div></div></td>' +
          '<td><strong>' + escapeHtml(profile.role || "—") + '</strong><br><span class="cell-details">' + escapeHtml(profile.affiliation || "") + '</span></td>' +
          '<td><span class="status-pill ' + escapeHtml(profile.status) + '">' + escapeHtml(humanize(profile.status)) + '</span></td>' +
          '<td><strong>' + escapeHtml(profile.branch || "Unassigned") + '</strong></td>' +
          '<td>' + topicTags + '</td>' +
          '<td>' + projectTags + '</td>' +
          '<td>' + paperTags + '</td>' +
          '<td><div class="capacity"><span>' + escapeHtml(hours) + '</span><div class="capacity-track" title="' + escapeHtml(capacity) + ' capacity"><span style="width:' + capacityWidth + '%"></span></div></div></td>' +
          '<td>' + escapeHtml(profile.location || "—") + '<br><span class="cell-details">' + escapeHtml(profile.timezone || "") + '</span></td>' +
          '<td><span class="data-tag">' + escapeHtml(humanize(member.privilege_level)) + '</span></td>' +
        '</tr>';
      }).join("");
      document.getElementById("members-table").innerHTML =
        '<div class="people-table-wrap"><table class="people-table"><thead><tr>' +
        '<th>Person</th><th>Role</th><th>Status</th><th>Research branch</th><th>Topics</th>' +
        '<th>Projects</th><th>Papers</th><th>Availability</th><th>Location</th><th>Access</th>' +
        '</tr></thead><tbody>' +
        (rows || '<tr><td class="empty-row" colspan="10">No people match these filters.</td></tr>') +
        '</tbody></table></div>';
    }

    function noteValue(member, key) {
      const prefix = key.toLowerCase() + ":";
      const line = String(member.notes || "").split("\\n").find((entry) =>
        entry.toLowerCase().startsWith(prefix));
      return line ? line.slice(key.length + 1).trim() : "";
    }

    function listValue(value, fallback) {
      const source = Array.isArray(value) ? value : String(value || fallback || "").split(",");
      return source.map((entry) => String(entry).trim()).filter(Boolean);
    }

    function memberProfile(member) {
      const identities = [member.id, member.name, member.email]
        .map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);
      const papers = state.papers.filter((paper) => (paper.authors || []).some((author) =>
        identities.includes(String(author).trim().toLowerCase())));
      const rawCapacity = member.capacity_percent ?? noteValue(member, "Capacity");
      const rawHours = member.hours_per_week ?? noteValue(member, "Hours per week");
      return {
        member,
        role: member.role || noteValue(member, "Career stage") || noteValue(member, "Role"),
        status: member.status || normalizeStatus(noteValue(member, "Status")) || "active",
        branch: member.research_branch || noteValue(member, "Research branch") || noteValue(member, "Research topic"),
        topics: listValue(member.research_topics, noteValue(member, "Research interests")),
        projects: listValue(member.projects, noteValue(member, "Projects")),
        papers,
        hours: numericValue(rawHours),
        capacity: numericValue(rawCapacity),
        location: member.location || noteValue(member, "Location"),
        affiliation: member.affiliation || noteValue(member, "Affiliation") || noteValue(member, "Main affiliation"),
        timezone: member.timezone || noteValue(member, "Timezone"),
        website: member.personal_website || noteValue(member, "Personal website")
      };
    }

    function numericValue(value) {
      if (value === undefined || value === null || value === "") return null;
      const parsed = Number(String(value).replace("%", ""));
      return Number.isFinite(parsed) ? parsed : null;
    }

    function normalizeStatus(value) {
      const normalized = String(value || "").trim().toLowerCase().replace(/[ -]+/g, "_");
      return memberStatuses.includes(normalized) ? normalized : "";
    }

    function humanize(value) {
      return String(value || "").replaceAll("_", " ").replace(/\\b\\w/g, (char) => char.toUpperCase());
    }

    function uniqueValues(values) {
      return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
    }

    function setFilterOptions(id, values, selected, blankLabel, labeler = (value) => value) {
      const select = document.getElementById(id);
      select.innerHTML = '<option value="">' + escapeHtml(blankLabel) + '</option>' +
        values.map((value) => '<option value="' + escapeHtml(value) + '"' +
          (value === selected ? " selected" : "") + '>' + escapeHtml(labeler(value)) + '</option>').join("");
    }

    function renderTags(values, kind, limit) {
      if (!values.length) return '<span class="cell-details">—</span>';
      const visible = values.slice(0, limit);
      const remainder = values.length - visible.length;
      return '<div class="tag-list">' +
        visible.map((value) => '<span class="data-tag ' + kind + '" title="' + escapeHtml(value) + '">' + escapeHtml(value) + '</span>').join("") +
        (remainder ? '<span class="data-tag">+' + remainder + '</span>' : "") +
        '</div>';
    }

    function renderPapers() {
      const source = state.papersRelevantOnly ? state.relevantPapers : state.papers;
      const active = source.filter((paper) => paper.reminder?.status !== "complete");
      const query = state.paperQuery.trim().toLowerCase();
      const papers = active.filter((paper) => !query ||
        [paper.title, paper.id, paper.current_step, ...(paper.authors || [])]
          .some((value) => String(value || "").toLowerCase().includes(query)));
      document.getElementById("paper-count").textContent =
        papers.length + " active" + (papers.length === active.length ? "" : " of " + active.length);
      const rows = papers.map((paper) => '<tr>' +
        '<td><strong>' + escapeHtml(paper.title) + '</strong><br><code>' + escapeHtml(paper.id) + '</code></td>' +
        '<td><span class="pill">' + escapeHtml(paper.current_step) + '</span></td>' +
        '<td>' + escapeHtml((paper.authors || []).join(", ")) + '</td>' +
        '<td>' + escapeHtml(paper.reminder?.status || "idle") + '</td>' +
        '<td><button class="button danger small" type="button" data-delete-paper="' + escapeHtml(paper.id) + '" data-paper-title="' + escapeHtml(paper.title) + '">Delete</button></td>' +
      '</tr>').join("");
      document.getElementById("papers-table").innerHTML = '<div class="table-wrap"><table><thead><tr><th>Paper</th><th>Step</th><th>Authors</th><th>Reminder</th><th>Manage</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="5">No matching active papers.</td></tr>') + '</tbody></table></div>';
      document.getElementById("nudges-list").innerHTML = state.nudges.length
        ? state.nudges.map((nudge) => '<div class="action"><strong>' + escapeHtml(nudge.title) + '</strong><span>' + escapeHtml(nudge.message) + '</span><code>' + escapeHtml(nudge.type) + '</code></div>').join("")
        : '<p class="subtle">No due nudges.</p>';
    }

    function renderActions() {
      document.getElementById("actions-list").innerHTML = state.proposals.length
        ? state.proposals.map((proposal) => '<div class="action">' +
          '<strong>' + escapeHtml(proposal.summary) + '</strong>' +
          '<span><code>' + escapeHtml(proposal.id) + '</code> <span class="pill">' + escapeHtml(proposal.risk_tier) + '</span></span>' +
          '<span>Payload hash: <code>' + escapeHtml(proposal.payload_hash) + '</code></span>' +
          (isPrivileged() ? '<div class="toolbar">' +
            '<button class="button" type="button" data-approve="' + escapeHtml(proposal.id) + '" data-hash="' + escapeHtml(proposal.payload_hash) + '">Approve as PI</button>' +
            '<button class="button primary" type="button" data-execute="' + escapeHtml(proposal.id) + '">Execute dry-run</button>' +
          '</div>' : "") +
        '</div>').join("")
        : '<p class="subtle">No pending actions.</p>';
    }

    function formatRequestedAt(value) {
      if (!value) return "unknown date";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
    }

    function renderSignupDetails(profile, email) {
      const rows = [
        '<strong>' + escapeHtml(String(profile.name || "Unnamed applicant")) + '</strong>',
        '<span class="cell-details">New applicant · ' + escapeHtml(email) + '</span>'
      ];
      const topics = Array.isArray(profile.research_topics)
        ? profile.research_topics.join(", ")
        : profile.research_topics;
      const fields = [
        ["Affiliation", profile.affiliation],
        ["Research branch", profile.research_branch],
        ["Research topics", topics],
        ["Location", profile.location],
        ["Timezone", profile.timezone],
        ["Personal website", profile.personal_website],
        ["Notes", profile.notes]
      ].filter((entry) => entry[1] != null && String(entry[1]).trim() !== "");
      if (fields.length) {
        rows.push('<span class="cell-details">' +
          fields.map((entry) => escapeHtml(entry[0]) + ": " + escapeHtml(String(entry[1]))).join(" · ") +
          '</span>');
      }
      return rows.join("");
    }

    function renderApprovals() {
      const list = document.getElementById("approvals-list");
      const count = document.getElementById("approvals-count");
      count.textContent = state.registrations.length ? state.registrations.length + " pending" : "";
      if (!state.registrations.length) {
        list.innerHTML = '<p class="subtle">No pending account requests.</p>';
        return;
      }
      list.innerHTML = state.registrations.map((registration) => {
        const details = registration.kind === "claim"
          ? '<strong>' + escapeHtml(registration.member_name || registration.member_id || "Roster member") + '</strong>' +
            '<span class="cell-details">Claiming existing profile · ' + escapeHtml(registration.email) + '</span>'
          : renderSignupDetails(registration.profile || {}, registration.email);
        return '<div class="approval-request" data-registration="' + escapeHtml(registration.id) + '">' +
          '<div class="req-head"><span class="pill">' + escapeHtml(registration.kind) + '</span>' +
          '<span class="cell-details">Requested ' + escapeHtml(formatRequestedAt(registration.created_at)) + '</span></div>' +
          details +
          '<div class="toolbar">' +
            '<button class="button primary" type="button" data-approve-reg="' + escapeHtml(registration.id) + '">Approve</button>' +
            '<button class="button danger" type="button" data-reject-reg="' + escapeHtml(registration.id) + '">Reject</button>' +
          '</div>' +
        '</div>';
      }).join("");
    }

    function formData(form) {
      return Object.fromEntries(new FormData(form).entries());
    }

    function setStatus(id, message, kind) {
      const el = document.getElementById(id);
      el.textContent = message;
      el.className = "status" + (kind ? " " + kind : "");
    }

    document.querySelectorAll(".tab").forEach((button) => {
      button.addEventListener("click", () => {
        const tab = button.dataset.tab;
        document.querySelectorAll(".tab").forEach((entry) => entry.setAttribute("aria-selected", String(entry === button)));
        document.querySelectorAll(".section").forEach((entry) => entry.classList.toggle("active", entry.id === tab));
        document.getElementById("page-title").textContent = sectionCopy[tab][0];
        document.getElementById("page-subtitle").textContent = sectionCopy[tab][1];
      });
    });

    document.getElementById("refresh-button").addEventListener("click", () => refresh().catch((error) => alert(error.message)));

    const memberStatuses = ["active", "part_time", "on_leave", "alumni", "external"];

    document.getElementById("member-search").addEventListener("input", (event) => {
      state.memberQuery = event.currentTarget.value;
      renderMembers();
    });

    ["branch", "status", "project", "paper"].forEach((filter) => {
      document.getElementById("member-" + filter + "-filter").addEventListener("change", (event) => {
        state.memberFilters[filter] = event.currentTarget.value;
        renderMembers();
      });
    });

    document.getElementById("member-clear-filters").addEventListener("click", () => {
      state.memberQuery = "";
      state.memberFilters = { branch: "", status: "", project: "", paper: "" };
      document.getElementById("member-search").value = "";
      renderMembers();
    });

    document.getElementById("members-table").addEventListener("click", (event) => {
      const row = event.target.closest("tr[data-edit-member]");
      if (!row) return;
      const member = state.members.find((entry) => entry.id === row.dataset.editMember);
      if (!member) return;
      populateMemberForm(member);
    });

    document.getElementById("paper-search").addEventListener("input", (event) => {
      state.paperQuery = event.currentTarget.value;
      renderPapers();
    });

    document.getElementById("member-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = formData(form);
      const body = {
        name: data.name,
        role: data.role,
        status: data.status,
        research_branch: data.research_branch,
        research_topics: commaList(data.research_topics),
        projects: commaList(data.projects),
        ...(data.hours_per_week !== "" ? { hours_per_week: Number(data.hours_per_week) } : {}),
        ...(data.capacity_percent !== "" ? { capacity_percent: Number(data.capacity_percent) } : {}),
        affiliation: data.affiliation,
        location: data.location,
        timezone: data.timezone,
        personal_website: data.personal_website,
        ...(data.email ? { email: data.email } : {}),
        ...(data.slack_user_id ? { slack_user_id: data.slack_user_id } : {}),
        ...(data.privilege_level ? { privilege_level: data.privilege_level } : {}),
        notes: data.notes
      };
      try {
        await api("/lab/members/" + encodeURIComponent(data.id), { method: "PUT", body: JSON.stringify(body) });
        setStatus("member-status", "Saved member.", "ok");
        await refresh();
      } catch (error) {
        setStatus("member-status", error.message, "error");
      }
    });

    function commaList(value) {
      return String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean);
    }

    function populateMemberForm(member) {
      const form = document.getElementById("member-form");
      const profile = memberProfile(member);
      const values = {
        id: member.id,
        name: member.name,
        role: profile.role,
        status: profile.status,
        research_branch: profile.branch,
        research_topics: profile.topics.join(", "),
        projects: profile.projects.join(", "),
        hours_per_week: profile.hours ?? "",
        capacity_percent: profile.capacity ?? "",
        affiliation: profile.affiliation,
        location: profile.location,
        timezone: profile.timezone,
        personal_website: profile.website,
        email: member.email || "",
        slack_user_id: member.slack_user_id || "",
        privilege_level: member.privilege_level,
        notes: member.notes || ""
      };
      Object.entries(values).forEach(([name, value]) => {
        const field = form.elements.namedItem(name);
        if (field) field.value = value;
      });
      form.closest("details").open = true;
      form.scrollIntoView({ behavior: "smooth", block: "start" });
      setStatus("member-status", "Editing " + member.name + ".", "");
    }

    document.getElementById("paper-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = formData(form);
      const artifacts = {
        ...(data.overleaf_edit_url ? { overleaf_edit_url: data.overleaf_edit_url } : {}),
        ...(data.google_drive_pdf_url ? { google_drive_pdf_url: data.google_drive_pdf_url } : {})
      };
      const reminder = {
        status: data.reminder_status,
        ...(data.last_author_dm_at ? { last_author_dm_at: data.last_author_dm_at } : {})
      };
      const body = {
        title: data.title,
        authors: String(data.authors).split(",").map((entry) => entry.trim()).filter(Boolean),
        current_step: data.current_step,
        ...(Object.keys(artifacts).length ? { artifacts } : {}),
        reminder
      };
      try {
        await api("/papers/" + encodeURIComponent(data.id), { method: "PUT", body: JSON.stringify(body) });
        form.reset();
        setStatus("paper-status", "Added paper.", "ok");
        await refresh();
      } catch (error) {
        setStatus("paper-status", error.message, "error");
      }
    });

    document.getElementById("papers-table").addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLButtonElement) || !target.dataset.deletePaper) return;
      const title = target.dataset.paperTitle || target.dataset.deletePaper;
      if (!confirm('Delete active paper "' + title + '"? This cannot be undone.')) return;
      target.disabled = true;
      try {
        await api("/papers/" + encodeURIComponent(target.dataset.deletePaper), { method: "DELETE" });
        setStatus("paper-status", "Deleted paper.", "ok");
        await refresh();
      } catch (error) {
        setStatus("paper-status", error.message, "error");
        target.disabled = false;
      }
    });

    document.getElementById("settings-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = formData(event.currentTarget);
      const body = {
        paper_escalation_business_days: Number(data.paper_escalation_business_days),
        head_professor_member_id: data.head_professor_member_id,
        applicant_sheet_id: data.applicant_sheet_id,
        applicant_last_reviewed_at: data.applicant_last_reviewed_at
      };
      try {
        await api("/settings", { method: "PUT", body: JSON.stringify(body) });
        setStatus("settings-status", "Saved settings.", "ok");
        await refresh();
      } catch (error) {
        setStatus("settings-status", error.message, "error");
      }
    });

    document.getElementById("actions-list").addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLButtonElement)) return;
      try {
        if (target.dataset.approve) {
          await api("/approvals/" + encodeURIComponent(target.dataset.approve) + "/approve", {
            method: "POST",
            body: JSON.stringify({ payload_hash: target.dataset.hash })
          });
        }
        if (target.dataset.execute) {
          await api("/actions/" + encodeURIComponent(target.dataset.execute) + "/execute", {
            method: "POST",
            body: JSON.stringify({ dry_run: true })
          });
        }
        await refresh();
      } catch (error) {
        alert(error.message);
      }
    });

    document.getElementById("approvals-list").addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLButtonElement)) return;
      const approveId = target.dataset.approveReg;
      const rejectId = target.dataset.rejectReg;
      const id = approveId || rejectId;
      if (!id) return;
      const decision = approveId ? "approve" : "reject";
      const row = target.closest("[data-registration]");
      row.querySelectorAll("button").forEach((button) => { button.disabled = true; });
      try {
        await api("/auth/registrations/" + encodeURIComponent(id) + "/" + decision, { method: "POST" });
        await refresh();
      } catch (error) {
        row.querySelectorAll("button").forEach((button) => { button.disabled = false; });
        alert(error.message);
      }
    });

    function isPrivileged() {
      const level = sessionMember?.privilege_level;
      return level === "admin" || level === "core_member";
    }

    // Cosmetic gating only; the service still enforces privilege on every sensitive route.
    function applyPrivilegeGating() {
      const privileged = isPrivileged();
      ["approvals", "settings", "audit"].forEach((tab) => {
        const button = document.querySelector('.tab[data-tab="' + tab + '"]');
        if (button) button.hidden = !privileged;
      });
      // The admin add/edit-person editor lives inside the members section; hide it
      // for plain members so they only see the read-only roster and their own profile.
      const memberEditor = document.querySelector(".member-editor");
      if (memberEditor) memberEditor.hidden = !privileged;
    }

    function showAuthGate(message, kind) {
      sessionMember = null;
      document.getElementById("app-shell").hidden = true;
      const gate = document.getElementById("auth-gate");
      gate.hidden = false;
      if (message !== undefined) {
        setStatus("auth-status", message, kind || "");
      }
    }

    function showConsole() {
      document.getElementById("auth-gate").hidden = true;
      document.getElementById("app-shell").hidden = false;
      const identity = document.getElementById("session-identity");
      identity.hidden = false;
      identity.textContent = (sessionMember?.name || sessionMember?.id || "member") +
        " · " + humanize(sessionMember?.privilege_level || "member");
      applyPrivilegeGating();
      populateProfileForm();
    }

    function populateProfileForm() {
      if (!sessionMember) return;
      const form = document.getElementById("profile-form");
      const profile = memberProfile(sessionMember);
      const values = {
        name: sessionMember.name || "",
        research_branch: profile.branch,
        research_topics: profile.topics.join(", "),
        projects: profile.projects.join(", "),
        hours_per_week: profile.hours ?? "",
        capacity_percent: profile.capacity ?? "",
        affiliation: profile.affiliation,
        location: profile.location,
        timezone: profile.timezone,
        personal_website: profile.website,
        slack_user_id: sessionMember.slack_user_id || "",
        notes: sessionMember.notes || ""
      };
      Object.entries(values).forEach(([name, value]) => {
        const field = form.elements.namedItem(name);
        if (field) field.value = value;
      });
    }

    // Dedicated auth POST so we can surface generic server errors and the 429 retry_after_seconds
    // hint without the generic api() throwing a bare message.
    async function authPost(path, body) {
      const response = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const text = await response.text();
      const payload = text.trim() ? JSON.parse(text) : null;
      return { response, payload };
    }

    // login: existing member signs in. claim: pick an unclaimed roster profile and request approval.
    // signup: someone not on the roster applies. claim/signup never mint a session; they queue a
    // pending registration an admin must approve.
    let authMode = "login";

    const authModeCopy = {
      login: {
        title: "Sign in",
        subtitle: "Use your lab email and password.",
        submit: "Sign in"
      },
      claim: {
        title: "Claim your profile",
        subtitle: "Find your roster profile and set a password (minimum 10 characters).",
        submit: "Request access"
      },
      signup: {
        title: "Request an account",
        subtitle: "Not on the roster yet? Tell us who you are and set a password (minimum 10 characters).",
        submit: "Request account"
      }
    };

    function setAuthMode(mode) {
      authMode = mode;
      const copy = authModeCopy[mode];
      document.getElementById("auth-title").textContent = copy.title;
      document.getElementById("auth-subtitle").textContent = copy.subtitle;
      document.getElementById("auth-submit").textContent = copy.submit;
      document.getElementById("claim-picker").hidden = mode !== "claim";
      document.getElementById("signup-fields").hidden = mode !== "signup";
      // Toggle required flags with visibility so hidden fields never block native form submission.
      const confirmLabel = document.getElementById("auth-confirm-label");
      confirmLabel.hidden = mode === "login";
      confirmLabel.querySelector("input").required = mode !== "login";
      document.getElementById("signup-fields").querySelector('[name="name"]').required = mode === "signup";
      document.getElementById("auth-to-claim").hidden = mode === "claim";
      document.getElementById("auth-to-signup").hidden = mode === "signup";
      document.getElementById("auth-to-login").hidden = mode === "login";
      setStatus("auth-status", "", "");
      if (mode === "claim") {
        loadRoster();
      }
    }

    function renderRoster() {
      const filter = String(document.getElementById("claim-filter").value || "").trim().toLowerCase();
      const selected = document.getElementById("claim-member-id").value;
      const matches = state.roster.filter((member) =>
        !filter || String(member.name || "").toLowerCase().includes(filter));
      document.getElementById("claim-list").innerHTML = matches.length
        ? matches.map((member) =>
            '<button type="button" class="roster-option' + (member.id === selected ? " selected" : "") +
            '" data-member-id="' + escapeHtml(member.id) + '">' + escapeHtml(member.name) + '</button>').join("")
        : '<p class="roster-empty">No matching members.</p>';
    }

    async function loadRoster() {
      try {
        const roster = await api("/auth/roster");
        state.roster = roster.members || [];
      } catch (error) {
        state.roster = [];
        setStatus("auth-status", "Could not load the roster. " + error.message, "error");
      }
      renderRoster();
    }

    document.getElementById("auth-to-claim").addEventListener("click", () => setAuthMode("claim"));
    document.getElementById("auth-to-signup").addEventListener("click", () => setAuthMode("signup"));
    document.getElementById("auth-to-login").addEventListener("click", () => setAuthMode("login"));

    document.getElementById("claim-filter").addEventListener("input", renderRoster);

    document.getElementById("claim-list").addEventListener("click", (event) => {
      const option = event.target.closest(".roster-option");
      if (!option) return;
      document.getElementById("claim-member-id").value = option.dataset.memberId;
      renderRoster();
      setStatus("auth-status", "", "");
    });

    function showAuthNotice(message) {
      document.getElementById("auth-form").hidden = true;
      document.getElementById("auth-notice").hidden = false;
      document.getElementById("auth-notice-text").textContent = message;
      document.getElementById("auth-title").textContent = "Request submitted";
      document.getElementById("auth-subtitle").textContent = "";
    }

    document.getElementById("auth-notice-back").addEventListener("click", () => {
      document.getElementById("auth-notice").hidden = true;
      const form = document.getElementById("auth-form");
      form.hidden = false;
      form.reset();
      document.getElementById("claim-member-id").value = "";
      setAuthMode("login");
    });

    function handleAuthRateLimit(payload) {
      const retry = payload?.retry_after_seconds;
      setStatus("auth-status",
        "Too many attempts." + (retry ? " Try again in " + retry + " seconds." : " Try again later."),
        "error");
    }

    async function submitLogin(email, password) {
      const { response, payload } = await authPost("/auth/login", { email, password });
      if (response.status === 429) {
        handleAuthRateLimit(payload);
        return;
      }
      // Distinct 403 body { error: string, code } for a real account still awaiting admin approval.
      if (response.status === 403 && payload?.code === "pending_approval") {
        setStatus("auth-status", "Your account is awaiting admin approval. You'll be able to sign in once it's approved.", "error");
        return;
      }
      if (!response.ok) {
        setStatus("auth-status", payload?.error?.message || "Sign in failed.", "error");
        return;
      }
      // Rely on the HttpOnly session cookie set by the server; only the member view is kept in JS.
      sessionMember = payload.member;
      document.getElementById("auth-form").reset();
      setStatus("auth-status", "", "");
      showConsole();
      await refresh();
    }

    const PENDING_NOTICE = "Request submitted — an admin must approve your account before you can sign in.";

    async function submitClaim(email, password, confirm) {
      const memberId = document.getElementById("claim-member-id").value;
      if (!memberId) {
        setStatus("auth-status", "Select your profile from the list.", "error");
        return;
      }
      if (password.length < 10) {
        setStatus("auth-status", "Password must be at least 10 characters.", "error");
        return;
      }
      if (password !== confirm) {
        setStatus("auth-status", "Passwords do not match.", "error");
        return;
      }
      const { response, payload } = await authPost("/auth/claim", { member_id: memberId, email, password });
      if (response.status === 429) {
        handleAuthRateLimit(payload);
        return;
      }
      if (!response.ok) {
        setStatus("auth-status", payload?.error?.message || "Could not submit claim.", "error");
        return;
      }
      showAuthNotice(PENDING_NOTICE);
    }

    async function submitSignup(email, password, confirm, data) {
      if (!String(data.name || "").trim()) {
        setStatus("auth-status", "Name is required.", "error");
        return;
      }
      if (password.length < 10) {
        setStatus("auth-status", "Password must be at least 10 characters.", "error");
        return;
      }
      if (password !== confirm) {
        setStatus("auth-status", "Passwords do not match.", "error");
        return;
      }
      const topics = commaList(data.research_topics);
      const profile = {
        name: data.name.trim(),
        ...(String(data.affiliation || "").trim() ? { affiliation: data.affiliation.trim() } : {}),
        ...(String(data.research_branch || "").trim() ? { research_branch: data.research_branch.trim() } : {}),
        ...(topics.length ? { research_topics: topics } : {})
      };
      const { response, payload } = await authPost("/auth/signup", { profile, email, password });
      if (response.status === 429) {
        handleAuthRateLimit(payload);
        return;
      }
      if (!response.ok) {
        setStatus("auth-status", payload?.error?.message || "Could not submit request.", "error");
        return;
      }
      showAuthNotice(PENDING_NOTICE);
    }

    document.getElementById("auth-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = formData(form);
      const email = data.email.trim();
      const password = data.password;
      const submit = document.getElementById("auth-submit");
      submit.disabled = true;
      try {
        if (authMode === "login") {
          await submitLogin(email, password);
        } else if (authMode === "claim") {
          await submitClaim(email, password, data.confirm_password);
        } else {
          await submitSignup(email, password, data.confirm_password, data);
        }
      } catch (error) {
        setStatus("auth-status", error.message, "error");
      } finally {
        submit.disabled = false;
      }
    });

    document.getElementById("signout-button").addEventListener("click", async () => {
      try {
        await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
      } catch {
        // Ignore network errors on logout; the local session view is cleared regardless.
      }
      document.getElementById("session-identity").hidden = true;
      showAuthGate("Signed out.", "ok");
    });

    document.getElementById("paper-relevant-toggle").addEventListener("change", async (event) => {
      state.papersRelevantOnly = event.currentTarget.checked;
      if (state.papersRelevantOnly) {
        try {
          const relevant = await api("/papers/relevant");
          state.relevantPapers = relevant.papers || [];
        } catch (error) {
          state.papersRelevantOnly = false;
          event.currentTarget.checked = false;
          setStatus("paper-status", error.message, "error");
        }
      }
      renderPapers();
    });

    document.getElementById("profile-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!sessionMember) return;
      const data = formData(event.currentTarget);
      const body = {
        name: data.name,
        research_branch: data.research_branch,
        research_topics: commaList(data.research_topics),
        projects: commaList(data.projects),
        ...(data.hours_per_week !== "" ? { hours_per_week: Number(data.hours_per_week) } : {}),
        ...(data.capacity_percent !== "" ? { capacity_percent: Number(data.capacity_percent) } : {}),
        affiliation: data.affiliation,
        location: data.location,
        timezone: data.timezone,
        personal_website: data.personal_website,
        slack_user_id: data.slack_user_id,
        notes: data.notes
      };
      try {
        const updated = await api("/lab/members/" + encodeURIComponent(sessionMember.id), {
          method: "PUT",
          body: JSON.stringify(body)
        });
        sessionMember = updated;
        setStatus("profile-status", "Saved profile.", "ok");
        populateProfileForm();
        await refresh();
      } catch (error) {
        setStatus("profile-status", error.message, "error");
      }
    });

    document.getElementById("password-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = formData(form);
      if (data.new_password.length < 10) {
        setStatus("password-status", "New password must be at least 10 characters.", "error");
        return;
      }
      if (data.new_password !== data.confirm_password) {
        setStatus("password-status", "New passwords do not match.", "error");
        return;
      }
      try {
        const { response, payload } = await authPost("/auth/password", {
          current_password: data.current_password,
          new_password: data.new_password
        });
        if (!response.ok) {
          setStatus("password-status", payload?.error?.message || "Could not change password.", "error");
          return;
        }
        form.reset();
        setStatus("password-status", "Password changed.", "ok");
      } catch (error) {
        setStatus("password-status", error.message, "error");
      }
    });

    async function boot() {
      try {
        const response = await fetch("/auth/session", {
          credentials: "same-origin",
          headers: { Accept: "application/json" }
        });
        if (!response.ok) {
          showAuthGate();
          return;
        }
        const view = await response.json();
        sessionMember = view.member;
        showConsole();
        await refresh();
      } catch (error) {
        showAuthGate(error.message, "error");
      }
    }

    boot();
  </script>
</body>
</html>`;
}
