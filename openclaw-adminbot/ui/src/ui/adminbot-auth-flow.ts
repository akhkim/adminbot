import { t } from "../i18n/index.ts";
// Control UI module orchestrates member auth against the app view state.
//
// Bridges the pure AdminBot API client (`adminbot-auth.ts`) into the running
// app: validates the form, injects the returned gateway url/token via
// applySettings, and drives connect()/disconnect. The gateway token only ever
// flows through applySettings so it stays in sessionStorage-scoped plumbing.
import {
  type AuthErrorKind,
  type MemberOnboarding,
  type MemberSession,
  type RosterMember,
  type SignupProfile,
  changeMemberPassword,
  claimMember,
  clearStoredMemberSession,
  fetchMemberSession,
  fetchRoster,
  hasSeenOnboardingWelcome,
  loadStoredMemberSession,
  loginMember,
  logoutMember,
  markOnboardingWelcomeSeen,
  resolveAdminBotBaseUrl,
  saveStoredMemberSession,
  signupMember,
} from "./adminbot-auth.ts";
import type { UiSettings } from "./storage.ts";

const MIN_CLAIM_PASSWORD_LENGTH = 10;

export type LoginMode = "signin" | "claim" | "signup";

// Closed roster-load failure surface for the claim picker. `unreachable` is the
// AdminBot origin being down; `failed` is any other non-ok response.
export type RosterError = "unreachable" | "failed" | null;

// View-level failure surface; `claim-failed` folds server 400/403 during
// claim/signup, `pending-approval` is login hitting an unapproved account.
export type MemberAuthFailure = {
  kind:
    | "member-auth-failed"
    | "member-claim-failed"
    | "member-rate-limited"
    | "member-pending-approval"
    | "adminbot-unreachable";
  retryAfterSeconds?: number;
};

export type MemberAuthHost = {
  settings: UiSettings;
  password?: string;
  client?: { stop: () => void } | null;
  connected?: boolean;
  hello?: unknown;
  memberEmail: string;
  memberPassword: string;
  memberPasswordConfirm: string;
  loginMode: LoginMode;
  memberAuthBusy: boolean;
  memberAuthFailure: MemberAuthFailure | null;
  memberFormError: string | null;
  loginPendingNotice: boolean;
  rosterMembers: RosterMember[];
  rosterLoading: boolean;
  rosterError: RosterError;
  rosterFilter: string;
  selectedMemberId: string | null;
  memberName: string;
  memberSlackUserId: string;
  memberRole: string;
  memberAffiliation: string;
  memberResearchBranch: string;
  memberResearchTopics: string;
  memberProjects: string;
  memberHoursPerWeek: string;
  memberCapacityPercent: string;
  memberLocation: string;
  memberTimezone: string;
  memberPersonalWebsite: string;
  memberNotes: string;
  memberPrivilegeLevel: string | null;
  memberId: string | null;
  adminBotOnboarding: MemberOnboarding | null;
  adminBotWelcomeVisible: boolean;
  changePasswordCurrent: string;
  changePasswordNew: string;
  changePasswordConfirm: string;
  changePasswordBusy: boolean;
  changePasswordError: string | null;
  changePasswordNotice: string | null;
  applySettings: (next: UiSettings) => void;
  connect: () => void;
};

function toMemberAuthFailure(
  kind: AuthErrorKind,
  retryAfterSeconds: number | undefined,
  mode: LoginMode,
): MemberAuthFailure {
  if (kind === "unreachable") {
    return { kind: "adminbot-unreachable" };
  }
  if (kind === "rate-limited") {
    return { kind: "member-rate-limited", retryAfterSeconds };
  }
  if (kind === "pending-approval") {
    return { kind: "member-pending-approval" };
  }
  // weak-password only reaches here for claim/signup; auth-failed there is still a
  // claim problem (e.g. already-claimed / disallowed email).
  if (kind === "weak-password" || mode !== "signin") {
    return { kind: "member-claim-failed" };
  }
  return { kind: "member-auth-failed" };
}

