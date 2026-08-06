import { describe, expect, it } from "vitest";
import { ADMINBOT_SEPARATE_DELIVERY_DOC_URL } from "./collaborator-subgroups.js";
import { ADMINBOT_DRIVE_ACCOUNT } from "./contracts.js";
import { renderAdminBotWebUi } from "./web-ui.js";

describe("renderAdminBotWebUi", () => {
  const html = renderAdminBotWebUi();

  it("renders a login/claim/signup card gate that hides the console until authenticated", () => {
    expect(html).toContain('id="auth-gate"');
    expect(html).toContain('id="auth-form"');
    expect(html).toContain('id="auth-to-claim"');
    expect(html).toContain('id="auth-to-signup"');
    expect(html).toContain('id="auth-to-login"');
    expect(html).toContain('id="auth-confirm-label"');
    // The console shell starts hidden and is revealed only after a session probe/login succeeds.
    expect(html).toContain('class="shell" id="app-shell" hidden');
  });

  it("probes the same-origin session and posts to the real auth routes", () => {
    expect(html).toContain('fetch("/auth/session"');
    expect(html).toContain('"/auth/login"');
    expect(html).toContain('"/auth/roster"');
    expect(html).toContain('"/auth/claim"');
    expect(html).toContain('"/auth/signup"');
    expect(html).toContain('"/auth/logout"');
    expect(html).toContain('"/auth/password"');
    expect(html).toContain('credentials: "same-origin"');
    // Rate-limit hint uses the server's retry_after_seconds on 429.
    expect(html).toContain("retry_after_seconds");
    expect(html).toContain("response.status === 429");
  });

  it("keeps the session member only in a JS variable, never in web storage", () => {
    expect(html).toContain("let sessionMember = null");
    expect(html).not.toContain("localStorage");
    expect(html).not.toContain("sessionStorage");
  });

  it("renders a searchable roster picker for the claim flow that submits member_id", () => {
    // Claim mode shows a filterable list of unclaimed members plus a hidden member_id field.
    expect(html).toContain('id="claim-picker"');
    expect(html).toContain('id="claim-filter"');
    expect(html).toContain('id="claim-list"');
    expect(html).toContain('id="claim-member-id"');
    expect(html).toContain("async function loadRoster()");
    expect(html).toContain("function renderRoster()");
    // Picker selection is required and the claim POST carries the selected member_id.
    expect(html).toContain("Select your profile from the list.");
    expect(html).toContain("member_id: memberId");
  });

  it("renders the sign-up mode with a required name plus optional profile fields", () => {
    expect(html).toContain('id="signup-fields"');
    expect(html).toContain('name="name"');
    expect(html).toContain('name="affiliation"');
    expect(html).toContain('name="research_branch"');
    expect(html).toContain('name="research_topics"');
    // Signup builds a profile object and posts it; research topics become a string[] via commaList.
    expect(html).toContain("async function submitSignup(");
    expect(html).toContain("commaList(data.research_topics)");
    expect(html).toContain("research_topics: topics");
    expect(html).toContain("Name is required.");
  });

  it("validates claim/signup passwords client-side before submitting", () => {
    expect(html).toContain("Password must be at least 10 characters.");
    expect(html).toContain("Passwords do not match.");
  });

  it("shows a pending-approval notice after a claim or signup, with no session created", () => {
    expect(html).toContain("function showAuthNotice(");
    expect(html).toContain('id="auth-notice"');
    expect(html).toContain('id="auth-notice-back"');
    expect(html).toContain(
      "Request submitted — an admin must approve your account before you can sign in.",
    );
    // The pending notice is used by both the claim and signup success paths.
    expect(html).toContain("showAuthNotice(PENDING_NOTICE)");
  });

  it("routes the login pending_approval 403 to a friendly awaiting-approval message", () => {
    expect(html).toContain('payload?.code === "pending_approval"');
    expect(html).toContain("Your account is awaiting admin approval");
  });

  it("exposes a My profile tab with the self-editable fields and a change-password form", () => {
    expect(html).toContain('data-tab="profile"');
    expect(html).toContain('id="profile-form"');
    expect(html).toContain('id="password-form"');
    for (const field of [
      "research_branch",
      "research_topics",
      "projects",
      "hours_per_week",
      "location",
      "affiliation",
      "timezone",
      "personal_website",
      "slack_user_id",
      "notes",
    ]) {
      expect(html).toContain(`name="${field}"`);
    }
    // Privileged fields must not be part of the self-service profile form.
    expect(html).not.toContain('id="profile-form"><label>Privilege');
  });

  it("keeps the reviewer exemption in the admin editor only, never the self-profile form", () => {
    // Governance-owned: a member must not be able to exempt themselves from reviewing.
    expect(html).toContain('name="reviewer_exempt"');
    expect(html).toContain("exemptField.checked = member.reviewer_exempt === true");
    const selfProfileForm = html.slice(
      html.indexOf('id="profile-form"'),
      html.indexOf('id="password-form"'),
    );
    expect(selfProfileForm).not.toContain("reviewer_exempt");
  });

  it("puts the compact this-week availability strip in the roster", () => {
    // The strip is built from the same bars as the timeline, so the roster cell and the
    // member's own chart cannot tell different stories.
    expect(html).toContain("availabilityStrip(member)");
    expect(html).toContain(
      "memberBars(member, false).filter((bar) => activeInWeek(bar, weekStart))",
    );
    expect(html).toContain("<th>Availability</th>");
    // Availability is member-owned: the admin editor never writes it.
    expect(html).not.toContain('id="member-availability-preview"');
  });

  it("adds an admin-gated member map that labels selectively", () => {
    expect(html).toContain('data-tab="map"');
    expect(html).toContain('["approvals", "settings", "audit", "reviewing", "map"]');
    expect(html).toContain('api("/member-map")');
    expect(html).toContain('api("/member-map/refresh"');
    // Europe puts several cities within a few degrees, so labels are skipped on collision
    // rather than drawn over each other.
    expect(html).toContain("placedLabels");
  });

  it("emits an inline script that actually parses", () => {
    // The page is built as one TS template literal, so an over-escaped quote (\\" inside a
    // double-quoted JS string) silently collapses and ships a page that dies at parse time.
    // toContain assertions cannot see that; compiling the script can. Function() compiles
    // without running, so no DOM is needed.
    const script = html.slice(
      html.indexOf("<script>") + "<script>".length,
      html.lastIndexOf("</script>"),
    );
    expect(script.length).toBeGreaterThan(1000);
    expect(() => new Function(script)).not.toThrow();
  });

  it("renders the Time Availability timeline in My profile with a table relief view", () => {
    expect(html).toContain('id="availability-title"');
    expect(html).toContain('id="availability-timeline"');
    expect(html).toContain('id="availability-legend"');
    expect(html).toContain('id="availability-tbody"');
    expect(html).toContain('id="availability-empty"');
    // Single-member chart: the heading is the series label, so it carries the member's name.
    expect(html).toContain('"Time Availability_" + name');
    // Aqua sits under 3:1 on the white panel, so the table view and the in-bar labels are the
    // required relief; both must stay present.
    expect(html).toContain('id="availability-view-table"');
    expect(html).toContain("function renderAvailabilityTable()");
    expect(html).toContain("function setAvailabilityView(");
  });

  it("keeps the validated categorical slot order and never recycles a hue", () => {
    // Validated on the ALL-PAIRS gate, because a Gantt can put any project beside any other.
    // Four is the ceiling that clears it; adding yellow (#eda100) beside orange is a hard fail at
    // normal-vision 13.7. Re-run scripts/validate_palette.js before changing these.
    for (const hex of ["#2a78d6", "#eb6834", "#1baf7a", "#4a3aa7"]) {
      expect(html).toContain(hex);
    }
    expect(html).not.toContain("#eda100");
    expect(html).toContain("const SERIES_SLOTS = 4");
    // Past the four slots a project takes the neutral fill instead of a cycled hue.
    expect(html).toContain("index < SERIES_SLOTS ? index + 1 : 0");
    expect(html).toContain(".tl-bar.other");
  });

  it("treats the open-capacity sentinel and time off as non-series encodings", () => {
    expect(html).toContain('const OPEN_PROJECT = "__open__"');
    // Only real project bars take a slot, so the sentinel never earns a categorical colour.
    expect(html).toContain('bars.filter((bar) => bar.type === "project")');
    expect(html).toContain('if (project === OPEN_PROJECT) return "open"');
    expect(html).toContain(".tl-bar.open");
    // Time off is hatched and always labelled with its kind, so it never reads as a project.
    expect(html).toContain(".tl-bar.off");
    expect(html).toContain("repeating-linear-gradient");
  });

  it("offers the full time-off reason set including non-vacation career arrangements", () => {
    expect(html).toContain(
      'const timeOffKinds = ["vacation", "internship", "course_load", "travel", "conference", "other"]',
    );
    expect(html).toContain('data-field="kind"');
    // "partial" still counts toward capacity; "none" zeroes the week.
    expect(html).toContain(">Partly available</option>");
    expect(html).toContain(">Not available</option>");
  });

  it("edits the schedule locally and saves only the schedule fields", () => {
    expect(html).toContain('id="schedule-form"');
    expect(html).toContain('id="availability-add"');
    expect(html).toContain('id="time-off-add"');
    expect(html).toContain("function renderScheduleEditors()");
    // A keystroke redraws the chart only; rebuilding the inputs mid-edit would steal focus.
    expect(html).toContain("renderAvailability();");
    // The PUT carries just availability/time_off so it cannot clobber the profile form's fields.
    expect(html).toContain("availability: schedule.availability.map(");
    expect(html).toContain("time_off: schedule.time_off.map(");
    expect(html).toContain("Saved schedule.");
  });

  it("mirrors the server availability validation before saving", () => {
    expect(html).toContain("function scheduleValidationError()");
    expect(html).toContain("Every commitment needs a start and end date.");
    expect(html).toContain("A commitment cannot end before it starts.");
    expect(html).toContain("Hours per week must be between 0 and 168.");
    expect(html).toContain("Every time-off entry needs a start and end date.");
    // Dates are parsed as UTC calendar days, matching the server, so no timezone day-shift.
    expect(html).toContain('Date.parse(String(value || "").trim() + "T00:00:00Z")');
  });

  it("lets a member link their own availability planning doc", () => {
    expect(html).toContain('id="availability-doc-url"');
    expect(html).toContain('name="availability_doc_url"');
    expect(html).toContain("function renderDocHint()");
    // Saved with the schedule, in the same whitelisted PUT.
    expect(html).toContain("availability_doc_url:");
    // Client mirror of the server host allowlist; the server stays the trust boundary.
    expect(html).toContain("(docs|drive)");
    expect(html).toContain("The availability doc must be an https Google Docs or Drive link.");
    // An unshared doc fails the import silently, so the prerequisite is stated in the UI, and it
    // renders the same constant the importer authenticates as so the two cannot drift apart.
    expect(html).toContain(ADMINBOT_DRIVE_ACCOUNT);
    expect(html).toContain("Remember to share the doc with");
    expect(html).toContain("Viewer access is enough");
  });

  it("adds a lab-wide Capacity tab that reuses the timeline renderer", () => {
    expect(html).toContain('data-tab="capacity"');
    expect(html).toContain('<section class="section" id="capacity">');
    expect(html).toContain("function renderCapacity()");
    // Same renderer as the profile chart, just grouped by person instead of by project.
    expect(html).toContain('renderTimelineInto("capacity-timeline"');
    expect(html).toContain('renderTimelineInto("availability-timeline"');
    // Slots are assigned over every member's bars at once, so a project keeps one colour lab-wide.
    expect(html).toContain("const slots = assignProjectSlots(bars)");
    // In the lab view a row is a person, so project bars must name their project.
    expect(html).toContain('showProject: bar.type === "project"');
    expect(html).toContain("renderCapacity();");
  });

  it("summarises the lab by people, projects, and capabilities", () => {
    for (const id of ["cap-people", "cap-committed", "cap-open", "cap-away"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain("function renderCapacityProjects(");
    expect(html).toContain("function renderCapabilities()");
    expect(html).toContain('id="capacity-projects"');
    expect(html).toContain('id="capacity-skills"');
    // Baseline hours are committed too; only the open sentinel counts as spare.
    expect(html).toContain('sumHours("project") + sumHours("baseline")');
    // A range counts for "this week" when it overlaps the Mon–Sun window at all.
    expect(html).toContain("function activeInWeek(");
    // Capabilities come from the roster, so they work before anyone fills in availability.
    expect(html).toContain("[profile.branch].concat(profile.topics)");
  });

  it("hides time-off reasons from unprivileged sessions in the lab view", () => {
    // Why someone is away (internship, heavy semester) is personal; the lab view shows only the
    // away/partly-away state unless the session is admin.
    expect(html).toContain("const showReasons = isPrivileged()");
    expect(html).toContain("memberBars(member, showReasons)");
    expect(html).toContain('showReasons ? humanize(row.kind || "other") : "Away"');
    expect(html).toContain("Time-off reasons are hidden");
    // A member's own profile always sees their own reasons.
    expect(html).toContain("return memberBars(schedule, true)");
  });

  it("opens to a visitor on the public surfaces instead of a sign-in wall", () => {
    // Mirrors the Control UI access table: a visitor gets the deadline board and the
    // reimbursement assistant, and asks for the sign-in form from the toolbar.
    expect(html).toContain('const PUBLIC_TABS = ["deadlines", "reimbursements"]');
    expect(html).toContain("function showPublicConsole(");
    expect(html).toContain("showPublicConsole();");
    expect(html).toContain('id="signin-button"');
    expect(html).toContain('data-tab="deadlines"');
    expect(html).toContain('data-tab="reimbursements"');
  });

  it("hides every non-public tab until someone signs in", () => {
    expect(html).toContain("const signedIn = Boolean(sessionMember)");
    expect(html).toContain("!PUBLIC_TABS.includes(tab)");
    // Governance surfaces stay gated on privilege for signed-in members, as before.
    expect(html).toContain('["approvals", "settings", "audit", "reviewing", "map"].includes(tab)');
    // Refresh and sign-out are session actions; a visitor has neither.
    expect(html).toContain('document.getElementById("signout-button").hidden = !signedIn');
    expect(html).toContain('document.getElementById("refresh-button").hidden = !signedIn');
  });

  it("offers the collaborator subgroup on the member editor, gated on the privilege select", () => {
    expect(html).toContain('id="member-subgroup-field" hidden');
    expect(html).toContain('<select name="collaborator_subgroup" id="member-subgroup">');
    // All eight subgroups reach the page, labeled through the same humanize() the roster uses.
    expect(html).toContain(
      '["interviewee","slightly_better_than_emails","acquaintance","alumni","coauthor_minor","coauthor_major","disappearing_coauthor","external_prof"]',
    );
    expect(html).toContain("collaboratorSubgroups,");
    expect(html).toContain('"Not set",');
    // The field is shown/blanked from the privilege value, and reset whenever a member is loaded.
    expect(html).toContain("function syncSubgroupField()");
    expect(html).toContain('=== "external_collaborator"');
    expect(html).toContain('addEventListener("change", syncSubgroupField)');
    expect(html).toContain('if (!applicable) subgroup.value = ""');
    expect(html).toContain('collaborator_subgroup: member.collaborator_subgroup || ""');
    // Saved only when set, so a non-collaborator never sends the field the service would reject.
    expect(html).toContain(
      "...(data.collaborator_subgroup ? { collaborator_subgroup: data.collaborator_subgroup } : {})",
    );
  });

  it("shows a subgroup's granted access items with a marker on every non-plain cell", () => {
    // The matrix travels with the page so the editor can explain a subgroup without a round trip.
    expect(html).toContain('"coauthor_minor":[');
    expect(html).toContain('{"label":"Recommendation letter button","cell":"case_by_case"}');
    expect(html).toContain('{"label":"Google file common practice guide","cell":"yes_separate"}');
    expect(html).toContain('{"label":"#proj-xxx project channel","cell":"pending"}');
    expect(html).toContain('{"label":"Recommendation letter button","cell":"auto_decline"}');
    // Non-plain cells carry the instruction as a marker inside the tag.
    expect(html).toContain('pending: { text: "pending" }');
    expect(html).toContain('case_by_case: { text: "case-by-case" }');
    expect(html).toContain('auto_decline: { text: "auto-decline" }');
    expect(html).toContain('id="member-subgroup-access"');
    expect(html).toContain("const marker = subgroupCellMarkers[grant.cell]");
  });

  it("links the separate-delivery marker at the doc its follow-up email points at", () => {
    expect(html).toContain(
      `yes_separate: { text: "separate", href: "${ADMINBOT_SEPARATE_DELIVERY_DOC_URL}" }`,
    );
    // Only that marker is a link; the rest stay plain text inside the pill.
    expect(html).toContain(
      "'<a href=\"' + marker.href + '\" target=\"_blank\" rel=\"noreferrer\">' + text + '</a>'",
    );
    expect(html).toContain(".data-tag em a { color: inherit; }");
  });

  it("tags the roster access column with the subgroup of an external collaborator", () => {
    expect(html).toContain(
      'member.collaborator_subgroup && member.privilege_level === "external_collaborator"',
    );
    expect(html).toContain(
      "'<span class=\"data-tag\">' + escapeHtml(humanize(member.collaborator_subgroup)) + '</span>'",
    );
  });

  it("embeds the deadline board rather than reimplementing it", () => {
    expect(html).toContain('id="deadlines-frame"');
    expect(html).toContain('src="/deadlines"');
  });

  it("drives the visitor reimbursement flow over the two anonymous routes only", () => {
    expect(html).toContain('fetch("/reimbursements/converse"');
    expect(html).toContain('fetch("/reimbursements/generate"');
    expect(html).toContain('id="reimb-form"');
    expect(html).toContain('id="reimb-generate"');
    // No credentials on the anonymous path: the routes are open and carry no session.
    const reimbursementBlock = html.slice(
      html.indexOf('fetch("/reimbursements/converse"'),
      html.indexOf('id="reimb-reset"'),
    );
    expect(reimbursementBlock).not.toContain("credentials:");
  });

  it("adds a relevant-papers toggle backed by /papers/relevant", () => {
    expect(html).toContain('id="paper-relevant-toggle"');
    expect(html).toContain('api("/papers/relevant")');
  });

  it("gates privileged surfaces (including Approvals) on the member privilege level", () => {
    expect(html).toContain("function isPrivileged()");
    expect(html).toContain('level === "admin"');
    expect(html).toContain("applyPrivilegeGating");
    expect(html).toContain("isPrivileged() ?");
    // Approvals and Reviewing are gated by the same privileged mechanism as Settings/Audit.
    expect(html).toContain('data-tab="approvals"');
    expect(html).toContain('data-tab="reviewing"');
    expect(html).toContain('["approvals", "settings", "audit", "reviewing", "map"]');
    // Registrations are only fetched for privileged sessions to avoid a guaranteed 403.
    expect(html).toContain("if (isPrivileged()) {");
    expect(html).toContain('api("/auth/registrations?status=pending")');
    // The admin add/edit-person editor inside the members section is gated too, so a
    // plain member never sees the privilege_level dropdown for other people.
    expect(html).toContain('document.querySelector(".member-editor")');
    expect(html).toContain("memberEditor.hidden = !privileged");
  });

  it("renders an approvals panel with per-request approve/reject actions and an empty state", () => {
    expect(html).toContain('id="approvals-list"');
    expect(html).toContain("function renderApprovals()");
    expect(html).toContain("No pending account requests.");
    // Claim rows surface the member name; signup rows surface the submitted profile.
    expect(html).toContain("registration.member_name");
    expect(html).toContain("function renderSignupDetails(");
    expect(html).toContain("data-approve-reg");
    expect(html).toContain("data-reject-reg");
    // Approve/reject POST to the registration decision endpoints and refresh afterwards.
    expect(html).toContain('"/auth/registrations/" + encodeURIComponent(id) + "/" + decision');
    expect(html).toContain('approveId ? "approve" : "reject"');
  });
});
