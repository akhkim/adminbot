import {
  ADMINBOT_SEPARATE_DELIVERY_DOC_URL,
  collaboratorSubgroupAccess,
} from "./collaborator-subgroups.js";
import {
  ADMINBOT_DRIVE_ACCOUNT,
  adminBotExternalCollaboratorSubgroups,
  adminBotMemberRoles,
} from "./contracts.js";

// Item label plus cell per subgroup, inlined into the page so the editor can show what a subgroup
// grants without another round trip. Only `label`/`cell` travel: the long matrix `detail` strings
// would multiply the page size for text the compact tag list has no room for anyway.
const collaboratorSubgroupGrants = Object.fromEntries(
  adminBotExternalCollaboratorSubgroups.map((subgroup) => [
    subgroup,
    collaboratorSubgroupAccess(subgroup).map((grant) => ({ label: grant.label, cell: grant.cell })),
  ]),
);

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
    .data-tag em { margin-left: 5px; color: var(--muted); font-style: normal; }
    /* Keep the marker link inside the pill's muted type; only the underline says it is clickable. */
    .data-tag em a { color: inherit; }
    .subgroup-access { display: flex; flex-wrap: wrap; gap: 5px; }
    .subgroup-access .data-tag { max-width: none; }
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
    /* Availability: a compact this-week strip in the roster; the full schedule lives in
       the Time Availability timeline. Bands are separated by a 2px gap in the surface
       colour rather than by borders, so neighbours read apart without adding ink that
       isn't data. Time off is hatched, never a hue, so it cannot read as a project. */
    .avail-strip {
      display: grid;
      gap: 4px;
      min-width: 120px;
    }
    .avail-strip-track {
      display: flex;
      gap: 2px;
      height: 10px;
      border-radius: 3px;
      overflow: hidden;
      background: var(--panel-alt);
    }
    .avail-strip-track span { display: block; height: 100%; }
    .avail-strip-off {
      background: repeating-linear-gradient(
        45deg, #c3c2b7, #c3c2b7 3px, var(--panel-alt) 3px, var(--panel-alt) 6px);
    }
    .avail-strip-meta { color: var(--muted); font-size: 11px; white-space: nowrap; }
    /* Public surfaces: the deadline board is embedded rather than reimplemented, so the console
       and the standalone /deadlines page can never show different dates. */
    .public-frame {
      width: 100%;
      height: 70vh;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }
    .reimb-log {
      display: grid;
      gap: 6px;
      margin: 12px 0;
      padding: 12px;
      background: var(--panel-alt);
      border-radius: 8px;
      max-height: 320px;
      overflow-y: auto;
    }
    .reimb-line { margin: 0; font-size: 13px; line-height: 1.6; }
    .reimb-line--user strong { color: var(--accent); }
    .reimb-form { display: grid; gap: 10px; }
    #map-canvas svg { display: block; width: 100%; height: auto; margin: 12px 0 4px; }
    .map-grid { stroke: var(--line); stroke-width: 1; }
    .map-equator { stroke: var(--line); stroke-width: 1.5; }
    .map-dot { fill: #2a78d6; fill-opacity: 0.75; }
    .map-label { font-size: 11px; fill: var(--text); font-weight: 600; }
    .checkbox-field {
      display: grid;
      grid-template-columns: auto 1fr;
      align-items: center;
      gap: 8px;
      font-weight: 600;
    }
    .checkbox-field input { width: auto; margin: 0; }
    .checkbox-field .field-hint { grid-column: 2; margin: 0; }
    .field-hint {
      display: block;
      color: var(--muted);
      font-size: 11px;
      font-weight: 400;
      margin-top: 4px;
    }
    .field-hint code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      background: var(--panel-alt);
      border-radius: 3px;
      padding: 1px 4px;
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
    /* Availability timeline slots, in fixed assignment order. In a Gantt any project can end up
       beside any other (see Andrew's HomeLab/Atlas row), so these are validated on the ALL-PAIRS
       gate, not the weaker adjacent-pair one: worst pair CVD 9.2, normal-vision 16.3 on this white
       panel. Four is the ceiling that clears it — adding yellow puts it next to orange (13.7, a
       hard fail) and magenta/green fail too. Projects past the fourth take the neutral .other fill
       and rely on their in-bar label. Aqua sits under 3:1 contrast, so labels and the table view
       are mandatory relief. Re-run the palette validator before touching any of this. */
    .viz {
      --series-1: #2a78d6;
      --series-2: #eb6834;
      --series-3: #1baf7a;
      --series-4: #4a3aa7;
      --viz-grid: #e1e0d9;
      --viz-axis: #c3c2b7;
    }
    .viz-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 4px;
    }
    /* The heading is the series label for a single-member chart, so it names the person. */
    .viz-title {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
      letter-spacing: -0.01em;
    }
    .compact-table { min-width: 0; }
    /* Base th/td allow mid-word breaks for the wide directory; a narrow panel would hyphenate
       these short headers instead of widening the column. */
    .compact-table th { white-space: nowrap; }
    .compact-table td { vertical-align: middle; }
    /* Prerequisite the member has to act on, not decoration: an unshared doc fails the import
       silently, so it gets a marked block rather than another line of grey subtext. */
    .callout {
      margin: 10px 0 14px;
      border: 1px solid var(--line);
      border-left: 3px solid var(--warn);
      border-radius: 8px;
      background: #fdfaf4;
      padding: 10px 12px;
      font-size: 13px;
    }
    .callout code {
      font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      font-size: 12.5px;
      background: #ffffff;
      border: 1px solid var(--line);
      border-radius: 5px;
      padding: 1px 5px;
      white-space: nowrap;
    }
    .viz-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(148px, 1fr));
      gap: 12px;
      margin: 12px 0 4px;
    }
    .toggle-view { display: flex; gap: 6px; }
    .toggle-view .button[aria-pressed="true"] {
      border-color: var(--accent);
      background: #e6f3f5;
      color: var(--accent-strong);
      font-weight: 700;
    }
    .viz-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 14px;
      margin: 10px 0 12px;
      font-size: 12px;
      color: var(--muted);
    }
    .viz-legend span {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .viz-swatch {
      width: 10px;
      height: 10px;
      border-radius: 3px;
      background: var(--sw, var(--series-1));
      flex: none;
    }
    /* Open capacity and time off are hatched in the chart, so their legend keys are hatched too —
       a flat swatch would imply they are ordinary series. */
    .viz-swatch.hatch {
      background: repeating-linear-gradient(45deg, var(--sw), var(--sw) 3px, #ffffff 3px, #ffffff 6px);
      border: 1px solid var(--viz-axis);
    }
    .timeline-scroll { overflow-x: auto; padding-bottom: 6px; }
    /* The editor is a separate concern from the chart above it, and the last timeline row needs
       clearance or its bars collide with the first heading. */
    .sched-editor {
      margin-top: 26px;
      border-top: 1px solid var(--line);
      padding-top: 20px;
      display: grid;
      gap: 22px;
    }
    .sched-editor h2 { margin-top: 0; }
    .timeline {
      min-width: 620px;
      display: grid;
      /* Row label gutter, then one equal column per week in the horizon. */
      grid-template-columns: 148px repeat(var(--weeks), minmax(26px, 1fr));
      align-items: center;
      row-gap: 6px;
      font-size: 12px;
    }
    .timeline .tl-month {
      grid-row: 1;
      color: var(--muted);
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      border-left: 1px solid var(--viz-axis);
      padding: 0 0 4px 5px;
      align-self: end;
      white-space: nowrap;
    }
    .timeline .tl-label {
      grid-column: 1;
      color: var(--text);
      padding-right: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .timeline .tl-track {
      grid-column: 2 / -1;
      grid-row: var(--r);
      height: 26px;
      border-top: 1px solid var(--viz-grid);
    }
    /* Continuation lane of the row above it — same subject, so no dividing rule. */
    .timeline .tl-track.lane { border-top: 0; }
    /* Bars are placed on the same grid as the header months so a range always lines up with
       the month it falls in; grid-column is 1-based over the week columns. */
    .timeline .tl-bar {
      grid-row: var(--r);
      grid-column: var(--c-start) / var(--c-end);
      height: 22px;
      border-radius: 4px;
      background: var(--sw);
      /* 2px surface gap keeps adjacent fills from reading as one continuous bar. */
      box-shadow: 0 0 0 2px var(--panel);
      /* Block, not flex: text-overflow never applies to an anonymous flex item, so a narrow bar
         would hard-clip its label instead of ellipsizing. line-height does the centring. */
      display: block;
      line-height: 20px;
      padding: 0 7px;
      min-width: 0;
      color: #ffffff;
      font-size: 11px;
      font-weight: 650;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      cursor: default;
    }
    /* Past the six validated slots a project takes the neutral fill rather than a recycled hue;
       its in-bar label is what keeps it identifiable. */
    .timeline .tl-bar.other {
      background: #c3c2b7;
      color: #17202a;
    }
    /* Declared spare capacity is a sentinel, not a project, so it gets a neutral outlined
       treatment instead of a categorical slot. */
    .timeline .tl-bar.open {
      background: repeating-linear-gradient(45deg, #eef2f6, #eef2f6 5px, #ffffff 5px, #ffffff 10px);
      color: var(--accent-strong);
      border: 1px solid var(--accent);
    }
    /* Time off is a state, not a series: hatched, ink-coloured, and always labelled with its
       kind so it never depends on colour alone. */
    .timeline .tl-bar.off {
      background: repeating-linear-gradient(45deg, #dfe5ec, #dfe5ec 5px, #f4f6f9 5px, #f4f6f9 10px);
      color: var(--text);
      border: 1px solid var(--viz-axis);
    }
    .timeline .tl-bar.off.partial {
      background: repeating-linear-gradient(135deg, #e9edf2, #e9edf2 4px, #fbfcfd 4px, #fbfcfd 11px);
    }
    .timeline .tl-today {
      grid-row: 2 / -1;
      grid-column: var(--c-start) / span 1;
      border-left: 2px solid var(--danger);
      height: 100%;
      pointer-events: none;
    }
    .viz-empty {
      color: var(--muted);
      font-size: 13px;
      border: 1px dashed var(--line);
      border-radius: 8px;
      padding: 22px 16px;
      text-align: center;
    }
    .sched-rows { display: grid; gap: 10px; }
    /* Flex rather than repeat(auto-fit): auto-fit is invalid alongside an intrinsic auto track,
       which silently collapses the whole template to one column. Flex wrapping also degrades
       cleanly at any panel width without a media query. */
    .sched-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 10px;
      align-items: flex-end;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: #fbfcfd;
    }
    .sched-row label {
      font-size: 11px;
      color: var(--muted);
      flex: 1 1 150px;
      min-width: 0;
    }
    .sched-row label.tight { flex: 0 1 116px; }
    .sched-row .drop {
      align-self: center;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel);
      color: var(--danger);
      cursor: pointer;
      padding: 7px 10px;
      white-space: nowrap;
    }
    .sched-row .drop:hover { border-color: var(--danger); }
    .sched-empty { color: var(--muted); font-size: 12px; }
    .viz-source {
      color: var(--muted);
      font-size: 11px;
      margin: 10px 0 0;
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
        <div class="panel">
          <h2>Member map</h2>
          <div class="list-toolbar">
            <span class="subtle">Where everyone is. Slack profile first; the roster location is used only where Slack has nothing.</span>
            <span class="count" id="map-count"></span>
          </div>
          <div class="toolbar">
            <button type="button" id="map-refresh">Refresh from Slack</button>
            <span class="status" id="map-status"></span>
          </div>
          <div id="map-canvas"></div>
          <div id="map-list"></div>
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
              <p class="callout">Remember to share the doc with <code>${ADMINBOT_DRIVE_ACCOUNT}</code> — Viewer access is enough. Without it AdminBot cannot open the doc and the import will find nothing.</p>
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
  <script>
    const privilegeLevels = ["external_collaborator", "trial", "member", "core_member", "admin"];
    const collaboratorSubgroups = ${JSON.stringify([...adminBotExternalCollaboratorSubgroups])};
    const collaboratorSubgroupGrants = ${JSON.stringify(collaboratorSubgroupGrants)};
    // Cells that are not a plain yes carry an instruction the person acting on the grant has to
    // see; without the marker "Rec letter button" would read as granted to everyone listed.
    // The separate marker links the doc its follow-up email points at, so an admin can read it first.
    const subgroupCellMarkers = {
      yes_separate: { text: "separate", href: ${JSON.stringify(ADMINBOT_SEPARATE_DELIVERY_DOC_URL)} },
      pending: { text: "pending" },
      case_by_case: { text: "case-by-case" },
      auto_decline: { text: "auto-decline" }
    };
    const memberRoles = ${JSON.stringify([...adminBotMemberRoles])};
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
      capacity: ["Capacity", "Lab-wide availability, open capacity, project staffing, and expertise."],
      papers: ["Papers", "Track active paper pipeline state, links, and reminders."],
      profile: ["My profile", "Update your own profile and account password."],
      actions: ["Actions", "Review approval-gated AdminBot proposals."],
      approvals: ["Approvals", "Review and decide pending account requests."],
      settings: ["Settings", "Set roster and paper reminder defaults."],
      audit: ["Audit", "Inspect local AdminBot service events."],
      deadlines: ["Deadlines", "Upcoming submission deadlines, AoE-correct and open to everyone."],
      reimbursements: ["Reimbursement", "Prepare a reimbursement packet. No account needed."]
    };
    // Surfaces a visitor may use before signing in. Mirrors the Control UI access table
    // (ui/src/ui/access.ts): the deadline board is a public snapshot and the reimbursement
    // assistant only ever sees what the claimant in front of it typed.
    const PUBLIC_TABS = ["deadlines", "reimbursements"];
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
      reviewing: { cycles: [], milestones: [] },
      memberMap: { places: [], unplaced: [], counts: { placed: 0, unplaced: 0, unknown: 0 } },
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

    function optionList(values, selected, blankLabel, labeler = (value) => value) {
      const blank = blankLabel ? '<option value="">' + blankLabel + '</option>' : "";
      return blank + values.map((value) =>
        '<option value="' + value + '"' + (value === selected ? " selected" : "") + '>' + labeler(value) + '</option>'
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
        // 503 here just means no OpenReview script is wired up on this host; the rest
        // of the console must still render.
        try {
          state.reviewing = await api("/openreview/status");
        } catch {
          state.reviewing = { cycles: [], milestones: [] };
        }
        try {
          state.memberMap = await api("/member-map");
        } catch {
          state.memberMap = { places: [], unplaced: [], counts: { placed: 0, unplaced: 0, unknown: 0 } };
        }
      } else {
        state.registrations = [];
        state.reviewing = { cycles: [], milestones: [] };
      }
      render();
    }

    function render() {
      document.getElementById("member-privilege").innerHTML = optionList(
        privilegeLevels,
        "external_collaborator"
      );
      document.getElementById("member-subgroup").innerHTML = optionList(
        collaboratorSubgroups,
        "",
        "Not set",
        humanize
      );
      syncSubgroupField();
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
      renderCapacity();
      renderPapers();
      renderActions();
      renderApprovals();
      renderReviewing();
      renderMemberMap();
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
        const hours = profile.hours === null ? "" : profile.hours + "h / week";
        return '<tr data-edit-member="' + escapeHtml(member.id) + '">' +
          '<td><div class="person-cell"><span class="avatar">' + escapeHtml(initials) + '</span><div class="person-meta"><strong>' + escapeHtml(member.name) + '</strong><span>' + escapeHtml(member.email || member.id) + '</span></div></div></td>' +
          '<td><strong>' + escapeHtml(profile.role || "—") + '</strong><br><span class="cell-details">' + escapeHtml(profile.affiliation || "") + '</span></td>' +
          '<td><span class="status-pill ' + escapeHtml(profile.status) + '">' + escapeHtml(humanize(profile.status)) + '</span></td>' +
          '<td><strong>' + escapeHtml(profile.branch || "Unassigned") + '</strong></td>' +
          '<td>' + topicTags + '</td>' +
          '<td>' + projectTags + '</td>' +
          '<td>' + paperTags + '</td>' +
          '<td>' + availabilityStrip(member) +
            (hours ? '<span class="cell-details">' + escapeHtml(hours) + '</span>' : "") + '</td>' +
          '<td>' + escapeHtml(profile.location || "—") + '<br><span class="cell-details">' + escapeHtml(profile.timezone || "") + '</span></td>' +
          '<td><span class="data-tag">' + escapeHtml(humanize(member.privilege_level)) + '</span>' +
            (member.collaborator_subgroup && member.privilege_level === "external_collaborator"
              ? '<span class="data-tag">' + escapeHtml(humanize(member.collaborator_subgroup)) + '</span>'
              : "") + '</td>' +
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
        availability: member.availability || [],
        location: member.location || noteValue(member, "Location"),
        affiliation: member.affiliation || noteValue(member, "Affiliation") || noteValue(member, "Main affiliation"),
        timezone: member.timezone || noteValue(member, "Timezone"),
        website: member.personal_website || noteValue(member, "Personal website")
      };
    }


    // --- Time availability ----------------------------------------------------
    // The roster cell: the week in force today only, so a 140-row table stays scannable.
    // Built from the same bars the Time Availability timeline and the Capacity view use, so
    // the strip can never tell a different story from the member's own chart.
    function availabilityStrip(member) {
      const weekStart = mondayOf(parseIso(isoOf(Date.now())));
      const live = memberBars(member, false).filter((bar) => activeInWeek(bar, weekStart));
      if (!live.length) return '<span class="cell-details">No availability set</span>';
      const commitments = live.filter((bar) => bar.type !== "off");
      const timeOff = live.filter((bar) => bar.type === "off");
      const slots = assignProjectSlots(commitments);
      const hours = commitments.reduce((total, bar) => total + (numericValue(bar.hours) ?? 0), 0);
      // Widths are shares of this week's committed hours, so the strip reads as "where the
      // time goes", not as a fraction of some assumed full week the member never declared.
      const bands = hours > 0
        ? commitments.map((bar) => {
            const share = ((numericValue(bar.hours) ?? 0) / hours) * 100;
            return share > 0
              ? '<span style="width:' + share + '%;background:' + stripFill(bar, slots) + '"></span>'
              : "";
          }).join("")
        : '<span style="width:100%;background:#c3c2b7"></span>';
      const summary = commitments
        .map((bar) => bar.label + (numericValue(bar.hours) === null ? "" : " " + bar.hours + "h"))
        .concat(timeOff.map((bar) => bar.availability === "partial" ? "partly away" : "away"))
        .join(", ");
      // Fully away wins the meta line: someone on leave is not "20h committed this week",
      // and whoever is looking for a spare pair of hands has to see that at a glance.
      const fullyAway = timeOff.some((bar) => bar.availability !== "partial");
      return '<div class="avail-strip" title="' + escapeHtml("Week of " + isoOf(weekStart) + ": " + summary) + '">' +
        '<div class="avail-strip-track">' + bands +
        (timeOff.length ? '<span class="avail-strip-off" style="width:' + (fullyAway ? 100 : 25) + '%"></span>' : "") +
        '</div>' +
        '<span class="avail-strip-meta">' +
        (fullyAway ? "away this week" : escapeHtml(hours + "h committed")) +
        '</span></div>';
    }

    function stripFill(bar, slots) {
      if (bar.type === "open") return "var(--accent)";
      const slot = slots.get(bar.project);
      return slot ? "var(--series-" + slot + ")" : "#c3c2b7";
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

    function renderReviewing() {
      const list = document.getElementById("reviewing-list");
      const count = document.getElementById("reviewing-count");
      const cycles = state.reviewing?.cycles || [];
      const milestones = state.reviewing?.milestones || [];
      const missing = cycles.reduce((total, cycle) => total + (cycle.reviews_missing || 0), 0);
      count.textContent = cycles.length
        ? cycles.length + " cycle(s) · " + missing + " review(s) missing"
        : "";
      if (!cycles.length) {
        list.innerHTML = '<p class="subtle">No reviewing cycles discovered yet. Run a cycle to query OpenReview.</p>';
        return;
      }
      list.innerHTML = cycles.map((cycle) => {
        const fired = milestones
          .filter((entry) => entry.venue_id === cycle.venue_id && entry.role === cycle.role)
          .map((entry) => '<span class="pill" title="' + escapeHtml(entry.detail || entry.fired_at) + '">' +
            escapeHtml(entry.milestone_key) + ' · ' + escapeHtml(entry.status) + '</span>')
          .join(" ");
        return '<div class="approval-request">' +
          '<div class="req-head"><strong>' + escapeHtml(cycle.title || cycle.venue_id) + '</strong>' +
          '<span class="pill">' + escapeHtml(roleLabel(cycle.role)) + '</span></div>' +
          '<span class="cell-details">' + escapeHtml(cycle.venue_id) + ' · deadline ' +
          escapeHtml(formatDeadline(cycle.deadline_ms)) + ' · ' +
          escapeHtml(String(cycle.reviews_missing ?? 0)) + ' of ' +
          escapeHtml(String(cycle.papers_total ?? 0)) + ' paper-reviews outstanding</span>' +
          (cycle.last_error ? '<span class="cell-details">Last error: ' + escapeHtml(cycle.last_error) + '</span>' : '') +
          (fired ? '<div class="toolbar">' + fired + '</div>' : '<span class="cell-details">No reminders fired yet.</span>') +
        '</div>';
      }).join("");
    }

    function roleLabel(role) {
      return role === "sac" ? "Senior AC" : role === "ac" ? "Area Chair" : "Reviewer";
    }

    function formatDeadline(deadlineMs) {
      if (!deadlineMs) return "unknown";
      const days = Math.round((deadlineMs - Date.now()) / 86400000);
      const when = new Date(deadlineMs).toISOString().slice(0, 16).replace("T", " ") + " UTC";
      return when + (days >= 0 ? " (in " + days + "d)" : " (" + Math.abs(days) + "d ago)");
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
        ...(data.openreview_id ? { openreview_id: data.openreview_id } : {}),
        reviewer_exempt: form.elements.namedItem("reviewer_exempt")?.checked === true,
        affiliation: data.affiliation,
        location: data.location,
        timezone: data.timezone,
        personal_website: data.personal_website,
        ...(data.email ? { email: data.email } : {}),
        ...(data.slack_user_id ? { slack_user_id: data.slack_user_id } : {}),
        ...(data.privilege_level ? { privilege_level: data.privilege_level } : {}),
        ...(data.collaborator_subgroup ? { collaborator_subgroup: data.collaborator_subgroup } : {}),
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

    // Cosmetic gating only: the service is what rejects a subgroup on any other privilege level and
    // clears it on promotion. Blanking the select while hidden keeps the save payload honest.
    function syncSubgroupField() {
      const subgroup = document.getElementById("member-subgroup");
      const applicable =
        document.getElementById("member-privilege").value === "external_collaborator";
      if (!applicable) subgroup.value = "";
      document.getElementById("member-subgroup-field").hidden = !applicable;
      const grants = applicable ? collaboratorSubgroupGrants[subgroup.value] || [] : [];
      const panel = document.getElementById("member-subgroup-access");
      panel.hidden = grants.length === 0;
      panel.innerHTML = grants.map((grant) => {
        const marker = subgroupCellMarkers[grant.cell];
        if (!marker) return '<span class="data-tag">' + escapeHtml(grant.label) + '</span>';
        const text = escapeHtml(marker.text);
        const body = marker.href
          ? '<a href="' + marker.href + '" target="_blank" rel="noreferrer">' + text + '</a>'
          : text;
        return '<span class="data-tag">' + escapeHtml(grant.label) + '<em>' + body + '</em></span>';
      }).join("");
    }

    document.getElementById("member-privilege").addEventListener("change", syncSubgroupField);
    document.getElementById("member-subgroup").addEventListener("change", syncSubgroupField);

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
        openreview_id: member.openreview_id || "",
        affiliation: profile.affiliation,
        location: profile.location,
        timezone: profile.timezone,
        personal_website: profile.website,
        email: member.email || "",
        slack_user_id: member.slack_user_id || "",
        privilege_level: member.privilege_level,
        collaborator_subgroup: member.collaborator_subgroup || "",
        notes: member.notes || ""
      };
      Object.entries(values).forEach(([name, value]) => {
        const field = form.elements.namedItem(name);
        if (field) field.value = value;
      });
      syncSubgroupField();
      // Checkboxes carry state on .checked, not .value, so they are set apart from the
      // text fields above; a missing one would silently read as "not exempt".
      const exemptField = form.elements.namedItem("reviewer_exempt");
      if (exemptField) exemptField.checked = member.reviewer_exempt === true;
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

    document.getElementById("reviewing-run").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const send = document.getElementById("reviewing-send").checked;
      button.disabled = true;
      setStatus("reviewing-status", send ? "Running and sending…" : "Running (dry run)…", "");
      try {
        const result = await api("/openreview/cycle/run", {
          method: "POST",
          body: JSON.stringify({ send })
        });
        const fired = (result.outcomes || []).filter((outcome) => outcome.status !== "no_milestone_due");
        setStatus(
          "reviewing-status",
          "Checked " + (result.venues || 0) + " cycle(s); " + fired.length + " milestone(s) actioned" +
            (result.errors?.length ? "; " + result.errors.length + " error(s)" : "") + ".",
          result.errors?.length ? "warn" : "ok"
        );
        await refresh();
      } catch (error) {
        setStatus("reviewing-status", error.message, "error");
      } finally {
        button.disabled = false;
      }
    });


    // --- Member map -----------------------------------------------------------
    // Equirectangular: longitude and latitude map straight onto x and y, which keeps the
    // projection honest and needs no coastline data. A graticule gives the eye something
    // to place the dots against; the labels do the rest of the work.
    function mapProject(lat, lon, width, height) {
      return { x: ((lon + 180) / 360) * width, y: ((90 - lat) / 180) * height };
    }

    function renderMemberMap() {
      const data = state.memberMap || { places: [], unplaced: [], counts: {} };
      const places = data.places || [];
      const counts = data.counts || {};
      document.getElementById("map-count").textContent = places.length
        ? places.length + " place(s) · " + (counts.placed || 0) + " placed"
        : "";
      const canvas = document.getElementById("map-canvas");
      const list = document.getElementById("map-list");
      if (!places.length) {
        canvas.innerHTML = "";
        list.innerHTML = '<p class="subtle">Nobody is placed yet. Members need a location on their profile, or a Slack profile to read one from.</p>';
        return;
      }

      const width = 900, height = 450;
      const biggest = places.reduce((max, place) => Math.max(max, place.members.length), 1);
      let grid = "";
      for (let lon = -180; lon <= 180; lon += 30) {
        const x = mapProject(0, lon, width, height).x;
        grid += '<line x1="' + x + '" y1="0" x2="' + x + '" y2="' + height + '" class="map-grid" />';
      }
      for (let lat = -60; lat <= 60; lat += 30) {
        const y = mapProject(lat, 0, width, height).y;
        grid += '<line x1="0" y1="' + y + '" x2="' + width + '" y2="' + y + '" class="map-grid" />';
      }
      const equator = mapProject(0, 0, width, height).y;
      grid += '<line x1="0" y1="' + equator + '" x2="' + width + '" y2="' + equator + '" class="map-equator" />';

      // Labels are placed biggest-first and skipped where they would collide with one
      // already down. Europe puts six cities inside a few degrees, so labelling every dot
      // produces an unreadable pile; the ranked list below carries what the map drops,
      // and every dot keeps its hover text either way.
      const placedLabels = [];
      const marks = places.map((place) => {
        const point = mapProject(place.lat, place.lon, width, height);
        // Area scales with headcount, so a city of ten does not read as ten times the
        // radius of a city of one.
        const radius = 5 + 9 * Math.sqrt(place.members.length / biggest);
        const names = place.members.map((member) => member.name).join(", ");
        const anchor = point.x > width - 120 ? "end" : "start";
        const text = place.label + " " + place.members.length;
        const textWidth = text.length * 6.2;
        const labelX = anchor === "end" ? point.x - radius - 5 : point.x + radius + 5;
        const box = {
          left: anchor === "end" ? labelX - textWidth : labelX,
          right: anchor === "end" ? labelX : labelX + textWidth,
          top: point.y - 8,
          bottom: point.y + 8
        };
        const collides = placedLabels.some((other) =>
          box.left < other.right && box.right > other.left &&
          box.top < other.bottom && box.bottom > other.top);
        if (!collides) placedLabels.push(box);
        return '<g><circle cx="' + point.x + '" cy="' + point.y + '" r="' + radius +
          '" class="map-dot"><title>' + escapeHtml(place.label + " — " + place.members.length + ": " + names) +
          '</title></circle>' +
          (collides ? "" : '<text x="' + labelX + '" y="' + (point.y + 4) + '" text-anchor="' + anchor +
            '" class="map-label">' + escapeHtml(text) + '</text>') + '</g>';
      }).join("");

      canvas.innerHTML = '<svg viewBox="0 0 ' + width + ' ' + height +
        '" role="img" aria-label="Where lab members are">' + grid + marks + '</svg>';

      const rows = places.map((place) => {
        const sources = place.members.filter((member) => member.source === "slack").length;
        return '<div class="approval-request"><div class="req-head"><strong>' +
          escapeHtml(place.label) + '</strong><span class="pill">' + place.members.length + '</span>' +
          '<span class="cell-details">' + escapeHtml(place.country) +
          (sources ? " · " + sources + " from Slack" : "") + '</span></div>' +
          '<span class="cell-details">' +
          place.members.map((member) => escapeHtml(member.name)).join(", ") + '</span></div>';
      }).join("");
      const unplaced = (data.unplaced || []).length
        ? '<div class="approval-request"><div class="req-head"><strong>Not placed</strong>' +
          '<span class="pill">' + data.unplaced.length + '</span></div>' +
          '<span class="cell-details">' + data.unplaced.map((entry) =>
            escapeHtml(entry.name + (entry.raw ? " (" + entry.raw + ")" : " — no location"))).join(", ") +
          '</span></div>'
        : "";
      list.innerHTML = rows + unplaced;
    }

    document.getElementById("map-refresh").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      setStatus("map-status", "Reading Slack profiles…", "");
      try {
        const result = await api("/member-map/refresh", { method: "POST" });
        setStatus("map-status", "Checked " + result.checked + " Slack profile(s); " +
          result.updated + " location(s) changed.", "ok");
        await refresh();
      } catch (error) {
        setStatus("map-status", error.message, "error");
      } finally {
        button.disabled = false;
      }
    });

    function isPrivileged() {
      const level = sessionMember?.privilege_level;
      return level === "admin" || level === "core_member";
    }

    // Cosmetic gating only; the service still enforces privilege on every sensitive route.
    function applyPrivilegeGating() {
      const signedIn = Boolean(sessionMember);
      const privileged = isPrivileged();
      document.querySelectorAll(".tab").forEach((button) => {
        const tab = button.dataset.tab;
        // Visitors see only the public surfaces; members lose the governance ones.
        button.hidden = signedIn
          ? !privileged && ["approvals", "settings", "audit", "reviewing", "map"].includes(tab)
          : !PUBLIC_TABS.includes(tab);
      });
      document.getElementById("signin-button").hidden = signedIn;
      document.getElementById("signout-button").hidden = !signedIn;
      document.getElementById("refresh-button").hidden = !signedIn;
      // The admin add/edit-person editor lives inside the members section; hide it
      // for plain members so they only see the read-only roster and their own profile.
      const memberEditor = document.querySelector(".member-editor");
      if (memberEditor) memberEditor.hidden = !privileged;
    }

    // A visitor is not turned away: the console opens on the surfaces PUBLIC_TABS names, and the
    // sign-in form becomes something they ask for from the toolbar. A message is passed only when
    // the gate is being shown because of a failure, in which case it is shown straight away.
    function showAuthGate(message, kind) {
      sessionMember = null;
      document.getElementById("app-shell").hidden = true;
      const gate = document.getElementById("auth-gate");
      gate.hidden = false;
      if (message !== undefined) {
        setStatus("auth-status", message, kind || "");
      }
    }

    function showPublicConsole(message, kind) {
      sessionMember = null;
      document.getElementById("auth-gate").hidden = true;
      document.getElementById("app-shell").hidden = false;
      document.getElementById("session-identity").hidden = true;
      applyPrivilegeGating();
      selectTab(PUBLIC_TABS[0]);
      if (message !== undefined) {
        setStatus("reimb-status", message, kind || "");
      }
    }

    function selectTab(tab) {
      const button = document.querySelector('.tab[data-tab="' + tab + '"]');
      if (button) button.click();
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
      setSchedule(sessionMember);
      document.getElementById("availability-doc-url").value =
        sessionMember.availability_doc_url || "";
      renderScheduleEditors();
      renderAvailability();
      renderDocHint();
    }

    function renderDocHint() {
      const linked = String(document.getElementById("availability-doc-url").value || "").trim();
      document.getElementById("availability-doc-hint").textContent = linked
        ? "Linked. AdminBot reads this doc on the next import and fills in the rows below."
        : "Not linked. Add the rows below by hand, or paste a doc link to have them read for you.";
    }

    // Mirrors ADMINBOT_OPEN_PROJECT in contracts.ts: a sentinel project name meaning "declared
    // spare capacity". It is not a real project, so it never takes a categorical colour slot and
    // never joins the member's own projects list.
    const OPEN_PROJECT = "__open__";
    const timeOffKinds = ["vacation", "internship", "course_load", "travel", "conference", "other"];
    // Four is what clears the all-pairs colour-vision gate on this surface; see the .viz comment.
    const SERIES_SLOTS = 4;
    const MS_PER_DAY = 86400000;
    const WEEK_MS = 7 * MS_PER_DAY;
    const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    // Schedule edits stay local until "Save schedule", so the timeline can redraw on every
    // keystroke without a round trip. Server-owned availability_updated_at is read off
    // sessionMember, never set here.
    let schedule = { availability: [], time_off: [] };
    let availabilityView = "timeline";

    function setSchedule(member) {
      schedule = {
        availability: Array.isArray(member?.availability) ? member.availability.map((row) => ({ ...row })) : [],
        time_off: Array.isArray(member?.time_off) ? member.time_off.map((row) => ({ ...row })) : []
      };
    }

    // Schedule dates are calendar days parsed as UTC, matching the server validator, so the
    // browser timezone can never shift a range onto the neighbouring day.
    function parseIso(value) {
      const ms = Date.parse(String(value || "").trim() + "T00:00:00Z");
      return Number.isFinite(ms) ? ms : null;
    }

    function isoOf(ms) {
      return new Date(ms).toISOString().slice(0, 10);
    }

    function addDays(ms, days) {
      return ms + days * MS_PER_DAY;
    }

    // Weeks start Monday. getUTCDay() is 0 on Sunday, which is 6 days into the week.
    function mondayOf(ms) {
      return addDays(ms, -((new Date(ms).getUTCDay() + 6) % 7));
    }

    // One normalized bar shape for both the per-member and the lab-wide timeline: the bar carries
    // its own type, so the renderer never infers styling from whichever group it landed in.
    function toBar(row, type, label) {
      return {
        start: row.start,
        end: row.end,
        type,
        label,
        project: projectKey(row),
        hours: row.hours_per_week,
        kind: row.kind,
        availability: row.availability,
        note: row.note
      };
    }

    function barType(row) {
      const project = projectKey(row);
      if (project === OPEN_PROJECT) return "open";
      if (!project) return "baseline";
      return "project";
    }

    // showReasons=false renders time off as a bare away/partly-away state. Why someone is away —
    // an internship, a heavy semester — is personal, so the lab-wide view reveals the reason only
    // to privileged sessions, while a member always sees their own.
    function memberBars(member, showReasons) {
      const availability = Array.isArray(member?.availability) ? member.availability : [];
      const timeOff = Array.isArray(member?.time_off) ? member.time_off : [];
      return availability
        .map((row) => toBar(row, barType(row), commitmentLabel(row)))
        .concat(timeOff.map((row) =>
          toBar(row, "off", showReasons ? humanize(row.kind || "other") : "Away")));
    }

    function scheduleBars() {
      return memberBars(schedule, true);
    }

    // The horizon covers every recorded range plus the current week so no bar is clipped, with a
    // 12-week floor so a near-empty chart does not collapse into a handful of columns, and a
    // 78-week ceiling because past that every bar compresses into an unreadable sliver.
    function horizonOf(bars) {
      const today = mondayOf(parseIso(isoOf(Date.now())));
      let first = today;
      let last = addDays(today, 11 * 7);
      for (const bar of bars) {
        const start = parseIso(bar.start);
        const end = parseIso(bar.end);
        if (start !== null && start < first) first = mondayOf(start);
        if (end !== null && end > last) last = end;
      }
      const weeks = Math.ceil((mondayOf(last) - first) / WEEK_MS) + 1;
      return { start: first, weeks: Math.min(Math.max(weeks, 12), 78), today };
    }

    // Grid column for a date; column 1 is the row-label gutter, so week 0 starts at column 2.
    // Out-of-horizon dates clamp to the edge rather than escaping the grid.
    function weekColumn(ms, horizon) {
      const index = Math.floor((mondayOf(ms) - horizon.start) / WEEK_MS);
      return Math.min(Math.max(index, 0), horizon.weeks - 1) + 2;
    }

    // Colour follows the project, not its row position, so adding or removing a commitment never
    // repaints the others: slots are assigned over the sorted project names. Past the six
    // validated slots a project gets the neutral treatment instead of a recycled hue — the in-bar
    // label still carries its identity.
    function assignProjectSlots(bars) {
      const slots = new Map();
      uniqueValues(bars.filter((bar) => bar.type === "project").map((bar) => bar.project))
        .forEach((name, index) => slots.set(name, index < SERIES_SLOTS ? index + 1 : 0));
      return slots;
    }

    function projectKey(row) {
      return String(row?.project || "").trim();
    }

    // A blank project is the whole-term baseline row; the sentinel is declared spare capacity.
    function commitmentLabel(row) {
      const project = projectKey(row);
      if (!project) return "Term baseline";
      if (project === OPEN_PROJECT) return "Open capacity";
      return project;
    }

    function renderAvailability() {
      const name = String(sessionMember?.name || sessionMember?.id || "").trim();
      // For a single-member chart the heading is the series label, so it names the person and no
      // legend entry is needed to identify whose availability this is.
      document.getElementById("availability-title").textContent =
        name ? "Time Availability_" + name : "Time Availability";
      const stamp = String(sessionMember?.availability_updated_at || "");
      document.getElementById("availability-updated").textContent = stamp
        ? "Schedule last updated " + stamp.slice(0, 10) + "."
        : "No schedule saved yet.";
      const bars = scheduleBars();
      const hasRows = bars.length > 0;
      document.getElementById("availability-empty").hidden = hasRows;
      document.getElementById("availability-timeline-wrap").hidden = !hasRows || availabilityView !== "timeline";
      document.getElementById("availability-table-wrap").hidden = !hasRows || availabilityView !== "table";
      document.getElementById("availability-legend").hidden = !hasRows;
      if (!hasRows) return;
      const slots = assignProjectSlots(bars);
      renderLegendInto("availability-legend", bars, slots);
      // One row per commitment label, with every kind of time off collapsed into a single row at
      // the bottom: the reason already rides on each bar, so a row per reason would just repeat it.
      const groups = groupBars(bars, (bar) => (bar.type === "off" ? "Time off" : bar.label));
      renderTimelineInto("availability-timeline", groups, bars, slots);
      renderAvailabilityTable();
    }

    // Groups preserve first-appearance order of the key, and time off always sinks to the bottom.
    function groupBars(bars, keyOf) {
      const groups = [];
      const byKey = new Map();
      for (const bar of bars) {
        const key = keyOf(bar);
        if (!byKey.has(key)) {
          byKey.set(key, { label: key, bars: [], off: bar.type === "off" });
          groups.push(byKey.get(key));
        }
        const group = byKey.get(key);
        group.bars.push(bar);
        group.off = group.off && bar.type === "off";
      }
      return groups.filter((group) => !group.off).concat(groups.filter((group) => group.off));
    }

    function renderLegendInto(hostId, bars, slots) {
      const entries = [];
      for (const [name, slot] of slots) {
        entries.push(swatchLegend(name, slot ? "var(--series-" + slot + ")" : "#c3c2b7"));
      }
      if (bars.some((bar) => bar.type === "baseline")) {
        entries.push(swatchLegend("Term baseline", "#c3c2b7"));
      }
      if (bars.some((bar) => bar.type === "open")) {
        entries.push(swatchLegend("Open capacity", "var(--accent)", true));
      }
      if (bars.some((bar) => bar.type === "off")) {
        entries.push(swatchLegend("Time off", "#c3c2b7", true));
      }
      document.getElementById(hostId).innerHTML = entries.join("");
    }

    function swatchLegend(label, color, hatched) {
      return '<span><i class="viz-swatch' + (hatched ? " hatch" : "") + '" style="--sw: ' + color +
        '"></i>' + escapeHtml(label) + "</span>";
    }

    function renderTimelineInto(hostId, groups, bars, slots) {
      const horizon = horizonOf(bars);
      const timeline = document.getElementById(hostId);
      timeline.style.setProperty("--weeks", String(horizon.weeks));
      const parts = [];
      // Month ruler: one tick per month boundary inside the horizon, so a bar always lines up
      // with the month it falls in without labelling all 78 weeks.
      let cursorMonth = -1;
      for (let week = 0; week < horizon.weeks; week += 1) {
        const date = new Date(addDays(horizon.start, week * 7));
        const month = date.getUTCMonth();
        if (month === cursorMonth) continue;
        cursorMonth = month;
        const suffix = month === 0 || week === 0 ? " " + String(date.getUTCFullYear()).slice(2) : "";
        parts.push('<div class="tl-month" style="grid-column: ' + (week + 2) + '">' +
          MONTH_NAMES[month] + suffix + "</div>");
      }
      // Grid row 1 is the month ruler, so data rows start at 2.
      let gridRow = 2;
      for (const group of groups) {
        const lanes = packLanes(group.bars);
        lanes.forEach((lane, laneIndex) => {
          const row = gridRow + laneIndex;
          // The label belongs to the group, not the lane, so only its first lane is labelled; the
          // title carries the full name because the gutter ellipsizes long project names.
          parts.push('<div class="tl-label" style="grid-row: ' + row + '" title="' +
            escapeHtml(group.label) + '">' +
            escapeHtml(laneIndex === 0 ? group.label : "") + "</div>");
          // The hairline delimits groups, not lanes: a person whose time off overlaps their project
          // bars occupies several lanes, and a rule above each one would read as separate people.
          parts.push('<div class="tl-track' + (laneIndex ? " lane" : "") +
            '" style="--r: ' + row + '"></div>');
          for (const bar of lane) {
            const rendered = renderTimelineBar(bar, row, horizon, slots);
            if (rendered) parts.push(rendered);
          }
        });
        gridRow += Math.max(lanes.length, 1);
      }
      parts.push('<div class="tl-today" style="--c-start: ' + weekColumn(horizon.today, horizon) + '"></div>');
      timeline.innerHTML = parts.join("");
    }

    // Two overlapping ranges on one grid row stack on top of each other and the lower one becomes
    // invisible — a conference during a heavy semester is exactly that case — so overlaps are
    // greedily packed into extra lanes. Input is sorted by start, so the first lane whose last bar
    // has already ended is always a valid home.
    function packLanes(bars) {
      const lanes = [];
      const ordered = bars.slice().sort((left, right) => String(left.start).localeCompare(String(right.start)));
      for (const bar of ordered) {
        const start = parseIso(bar.start);
        const lane = lanes.find((rows) => {
          const end = parseIso(rows[rows.length - 1].end);
          return start === null || end === null || end < start;
        });
        if (lane) lane.push(bar);
        else lanes.push([bar]);
      }
      return lanes;
    }

    function renderTimelineBar(bar, gridRow, horizon, slots) {
      const start = parseIso(bar.start);
      const end = parseIso(bar.end);
      // A row mid-edit can hold a blank or half-typed date; skip it rather than drawing garbage.
      if (start === null || end === null || start > end) return "";
      const columnStart = weekColumn(start, horizon);
      const columnEnd = Math.max(weekColumn(end, horizon) + 1, columnStart + 1);
      const style = ["--r: " + gridRow, "--c-start: " + columnStart, "--c-end: " + columnEnd];
      let classes = "tl-bar";
      let text = "";
      if (bar.type === "off") {
        // Icon before the label, not a " · partial" suffix: a narrow bar ellipsizes the suffix away
        // and leaves a dangling separator, and the glyph keeps the state readable without colour.
        classes += bar.availability === "partial" ? " off partial" : " off";
        text = (bar.availability === "partial" ? "◐ " : "● ") + bar.label;
      } else if (bar.type === "open") {
        classes += " open";
        text = formatHours(bar.hours) + " open";
      } else {
        const slot = slots.get(bar.project);
        if (slot) style.push("--sw: var(--series-" + slot + ")");
        else classes += " other";
        // In the lab view a row is a person, so the bar has to name the project it belongs to.
        text = formatHours(bar.hours) + (bar.showProject ? " " + bar.label : "");
      }
      return '<div class="' + classes + '" style="' + style.join("; ") + '" title="' +
        escapeHtml(barTooltip(bar)) + '">' + escapeHtml(text) + "</div>";
    }

    function barTooltip(bar) {
      const range = bar.start + " → " + bar.end;
      const detail = bar.type === "off"
        ? bar.label + " · availability " + (bar.availability || "none")
        : formatHours(bar.hours) + " / week";
      const owner = bar.owner ? bar.owner + " · " : "";
      const subject = bar.type === "off" ? "Time off" : bar.label;
      return owner + subject + " · " + range + " · " + detail + (bar.note ? " · " + bar.note : "");
    }

    function formatHours(value) {
      const hours = numericValue(value);
      return hours === null ? "—" : hours + "h";
    }

    // The table is the relief path for the three categorical slots that sit under 3:1 contrast on
    // this white panel, and the accessible read of the same data.
    function renderAvailabilityTable() {
      const rows = schedule.availability
        .map((row) => ({
          start: row.start,
          end: row.end,
          commitment: commitmentLabel(row),
          hours: formatHours(row.hours_per_week),
          note: row.note || ""
        }))
        .concat(schedule.time_off.map((row) => ({
          start: row.start,
          end: row.end,
          commitment: "Time off · " + humanize(row.kind || "other"),
          hours: row.availability === "partial" ? "Partial" : "None",
          note: row.note || ""
        })))
        .sort((left, right) => String(left.start).localeCompare(String(right.start)));
      document.getElementById("availability-tbody").innerHTML = rows.map((row) =>
        "<tr><td>" + escapeHtml(row.start || "—") + "</td><td>" + escapeHtml(row.end || "—") +
        "</td><td>" + escapeHtml(row.commitment) + "</td><td>" + escapeHtml(row.hours) +
        "</td><td>" + escapeHtml(row.note) + "</td></tr>").join("");
    }

    // Lab-wide view: one row per member, so the bar has to name its project, and project colours
    // are assigned over every member's bars at once — a project keeps one colour lab-wide, which is
    // the whole point of reading across people.
    function renderCapacity() {
      const showReasons = isPrivileged();
      const groups = [];
      const bars = [];
      for (const member of state.members.slice().sort((left, right) =>
        String(left.name || left.id).localeCompare(String(right.name || right.id)))) {
        const owner = String(member.name || member.id || "").trim();
        const own = memberBars(member, showReasons)
          .map((bar) => ({ ...bar, owner, showProject: bar.type === "project" }));
        if (!own.length) continue;
        bars.push(...own);
        groups.push({ label: owner, bars: own });
      }
      const hasRows = bars.length > 0;
      document.getElementById("capacity-empty").hidden = hasRows;
      document.getElementById("capacity-legend").hidden = !hasRows;
      const weekStart = mondayOf(parseIso(isoOf(Date.now())));
      renderCapacityStats(groups, bars, weekStart);
      renderCapacityProjects(bars, weekStart);
      renderCapabilities();
      document.getElementById("capacity-week").textContent =
        "Week of " + isoOf(weekStart);
      if (!hasRows) {
        document.getElementById("capacity-timeline").innerHTML = "";
        document.getElementById("capacity-note").textContent = "";
        return;
      }
      const slots = assignProjectSlots(bars);
      // Never let the palette cap be silent: past four projects the extras share the neutral fill
      // and only their label tells them apart, so say so instead of looking fully colour-coded.
      const greyed = [...slots.values()].filter((slot) => slot === 0).length;
      document.getElementById("capacity-note").textContent = [
        "Hours are as recorded by each member.",
        showReasons
          ? "Time-off reasons are visible to admins and core members only."
          : "Time-off reasons are hidden; only away/partly-away is shown.",
        greyed
          ? greyed + (greyed === 1
            ? " project past the first four shares"
            : " projects past the first four share") +
            " the neutral fill — read their bar labels."
          : ""
      ].filter(Boolean).join(" ");
      renderLegendInto("capacity-legend", bars, slots);
      renderTimelineInto("capacity-timeline", groups, bars, slots);
    }

    // A range counts toward "this week" if it overlaps the Monday–Sunday window at all.
    function activeInWeek(bar, weekStart) {
      const start = parseIso(bar.start);
      const end = parseIso(bar.end);
      return start !== null && end !== null && start <= addDays(weekStart, 6) && end >= weekStart;
    }

    function renderCapacityStats(groups, bars, weekStart) {
      const live = bars.filter((bar) => activeInWeek(bar, weekStart));
      const sumHours = (type) => live
        .filter((bar) => bar.type === type)
        .reduce((total, bar) => total + (numericValue(bar.hours) ?? 0), 0);
      // Baseline rows are real committed hours too; only the open sentinel is spare.
      const committed = sumHours("project") + sumHours("baseline");
      const away = new Set(live.filter((bar) => bar.type === "off").map((bar) => bar.owner));
      document.getElementById("cap-people").textContent = groups.length;
      document.getElementById("cap-committed").textContent = committed;
      document.getElementById("cap-open").textContent = sumHours("open");
      document.getElementById("cap-away").textContent = away.size;
    }

    function renderCapacityProjects(bars, weekStart) {
      const projects = new Map();
      for (const bar of bars.filter((bar) => bar.type === "project")) {
        if (!projects.has(bar.project)) {
          projects.set(bar.project, { hours: 0, people: new Set(), through: "" });
        }
        const entry = projects.get(bar.project);
        entry.people.add(bar.owner);
        if (String(bar.end) > entry.through) entry.through = String(bar.end);
        if (activeInWeek(bar, weekStart)) entry.hours += numericValue(bar.hours) ?? 0;
      }
      const rows = [...projects.entries()].sort((left, right) => right[1].hours - left[1].hours);
      document.getElementById("capacity-projects").innerHTML = rows.length
        ? rows.map(([name, entry]) =>
          "<tr><td>" + escapeHtml(name) + "</td><td>" + entry.hours +
          "</td><td>" + escapeHtml([...entry.people].sort().join(", ")) +
          "</td><td>" + escapeHtml(entry.through || "—") + "</td></tr>").join("")
        : '<tr><td colspan="4" class="cell-details">No project commitments recorded.</td></tr>';
    }

    // "Capabilities" comes from the roster itself (branch + topics), not the schedule, so it still
    // answers "can the lab do X" for members who have not filled in availability yet.
    function renderCapabilities() {
      const skills = new Map();
      for (const member of state.members) {
        const profile = memberProfile(member);
        const owner = String(member.name || member.id || "").trim();
        for (const skill of [profile.branch].concat(profile.topics).filter(Boolean)) {
          if (!skills.has(skill)) skills.set(skill, new Set());
          skills.get(skill).add(owner);
        }
      }
      const rows = [...skills.entries()]
        .sort((left, right) => right[1].size - left[1].size || left[0].localeCompare(right[0]));
      document.getElementById("capacity-skills").innerHTML = rows.length
        ? rows.map(([skill, people]) =>
          "<tr><td>" + escapeHtml(skill) + "</td><td>" + people.size +
          "</td><td>" + escapeHtml([...people].sort().join(", ")) + "</td></tr>").join("")
        : '<tr><td colspan="3" class="cell-details">No research branches or topics recorded.</td></tr>';
    }

    // Editors are re-rendered only on add/remove; a keystroke updates state and redraws the chart
    // alone, because rebuilding the inputs mid-edit would steal focus from the field being typed.
    function renderScheduleEditors() {
      const availabilityHost = document.getElementById("availability-rows");
      availabilityHost.innerHTML = schedule.availability.length
        ? schedule.availability.map((row, index) => availabilityRowMarkup(row, index)).join("")
        : '<p class="sched-empty">No commitments yet.</p>';
      const timeOffHost = document.getElementById("time-off-rows");
      timeOffHost.innerHTML = schedule.time_off.length
        ? schedule.time_off.map((row, index) => timeOffRowMarkup(row, index)).join("")
        : '<p class="sched-empty">No time off recorded.</p>';
    }

    function availabilityRowMarkup(row, index) {
      const project = projectKey(row);
      const options = uniqueValues(memberProfile(sessionMember || {}).projects)
        .map((name) => '<option value="' + escapeHtml(name) + '"' +
          (name === project ? " selected" : "") + ">" + escapeHtml(name) + "</option>").join("");
      return '<div class="sched-row" data-list="availability" data-index="' + index + '">' +
        '<label class="tight">From<input type="date" data-field="start" value="' + escapeHtml(row.start || "") + '"></label>' +
        '<label class="tight">To<input type="date" data-field="end" value="' + escapeHtml(row.end || "") + '"></label>' +
        '<label>Project<select data-field="project"><option value="">Term baseline</option>' +
        '<option value="' + OPEN_PROJECT + '"' + (project === OPEN_PROJECT ? " selected" : "") +
        ">Open capacity</option>" + options +
        (project && project !== OPEN_PROJECT && !options.includes('value="' + escapeHtml(project) + '"')
          ? '<option value="' + escapeHtml(project) + '" selected>' + escapeHtml(project) + "</option>"
          : "") +
        "</select></label>" +
        '<label class="tight">Hours / week<input type="number" min="0" max="168" step="1" data-field="hours_per_week" value="' +
        escapeHtml(row.hours_per_week ?? "") + '"></label>' +
        '<label>Note<input type="text" data-field="note" placeholder="Optional" value="' +
        escapeHtml(row.note || "") + '"></label>' +
        '<button class="drop" type="button" data-drop="availability" data-index="' + index + '">Remove</button>' +
        "</div>";
    }

    function timeOffRowMarkup(row, index) {
      const kinds = timeOffKinds.map((kind) => '<option value="' + kind + '"' +
        (row.kind === kind ? " selected" : "") + ">" + humanize(kind) + "</option>").join("");
      return '<div class="sched-row" data-list="time_off" data-index="' + index + '">' +
        '<label class="tight">From<input type="date" data-field="start" value="' + escapeHtml(row.start || "") + '"></label>' +
        '<label class="tight">To<input type="date" data-field="end" value="' + escapeHtml(row.end || "") + '"></label>' +
        '<label>Reason<select data-field="kind">' + kinds + "</select></label>" +
        '<label>Still available<select data-field="availability">' +
        '<option value="none"' + (row.availability === "partial" ? "" : " selected") + ">Not available</option>" +
        '<option value="partial"' + (row.availability === "partial" ? " selected" : "") + ">Partly available</option>" +
        "</select></label>" +
        '<label>Note<input type="text" data-field="note" placeholder="Optional" value="' +
        escapeHtml(row.note || "") + '"></label>' +
        '<button class="drop" type="button" data-drop="time_off" data-index="' + index + '">Remove</button>' +
        "</div>";
    }

    // Client-side mirror of validateAvailability in service-core.ts. The server stays the trust
    // boundary; this only saves a round trip on obvious mistakes.
    function scheduleValidationError() {
      for (const row of schedule.availability) {
        if (!row.start || !row.end) return "Every commitment needs a start and end date.";
        if (parseIso(row.start) > parseIso(row.end)) return "A commitment cannot end before it starts.";
        const hours = numericValue(row.hours_per_week);
        if (hours === null || hours < 0 || hours > 168) return "Hours per week must be between 0 and 168.";
      }
      for (const row of schedule.time_off) {
        if (!row.start || !row.end) return "Every time-off entry needs a start and end date.";
        if (parseIso(row.start) > parseIso(row.end)) return "Time off cannot end before it starts.";
      }
      // Mirrors the server's host allowlist: the importer fetches this URL, so it has to be a
      // Google Docs or Drive link, not an arbitrary host.
      const doc = String(document.getElementById("availability-doc-url").value || "").trim();
      if (doc && !/^https:\\/\\/(docs|drive)\\.google\\.com\\//u.test(doc)) {
        return "The availability doc must be an https Google Docs or Drive link.";
      }
      return "";
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
        ...(String(data.role || "").trim() ? { role: data.role.trim() } : {}),
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

    // Delegated so the handlers survive every editor re-render. A field edit mutates state and
    // redraws the chart only; add/remove rebuilds the inputs.
    document.getElementById("schedule-form").addEventListener("input", (event) => {
      const field = event.target.dataset?.field;
      const container = event.target.closest(".sched-row");
      if (!field || !container) return;
      const row = schedule[container.dataset.list]?.[Number(container.dataset.index)];
      if (!row) return;
      // Kept as the raw string; Number() conversion happens once, on submit.
      row[field] = event.target.value;
      renderAvailability();
    });

    document.getElementById("schedule-form").addEventListener("change", (event) => {
      if (event.target.dataset?.field) renderAvailability();
    });

    document.getElementById("schedule-form").addEventListener("click", (event) => {
      const list = event.target.dataset?.drop;
      if (!list) return;
      schedule[list].splice(Number(event.target.dataset.index), 1);
      renderScheduleEditors();
      renderAvailability();
    });

    document.getElementById("availability-add").addEventListener("click", () => {
      // Seed a one-week row starting this coming Monday: the near-term horizon is the common case,
      // and a prefilled range means the bar shows up immediately instead of after four fields.
      const monday = mondayOf(addDays(Date.now(), 7));
      schedule.availability.push({
        id: crypto.randomUUID(),
        start: isoOf(monday),
        end: isoOf(addDays(monday, 6)),
        project: "",
        hours_per_week: memberProfile(sessionMember || {}).hours ?? 0
      });
      renderScheduleEditors();
      renderAvailability();
    });

    document.getElementById("time-off-add").addEventListener("click", () => {
      const monday = mondayOf(addDays(Date.now(), 7));
      schedule.time_off.push({
        start: isoOf(monday),
        end: isoOf(addDays(monday, 6)),
        kind: "vacation",
        availability: "none"
      });
      renderScheduleEditors();
      renderAvailability();
    });

    document.getElementById("availability-view-timeline").addEventListener("click", () => setAvailabilityView("timeline"));
    document.getElementById("availability-view-table").addEventListener("click", () => setAvailabilityView("table"));

    function setAvailabilityView(view) {
      availabilityView = view;
      document.getElementById("availability-view-timeline").setAttribute("aria-pressed", String(view === "timeline"));
      document.getElementById("availability-view-table").setAttribute("aria-pressed", String(view === "table"));
      renderAvailability();
    }

    document.getElementById("schedule-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!sessionMember) return;
      const invalid = scheduleValidationError();
      if (invalid) {
        setStatus("schedule-status", invalid, "error");
        return;
      }
      // Only the schedule fields are sent; updateOwnProfile merges a whitelisted patch, so this
      // cannot clobber the profile fields owned by the other form.
      const body = {
        availability: schedule.availability.map((row) => ({
          id: row.id || crypto.randomUUID(),
          start: row.start,
          end: row.end,
          ...(projectKey(row) ? { project: projectKey(row) } : {}),
          hours_per_week: Number(row.hours_per_week),
          ...(row.note ? { note: row.note } : {}),
          ...(row.color ? { color: row.color } : {})
        })),
        time_off: schedule.time_off.map((row) => ({
          start: row.start,
          end: row.end,
          kind: row.kind || "other",
          availability: row.availability === "partial" ? "partial" : "none",
          ...(row.note ? { note: row.note } : {})
        })),
        availability_doc_url:
          String(document.getElementById("availability-doc-url").value || "").trim()
      };
      try {
        const updated = await api("/lab/members/" + encodeURIComponent(sessionMember.id), {
          method: "PUT",
          body: JSON.stringify(body)
        });
        sessionMember = updated;
        setSchedule(updated);
        setStatus("schedule-status", "Saved schedule.", "ok");
        renderScheduleEditors();
        renderAvailability();
        renderDocHint();
        await refresh();
      } catch (error) {
        setStatus("schedule-status", error.message, "error");
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
          // No session is the ordinary case for a visitor, not an error: open the public console
          // and let them reach the sign-in form from the toolbar.
          showPublicConsole();
          return;
        }
        const view = await response.json();
        sessionMember = view.member;
        showConsole();
        await refresh();
      } catch (error) {
        showPublicConsole();
        setStatus("reimb-status", error.message, "error");
      }
    }

    document.getElementById("signin-button").addEventListener("click", () => {
      showAuthGate("", "");
    });

    // Reimbursement over the two open routes. The service treats this principal as anonymous and
    // lets it reach nothing else, so the packet it builds only ever contains what was typed here.
    const reimbursement = { messages: [], draft: {}, ready: false };

    function renderReimbursementLog() {
      document.getElementById("reimb-log").innerHTML = reimbursement.messages
        .map((entry) =>
          '<p class="reimb-line reimb-line--' + entry.role + '"><strong>' +
          (entry.role === "user" ? "You" : "AdminBot") + ':</strong> ' +
          escapeHtml(entry.text) + "</p>")
        .join("") || '<p class="subtle">Describe the expense to get started.</p>';
    }

    document.getElementById("reimb-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const message = String(formData(form).message || "").trim();
      if (!message) return;
      reimbursement.messages.push({ role: "user", text: message });
      // One vocabulary for both surfaces: the options come from adminBotMemberRoles in contracts.ts
    // rather than being retyped in markup, so the console and the Control UI cannot drift.
    const roleOptions = (placeholder) =>
      '<option value="">' + placeholder + "</option>" +
      memberRoles.map((role) => '<option value="' + escapeHtml(role) + '">' + escapeHtml(role) + "</option>").join("");
    document.getElementById("signup-role").innerHTML = roleOptions("Select a role…");
    document.getElementById("member-role-select").innerHTML = roleOptions("Not set");

    renderReimbursementLog();
      form.reset();
      setStatus("reimb-status", "Working…", "");
      try {
        const response = await fetch("/reimbursements/converse", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ message, draft: reimbursement.draft })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.error?.message || "Could not reach AdminBot.");
        reimbursement.draft = payload.draft || reimbursement.draft;
        reimbursement.ready = payload.ready === true;
        reimbursement.messages.push({ role: "adminbot", text: payload.reply || "" });
        renderReimbursementLog();
        setStatus("reimb-status", reimbursement.ready ? "Ready to generate." : "", "");
      } catch (error) {
        setStatus("reimb-status", error.message, "error");
      }
    });

    document.getElementById("reimb-generate").addEventListener("click", async () => {
      setStatus("reimb-status", "Generating…", "");
      try {
        const response = await fetch("/reimbursements/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ draft: reimbursement.draft })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.error?.message || "Could not generate the packet.");
        const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
        reimbursement.messages.push({
          role: "adminbot",
          text: artifacts.length
            ? "Prepared: " + artifacts.map((item) => item.name || item.kind || "artifact").join(", ")
            : "Packet prepared."
        });
        renderReimbursementLog();
        setStatus("reimb-status", "Done.", "ok");
      } catch (error) {
        setStatus("reimb-status", error.message, "error");
      }
    });

    document.getElementById("reimb-reset").addEventListener("click", () => {
      reimbursement.messages = [];
      reimbursement.draft = {};
      reimbursement.ready = false;
      renderReimbursementLog();
      setStatus("reimb-status", "", "");
    });

    renderReimbursementLog();

    boot();
  </script>
</body>
</html>`;
}