function splitCommaList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function buildSignupProfile(host: MemberAuthHost): SignupProfile {
  const topics = splitCommaList(host.memberResearchTopics);
  const projects = splitCommaList(host.memberProjects);
  const affiliation = host.memberAffiliation.trim();
  const slackUserId = host.memberSlackUserId.trim();
  const role = host.memberRole.trim();
  const researchBranch = host.memberResearchBranch.trim();
  const hoursPerWeek = parseOptionalNumber(host.memberHoursPerWeek);
  const capacityPercent = parseOptionalNumber(host.memberCapacityPercent);
  const location = host.memberLocation.trim();
  const timezone = host.memberTimezone.trim();
  const personalWebsite = host.memberPersonalWebsite.trim();
  const notes = host.memberNotes.trim();
  return {
    name: host.memberName.trim(),
    ...(slackUserId ? { slack_user_id: slackUserId } : {}),
    ...(role ? { role } : {}),
    ...(affiliation ? { affiliation } : {}),
    ...(researchBranch ? { research_branch: researchBranch } : {}),
    ...(topics.length ? { research_topics: topics } : {}),
    ...(projects.length ? { projects } : {}),
    ...(hoursPerWeek !== undefined ? { hours_per_week: hoursPerWeek } : {}),
    ...(capacityPercent !== undefined ? { capacity_percent: capacityPercent } : {}),
    ...(location ? { location } : {}),
    ...(timezone ? { timezone } : {}),
    ...(personalWebsite ? { personal_website: personalWebsite } : {}),
    ...(notes ? { notes } : {}),
  };
}

// Loads the unclaimed roster for the claim picker. Called when the user enters
// claim mode; leaves an existing selection untouched on refresh.
export async function loadRoster(host: MemberAuthHost): Promise<void> {
  host.rosterLoading = true;
  host.memberAuthFailure = null;
  try {
    const result = await fetchRoster(resolveAdminBotBaseUrl(host.settings));
    if (result.ok) {
      host.rosterMembers = result.value;
      host.rosterError = null;
      return;
    }
    // Distinguish a down origin from any other failure so the picker can offer a
    // retry instead of the misleading "no matching profiles" empty state.
    host.rosterError = result.kind === "unreachable" ? "unreachable" : "failed";
    if (result.kind === "unreachable") {
      host.memberAuthFailure = { kind: "adminbot-unreachable" };
    }
  } finally {
    host.rosterLoading = false;
  }
}

function applyMemberSession(host: MemberAuthHost, session: MemberSession) {
  saveStoredMemberSession({
    sessionToken: session.session_token,
    expiresAt: session.expires_at,
  });
  host.memberPassword = "";
  host.memberPasswordConfirm = "";
  host.memberFormError = null;
  host.memberAuthFailure = null;
  // Persist real privilege so the Gateway-RPC admin surfaces gate on it instead
  // of assuming admin for every signed-in member.
  host.memberPrivilegeLevel = session.member?.privilege_level ?? null;
  host.memberId = session.member?.id ?? null;
  host.adminBotOnboarding = session.member?.onboarding ?? null;
  // Auto-show the welcome screen once per member per browser; a manual "view onboarding"
  // entry point elsewhere can still reopen it later regardless of this flag.
  host.adminBotWelcomeVisible = Boolean(
    host.adminBotOnboarding && host.memberId && !hasSeenOnboardingWelcome(host.memberId),
  );
  host.applySettings({
    ...host.settings,
    gatewayUrl: session.gateway?.url ?? host.settings.gatewayUrl,
    token: session.gateway?.token ?? host.settings.token,
  });
  host.connect();
}

