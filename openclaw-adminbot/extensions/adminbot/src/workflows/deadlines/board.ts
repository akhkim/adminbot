// Generated from extensions/adminbot/content/deadlines/deadlines-board.html by
// scripts/adminbot-deadline-web-ui-gen.py. Do not hand-edit; regenerate instead.
// Renders the self-contained live deadline countdown board (Output 0).

import { DEFAULT_ADMINBOT_CONTROL_UI_URL } from "../../contracts/control-ui.js";

const TEMPLATE = `<title>Jinesis Deadlines</title>
<style>
  :root {
    --bg: #0b0f1a;
    --surface: #141b2b;
    --surface-2: #1b2437;
    --raised: #202b41;
    --border: #26324a;
    --border-soft: #1e2740;
    --ink: #e8edf7;
    --ink-2: #9fb0cc;
    --muted: #66799a;
    --accent: #8ea2ff;
    --accent-strong: #6f86ff;
    --calm: #34d3a6;
    --warn: #eab54a;
    --serious: #f5883e;
    --crit: #f2606a;
    --classification-primary: #c084fc;
    --classification-secondary: #d6b46b;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace;
    --radius: 14px;
    --gap: 16px;
  }
  * {
    box-sizing: border-box;
  }
  body {
    margin: 0;
  }
  .wrap {
    background: var(--bg);
    color: var(--ink);
    font-family: var(--sans);
    min-height: 100vh;
    padding: 28px clamp(14px, 4vw, 40px) 64px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  a {
    color: var(--accent);
    text-decoration: none;
  }
  a:hover {
    color: var(--accent-strong);
  }
  :focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 6px;
  }
  .container {
    max-width: 1200px;
    margin: 0 auto;
  }

  /* header */
  .page-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }
  h1 {
    font-size: clamp(24px, 4vw, 34px);
    margin: 0;
    letter-spacing: -0.02em;
    text-wrap: balance;
    font-weight: 650;
  }
  .sub {
    margin: 8px 0 0;
    color: var(--ink-2);
    font-size: 14.5px;
  }
  .proposal-link {
    flex: 0 0 auto;
    padding: 8px 12px;
    border: 1px solid var(--accent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    color: var(--ink);
    font-size: 13px;
    font-weight: 600;
  }
  /* hero + stats grid */
  .top {
    display: grid;
    grid-template-columns: 1.3fr 0.9fr;
    gap: var(--gap);
    margin: 26px 0;
  }
  @media (max-width: 760px) {
    .top {
      grid-template-columns: 1fr;
    }
  }
  .hero {
    background: linear-gradient(160deg, var(--surface-2), var(--surface));
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 22px 24px;
    position: relative;
    overflow: hidden;
  }
  .hero::before {
    content: "";
    position: absolute;
    inset: 0 auto 0 0;
    width: 4px;
    background: var(--h-color, var(--accent));
  }
  .hero[data-entry-type="workshop"] {
    background: color-mix(in srgb, var(--surface) 88%, var(--muted));
  }
  .hero[data-entry-type="workshop"] .hname {
    color: var(--ink-2);
    font-weight: 500;
  }
  .hero .lbl {
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .hero .hname {
    font-size: 18px;
    font-weight: 600;
    margin: 10px 0 2px;
    letter-spacing: -0.01em;
    line-height: 1.3;
  }
  .hero .hmeta {
    color: var(--ink-2);
    font-size: 14px;
    margin-bottom: 16px;
  }
  .cd {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    display: flex;
    gap: 14px;
    align-items: flex-end;
  }
  .cd .unit {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .cd .num {
    font-size: clamp(26px, 5vw, 40px);
    font-weight: 600;
    line-height: 1;
    color: var(--h-color, var(--accent));
  }
  .cd .cap {
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .cd .sep {
    font-size: 26px;
    color: var(--border);
    align-self: center;
    padding-bottom: 14px;
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-template-rows: repeat(2, 1fr);
    gap: var(--gap);
  }
  .stat {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 18px;
    display: flex;
    align-items: flex-start;
    flex-direction: column;
    justify-content: space-between;
    gap: 12px;
  }
  .stat .k {
    color: var(--ink-2);
    font-size: 14px;
  }
  .stat .v {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    font-size: 24px;
    font-weight: 600;
  }

  /* controls */
  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    margin: 8px 0 18px;
  }
  .modes {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
    margin: 18px 0 10px;
  }
  .search {
    flex: 1 1 220px;
    min-width: 180px;
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--ink);
    border-radius: 10px;
    padding: 10px 13px;
    font-size: 15px;
    font-family: var(--sans);
  }
  .filter {
    flex: 0 0 auto;
    min-width: 0;
  }
  #entry-type {
    width: 170px;
  }
  #archival-status {
    width: 220px;
  }
  #priority {
    width: 170px;
  }
  .search::placeholder {
    color: var(--muted);
  }
  .chips {
    display: flex;
    flex: 1 0 100%;
    gap: 8px;
    flex-wrap: wrap;
  }
  .chip {
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--ink-2);
    padding: 8px 13px;
    border-radius: 999px;
    font-size: 14px;
    cursor: pointer;
    font-family: var(--sans);
    display: inline-flex;
    gap: 7px;
    align-items: center;
    transition:
      background 0.15s,
      color 0.15s,
      border-color 0.15s;
  }
  .chip:hover {
    border-color: var(--accent);
  }
  .chip[aria-pressed="true"] {
    background: color-mix(in srgb, var(--accent) 20%, transparent);
    border-color: var(--accent);
    color: var(--ink);
  }
  .chip .ct {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
  }
  .chip[aria-pressed="true"] .ct {
    color: var(--accent);
  }
  .toggle {
    display: flex;
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }
  .toggle button {
    background: var(--surface);
    border: 0;
    color: var(--ink-2);
    padding: 8px 14px;
    font-size: 14px;
    cursor: pointer;
    font-family: var(--sans);
  }
  .toggle button[aria-pressed="true"] {
    background: var(--raised);
    color: var(--ink);
  }
  .archival-guide {
    margin: -8px 0 18px;
    color: var(--muted);
    font-size: 12.5px;
  }
  .archival-guide summary {
    width: max-content;
    color: var(--ink-2);
    cursor: pointer;
  }
  .archival-guide dl {
    display: grid;
    gap: 7px;
    max-width: 720px;
    margin: 10px 0 0;
    padding-left: 14px;
    border-left: 2px solid var(--border);
  }
  .archival-guide dl > div {
    display: grid;
    grid-template-columns: 100px minmax(0, 1fr);
    gap: 12px;
  }
  .archival-guide dt {
    color: var(--ink);
    font-weight: 600;
  }
  .archival-guide dd {
    margin: 0;
  }

  /* cards */
  .grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--gap);
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px 16px 15px 19px;
    position: relative;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 9px;
  }
  .card::before {
    content: "";
    position: absolute;
    inset: 0 auto 0 0;
    width: 4px;
    background: var(--u);
  }
  .card .row1 {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  .labels {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .classification {
    display: inline-flex;
    gap: 6px;
    white-space: nowrap;
  }
  .badge,
  .priority,
  .archival {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 600;
    line-height: 1.2;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .badge {
    border-color: color-mix(in srgb, var(--ink) 55%, var(--border));
    background: color-mix(in srgb, var(--ink) 10%, transparent);
    color: var(--ink);
  }
  .priority[data-priority="primary"] {
    border-color: var(--classification-primary);
    background: color-mix(in srgb, var(--classification-primary) 14%, transparent);
    color: var(--classification-primary);
  }
  .priority[data-priority="secondary"] {
    border-color: var(--classification-secondary);
    background: color-mix(in srgb, var(--classification-secondary) 10%, transparent);
    color: var(--classification-secondary);
  }
  .archival {
    background: var(--surface-2);
    color: var(--ink-2);
  }
  .card[data-entry-type="workshop"] {
    background: color-mix(in srgb, var(--surface) 88%, var(--muted));
    border-color: var(--border-soft);
  }
  .card[data-entry-type="workshop"] .cname,
  .deadline-group__row[data-entry-type="workshop"] .deadline-group__row-name {
    color: var(--ink-2);
  }
  [data-entry-type="workshop"] .badge {
    border-color: color-mix(in srgb, var(--ink-2) 55%, var(--border));
    background: color-mix(in srgb, var(--ink-2) 12%, transparent);
    color: var(--ink-2);
  }
  .pill {
    font-size: 12px;
    font-weight: 600;
    padding: 3px 9px;
    border-radius: 999px;
    white-space: nowrap;
    background: color-mix(in srgb, var(--u) 18%, transparent);
    color: var(--u);
  }
  .cname {
    display: -webkit-box;
    overflow: hidden;
    font-size: 16px;
    font-weight: 600;
    line-height: 1.3;
    letter-spacing: -0.01em;
    margin: 1px 0;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
  }
  .hname a,
  .cname a,
  td.name a,
  .deadline-group__row-name a {
    color: inherit;
    text-decoration: underline;
    text-decoration-color: var(--border);
    text-underline-offset: 3px;
  }
  .hname a:hover,
  .cname a:hover,
  td.name a:hover,
  .deadline-group__row-name a:hover {
    color: inherit;
    text-decoration-color: currentcolor;
  }
  .cgroup {
    display: flex;
    align-items: baseline;
    gap: 4px;
    min-width: 0;
    white-space: nowrap;
    font-size: 13px;
    color: var(--muted);
  }
  .cgroup-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cgroup-stage {
    flex: 0 0 auto;
  }
  .cdl {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--ink-2);
    font-variant-numeric: tabular-nums;
  }
  .aoe {
    color: var(--muted);
  }
  .ccd {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    font-size: 20px;
    font-weight: 600;
    color: var(--u);
    letter-spacing: 0.01em;
  }
  .cnote {
    font-size: 12.5px;
    color: var(--muted);
  }
  .clink {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    margin-top: auto;
    color: var(--ink-2);
    font-size: 13.5px;
    font-family: var(--mono);
    line-height: 1.2;
    text-decoration: none;
    white-space: nowrap;
  }
  .clink--button {
    padding: 7px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .clink:hover,
  .clink:focus-visible {
    color: var(--ink);
  }
  .clink--button:hover,
  .clink--button:focus-visible {
    border-color: var(--ink-2);
  }

  .deadline-board__group-list {
    display: grid;
    gap: 12px;
  }
  .deadline-group {
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: inset 4px 0 var(--u);
  }
  .deadline-group__summary {
    display: grid;
    grid-template-columns: 16px 150px minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 14px 18px;
    border: 0;
    background: transparent;
    color: var(--ink);
    cursor: pointer;
    font-family: var(--sans);
    text-align: left;
  }
  .deadline-group__summary:hover,
  .deadline-group__summary:focus-visible {
    background: var(--surface-2);
  }
  .deadline-group__chevron {
    color: var(--muted);
    font-size: 20px;
    line-height: 1;
    transition: transform 0.15s;
  }
  .deadline-group[data-open] .deadline-group__chevron {
    transform: rotate(90deg);
  }
  .deadline-group__summary-countdown,
  .deadline-group__row-countdown {
    color: var(--u);
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .deadline-group__heading {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 3px;
  }
  .deadline-group__heading strong {
    overflow: hidden;
    font-size: 16px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .deadline-group__heading small,
  .deadline-group__count {
    color: var(--ink-2);
    font-size: 13px;
  }
  .deadline-group__count {
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 999px;
    white-space: nowrap;
  }
  .deadline-group__panel {
    border-top: 1px solid var(--border);
  }
  .deadline-group__section + .deadline-group__section {
    border-top: 1px solid var(--border);
  }
  .deadline-group__section-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 0;
    padding: 8px 18px;
    background: var(--surface-2);
    color: var(--muted);
    font-family: var(--mono);
    font-size: 12px;
  }
  .deadline-group__section-head strong {
    color: var(--ink);
    font-weight: 600;
  }
  .deadline-group__row {
    display: grid;
    grid-template-columns: 124px 208px minmax(0, 1fr) auto;
    grid-template-areas: "countdown date main source";
    align-items: center;
    gap: 12px;
    padding: 12px 18px;
    border-bottom: 1px solid var(--border-soft);
  }
  .deadline-group__row:last-child {
    border-bottom: 0;
  }
  .deadline-group__row:hover {
    background: var(--surface-2);
  }
  .deadline-group__row[data-entry-type="workshop"] {
    background: color-mix(in srgb, var(--surface) 88%, var(--muted));
  }
  .deadline-group__row-main {
    grid-area: main;
    min-width: 0;
  }
  .deadline-group__row-countdown {
    grid-area: countdown;
  }
  .deadline-group__row-name {
    margin: 0;
    overflow-wrap: anywhere;
    color: var(--ink);
    font-size: 14px;
    font-weight: 600;
    line-height: 1.35;
  }
  .deadline-group__row-note {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 3px 0 0;
    color: var(--muted);
    font-size: 12.5px;
  }
  .deadline-group__row-note:empty {
    display: none;
  }
  .deadline-group__row-date {
    grid-area: date;
    color: var(--ink-2);
    font-family: var(--mono);
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .deadline-group__row .clink {
    grid-area: source;
    margin: 0;
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .deadline-group__row-actions {
    grid-area: source;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
  }

  /* table */
  .tablewrap {
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 14px;
    min-width: 640px;
  }
  th,
  td {
    text-align: left;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border-soft);
    line-height: 1.25;
    vertical-align: middle;
    white-space: nowrap;
  }
  th {
    font-family: var(--mono);
    font-size: 11.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
    position: sticky;
    top: 0;
    background: var(--surface-2);
  }
  td.name {
    max-width: 420px;
    min-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  td.name a {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  td .clink {
    margin-top: 0;
    padding: 4px 6px;
  }
  td .labels {
    flex-wrap: nowrap;
  }
  td .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--u);
    margin-right: 8px;
    vertical-align: middle;
  }
  tr[data-entry-type="workshop"] {
    background: color-mix(in srgb, var(--surface) 88%, var(--muted));
    color: var(--ink-2);
  }
  .tcd {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    color: var(--ink);
  }
  .tcd.countdown {
    color: var(--u);
  }
  td.meta {
    color: var(--ink-2);
  }
  tr:last-child td {
    border-bottom: 0;
  }
  .hidden {
    display: none !important;
  }
  .empty {
    color: var(--muted);
    text-align: center;
    padding: 40px;
    font-size: 14px;
  }
  .foot {
    margin-top: 26px;
    color: var(--muted);
    font-size: 12.5px;
    font-family: var(--mono);
  }
  @media (max-width: 1000px) {
    .grid {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }
  @media (max-width: 760px) {
    .grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 600px) {
    .page-head {
      flex-direction: column;
    }
    .filter {
      flex: 1 1 100%;
      width: 100%;
    }
    .deadline-group__summary {
      grid-template-columns: 16px minmax(0, 1fr) auto;
    }
    .deadline-group__summary-countdown {
      grid-row: 2;
      grid-column: 2;
    }
    .deadline-group__heading {
      grid-row: 1;
      grid-column: 2;
    }
    .deadline-group__count {
      grid-row: 1 / span 2;
      grid-column: 3;
    }
    .deadline-group__row {
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas:
        "countdown date"
        "main main"
        "source source";
      gap: 8px 16px;
    }
    .deadline-group__row-main {
      grid-column: auto;
    }
    .deadline-group__row .clink {
      justify-self: start;
    }
    .archival-guide dl > div {
      grid-template-columns: 1fr;
      gap: 0;
    }
    .deadline-group__row-actions {
      grid-column: 1 / -1;
      justify-content: flex-start;
    }
  }
  @media (max-width: 480px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    * {
      transition: none !important;
    }
  }
</style>

<div class="wrap">
  <div class="container">
    <div class="page-head">
      <div>
        <h1>Deadlines</h1>
        <p class="sub">Past and upcoming conference &amp; workshop deadlines.</p>
      </div>
      <a class="proposal-link" href="__DEADLINE_PROPOSAL_URL__">Propose a deadline</a>
    </div>

    <div class="modes">
      <div class="toggle" role="group" aria-label="Deadline period">
        <button id="p-past" aria-pressed="false">Past</button>
        <button id="p-upcoming" aria-pressed="true">Upcoming</button>
      </div>
      <div class="toggle" role="group" aria-label="View">
        <button id="v-groups" aria-pressed="true">Groups</button>
        <button id="v-cards" aria-pressed="false">Cards</button>
        <button id="v-table" aria-pressed="false">Table</button>
      </div>
    </div>

    <div class="controls">
      <input
        class="search"
        id="search"
        type="search"
        placeholder="Search conferences & workshops…"
        aria-label="Search deadlines"
      />
      <select class="search filter" id="entry-type" aria-label="Filter by entry type">
        <option value="all">All entry types</option>
        <option value="main_conference">Main conferences</option>
        <option value="demo_track">Demo tracks</option>
        <option value="workshop">Workshops</option>
        <option value="arr_direct_submission">ARR direct submissions</option>
        <option value="arr_commitment">ARR commitments</option>
        <option value="rebuttal">Rebuttals</option>
        <option value="other">Other</option>
      </select>
      <select class="search filter" id="archival-status" aria-label="Filter by archival status">
        <option value="all">All archival statuses</option>
        <option value="archival">Archival</option>
        <option value="non_archival">Non-archival</option>
        <option value="mixed">Archival + non-archival</option>
        <option value="unknown">Archival status unknown</option>
      </select>
      <select class="search filter" id="priority" aria-label="Filter by priority">
        <option value="all">All priorities</option>
        <option value="primary">Primary priority</option>
        <option value="secondary">Secondary priority</option>
        <option value="standard">Standard priority</option>
      </select>
      <div class="chips" id="chips" role="group" aria-label="Filter by venue"></div>
    </div>

    <details class="archival-guide">
      <summary>What priority and archival status mean</summary>
      <p>Primary and Secondary are the lab's venue priorities. Archival status is a separate publication-policy classification.</p>
      <p>Workshop status follows its own CFP or an official parent policy. A workshop can offer archival, non-archival, or separate archival and non-archival routes.</p>
      <dl>
        <div>
          <dt>Archival</dt>
          <dd>counts as publishing; the same paper cannot generally be submitted elsewhere.</dd>
        </div>
        <div>
          <dt>Non-archival</dt>
          <dd>does not count as publishing; you can still submit the paper elsewhere.</dd>
        </div>
        <div>
          <dt>Archival + non-archival</dt>
          <dd>choose the CFP's non-archival route if the paper may be submitted elsewhere.</dd>
        </div>
        <div>
          <dt>Unknown</dt>
          <dd>check the call for papers before assuming another submission is allowed.</dd>
        </div>
      </dl>
    </details>

    <div class="top">
      <div class="hero" id="hero"></div>
      <div class="stats">
        <div class="stat">
          <span class="k">Matching deadlines</span><span class="v" id="s-total">–</span>
        </div>
        <div class="stat">
          <span class="k" id="s-today-label">Due today</span
          ><span class="v" id="s-today" style="color: var(--crit)">–</span>
        </div>
        <div class="stat">
          <span class="k" id="s-7-label">Due within 7 days</span
          ><span class="v" id="s-7" style="color: var(--serious)">–</span>
        </div>
        <div class="stat">
          <span class="k" id="s-30-label">Due within 30 days</span
          ><span class="v" id="s-30" style="color: var(--warn)">–</span>
        </div>
      </div>
    </div>

    <div class="grid" id="grid"></div>
    <div class="deadline-board__group-list hidden" id="group-list"></div>
    <div class="tablewrap hidden" id="tablewrap">
      <table>
        <thead>
          <tr>
            <th>Deadline (AoE)</th>
            <th>Countdown</th>
            <th>Item</th>
            <th>Type</th>
            <th>Venue</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>
    <div class="empty hidden" id="empty">No deadlines match your filter.</div>

    <p class="foot" id="foot"></p>
  </div>
</div>

<script>
  const DATA = __ITEMS_JSON__;
  // AoE (UTC-12): wall-clock T corresponds to UTC instant T + 12h
  function aoeToUTC(s) {
    const m = s.match(/(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):(\\d{2}):(\\d{2})/);
    if (!m) return null;
    const [_, y, mo, d, h, mi, se] = m.map(Number);
    return Date.UTC(y, mo - 1, d, h, mi, se) + 12 * 3600 * 1000;
  }
  DATA.forEach((x) => {
    x._sub = aoeToUTC(x.deadline_aoe);
    x._notif = x.notification_aoe ? aoeToUTC(x.notification_aoe) : null;
  });
  DATA.sort((a, b) => a._sub - b._sub);

  const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  function fmtDate(ms) {
    const d = new Date(ms);
    return \`\${MONTHS[d.getUTCMonth()]} \${d.getUTCDate()}, \${d.getUTCFullYear()}\`;
  }
  function fmtAoe(x) {
    const m = (x || "").match(/(\\d{4})-(\\d{2})-(\\d{2})/);
    if (!m) return "";
    return \`\${MONTHS[+m[2] - 1]} \${+m[3]}, \${m[1]}\`;
  }
  function fmtAoeDateTimeText(x) {
    const time = (x || "").match(/[ T](\\d{2}):(\\d{2})/);
    const date = fmtAoe(x);
    return date && time ? \`\${date} · \${time[1]}:\${time[2]} AoE\` : date;
  }
  function fmtAoeDateTime(x) {
    const text = fmtAoeDateTimeText(x);
    const separator = text.indexOf(" · ");
    return separator < 0
      ? text
      : \`\${text.slice(0, separator)} <span class="aoe">\${text.slice(separator)}</span>\`;
  }
  function aoeDayKey(now) {
    return new Date(now - 12 * 3600000).toISOString().slice(0, 10);
  }
  function urgencyVar(days) {
    return days <= 3
      ? "var(--crit)"
      : days <= 7
        ? "var(--serious)"
        : days <= 30
          ? "var(--warn)"
          : "var(--calm)";
  }
  function urgencyLabel(ms, now) {
    const diff = ms - now;
    if (diff <= 0) return { txt: "passed", cvar: "var(--muted)" };
    const days = diff / 86400000;
    const d = Math.floor(days);
    const cvar = urgencyVar(days);
    return { txt: d === 0 ? "today" : d + " day" + (d === 1 ? "" : "s") + " left", cvar };
  }
  function parts(diff) {
    if (diff < 0) diff = 0;
    const d = Math.floor(diff / 86400000);
    const h = Math.floor(diff / 3600000) % 24;
    const m = Math.floor(diff / 60000) % 60;
    const s = Math.floor(diff / 1000) % 60;
    return { d, h, m, s };
  }
  const pad = (n) => String(n).padStart(2, "0");

  let activeGroup = "All",
    view = "groups",
    period = "upcoming",
    entryType = "all",
    archivalStatus = "all",
    priority = "all",
    query = "",
    renderedAoeDay = "";
  const expandedGroups = new Set();
  const chips = document.getElementById("chips");
  function chip(label, val, count) {
    const b = document.createElement("button");
    b.className = "chip";
    b.setAttribute("aria-pressed", val === activeGroup);
    b.innerHTML = \`\${label} <span class="ct">\${count}</span>\`;
    b.onclick = () => {
      activeGroup = val;
      [...chips.children].forEach((c) => c.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", "true");
      render();
    };
    chips.appendChild(b);
  }
  function rebuildChips(entries) {
    if (activeGroup !== "All" && !entries.some((x) => x.venue_group === activeGroup)) {
      activeGroup = "All";
    }
    const groups = [
      ...new Map(
        entries.map((x) => [x.venue_group, { id: x.venue_group, label: x.venue_group }]),
      ).values(),
    ];
    chips.replaceChildren();
    chip("All", "All", entries.length);
    groups.forEach((group) =>
      chip(group.label, group.id, entries.filter((x) => x.venue_group === group.id).length),
    );
  }

  document.getElementById("search").addEventListener("input", (e) => {
    query = e.target.value.toLowerCase().trim();
    render();
  });
  document.getElementById("entry-type").addEventListener("change", (e) => {
    entryType = e.target.value;
    render();
  });
  document.getElementById("archival-status").addEventListener("change", (e) => {
    archivalStatus = e.target.value;
    render();
  });
  document.getElementById("priority").addEventListener("change", (e) => {
    priority = e.target.value;
    render();
  });
  function setView(v) {
    view = v;
    document.getElementById("v-cards").setAttribute("aria-pressed", v === "cards");
    document.getElementById("v-groups").setAttribute("aria-pressed", v === "groups");
    document.getElementById("v-table").setAttribute("aria-pressed", v === "table");
    document.getElementById("grid").classList.toggle("hidden", v !== "cards");
    document.getElementById("group-list").classList.toggle("hidden", v !== "groups");
    document.getElementById("tablewrap").classList.toggle("hidden", v !== "table");
    render();
  }
  document.getElementById("v-cards").onclick = () => setView("cards");
  document.getElementById("v-groups").onclick = () => setView("groups");
  document.getElementById("v-table").onclick = () => setView("table");
  function setPeriod(value) {
    period = value;
    document.getElementById("p-upcoming").setAttribute("aria-pressed", value === "upcoming");
    document.getElementById("p-past").setAttribute("aria-pressed", value === "past");
    render();
  }
  document.getElementById("p-upcoming").onclick = () => setPeriod("upcoming");
  document.getElementById("p-past").onclick = () => setPeriod("past");

  function matching(now, overrides = {}) {
    const selectedEntryType = overrides.entryType ?? entryType;
    const selectedArchivalStatus = overrides.archivalStatus ?? archivalStatus;
    const selectedPriority = overrides.priority ?? priority;
    return DATA.filter(
      (x) =>
        (period === "upcoming" ? x._sub > now : x._sub <= now) &&
        (selectedEntryType === "all" || x.entry_type === selectedEntryType) &&
        (selectedArchivalStatus === "all" || x.archival_status === selectedArchivalStatus) &&
        (selectedPriority === "all" || x.venue_priority === selectedPriority) &&
        (!query ||
          (
            x.name +
            " " +
            x.venue_group +
            " " +
            x.entry_type +
            " " +
            x.deadline_label +
            " " +
            x.archival_status +
            " " +
            x.venue_priority
          )
            .toLowerCase()
            .includes(query)),
    ).toSorted((a, b) => (period === "upcoming" ? a._sub - b._sub : b._sub - a._sub));
  }
  function updateFacetCounts(now) {
    [
      ["entry-type", "entryType"],
      ["archival-status", "archivalStatus"],
      ["priority", "priority"],
    ].forEach(([id, key]) => {
      const select = document.getElementById(id);
      [...select.options].forEach((option) => {
        option.dataset.label ||= option.textContent;
        option.textContent = \`\${option.dataset.label} (\${matching(now, { [key]: option.value }).length})\`;
      });
    });
  }
  const grid = document.getElementById("grid"),
    groupList = document.getElementById("group-list"),
    tbody = document.getElementById("tbody"),
    empty = document.getElementById("empty"),
    hero = document.getElementById("hero");

  function render() {
    const now = Date.now();
    renderedAoeDay = aoeDayKey(now);
    updateFacetCounts(now);
    const matches = matching(now);
    rebuildChips(matches);
    const list = matches.filter((x) => activeGroup === "All" || x.venue_group === activeGroup);
    empty.classList.toggle("hidden", list.length > 0);
    document.getElementById("s-total").textContent = list.length;
    document.getElementById("s-today").textContent = list.filter(
      (x) => x.deadline_aoe.slice(0, 10) === aoeDayKey(now),
    ).length;
    const distance = (x) => (period === "upcoming" ? x._sub - now : now - x._sub);
    document.getElementById("s-7").textContent = list.filter(
      (x) => distance(x) >= 0 && distance(x) <= 7 * 86400000,
    ).length;
    document.getElementById("s-30").textContent = list.filter(
      (x) => distance(x) >= 0 && distance(x) <= 30 * 86400000,
    ).length;
    const direction = period === "upcoming" ? "Due" : "Passed";
    document.getElementById("s-today-label").textContent = \`\${direction} today\`;
    document.getElementById("s-7-label").textContent = \`\${direction} within 7 days\`;
    document.getElementById("s-30-label").textContent = \`\${direction} within 30 days\`;

    const next = list[0];
    if (next) {
      const u = urgencyLabel(next._sub, now);
      hero.dataset.entryType = next.entry_type;
      hero.dataset.archivalStatus = next.archival_status;
      hero.dataset.venuePriority = next.venue_priority;
      hero.style.setProperty("--h-color", u.cvar);
      const p = parts(next._sub - now);
      const call = titleUrl(next);
      const title = call
        ? \`<a href="\${esc(call)}" target="_blank" rel="noopener noreferrer">\${esc(next.name)}</a>\`
        : esc(next.name);
      hero.innerHTML = \`<div class="lbl">\${period === "upcoming" ? "Next" : "Most recent"} deadline · \${esc(next.venue_group)}</div>
      <div class="hname">\${title}</div>
      <div class="hmeta">\${cap(next.deadline_label)} · \${fmtAoeDateTime(next.deadline_aoe)} · <span style="color:\${u.cvar}">\${u.txt}</span> \${classificationLabels(next)}</div>
      \${
        period === "upcoming"
          ? \`<div class="cd" data-t="\${next._sub}">
        \${unit(p.d, "days")}<span class="sep">:</span>\${unit(pad(p.h), "hrs")}<span class="sep">:</span>\${unit(pad(p.m), "min")}<span class="sep">:</span>\${unit(pad(p.s), "sec")}
      </div>\`
          : ""
      }<div class="hlinks">\${staleNote(next)}\${historyNote(next)}\${sourceLinks(next)}</div>\`;
    } else {
      delete hero.dataset.entryType;
      delete hero.dataset.archivalStatus;
      delete hero.dataset.venuePriority;
      hero.innerHTML = \`<div class="lbl">\${period === "upcoming" ? "Next" : "Most recent"} deadline</div><div class="hname">Nothing matches this filter</div>\`;
    }

    if (view === "cards") renderCards(list, now);
    else if (view === "groups") renderGroups(list, now);
    else renderTable(list, now);
    const checked = DATA.map((x) => x.source_checked_at || "").filter(Boolean).sort().at(-1);
    document.getElementById("foot").textContent =
      \`Showing \${list.length} of \${matches.length} matching \${period} deadlines · official venue sites + OpenReview\${checked ? \` · source checks through \${checked.slice(0, 10)}\` : ""}\`;
  }
  function unit(v, c) {
    return \`<div class="unit"><span class="num">\${v}</span><span class="cap">\${c}</span></div>\`;
  }
  function cap(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function esc(s) {
    return String(s).replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
    );
  }

  const ENTRY_TYPE_LABELS = {
    main_conference: "Main conference",
    demo_track: "Demo track",
    workshop: "Workshop",
    arr_direct_submission: "ARR direct submission",
    arr_commitment: "ARR commitment",
    rebuttal: "Rebuttal",
    other: "Other",
  };
  function entryTypeLabel(x) {
    return ENTRY_TYPE_LABELS[x.entry_type] || ENTRY_TYPE_LABELS.other;
  }
  function priorityLabel(x) {
    if (x.venue_priority === "primary") {
      return '<span class="priority" data-priority="primary">Primary</span>';
    }
    return x.venue_priority === "secondary"
      ? '<span class="priority" data-priority="secondary">Secondary</span>'
      : "";
  }
  function archivalLabel(x) {
    if (x.archival_status === "unknown") {
      return '<span class="archival" data-archival="unknown">Archival status not established</span>';
    }
    if (x.archival_status === "mixed") {
      return '<span class="archival" data-archival="mixed">Archival + non-archival</span>';
    }
    const label = x.archival_status === "non_archival" ? "Non-archival" : "Archival";
    return \`<span class="archival" data-archival="\${esc(x.archival_status)}">\${label}</span>\`;
  }
  function classificationLabels(x) {
    const labels = priorityLabel(x) + archivalLabel(x);
    return labels ? \`<span class="classification">\${labels}</span>\` : "";
  }
  function titleUrl(x) {
    return x.entry_type === "workshop" ? x.homepage_url || "" : x.link || "";
  }
  function sourceLinks(x) {
    if (x.entry_type !== "workshop") {
      return x.link
        ? \`<a class="clink clink--button" href="\${esc(x.link)}" target="_blank" rel="noopener noreferrer">Official site ↗</a>\`
        : "";
    }
    const source = x.cfp_url
      ? \`<a class="clink clink--button" href="\${esc(x.cfp_url)}" target="_blank" rel="noopener noreferrer">Call for papers ↗</a>\`
      : x.homepage_url
        ? \`<a class="clink clink--button" href="\${esc(x.homepage_url)}" target="_blank" rel="noopener noreferrer">Official site ↗</a>\`
        : \`<span class="cnote">Call for papers not found yet</span>\`;
    const review = x.openreview_url
      ? \`<a class="clink clink--button" href="\${esc(x.openreview_url)}" target="_blank" rel="noopener noreferrer">OpenReview ↗</a>\`
      : "";
    return source + review;
  }
  function historyNote(x) {
    const earlier = (x.revisions || []).slice(0, -1);
    return earlier.length
      ? \`<details class="cnote"><summary>Deadline history (\${earlier.length})</summary><ul>\${earlier
          .map(
            (revision) =>
              \`<li>\${fmtAoeDateTime(revision.deadline_aoe)} · \${esc(cap(revision.deadline_label || "deadline"))} · recorded \${esc((revision.observed_at || "").slice(0, 10))}\${revision.link ? \` · <a href="\${esc(revision.link)}" target="_blank" rel="noopener noreferrer">source ↗</a>\` : ""}</li>\`,
          )
          .join("")}</ul></details>\`
      : "";
  }
  function staleNote(x) {
    return x.stale ? \`<span class="cnote">Source not observed in the latest sweep.</span>\` : "";
  }

  function renderCards(list, now) {
    grid.innerHTML = list
      .map((x) => {
        const u =
          period === "past" ? { txt: "passed", cvar: "var(--muted)" } : urgencyLabel(x._sub, now);
        const p = parts(x._sub - now);
        const type = entryTypeLabel(x);
        const call = titleUrl(x);
        const title = call
          ? \`<a href="\${esc(call)}" target="_blank" rel="noopener noreferrer">\${esc(x.name)}</a>\`
          : esc(x.name);
        const notif = x._notif
          ? \`<div class="cnote">Accept/reject: \${fmtAoe(x.notification_aoe)} AoE</div>\`
          : "";
        return \`<div class="card" data-entry-type="\${esc(x.entry_type)}" data-archival-status="\${esc(x.archival_status)}" data-venue-priority="\${esc(x.venue_priority)}" style="--u:\${u.cvar}">
      <div class="row1"><span class="badge">\${type}</span><span class="pill">\${u.txt}</span></div>
      <div class="cname">\${title}</div>
      <div class="cgroup" title="\${esc(x.venue_group)} · \${esc(cap(x.deadline_label))}"><span class="cgroup-name">\${esc(x.venue_group)}</span><span aria-hidden="true">·</span><span class="cgroup-stage">\${esc(cap(x.deadline_label))}</span></div>
      \${classificationLabels(x)}
      <div class="cdl">\${fmtAoeDateTime(x.deadline_aoe)}</div>
      <div class="ccd"\${period === "upcoming" ? \` data-t="\${x._sub}"\` : ""}>\${period === "past" ? "passed" : \`\${p.d}d \${pad(p.h)}:\${pad(p.m)}:\${pad(p.s)}\`}</div>
      \${notif}\${staleNote(x)}\${historyNote(x)}\${sourceLinks(x)}
    </div>\`;
      })
      .join("");
  }
  function renderTable(list, now) {
    tbody.innerHTML = list
      .map((x) => {
        const u =
          period === "past" ? { txt: "passed", cvar: "var(--muted)" } : urgencyLabel(x._sub, now);
        const p = parts(x._sub - now);
        const type = entryTypeLabel(x);
        const call = titleUrl(x);
        const title = call
          ? \`<a href="\${esc(call)}" target="_blank" rel="noopener noreferrer">\${esc(x.name)}</a>\`
          : esc(x.name);
        const actions = sourceLinks(x);
        return \`<tr data-entry-type="\${esc(x.entry_type)}" data-archival-status="\${esc(x.archival_status)}" data-venue-priority="\${esc(x.venue_priority)}" style="--u:\${u.cvar}"><td class="tcd">\${fmtAoeDateTime(x.deadline_aoe)}</td>
      <td class="tcd countdown"\${period === "upcoming" ? \` data-t="\${x._sub}"\` : ""}>\${period === "past" ? "passed" : \`\${p.d}d \${pad(p.h)}:\${pad(p.m)}:\${pad(p.s)}\`}</td>
      <td class="name"><span class="dot" style="--u:\${u.cvar}"></span>\${title}</td>
      <td class="meta"><span class="labels"><span class="badge">\${type}</span>\${classificationLabels(x)}</span></td><td class="meta">\${esc(x.venue_group)}</td><td>\${x.stale ? \`<span class="cnote" title="Source not observed in the latest sweep.">stale</span>\` : ""}\${historyNote(x)}\${actions}</td></tr>\`;
      })
      .join("");
  }
  function groupEntries(list) {
    const groups = new Map();
    list.forEach((entry) => {
      const id = entry.venue_group.trim();
      const kind =
        entry.entry_type === "rebuttal"
          ? "other"
          : entry.archival_status === "archival"
            ? "archival"
            : entry.archival_status === "non_archival"
              ? "nonArchival"
              : entry.archival_status === "mixed"
                ? "mixed"
                : "unknown";
      const current = groups.get(id);
      if (current) {
        current.entries.push(entry);
        current.sections[kind].push(entry);
      } else {
        const sections = { archival: [], nonArchival: [], mixed: [], unknown: [], other: [] };
        sections[kind].push(entry);
        groups.set(id, {
          id,
          label: id,
          entries: [entry],
          sections,
        });
      }
    });
    return [...groups.values()];
  }
  function groupRowTitle(entry, conference) {
    const stage = cap(entry.deadline_label);
    const titleContext = entry.venue_group.trim().replace(/\\s+workshops$/iu, "") || conference;
    let name = entry.name.trim();
    [\` (\${titleContext})\`, \` [\${titleContext}]\`].forEach((affix) => {
      if (name.endsWith(affix)) name = name.slice(0, -affix.length).trim();
    });
    [" — ", " – ", " - ", ": "].forEach((separator) => {
      if (name.startsWith(\`\${titleContext}\${separator}\`))
        name = name.slice(titleContext.length + separator.length).trim();
    });
    if (name.toLocaleLowerCase() === titleContext.toLocaleLowerCase())
      return { name: stage, stage: "" };
    if (stage.toLocaleLowerCase() === "arr commitment")
      name = name.replace(/\\s*(?:\\(ARR commitment\\)|[-—–:]?\\s*ARR commitment)$/iu, "").trim();
    return { name: name || entry.name, stage };
  }
  function renderGroupSection(label, entries, group, now) {
    if (!entries.length) return "";
    const rows = entries
      .map((x) => {
        const rowUrgency =
          period === "past" ? { txt: "passed", cvar: "var(--muted)" } : urgencyLabel(x._sub, now);
        const p = parts(x._sub - now);
        const title = groupRowTitle(x, group.label);
        const call = titleUrl(x);
        const linkedTitle = call
          ? \`<a href="\${esc(call)}" target="_blank" rel="noopener noreferrer">\${esc(title.name)}</a>\`
          : esc(title.name);
        const actions = sourceLinks(x);
        const earlier = (x.revisions || []).slice(0, -1);
        const detail = [
          x._notif ? \`Accept/reject \${fmtAoe(x.notification_aoe)} AoE\` : "",
          earlier.length
            ? \`Previously \${earlier.map((revision) => \`\${fmtAoeDateTimeText(revision.deadline_aoe)} (\${cap(revision.deadline_label || "deadline")})\`).join(", ")}\`
            : "",
          x.stale ? "Source not observed in the latest sweep" : "",
        ]
          .filter(Boolean)
          .join(" · ");
        const note = [title.stage, detail].filter(Boolean).join(" · ");
        return \`<div class="deadline-group__row" data-entry-type="\${esc(x.entry_type)}" data-archival-status="\${esc(x.archival_status)}" data-venue-priority="\${esc(x.venue_priority)}" style="--u:\${rowUrgency.cvar}">
          <span class="deadline-group__row-countdown"\${period === "upcoming" ? \` data-t="\${x._sub}"\` : ""}>\${period === "past" ? "passed" : \`\${p.d}d \${pad(p.h)}:\${pad(p.m)}:\${pad(p.s)}\`}</span>
          <time class="deadline-group__row-date">\${fmtAoeDateTime(x.deadline_aoe)}</time>
          <div class="deadline-group__row-main"><h3 class="deadline-group__row-name">\${linkedTitle}</h3><p class="deadline-group__row-note">\${note ? \`<span class="deadline-group__row-detail">\${esc(note)}</span>\` : ""}<span class="labels"><span class="badge">\${entryTypeLabel(x)}</span>\${classificationLabels(x)}</span></p></div>\${actions ? \`<span class="deadline-group__row-actions">\${actions}</span>\` : ""}
        </div>\`;
      })
      .join("");
    return \`<section class="deadline-group__section"><p class="deadline-group__section-head"><strong>\${label}</strong><span>\${entries.length}</span></p>\${rows}</section>\`;
  }
  function renderGroups(list, now) {
    groupList.innerHTML = groupEntries(list)
      .map((group, index) => {
        const first = group.entries[0];
        const firstUrgency =
          period === "past"
            ? { txt: "passed", cvar: "var(--muted)" }
            : urgencyLabel(first._sub, now);
        const firstParts = parts(first._sub - now);
        const open = expandedGroups.has(group.id);
        const panelId = \`deadline-group-panel-\${index}\`;
        const counts = [
          group.sections.archival.length ? \`\${group.sections.archival.length} archival\` : "",
          group.sections.nonArchival.length
            ? \`\${group.sections.nonArchival.length} non-archival\`
            : "",
          group.sections.mixed.length
            ? \`\${group.sections.mixed.length} archival + non-archival\`
            : "",
          group.sections.unknown.length ? \`\${group.sections.unknown.length} unknown\` : "",
          group.sections.other.length ? \`\${group.sections.other.length} other\` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        const panel = [
          renderGroupSection("Archival", group.sections.archival, group, now),
          renderGroupSection("Non-archival", group.sections.nonArchival, group, now),
          renderGroupSection("Archival + non-archival", group.sections.mixed, group, now),
          renderGroupSection("Archival status unknown", group.sections.unknown, group, now),
          renderGroupSection("Other dates", group.sections.other, group, now),
        ].join("");
        return \`<section class="deadline-group" data-count="\${group.entries.length}" style="--u:\${firstUrgency.cvar}"\${open ? " data-open" : ""}>
          <button class="deadline-group__summary" data-group="\${esc(group.id)}" aria-expanded="\${open}" aria-controls="\${panelId}">
            <span class="deadline-group__chevron" aria-hidden="true">›</span><span class="deadline-group__summary-countdown"\${period === "upcoming" ? \` data-t="\${first._sub}"\` : ""}>\${period === "past" ? "passed" : \`\${firstParts.d}d \${pad(firstParts.h)}:\${pad(firstParts.m)}:\${pad(firstParts.s)}\`}</span>
            <span class="deadline-group__heading"><strong>\${esc(group.label)}</strong><small>\${fmtAoeDateTime(first.deadline_aoe)}</small></span><span class="deadline-group__count">\${counts}</span>
          </button><div class="deadline-group__panel\${open ? "" : " hidden"}" id="\${panelId}">\${panel}</div>
        </section>\`;
      })
      .join("");
    groupList.querySelectorAll("[data-group]").forEach((button) => {
      button.onclick = () => {
        const group = button.dataset.group;
        if (expandedGroups.has(group)) expandedGroups.delete(group);
        else expandedGroups.add(group);
        renderGroups(list, Date.now());
      };
    });
  }
  // live tick: update only the countdown numbers, cheaply
  function tick() {
    const now = Date.now();
    if (
      aoeDayKey(now) !== renderedAoeDay ||
      [...document.querySelectorAll("[data-t]")].some((el) => Number(el.dataset.t) <= now)
    ) {
      render();
      return;
    }
    document.querySelectorAll("[data-t]").forEach((el) => {
      const p = parts(Number(el.dataset.t) - now);
      if (el.classList.contains("cd")) {
        const nums = el.querySelectorAll(".num");
        if (nums.length === 4) {
          nums[0].textContent = p.d;
          nums[1].textContent = pad(p.h);
          nums[2].textContent = pad(p.m);
          nums[3].textContent = pad(p.s);
        }
      } else {
        el.textContent = \`\${p.d}d \${pad(p.h)}:\${pad(p.m)}:\${pad(p.s)}\`;
      }
    });
  }
  setView(view);
  setInterval(tick, 1000);
</script>
`;

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

export function renderDeadlinesWebUi(
  items: readonly unknown[],
  options: { proposalUrl?: string } = {},
): string {
  const proposalUrl =
    options.proposalUrl ?? `${DEFAULT_ADMINBOT_CONTROL_UI_URL}/adminbot/deadlines`;
  return TEMPLATE.replace("__ITEMS_JSON__", JSON.stringify(items)).replace(
    "__DEADLINE_PROPOSAL_URL__",
    escapeAttribute(proposalUrl),
  );
}
