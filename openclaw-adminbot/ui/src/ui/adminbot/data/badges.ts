import { t } from "../../../i18n/index.ts";
import type { UiSettings } from "../../storage.ts";
import {
  approveBadgeNomination,
  assignBadgeToMember,
  createBadge,
  fetchBadgeNominations,
  fetchBadges,
  loadStoredMemberSession,
  rejectBadgeNomination,
  removeBadgeFromMember,
  resolveAdminBotBaseUrl,
  submitBadgeNomination,
  updateBadge,
  type AuthErrorKind,
  type BadgeDefinition,
  type BadgeDefinitionInput,
  type BadgeNominationView,
} from "../auth/session.ts";
import {
  loadAdminBot,
  type AdminBotDashboardData,
  type AdminBotHost,
} from "../controllers/admin.ts";

export type BadgeLoadError = "no-session" | "expired" | "forbidden" | "unreachable" | "failed";

type BadgeNotice = { kind: "success" | "error"; text: string } | null;

export type AdminBotBadgesHost = {
  settings: UiSettings;
  adminBotData: AdminBotDashboardData;
  adminBotBadgeDefinitions: BadgeDefinition[];
  adminBotBadgeDefinitionsLoading: boolean;
  adminBotBadgeDefinitionsLoadedAt: number | null;
  adminBotBadgeDefinitionsError: BadgeLoadError | null;
  adminBotBadgeNominations: BadgeNominationView[];
  adminBotBadgeNominationsLoading: boolean;
  adminBotBadgeNominationsLoadedAt: number | null;
  adminBotBadgeNominationsError: BadgeLoadError | null;
  adminBotBadgeBusyKey: string | null;
  adminBotBadgeNotice: BadgeNotice;
  profileBadgeNominations: BadgeNominationView[];
  profileBadgeNominationsLoading: boolean;
  profileBadgeNominationsLoadedAt: number | null;
  profileBadgeNominationsError: BadgeLoadError | null;
  profileBadgeBusy: boolean;
  profileBadgeNotice: BadgeNotice;
};

function loadErrorFor(kind: AuthErrorKind): BadgeLoadError {
  if (kind === "unreachable") {
    return "unreachable";
  }
  if (kind === "forbidden") {
    return "forbidden";
  }
  return "expired";
}

function errorText(kind: AuthErrorKind, fallbackKey: string): string {
  if (kind === "unreachable") {
    return t("adminbotBadges.error.unreachable");
  }
  if (kind === "forbidden") {
    return t("adminbotBadges.error.forbidden");
  }
  return t(fallbackKey);
}

export async function loadBadgeDefinitions(host: AdminBotBadgesHost): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotBadgeDefinitions = [];
    host.adminBotBadgeDefinitionsError = "no-session";
    host.adminBotBadgeDefinitionsLoading = false;
    host.adminBotBadgeDefinitionsLoadedAt = null;
    return;
  }
  host.adminBotBadgeDefinitionsLoading = true;
  host.adminBotBadgeDefinitionsError = null;
  try {
    const result = await fetchBadges(stored.sessionToken, resolveAdminBotBaseUrl(host.settings));
    if (!result.ok) {
      host.adminBotBadgeDefinitions = [];
      host.adminBotBadgeDefinitionsError = loadErrorFor(result.kind);
      host.adminBotBadgeDefinitionsLoadedAt = null;
      return;
    }
    host.adminBotBadgeDefinitions = result.value;
    host.adminBotBadgeDefinitionsError = null;
    host.adminBotBadgeDefinitionsLoadedAt = Date.now();
  } finally {
    host.adminBotBadgeDefinitionsLoading = false;
  }
}

export async function loadProfileBadgeNominations(host: AdminBotBadgesHost): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.profileBadgeNominations = [];
    host.profileBadgeNominationsError = "no-session";
    host.profileBadgeNominationsLoading = false;
    host.profileBadgeNominationsLoadedAt = null;
    return;
  }
  host.profileBadgeNominationsLoading = true;
  host.profileBadgeNominationsError = null;
  try {
    const result = await fetchBadgeNominations(
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!result.ok) {
      host.profileBadgeNominations = [];
      host.profileBadgeNominationsError = loadErrorFor(result.kind);
      host.profileBadgeNominationsLoadedAt = null;
      return;
    }
    host.profileBadgeNominations = result.value;
    host.profileBadgeNominationsError = null;
    host.profileBadgeNominationsLoadedAt = Date.now();
  } finally {
    host.profileBadgeNominationsLoading = false;
  }
}

export async function loadAdminBadgeNominations(host: AdminBotBadgesHost): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotBadgeNominations = [];
    host.adminBotBadgeNominationsError = "no-session";
    host.adminBotBadgeNominationsLoading = false;
    host.adminBotBadgeNominationsLoadedAt = null;
    return;
  }
  host.adminBotBadgeNominationsLoading = true;
  host.adminBotBadgeNominationsError = null;
  try {
    const result = await fetchBadgeNominations(
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
      { status: "pending" },
    );
    if (!result.ok) {
      host.adminBotBadgeNominations = [];
      host.adminBotBadgeNominationsError = loadErrorFor(result.kind);
      host.adminBotBadgeNominationsLoadedAt = null;
      return;
    }
    host.adminBotBadgeNominations = result.value;
    host.adminBotBadgeNominationsError = null;
    host.adminBotBadgeNominationsLoadedAt = Date.now();
  } finally {
    host.adminBotBadgeNominationsLoading = false;
  }
}

