import { t } from "../../../i18n/index.ts";
import type { UiSettings } from "../../storage.ts";
import {
  approveBadgeNomination,
  approveBadgeSuggestion,
  assignBadgeToMember,
  createBadge,
  fetchBadgeNominations,
  fetchBadges,
  fetchBadgeSuggestions,
  loadStoredMemberSession,
  rejectBadgeNomination,
  rejectBadgeSuggestion,
  removeBadgeFromMember,
  resolveAdminBotBaseUrl,
  submitBadgeNomination,
  submitBadgeSuggestion,
  updateBadge,
  type AuthErrorKind,
  type BadgeDefinition,
  type BadgeDefinitionInput,
  type BadgeNominationView,
  type BadgeSuggestionInput,
  type BadgeSuggestionView,
} from "../auth/session.ts";
import {
  loadAdminBot,
  type AdminBotDashboardData,
  type AdminBotHost,
} from "../controllers/admin.ts";

export type BadgeLoadError =
  | "no-session"
  | "expired"
  | "forbidden"
  | "unreachable"
  // The service answered, but has no badge routes: a 404 from an AdminBot deployed before the
  // badge system landed. The Control UI ships from Vercel and the service from Aurora, so the
  // console routinely runs ahead of what it is talking to; without this the skew arrived as
  // "your session expired" and sent admins round a sign-in loop nothing could fix.
  | "not-deployed"
  | "failed";

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
  // Badge suggestions. One list for both surfaces, because the service already decides what is in
  // it: a member's own for a member, the whole queue for an admin. A second host field scoped
  // "profile" would be the same GET twice with the same answer.
  adminBotBadgeSuggestions: BadgeSuggestionView[];
  adminBotBadgeSuggestionsLoading: boolean;
  adminBotBadgeSuggestionsLoadedAt: number | null;
  adminBotBadgeSuggestionsError: BadgeLoadError | null;
  badgeSuggestionBusy: boolean;
  badgeSuggestionNotice: BadgeNotice;
};

function loadErrorFor(kind: AuthErrorKind): BadgeLoadError {
  if (kind === "unreachable") {
    return "unreachable";
  }
  if (kind === "forbidden") {
    return "forbidden";
  }
  if (kind === "not-found") {
    return "not-deployed";
  }
  // Transient and worth a retry button; only a genuine 401 should tell somebody to sign in again.
  if (kind === "rate-limited") {
    return "failed";
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
  if (kind === "not-found") {
    return t("adminbotBadges.error.notDeployed");
  }
  return t(fallbackKey);
}

/**
 * Whether the tab still owes a fetch.
 *
 * The `*Error` term is the load-bearing half. These run from the render pass, and a failed load
 * leaves `loadedAt` null with `loading` back to false -- so without it, the completion of a failed
 * fetch re-renders, the guard passes again, and the tab hammers the service in a loop for as long
 * as it stays open. The Refresh button is what clears the error and asks again.
 */
export function shouldLoadBadgeDefinitions(host: AdminBotBadgesHost): boolean {
  return (
    !host.adminBotBadgeDefinitionsLoading &&
    !host.adminBotBadgeDefinitionsError &&
    host.adminBotBadgeDefinitionsLoadedAt === null
  );
}

export function shouldLoadAdminBadgeNominations(host: AdminBotBadgesHost): boolean {
  return (
    !host.adminBotBadgeNominationsLoading &&
    !host.adminBotBadgeNominationsError &&
    host.adminBotBadgeNominationsLoadedAt === null
  );
}

export function shouldLoadProfileBadgeNominations(host: AdminBotBadgesHost): boolean {
  return (
    !host.profileBadgeNominationsLoading &&
    !host.profileBadgeNominationsError &&
    host.profileBadgeNominationsLoadedAt === null
  );
}

export function shouldLoadBadgeSuggestions(host: AdminBotBadgesHost): boolean {
  return (
    !host.adminBotBadgeSuggestionsLoading &&
    !host.adminBotBadgeSuggestionsError &&
    host.adminBotBadgeSuggestionsLoadedAt === null
  );
}

export async function loadBadgeSuggestions(host: AdminBotBadgesHost): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotBadgeSuggestions = [];
    host.adminBotBadgeSuggestionsError = "no-session";
    host.adminBotBadgeSuggestionsLoading = false;
    host.adminBotBadgeSuggestionsLoadedAt = null;
    return;
  }
  host.adminBotBadgeSuggestionsLoading = true;
  host.adminBotBadgeSuggestionsError = null;
  try {
    const result = await fetchBadgeSuggestions(
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!result.ok) {
      host.adminBotBadgeSuggestions = [];
      host.adminBotBadgeSuggestionsError = loadErrorFor(result.kind);
      host.adminBotBadgeSuggestionsLoadedAt = null;
      return;
    }
    host.adminBotBadgeSuggestions = result.value;
    host.adminBotBadgeSuggestionsError = null;
    host.adminBotBadgeSuggestionsLoadedAt = Date.now();
  } finally {
    host.adminBotBadgeSuggestionsLoading = false;
  }
}

