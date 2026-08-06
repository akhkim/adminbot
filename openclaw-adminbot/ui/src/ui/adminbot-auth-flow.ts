import { t } from "../i18n/index.ts";
// Control UI module orchestrates member auth against the app view state.
//
// Bridges the pure AdminBot API client (`adminbot-auth.ts`) into the running
// app: validates the form, injects the returned gateway url/token via
// applySettings, and drives connect()/disconnect. The gateway token only ever
// flows through applySettings so it stays in sessionStorage-scoped plumbing.
import {
  type AuthErrorKind,
  acknowledgeOnboardingStep,
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
  issueDeviceToken,
  loadStoredMemberSession,
  loginMember,
  logoutMember,
  markOnboardingWelcomeSeen,
  resolveAdminBotBaseUrl,
  saveStoredMemberSession,
  setOnboardingStep,
  signupMember,
} from "./adminbot-auth.ts";
import { clearDeviceAuthToken, storeDeviceAuthToken } from "./device-auth.ts";
import { loadOrCreateDeviceIdentity } from "./device-identity.ts";
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
  memberLocation: string;
  memberTimezone: string;
  memberPersonalWebsite: string;
  memberNotes: string;
  memberPrivilegeLevel: string | null;
  memberId: string | null;
  adminBotOnboarding: MemberOnboarding | null;
  adminBotWelcomeVisible: boolean;
  adminBotOnboardingBusyStepId: string | null;
  adminBotOnboardingError: string | null;
  // Optional so the auth flow can be driven by hosts that never render the gate (tests, the
  // console). Signing out closes it so the visitor lands on the public shell, not the form.
  authGateVisible?: boolean;
  // Latch owned by app-gateway: device-token recovery runs at most once per connected session.
  // Signing in is a new session, so the flow below clears it.
  deviceTokenRecoveryAttempted?: boolean;
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

// Gives this browser its own gateway credential: a device token minted from the member session and
// capped at their privilege. Returns true when the browser can connect on that token alone, which
// is the whole point — no member ever has to hold (or paste) the shared gateway secret.
//
// Returns false whenever the token can't be minted (insecure context with no crypto.subtle, an
// AdminBot that predates the route, or a gateway with no shared secret to bind to) so the caller
// falls back to the token the session handed it instead of leaving the user stranded offline.
async function ensureMemberDeviceToken(
  host: MemberAuthHost,
  sessionToken: string,
): Promise<boolean> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    return false;
  }
  try {
    const identity = await loadOrCreateDeviceIdentity();
    const result = await issueDeviceToken(
      {
        deviceId: identity.deviceId,
        publicKey: identity.publicKey,
        ...(typeof navigator === "undefined" ? {} : { platform: navigator.platform }),
      },
      sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!result.ok) {
      return false;
    }
    // Stored under the same key the gateway client reads at connect, so the client picks it up
    // with no extra plumbing and re-uses it on every later reload.
    storeDeviceAuthToken({
      deviceId: identity.deviceId,
      role: "operator",
      token: result.value.token,
      scopes: result.value.scopes,
    });
    return true;
  } catch {
    return false;
  }
}

// Applies the gateway settings a signed-in member connects with. The shared gateway token from the
// session is only injected when this browser could not get a device token of its own — otherwise
// settings.token stays empty, which is what makes the client authenticate as the device.
async function connectAsMember(
  host: MemberAuthHost,
  session: { session_token?: string; gateway?: { url?: string; token?: string } },
  sessionToken: string,
) {
  const hasDeviceToken = await ensureMemberDeviceToken(host, sessionToken);
  host.applySettings({
    ...host.settings,
    gatewayUrl: session.gateway?.url ?? host.settings.gatewayUrl,
    token: hasDeviceToken ? "" : (session.gateway?.token ?? host.settings.token),
  });
  host.connect();
}