async function refreshAdminBadgeData(host: AdminBotBadgesHost): Promise<void> {
  host.adminBotBadgeDefinitionsLoadedAt = null;
  host.adminBotBadgeNominationsLoadedAt = null;
  await Promise.all([
    loadBadgeDefinitions(host),
    loadAdminBadgeNominations(host),
    // The badge screens carry only their own slice of the app state; loadAdminBot reads the
    // roster off the full host, and nothing it touches is missing here at runtime.
    loadAdminBot(host as unknown as AdminBotHost, "admin"),
  ]);
}

export async function saveAdminBadgeDefinition(
  host: AdminBotBadgesHost,
  input: BadgeDefinitionInput,
): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotBadgeDefinitionsError = "no-session";
    return;
  }
  host.adminBotBadgeBusyKey = `definition:${input.id || "new"}`;
  host.adminBotBadgeNotice = null;
  const result =
    host.adminBotBadgeDefinitions.some((badge) => badge.id === input.id)
      ? await updateBadge(
          input.id!,
          input,
          stored.sessionToken,
          resolveAdminBotBaseUrl(host.settings),
        )
      : await createBadge(input, stored.sessionToken, resolveAdminBotBaseUrl(host.settings));
  try {
    if (!result.ok) {
      host.adminBotBadgeNotice = {
        kind: "error",
        text: result.message ?? errorText(result.kind, "adminbotBadges.error.saveFailed"),
      };
      return;
    }
    host.adminBotBadgeNotice = { kind: "success", text: t("adminbotBadges.notice.saved") };
    await refreshAdminBadgeData(host);
  } finally {
    host.adminBotBadgeBusyKey = null;
  }
}

export async function assignAdminBadge(
  host: AdminBotBadgesHost,
  memberId: string,
  badgeId: string,
  evidence?: string,
): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotBadgeNominationsError = "no-session";
    return;
  }
  host.adminBotBadgeBusyKey = `assign:${memberId}:${badgeId}`;
  host.adminBotBadgeNotice = null;
  try {
    const result = await assignBadgeToMember(
      memberId,
      badgeId,
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
      evidence,
    );
    if (!result.ok) {
      host.adminBotBadgeNotice = {
        kind: "error",
        text: result.message ?? errorText(result.kind, "adminbotBadges.error.assignFailed"),
      };
      return;
    }
    host.adminBotBadgeNotice = { kind: "success", text: t("adminbotBadges.notice.assigned") };
    await refreshAdminBadgeData(host);
  } finally {
    host.adminBotBadgeBusyKey = null;
  }
}

export async function removeAdminBadge(
  host: AdminBotBadgesHost,
  memberId: string,
  badgeId: string,
): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotBadgeNominationsError = "no-session";
    return;
  }
  host.adminBotBadgeBusyKey = `remove:${memberId}:${badgeId}`;
  host.adminBotBadgeNotice = null;
  try {
    const result = await removeBadgeFromMember(
      memberId,
      badgeId,
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!result.ok) {
      host.adminBotBadgeNotice = {
        kind: "error",
        text: result.message ?? errorText(result.kind, "adminbotBadges.error.removeFailed"),
      };
      return;
    }
    host.adminBotBadgeNotice = { kind: "success", text: t("adminbotBadges.notice.removed") };
    await refreshAdminBadgeData(host);
  } finally {
    host.adminBotBadgeBusyKey = null;
  }
}

export async function decideAdminBadgeNomination(
  host: AdminBotBadgesHost,
  nominationId: string,
  decision: "approve" | "reject",
): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotBadgeNominationsError = "no-session";
    return;
  }
  host.adminBotBadgeBusyKey = `${decision}:${nominationId}`;
  host.adminBotBadgeNotice = null;
  try {
    const decide = decision === "approve" ? approveBadgeNomination : rejectBadgeNomination;
    const result = await decide(
      nominationId,
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!result.ok) {
      host.adminBotBadgeNotice = {
        kind: "error",
        text: result.message ?? errorText(result.kind, "adminbotBadges.error.decisionFailed"),
      };
      return;
    }
    host.adminBotBadgeNotice = {
      kind: "success",
      text:
        decision === "approve"
          ? t("adminbotBadges.notice.approved")
          : t("adminbotBadges.notice.rejected"),
    };
    await refreshAdminBadgeData(host);
  } finally {
    host.adminBotBadgeBusyKey = null;
  }
}

export async function submitOwnBadgeNomination(
  host: AdminBotBadgesHost,
  badgeId: string,
  evidence: string,
): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.profileBadgeNominationsError = "no-session";
    return;
  }
  host.profileBadgeBusy = true;
  host.profileBadgeNotice = null;
  try {
    const result = await submitBadgeNomination(
      { badgeId, evidence },
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!result.ok) {
      host.profileBadgeNotice = {
        kind: "error",
        text: result.message ?? errorText(result.kind, "profile.badges.nominateFailed"),
      };
      return;
    }
    host.profileBadgeNotice = { kind: "success", text: t("profile.badges.nominateSubmitted") };
    host.profileBadgeNominationsLoadedAt = null;
    await loadProfileBadgeNominations(host);
  } finally {
    host.profileBadgeBusy = false;
  }
}