export async function submitMemberAuth(host: MemberAuthHost): Promise<void> {
  host.memberFormError = null;
  host.memberAuthFailure = null;
  const mode = host.loginMode;
  const email = host.memberEmail.trim();
  const password = host.memberPassword;
  if (!email || !password) {
    host.memberFormError = t("login.member.errorRequired");
    return;
  }
  if (mode !== "signin") {
    if (mode === "claim" && !host.selectedMemberId) {
      host.memberFormError = t("login.member.errorNoSelection");
      return;
    }
    if (mode === "signup" && !host.memberName.trim()) {
      host.memberFormError = t("login.member.errorNameRequired");
      return;
    }
    if (password.length < MIN_CLAIM_PASSWORD_LENGTH) {
      host.memberFormError = t("login.member.errorTooShort", {
        min: String(MIN_CLAIM_PASSWORD_LENGTH),
      });
      return;
    }
    if (password !== host.memberPasswordConfirm) {
      host.memberFormError = t("login.member.errorMismatch");
      return;
    }
  }

  const baseUrl = resolveAdminBotBaseUrl(host.settings);
  host.memberAuthBusy = true;
  try {
    if (mode === "signin") {
      const result = await loginMember(email, password, baseUrl);
      if (!result.ok) {
        host.memberAuthFailure = toMemberAuthFailure(result.kind, result.retryAfterSeconds, mode);
        return;
      }
      applyMemberSession(host, result.value);
      return;
    }
    // Claim/signup do not log in — the account awaits admin approval.
    const result =
      mode === "claim"
        ? await claimMember(host.selectedMemberId ?? "", email, password, baseUrl)
        : await signupMember(buildSignupProfile(host), email, password, baseUrl);
    if (!result.ok) {
      host.memberAuthFailure = toMemberAuthFailure(result.kind, result.retryAfterSeconds, mode);
      return;
    }
    host.memberPassword = "";
    host.memberPasswordConfirm = "";
    host.loginPendingNotice = true;
  } finally {
    host.memberAuthBusy = false;
  }
}

// Resume outcome kinds let the init path decide whether to fall back to the gate.
export type ResumeOutcome = "no-session" | "resumed" | "unreachable" | "cleared";

export async function resumeMemberSession(host: MemberAuthHost): Promise<ResumeOutcome> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    return "no-session";
  }
  const baseUrl = resolveAdminBotBaseUrl(host.settings);
  const result = await fetchMemberSession(stored.sessionToken, baseUrl);
  if (result.ok) {
    saveStoredMemberSession({
      sessionToken: stored.sessionToken,
      expiresAt: result.value.expires_at,
    });
    host.memberPrivilegeLevel = result.value.member?.privilege_level ?? null;
    host.memberId = result.value.member?.id ?? null;
    // Refresh the checklist data but never auto-open the welcome screen on a plain page
    // reload — only a fresh sign-in (applyMemberSession) or the manual reopen entry point do.
    host.adminBotOnboarding = result.value.member?.onboarding ?? null;
    host.applySettings({
      ...host.settings,
      gatewayUrl: result.value.gateway?.url ?? host.settings.gatewayUrl,
      token: result.value.gateway?.token ?? host.settings.token,
    });
    host.connect();
    return "resumed";
  }
  if (result.kind === "unreachable") {
    // AdminBot down: keep the (still-valid) session and surface the hint so the
    // user retries rather than losing their login.
    host.memberAuthFailure = { kind: "adminbot-unreachable" };
    return "unreachable";
  }
  // 401 / rejected: the stored session is dead — drop it and show the gate.
  clearStoredMemberSession();
  return "cleared";
}

export function hasStoredMemberSession(): boolean {
  return loadStoredMemberSession() !== null;
}

// Populate the signed-in member's privilege level from the stored session so the
// privilege-gated admin surfaces (Lab Members) resolve their mode on reload even
// when the gateway token is already present (sessionStorage-scoped) and the full
// resume is skipped. Best-effort: a failed/unreachable fetch leaves the safe
// default (null → read-only "general" mode) in place.
export async function loadMemberPrivilege(host: MemberAuthHost): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.memberPrivilegeLevel = null;
    host.memberId = null;
    return;
  }
  const result = await fetchMemberSession(
    stored.sessionToken,
    resolveAdminBotBaseUrl(host.settings),
  );
  if (result.ok) {
    host.memberPrivilegeLevel = result.value.member?.privilege_level ?? null;
    host.memberId = result.value.member?.id ?? null;
    host.adminBotOnboarding = result.value.member?.onboarding ?? null;
  }
}

