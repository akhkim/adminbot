// Control UI controller for the admin "Member requests" surface.
//
// Lists pending account claims/signups and drives approve/reject against the
// AdminBot HTTP service with the signed-in admin's member session token. The
// service only honours these routes for an admin member session, so
// a plain member reaching this page gets a `forbidden` state, not silence.
import { t } from "../../../i18n/index.ts";
import type { UiSettings } from "../../storage.ts";
import {
  type AuthErrorKind,
  type MemberRegistration,
  approveRegistration,
  fetchPendingRegistrations,
  loadStoredMemberSession,
  rejectRegistration,
  resolveAdminBotBaseUrl,
} from "../auth/session.ts";

// Closed reasons the queue can be empty. "no-session"/"expired" route back to the
// member login; "forbidden" means signed in without governance privilege.
export type RegistrationsLoadError =
  | "no-session"
  | "expired"
  | "forbidden"
  | "unreachable"
  | "failed";

export type RegistrationDecision = "approve" | "reject";

export type AdminBotRegistrationsHost = {
  settings: UiSettings;
  registrations: MemberRegistration[];
  registrationsLoading: boolean;
  registrationsError: RegistrationsLoadError | null;
  registrationsBusyId: string | null;
  registrationsNotice: { kind: "success" | "error"; text: string } | null;
};

function loadErrorFor(kind: AuthErrorKind): RegistrationsLoadError {
  if (kind === "unreachable") {
    return "unreachable";
  }
  if (kind === "forbidden") {
    return "forbidden";
  }
  return "expired";
}

function decisionErrorText(kind: AuthErrorKind): string {
  if (kind === "unreachable") {
    return t("adminbotRegistrations.error.unreachable");
  }
  if (kind === "forbidden") {
    return t("adminbotRegistrations.error.forbidden");
  }
  return t("adminbotRegistrations.error.decisionFailed");
}

export async function loadAdminBotRegistrations(host: AdminBotRegistrationsHost): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.registrations = [];
    host.registrationsError = "no-session";
    host.registrationsLoading = false;
    return;
  }
  host.registrationsLoading = true;
  host.registrationsError = null;
  try {
    const result = await fetchPendingRegistrations(
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!result.ok) {
      host.registrations = [];
      host.registrationsError = loadErrorFor(result.kind);
      return;
    }
    host.registrations = result.value;
    host.registrationsError = null;
  } finally {
    host.registrationsLoading = false;
  }
}

export async function decideAdminBotRegistration(
  host: AdminBotRegistrationsHost,
  registrationId: string,
  decision: RegistrationDecision,
): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.registrationsError = "no-session";
    return;
  }
  host.registrationsBusyId = registrationId;
  host.registrationsNotice = null;
  const baseUrl = resolveAdminBotBaseUrl(host.settings);
  try {
    const decide = decision === "approve" ? approveRegistration : rejectRegistration;
    const result = await decide(registrationId, stored.sessionToken, baseUrl);
    if (!result.ok) {
      host.registrationsNotice = { kind: "error", text: decisionErrorText(result.kind) };
      return;
    }
    host.registrationsNotice = {
      kind: "success",
      text:
        decision === "approve"
          ? t("adminbotRegistrations.approved")
          : t("adminbotRegistrations.rejected"),
    };
  } finally {
    host.registrationsBusyId = null;
  }
  // Refetch rather than splice locally: approval mints a member server-side, so the
  // authoritative queue is the only thing that reflects a concurrent admin's decision.
  await loadAdminBotRegistrations(host);
}
