import { describe, expect, it } from "vitest";
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
      "capacity_percent",
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

  it("adds a relevant-papers toggle backed by /papers/relevant", () => {
    expect(html).toContain('id="paper-relevant-toggle"');
    expect(html).toContain('api("/papers/relevant")');
  });

  it("gates privileged surfaces (including Approvals) on the member privilege level", () => {
    expect(html).toContain("function isPrivileged()");
    expect(html).toContain('level === "admin" || level === "core_member"');
    expect(html).toContain("applyPrivilegeGating");
    expect(html).toContain("isPrivileged() ?");
    // The Approvals tab is gated by the same privileged mechanism as Settings/Audit.
    expect(html).toContain('data-tab="approvals"');
    expect(html).toContain('["approvals", "settings", "audit"]');
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
