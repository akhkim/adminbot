// The Profile Overview tab's side of the wire.
//
// Three calls: read how far along everyone's record is, run the reminder pass now rather than
// waiting for the daily cron, and populate the nudge list from the roster's member types. All are
// admin-only and the service enforces that; nothing here decides who may look.
import { t } from "../../../i18n/index.ts";
import type { UiSettings } from "../../storage.ts";
import {
  fetchEscalatedNudges,
  fetchMemberProfileOverview,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
  runMandatoryFieldsReminder,
  seedNudgeList,
  type EscalatedNudgeRow,
  type MemberAdoptionSummary,
  type MemberProfileOverviewRow,
} from "../auth/session.ts";

export type AdminBotProfileOverviewHost = {
  settings: UiSettings;
  adminBotProfileOverview: MemberProfileOverviewRow[];
  /** How many fields count as complete. Zero until the first read answers. */
  adminBotProfileOverviewFieldCount: number;
  /** The lab-wide adoption roll-up. Null until the first read answers. */
  adminBotProfileAdoption?: MemberAdoptionSummary | null;
  adminBotProfileOverviewLoading: boolean;
  adminBotProfileOverviewError: string | null;
  adminBotProfileOverviewLoadedAt: number | null;
  adminBotProfileOverviewReminding: boolean;
  adminBotProfileOverviewNotice: string | null;
  /** Nudges raised to the head professor and still unanswered. Empty until the first read. */
  adminBotEscalatedNudges: EscalatedNudgeRow[];
};

function failureText(result: { kind: string; message?: string }, baseUrl: string): string {
  if (result.kind === "unreachable") {
    return t("profileOverview.error.unreachable", { url: baseUrl });
  }
  if (result.kind === "forbidden") {
    return t("profileOverview.error.forbidden");
  }
  return result.message ?? t("profileOverview.error.failed");
}

function session(host: AdminBotProfileOverviewHost): { token: string; baseUrl: string } | null {
  const stored = loadStoredMemberSession();
  return stored
    ? { token: stored.sessionToken, baseUrl: resolveAdminBotBaseUrl(host.settings) }
    : null;
}

export async function loadAdminBotProfileOverview(
  host: AdminBotProfileOverviewHost,
): Promise<void> {
  const wire = session(host);
  if (!wire) {
    host.adminBotProfileOverviewError = t("profileOverview.error.signIn");
    return;
  }
  host.adminBotProfileOverviewLoading = true;
  host.adminBotProfileOverviewError = null;
  try {
    const result = await fetchMemberProfileOverview(wire.token, wire.baseUrl);
    if (!result.ok) {
      host.adminBotProfileOverview = [];
      host.adminBotProfileOverviewError = failureText(result, wire.baseUrl);
      return;
    }
    host.adminBotProfileOverview = result.value.members;
    host.adminBotProfileOverviewFieldCount = result.value.mandatoryFieldCount;
    host.adminBotProfileAdoption = result.value.adoption;
    // Loaded alongside rather than on its own: the escalation queue and the adoption columns are
    // read by the same person on the same page, and a second spinner for four rows is worse than
    // waiting for them together. A failure here does not blank the page it rides on -- the columns
    // are the reason someone opened it, so the queue simply stays empty.
    const escalated = await fetchEscalatedNudges(wire.token, wire.baseUrl);
    host.adminBotEscalatedNudges = escalated.ok ? escalated.value : [];
  } finally {
    host.adminBotProfileOverviewLoading = false;
  }
}

/**
 * Sends the reminder now, for whatever the page is filtered to.
 *
 * The message is still composed entirely by the service from roster state -- this button chooses
 * words for nobody. What the scope adds is subtraction: `include` picks which of the two gaps to
 * chase and the id list narrows to the rows on screen, and the service re-derives both from the
 * roster, so neither can address somebody it does not already consider owed a reminder. The
 * service also keeps its own cadence, so a second press within the window sends nothing.
 */
export async function remindAdminBotIncompleteProfiles(
  host: AdminBotProfileOverviewHost,
  scope?: { include: "profile" | "timeline" | "both"; memberIds: string[] },
): Promise<void> {
  const wire = session(host);
  if (!wire) {
    host.adminBotProfileOverviewError = t("profileOverview.error.signIn");
    return;
  }
  host.adminBotProfileOverviewReminding = true;
  host.adminBotProfileOverviewError = null;
  host.adminBotProfileOverviewNotice = null;
  try {
    const result = await runMandatoryFieldsReminder(wire.token, wire.baseUrl, scope);
    if (!result.ok) {
      host.adminBotProfileOverviewError = failureText(result, wire.baseUrl);
      return;
    }
    host.adminBotProfileOverviewNotice = result.value.created
      ? t("profileOverview.reminded", { count: String(result.value.created) })
      : t("profileOverview.remindedNone");
    // Re-read so the "last reminded" column reflects what just happened.
    host.adminBotProfileOverviewLoadedAt = null;
  } finally {
    host.adminBotProfileOverviewReminding = false;
  }
}

/**
 * Put the lab's own people on the nudge list, for a lab that has never had one.
 *
 * Shares the reminder's busy flag and notice line: they are the two write buttons on this page and
 * only one of them should ever be in flight, since seeding changes who the reminder would reach.
 */
export async function seedAdminBotNudgeList(host: AdminBotProfileOverviewHost): Promise<void> {
  const wire = session(host);
  if (!wire) {
    host.adminBotProfileOverviewError = t("profileOverview.error.signIn");
    return;
  }
  host.adminBotProfileOverviewReminding = true;
  host.adminBotProfileOverviewError = null;
  host.adminBotProfileOverviewNotice = null;
  try {
    const result = await seedNudgeList(wire.token, wire.baseUrl, false);
    if (!result.ok) {
      host.adminBotProfileOverviewError = failureText(result, wire.baseUrl);
      return;
    }
    host.adminBotProfileOverviewNotice = result.value.added
      ? t("profileOverview.nudgeList.seeded", { count: String(result.value.added) })
      : t("profileOverview.nudgeList.seededNone");
    host.adminBotProfileOverviewLoadedAt = null;
  } finally {
    host.adminBotProfileOverviewReminding = false;
  }
}
