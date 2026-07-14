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
      table-layout: fixed;
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
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <div class="brand"><span class="mark">A</span><span>AdminBot</span></div>
      <nav aria-label="AdminBot console sections">
        <button class="tab" data-tab="members" aria-selected="true">Members</button>
        <button class="tab" data-tab="papers">Papers</button>
        <button class="tab" data-tab="actions">Actions</button>
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
          <button class="button" id="refresh-button" type="button">Refresh</button>
        </div>
      </header>

      <section class="section active" id="members">
        <div class="grid">
          <div class="panel">
            <h2>Member Record</h2>
            <form id="member-form">
              <label>Member id<input name="id" required placeholder="zhijing"></label>
              <label>Name<input name="name" required placeholder="Zhijing"></label>
              <label>Email<input name="email" type="email" placeholder="name@example.edu"></label>
              <label>Slack user id<input name="slack_user_id" placeholder="U0123456789"></label>
              <label>Privilege
                <select name="privilege_level" id="member-privilege"></select>
              </label>
              <label>Notes<textarea name="notes" placeholder="Access notes or temporary exceptions"></textarea></label>
              <button class="button primary" type="submit">Save member</button>
              <div class="status" id="member-status"></div>
            </form>
          </div>
          <div class="panel">
            <h2>Member List</h2>
            <div id="members-table"></div>
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
              <label>Default privilege
                <select name="default_privilege_level" id="settings-default-privilege"></select>
              </label>
              <label>Paper escalation business days
                <input name="paper_escalation_business_days" type="number" min="1" step="1" required>
              </label>
              <label>Head professor member id
                <input name="head_professor_member_id" placeholder="zhijing">
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

      <section class="section" id="audit">
        <div class="panel">
          <h2>Audit Events</h2>
          <pre id="audit-json"></pre>
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
      actions: ["Actions", "Review approval-gated AdminBot proposals."],
      settings: ["Settings", "Set roster and paper reminder defaults."],
      audit: ["Audit", "Inspect local AdminBot service events."]
    };
    const state = { settings: null, members: [], papers: [], nudges: [], proposals: [], audit: [] };

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
      render();
    }

    function render() {
      document.getElementById("member-privilege").innerHTML = optionList(
        privilegeLevels,
        "",
        "temporary default: " + (state.settings?.default_privilege_level || "member")
      );
      document.getElementById("settings-default-privilege").innerHTML = optionList(
        privilegeLevels,
        state.settings?.default_privilege_level || "member"
      );
      document.getElementById("paper-step").innerHTML = optionList(paperSteps, "brainstorming_docs");
      document.querySelector('[name="paper_escalation_business_days"]').value =
        state.settings?.paper_escalation_business_days || 3;
      document.querySelector('[name="head_professor_member_id"]').value =
        state.settings?.head_professor_member_id || "";
      renderMembers();
      renderPapers();
      renderActions();
      document.getElementById("settings-json").textContent = JSON.stringify(state.settings, null, 2);
      document.getElementById("audit-json").textContent = JSON.stringify(state.audit, null, 2);
    }

    function renderMembers() {
      function noteValue(member, key) {
        const prefix = key.toLowerCase() + ":";
        const line = String(member.notes || "").split("\\n").find((entry) => entry.toLowerCase().startsWith(prefix));
        return line ? line.slice(key.length + 1).trim() : "";
      }
      function compactList(entries) {
        return entries.filter(Boolean).join(" / ") || "";
      }
      const rows = state.members.map((member) => '<tr>' +
        '<td><strong>' + escapeHtml(member.name) + '</strong><br><code>' + escapeHtml(member.id) + '</code></td>' +
        '<td>' + escapeHtml(member.email || "") + '<br>' + escapeHtml(compactList([noteValue(member, "Gmail for calendar"), noteValue(member, "WhatsApp"), member.slack_user_id || ""])) + '</td>' +
        '<td>' + escapeHtml(compactList([noteValue(member, "Location"), noteValue(member, "Research interests")])) + '<br>' + escapeHtml(compactList([noteValue(member, "Joined month"), noteValue(member, "GitHub"), noteValue(member, "Personal website")])) + '</td>' +
        '<td><span class="pill">' + escapeHtml(member.privilege_level) + '</span></td>' +
        '<td>' + escapeHtml((member.access || []).map((grant) => grant.service + ":" + grant.access).join(", ")) + '</td>' +
      '</tr>').join("");
      document.getElementById("members-table").innerHTML = '<table><thead><tr><th>Name</th><th>Contact</th><th>Profile</th><th>Privilege</th><th>Access</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="5">No members yet.</td></tr>') + '</tbody></table>';
    }

    function renderPapers() {
      const active = state.papers.filter((paper) => paper.reminder?.status !== "complete");
      const rows = active.map((paper) => '<tr>' +
        '<td><strong>' + escapeHtml(paper.title) + '</strong><br><code>' + escapeHtml(paper.id) + '</code></td>' +
        '<td><span class="pill">' + escapeHtml(paper.current_step) + '</span></td>' +
        '<td>' + escapeHtml((paper.authors || []).join(", ")) + '</td>' +
        '<td>' + escapeHtml(paper.reminder?.status || "idle") + '</td>' +
      '</tr>').join("");
      document.getElementById("papers-table").innerHTML = '<table><thead><tr><th>Paper</th><th>Step</th><th>Authors</th><th>Reminder</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="4">No active papers yet.</td></tr>') + '</tbody></table>';
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
          '<div class="toolbar">' +
            '<button class="button" type="button" data-approve="' + escapeHtml(proposal.id) + '" data-hash="' + escapeHtml(proposal.payload_hash) + '">Approve as PI</button>' +
            '<button class="button primary" type="button" data-execute="' + escapeHtml(proposal.id) + '">Execute dry-run</button>' +
          '</div>' +
        '</div>').join("")
        : '<p class="subtle">No pending actions.</p>';
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

    document.getElementById("member-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = formData(event.currentTarget);
      const body = {
        name: data.name,
        ...(data.email ? { email: data.email } : {}),
        ...(data.slack_user_id ? { slack_user_id: data.slack_user_id } : {}),
        ...(data.privilege_level ? { privilege_level: data.privilege_level } : {}),
        ...(data.notes ? { notes: data.notes } : {})
      };
      try {
        await api("/lab/members/" + encodeURIComponent(data.id), { method: "PUT", body: JSON.stringify(body) });
        setStatus("member-status", "Saved member.", "ok");
        await refresh();
      } catch (error) {
        setStatus("member-status", error.message, "error");
      }
    });

    document.getElementById("paper-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = formData(event.currentTarget);
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
        setStatus("paper-status", "Saved paper.", "ok");
        await refresh();
      } catch (error) {
        setStatus("paper-status", error.message, "error");
      }
    });

    document.getElementById("settings-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = formData(event.currentTarget);
      const body = {
        default_privilege_level: data.default_privilege_level,
        paper_escalation_business_days: Number(data.paper_escalation_business_days),
        head_professor_member_id: data.head_professor_member_id
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
            body: JSON.stringify({ payload_hash: target.dataset.hash, approver_role: "pi" })
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

    refresh().catch((error) => {
      document.getElementById("page-subtitle").textContent = error.message;
    });
  </script>
</body>
</html>`;
}
