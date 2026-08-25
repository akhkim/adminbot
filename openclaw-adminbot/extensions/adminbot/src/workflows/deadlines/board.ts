// Generated from extensions/adminbot/content/deadlines/deadlines-board.html by
// scripts/adminbot-deadline-web-ui-gen.py. Do not hand-edit; regenerate instead.
// Renders the self-contained live deadline countdown board (Output 0).

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
    justify-content: flex-end;
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
  .search::placeholder {
    color: var(--muted);
  }
  .chips {
    display: flex;
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
    grid-template-columns: repeat(auto-fill, minmax(min(304px, 100%), 1fr));
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
  .badge {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 3px 7px;
    white-space: nowrap;
  }
  .labels {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .pill {
    font-size: 11.5px;
    font-weight: 600;
    padding: 3px 9px;
    border-radius: 999px;
    white-space: nowrap;
    background: color-mix(in srgb, var(--u) 18%, transparent);
    color: var(--u);
  }
  .cname {
    font-size: 16px;
    font-weight: 600;
    line-height: 1.3;
    letter-spacing: -0.01em;
    margin: 1px 0;
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
  .cdl .aoe {
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
    margin-top: auto;
    font-size: 13.5px;
    font-family: var(--mono);
    white-space: nowrap;
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
    padding: 11px 14px;
    border-bottom: 1px solid var(--border-soft);
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
    white-space: normal;
    min-width: 260px;
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
  @media (max-width: 600px) {
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
  }
  @media (prefers-reduced-motion: reduce) {
    * {
      transition: none !important;
    }
  }
</style>

<div class="wrap">
  <div class="container">
    <h1>Deadlines</h1>
    <p class="sub">Upcoming conference &amp; workshop deadlines.</p>

    <div class="modes">
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
      <div class="chips" id="chips" role="group" aria-label="Filter by venue"></div>
    </div>

    <details class="archival-guide">
      <summary>What archival status means</summary>
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
          <span class="k">Due today</span
          ><span class="v" id="s-today" style="color: var(--crit)">–</span>
        </div>
        <div class="stat">
          <span class="k">Due within 7 days</span
          ><span class="v" id="s-7" style="color: var(--serious)">–</span>
        </div>
        <div class="stat">
          <span class="k">Due within 30 days</span
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
  function fmtAoeDateTime(x) {
    const time = (x || "").match(/[ T](\\d{2}):(\\d{2})/);
    const date = fmtAoe(x);
    return date && time ? \`\${date} · \${time[1]}:\${time[2]} AoE\` : date;
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
        entries.map((x) => [x.venue_group, { id: x.venue_group, label: x.group_label }]),
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

  function matching(now) {
    return DATA.filter(
      (x) =>
        x._sub > now &&
        (!query ||
          (x.name + " " + x.group_label + " " + x.entry_type).toLowerCase().includes(query)),
    );
  }
  const grid = document.getElementById("grid"),
    groupList = document.getElementById("group-list"),
    tbody = document.getElementById("tbody"),
    empty = document.getElementById("empty"),
    hero = document.getElementById("hero");

  function render() {
    const now = Date.now();
    renderedAoeDay = aoeDayKey(now);
    const matches = matching(now);
    rebuildChips(matches);
    const list = matches.filter((x) => activeGroup === "All" || x.venue_group === activeGroup);
    empty.classList.toggle("hidden", list.length > 0);
    document.getElementById("s-total").textContent = list.length;
    document.getElementById("s-today").textContent = list.filter(
      (x) => x.deadline_aoe.slice(0, 10) === aoeDayKey(now),
    ).length;
    document.getElementById("s-7").textContent = list.filter(
      (x) => x._sub - now <= 7 * 86400000,
    ).length;
    document.getElementById("s-30").textContent = list.filter(
      (x) => x._sub - now <= 30 * 86400000,
    ).length;

    // hero = soonest upcoming (respect current filter)
    const next = list[0];
    if (next) {
      const u = urgencyLabel(next._sub, now);
      hero.style.setProperty("--h-color", u.cvar);
      const p = parts(next._sub - now);
      hero.innerHTML = \`<div class="lbl">Next deadline · \${esc(next.group_label)}</div>
      <div class="hname">\${esc(next.name)}</div>
      <div class="hmeta">\${cap(next.deadline_label)} · \${fmtAoeDateTime(next.deadline_aoe)} · <span style="color:\${u.cvar}">\${u.txt}</span></div>
      <div class="cd" data-t="\${next._sub}">
        \${unit(p.d, "days")}<span class="sep">:</span>\${unit(pad(p.h), "hrs")}<span class="sep">:</span>\${unit(pad(p.m), "min")}<span class="sep">:</span>\${unit(pad(p.s), "sec")}
      </div>\`;
    } else
      hero.innerHTML =
        '<div class="lbl">Next deadline</div><div class="hname">Nothing upcoming</div>';

    if (view === "cards") renderCards(list, now);
    else if (view === "groups") renderGroups(list, now);
    else renderTable(list, now);
    document.getElementById("foot").textContent =
      \`Showing \${list.length} of \${matches.length} upcoming deadlines · source: aideadlines.org + OpenReview (NeurIPS.cc/2026/Workshop) · generated 2026-07-25\`;
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

  function renderCards(list, now) {
    grid.innerHTML = list
      .map((x) => {
        const u = urgencyLabel(x._sub, now);
        const p = parts(x._sub - now);
        const type = entryTypeLabel(x);
        const link = x.link
          ? \`<a class="clink" href="\${esc(x.link)}" target="_blank" rel="noopener">Open call ↗</a>\`
          : "";
        const notif = x._notif
          ? \`<div class="cnote">Accept/reject: \${fmtAoe(x.notification_aoe)} AoE</div>\`
          : "";
        return \`<div class="card" style="--u:\${u.cvar}">
      <div class="row1"><span class="badge">\${type}</span><span class="pill">\${u.txt}</span></div>
      <div class="cname">\${esc(x.name)}</div>
      <div class="cgroup" title="\${esc(x.group_label)} · \${esc(cap(x.deadline_label))}"><span class="cgroup-name">\${esc(x.group_label)}</span><span aria-hidden="true">·</span><span class="cgroup-stage">\${esc(cap(x.deadline_label))}</span></div>
      <div class="cdl">\${fmtAoeDateTime(x.deadline_aoe)}</div>
      <div class="ccd" data-t="\${x._sub}">\${p.d}d \${pad(p.h)}:\${pad(p.m)}:\${pad(p.s)}</div>
      \${notif}\${link}
    </div>\`;
      })
      .join("");
  }
  function renderTable(list, now) {
    tbody.innerHTML = list
      .map((x) => {
        const u = urgencyLabel(x._sub, now);
        const p = parts(x._sub - now);
        const type = entryTypeLabel(x);
        const link = x.link ? \`<a href="\${esc(x.link)}" target="_blank" rel="noopener">↗</a>\` : "";
        return \`<tr style="--u:\${u.cvar}"><td class="tcd">\${fmtAoeDateTime(x.deadline_aoe)}</td>
      <td class="tcd countdown" data-t="\${x._sub}">\${p.d}d \${pad(p.h)}:\${pad(p.m)}:\${pad(p.s)}</td>
      <td class="name"><span class="dot" style="--u:\${u.cvar}"></span>\${esc(x.name)}</td>
      <td class="meta"><span class="badge">\${type}</span></td><td class="meta">\${esc(x.group_label)}</td><td>\${link}</td></tr>\`;
      })
      .join("");
  }
  function groupEntries(list) {
    const groups = new Map();
    list.forEach((entry) => {
      const id = entry.group_label.trim() || entry.venue_group.trim();
      const kind =
        entry.entry_type === "rebuttal"
          ? "other"
          : entry.archival_status === "archival"
            ? "archival"
            : entry.archival_status === "non_archival"
              ? "nonArchival"
              : "unknown";
      const current = groups.get(id);
      if (current) {
        current.entries.push(entry);
        current.sections[kind].push(entry);
      } else {
        const sections = { archival: [], nonArchival: [], unknown: [], other: [] };
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
        const rowUrgency = urgencyLabel(x._sub, now);
        const p = parts(x._sub - now);
        const link = x.link
          ? \`<a class="clink" href="\${esc(x.link)}" target="_blank" rel="noopener noreferrer" aria-label="Open call for \${esc(x.name)}">↗</a>\`
          : "";
        const title = groupRowTitle(x, group.label);
        const detail = [x._notif ? \`Accept/reject \${fmtAoe(x.notification_aoe)} AoE\` : ""]
          .filter(Boolean)
          .join(" · ");
        const note = [title.stage, detail].filter(Boolean).join(" · ");
        return \`<div class="deadline-group__row" style="--u:\${rowUrgency.cvar}">
          <span class="deadline-group__row-countdown" data-t="\${x._sub}">\${p.d}d \${pad(p.h)}:\${pad(p.m)}:\${pad(p.s)}</span>
          <time class="deadline-group__row-date">\${fmtAoeDateTime(x.deadline_aoe)}</time>
          <div class="deadline-group__row-main"><h3 class="deadline-group__row-name">\${esc(title.name)}</h3><p class="deadline-group__row-note">\${note ? \`<span class="deadline-group__row-detail">\${esc(note)}</span>\` : ""}<span class="labels"><span class="badge">\${entryTypeLabel(x)}</span></span></p></div>\${link}
        </div>\`;
      })
      .join("");
    return \`<section class="deadline-group__section"><p class="deadline-group__section-head"><strong>\${label}</strong><span>\${entries.length}</span></p>\${rows}</section>\`;
  }
  function renderGroups(list, now) {
    groupList.innerHTML = groupEntries(list)
      .map((group, index) => {
        const first = group.entries[0];
        const firstUrgency = urgencyLabel(first._sub, now);
        const firstParts = parts(first._sub - now);
        const open = expandedGroups.has(group.id);
        const panelId = \`deadline-group-panel-\${index}\`;
        const counts = [
          group.sections.archival.length ? \`\${group.sections.archival.length} archival\` : "",
          group.sections.nonArchival.length
            ? \`\${group.sections.nonArchival.length} non-archival\`
            : "",
          group.sections.unknown.length ? \`\${group.sections.unknown.length} unknown\` : "",
          group.sections.other.length ? \`\${group.sections.other.length} other\` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        const panel = [
          renderGroupSection("Archival", group.sections.archival, group, now),
          renderGroupSection("Non-archival", group.sections.nonArchival, group, now),
          renderGroupSection("Archival status unknown", group.sections.unknown, group, now),
          renderGroupSection("Other dates", group.sections.other, group, now),
        ].join("");
        return \`<section class="deadline-group" data-count="\${group.entries.length}" style="--u:\${firstUrgency.cvar}"\${open ? " data-open" : ""}>
          <button class="deadline-group__summary" data-group="\${esc(group.id)}" aria-expanded="\${open}" aria-controls="\${panelId}">
            <span class="deadline-group__chevron" aria-hidden="true">›</span><span class="deadline-group__summary-countdown" data-t="\${first._sub}">\${firstParts.d}d \${pad(firstParts.h)}:\${pad(firstParts.m)}:\${pad(firstParts.s)}</span>
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

export function renderDeadlinesWebUi(items: readonly unknown[]): string {
  return TEMPLATE.replace("__ITEMS_JSON__", JSON.stringify(items));
}