/**
 * Propose a badge from the profile page.
 *
 * The service's 409s are worth surfacing verbatim rather than flattening into "that did not work":
 * "that badge already exists" and "already suggested and awaiting a decision" are two different
 * things for the member to do next, and only one of them is a dead end.
 */
export async function submitOwnBadgeSuggestion(
  host: AdminBotBadgesHost,
  input: BadgeSuggestionInput,
): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotBadgeSuggestionsError = "no-session";
    return;
  }
  host.badgeSuggestionBusy = true;
  host.badgeSuggestionNotice = null;
  try {
    const result = await submitBadgeSuggestion(
      input,
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!result.ok) {
      host.badgeSuggestionNotice = {
        kind: "error",
        text: result.message ?? errorText(result.kind, "profile.badges.suggestFailed"),
      };
      return;
    }
    host.badgeSuggestionNotice = { kind: "success", text: t("profile.badges.suggestSubmitted") };
    host.adminBotBadgeSuggestionsLoadedAt = null;
    await loadBadgeSuggestions(host);
  } finally {
    host.badgeSuggestionBusy = false;
  }
}

/**
 * An admin's answer on a suggested badge.
 *
 * An approval changes the catalogue, so the definitions are reloaded too -- otherwise the badge
 * the admin just created is missing from every picker on the page until something else refreshes
 * it, which reads as the approval having failed.
 */
export async function decideBadgeSuggestion(
  host: AdminBotBadgesHost,
  suggestionId: string,
  decision: "approve" | "reject",
): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotBadgeSuggestionsError = "no-session";
    return;
  }
  host.badgeSuggestionBusy = true;
  host.badgeSuggestionNotice = null;
  try {
    const decide = decision === "approve" ? approveBadgeSuggestion : rejectBadgeSuggestion;
    const result = await decide(
      suggestionId,
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!result.ok) {
      host.badgeSuggestionNotice = {
        kind: "error",
        text: result.message ?? errorText(result.kind, "adminbotBadges.suggestion.decideFailed"),
      };
      return;
    }
    host.badgeSuggestionNotice = {
      kind: "success",
      text: t(
        decision === "approve"
          ? "adminbotBadges.suggestion.approved"
          : "adminbotBadges.suggestion.rejected",
      ),
    };
    host.adminBotBadgeSuggestionsLoadedAt = null;
    await loadBadgeSuggestions(host);
    if (decision === "approve") {
      host.adminBotBadgeDefinitionsLoadedAt = null;
      await loadBadgeDefinitions(host);
    }
  } finally {
    host.badgeSuggestionBusy = false;
  }
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
  try {
    // Inside the try: a throw from the request itself used to escape before the `finally`, leaving
    // busyKey set and every button on the tab disabled until a reload.
    const result = host.adminBotBadgeDefinitions.some((badge) => badge.id === input.id)
      ? await updateBadge(
          input.id!,
          input,
          stored.sessionToken,
          resolveAdminBotBaseUrl(host.settings),
        )
      : await createBadge(input, stored.sessionToken, resolveAdminBotBaseUrl(host.settings));
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

/**
 * Submit a nomination from the profile page, for the viewer or for a colleague.
 *
 * `memberId` is left off when it is the viewer's own, so the service stores a self-nomination as
 * exactly that rather than as one somebody filed on their behalf.
 */
export async function submitOwnBadgeNomination(
  host: AdminBotBadgesHost,
  badgeId: string,
  evidence: string,
  memberId?: string,
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
      { badgeId, evidence, ...(memberId ? { memberId } : {}) },
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
