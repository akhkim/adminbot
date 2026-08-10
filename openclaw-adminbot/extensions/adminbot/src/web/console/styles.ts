/** Admin console stylesheet, served inline: the console is one self-contained document. */
export const adminBotConsoleStyles = `    :root {
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
`;