async function applyMemberSession(host: MemberAuthHost, session: MemberSession) {
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
  // A rejected device token before sign-in cannot recover — recoverFromRejectedDeviceToken needs a
  // member session and returns false without one — but it still burns the once-per-session latch.
  // Signing in is exactly the event that makes recovery possible, so re-arm it here; otherwise the
  // first login after a stale token shows "device token mismatch" and only a page reload fixes it.
  host.deviceTokenRecoveryAttempted = false;
  host.adminBotOnboarding = session.member?.onboarding ?? null;
  // Auto-show the welcome screen once per member per browser; a manual "view onboarding"
  // entry point elsewhere can still reopen it later regardless of this flag.
  host.adminBotWelcomeVisible = Boolean(
    host.adminBotOnboarding && host.memberId && !hasSeenOnboardingWelcome(host.memberId),
  );
  await connectAsMember(host, session, session.session_token);
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
      await applyMemberSession(host, result.value);
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
    await connectAsMember(host, result.value, stored.sessionToken);
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
  host.memberLocation = "";
  host.memberTimezone = "";
  host.memberPersonalWebsite = "";
  host.memberNotes = "";
  host.memberPrivilegeLevel = null;
  host.memberId = null;
  host.adminBotOnboarding = null;
  host.adminBotWelcomeVisible = false;
  host.loginMode = "signin";
  host.authGateVisible = false;
  // Tear down the live gateway connection and drop the gateway token from the
  // in-memory + sessionStorage-scoped plumbing.
  host.client?.stop();
  host.client = null;
  host.connected = false;
  host.hello = null;
  host.password = "";
  host.applySettings({ ...host.settings, token: "" });
  await clearMemberDeviceToken();
}

// Recovers a connect the gateway refused for want of a credential it accepts: it rejected this
// device's token (AUTH_DEVICE_TOKEN_MISMATCH), or we presented none at all (AUTH_TOKEN_MISSING).
// Neither is fixable by retrying the same way -- the device is no longer paired, the token was
// revoked, the shared secret rotated so the issuer stamp is stale, or the token was never minted.
// The member is still signed in, which is the one credential that can produce a new one.
//
// Minting a replacement comes first: it keeps the member off the shared gateway secret, which is
// the whole point of per-device tokens. The session's shared token is the fallback for a service
// that cannot mint (no issuer configured, or a build predating the route) -- the gateway then
// re-pairs the device and returns a device token in its hello, so the browser still ends up
// device-bound.
//
// Returns true when the caller should reconnect.
export async function recoverFromRejectedDeviceToken(host: MemberAuthHost): Promise<boolean> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    return false;
  }
  await clearMemberDeviceToken();
  if (await ensureMemberDeviceToken(host, stored.sessionToken)) {
    // Clear any stale shared token so the reconnect authenticates as the device, matching the
    // post-login state connectAsMember establishes.
    host.applySettings({ ...host.settings, token: "" });
    return true;
  }
  const result = await fetchMemberSession(
    stored.sessionToken,
    resolveAdminBotBaseUrl(host.settings),
  );
  const gatewayToken = result.ok ? result.value.gateway?.token : undefined;
  if (!gatewayToken) {
    return false;
  }
  host.applySettings({ ...host.settings, token: gatewayToken });
  return true;
}

// Signing out must also drop the device's gateway token: it outlives the member session otherwise,
// leaving a credential on the machine that still reaches the gateway with the signed-out member's
// scopes. Best-effort — a browser with no device identity has nothing to clear.
async function clearMemberDeviceToken(): Promise<void> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    return;
  }
  try {
    const identity = await loadOrCreateDeviceIdentity();
    clearDeviceAuthToken({ deviceId: identity.deviceId, role: "operator" });
  } catch {
    // No device identity to clear.
  }
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

// Called from the welcome screen's per-step "I've read this" button. The server owns the
// checklist, so the rebuilt copy it returns replaces the local one rather than being patched in
// place -- that keeps `current_step` and the remaining count honest after each acknowledgement.
export async function acknowledgeOnboardingStepForMember(
  host: MemberAuthHost,
  stepId: string,
): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    return;
  }
  const result = await acknowledgeOnboardingStep(
    stepId,
    stored.sessionToken,
    resolveAdminBotBaseUrl(host.settings),
  );
  if (result.ok) {
    host.adminBotOnboarding = result.value;
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

// Called from the welcome screen's per-step "Mark done"/"Undo" toggle. Completion is
// self-attested by design — no external service (LinkedIn included) can verify these steps, so
// the member's own word is the source of truth, and it is what the onboarding nudge keys off.
export async function toggleOnboardingStep(
  host: MemberAuthHost,
  stepId: string,
  complete: boolean,
): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored || !host.memberId || host.adminBotOnboardingBusyStepId) {
    return;
  }
  host.adminBotOnboardingBusyStepId = stepId;
  host.adminBotOnboardingError = null;
  try {
    const result = await setOnboardingStep(
      host.memberId,
      stepId,
      complete,
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!result.ok) {
      host.adminBotOnboardingError =
        result.kind === "unreachable"
          ? "The AdminBot service is unreachable — try again in a moment."
          : "Couldn't update this step — sign in again and retry.";
      return;
    }
    host.adminBotOnboarding = result.value.onboarding ?? host.adminBotOnboarding;
  } finally {
    host.adminBotOnboardingBusyStepId = null;
  }
}