export async function signOutMember(host: MemberAuthHost): Promise<void> {
  const stored = loadStoredMemberSession();
  const baseUrl = resolveAdminBotBaseUrl(host.settings);
  if (stored) {
    await logoutMember(stored.sessionToken, baseUrl);
  }
  clearStoredMemberSession();
  host.memberAuthFailure = null;
  host.memberFormError = null;
  host.loginPendingNotice = false;
  host.memberEmail = "";
  host.memberPassword = "";
  host.memberPasswordConfirm = "";
  host.selectedMemberId = null;
  host.rosterFilter = "";
  host.memberName = "";
  host.memberSlackUserId = "";
  host.memberRole = "";
  host.memberAffiliation = "";
  host.memberResearchBranch = "";
  host.memberResearchTopics = "";
  host.memberProjects = "";
  host.memberHoursPerWeek = "";
  host.memberCapacityPercent = "";
  host.memberLocation = "";
  host.memberTimezone = "";
  host.memberPersonalWebsite = "";
  host.memberNotes = "";
  host.memberPrivilegeLevel = null;
  host.memberId = null;
  host.adminBotOnboarding = null;
  host.adminBotWelcomeVisible = false;
  host.loginMode = "signin";
  // Tear down the live gateway connection and drop the gateway token from the
  // in-memory + sessionStorage-scoped plumbing.
  host.client?.stop();
  host.client = null;
  host.connected = false;
  host.hello = null;
  host.password = "";
  host.applySettings({ ...host.settings, token: "" });
}

export function openChangePassword(host: MemberAuthHost): void {
  host.changePasswordCurrent = "";
  host.changePasswordNew = "";
  host.changePasswordConfirm = "";
  host.changePasswordError = null;
  host.changePasswordNotice = null;
}

export function closeChangePassword(host: MemberAuthHost): void {
  host.changePasswordCurrent = "";
  host.changePasswordNew = "";
  host.changePasswordConfirm = "";
  host.changePasswordError = null;
}

export async function submitChangePassword(host: MemberAuthHost): Promise<void> {
  host.changePasswordNotice = null;
  if (!host.changePasswordCurrent || !host.changePasswordNew) {
    host.changePasswordError = t("login.member.changePassword.errorRequired");
    return;
  }
  if (host.changePasswordNew.length < MIN_CLAIM_PASSWORD_LENGTH) {
    host.changePasswordError = t("login.member.errorTooShort", {
      min: String(MIN_CLAIM_PASSWORD_LENGTH),
    });
    return;
  }
  if (host.changePasswordNew !== host.changePasswordConfirm) {
    host.changePasswordError = t("login.member.errorMismatch");
    return;
  }
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.changePasswordError = t("login.member.changePassword.errorAuthFailed");
    return;
  }
  host.changePasswordBusy = true;
  host.changePasswordError = null;
  try {
    const baseUrl = resolveAdminBotBaseUrl(host.settings);
    const result = await changeMemberPassword(
      host.changePasswordCurrent,
      host.changePasswordNew,
      stored.sessionToken,
      baseUrl,
    );
    if (!result.ok) {
      host.changePasswordError = changePasswordErrorMessage(result.kind);
      return;
    }
    host.changePasswordCurrent = "";
    host.changePasswordNew = "";
    host.changePasswordConfirm = "";
    host.changePasswordNotice = t("login.member.changePassword.success");
  } finally {
    host.changePasswordBusy = false;
  }
}

function changePasswordErrorMessage(kind: AuthErrorKind): string {
  switch (kind) {
    case "rate-limited":
      return t("login.member.changePassword.errorRateLimited");
    case "unreachable":
      return t("login.member.changePassword.errorUnreachable");
    case "weak-password":
      return t("login.member.errorTooShort", { min: String(MIN_CLAIM_PASSWORD_LENGTH) });
    default:
      return t("login.member.changePassword.errorAuthFailed");
  }
}

// Called from the welcome screen's dismiss button. Marks it seen (so a future login/reload
// doesn't auto-show it again) and hides it; the checklist stays reachable via the manual
// reopen entry point in Lab Members regardless.
export function dismissAdminBotWelcome(host: MemberAuthHost): void {
  if (host.memberId) {
    markOnboardingWelcomeSeen(host.memberId);
  }
  host.adminBotWelcomeVisible = false;
}

// Called from the Lab Members "view onboarding checklist" reopen entry point.
export function showAdminBotWelcome(host: MemberAuthHost): void {
  if (host.adminBotOnboarding) {
    host.adminBotWelcomeVisible = true;
  }
}
