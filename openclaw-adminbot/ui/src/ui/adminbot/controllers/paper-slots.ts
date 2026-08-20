// My Projects & Papers' side of the wire.
//
// Four calls: read what every paper still owes, read one paper's slots when its card opens, write
// a slot, and run the nudge pass now instead of waiting for the cron. The rules -- what a slot is
// called, what shape it accepts, which one gates which step -- are not here: they come from the
// service's own registry, imported by the view.
//
// Slots are loaded per card rather than all at once. Twenty-three rows per paper is a lot to fetch
// for papers nobody has expanded, and a card that is closed shows only the counts, which the
// overview already carries.
import { t } from "../../../i18n/index.ts";
import type { UiSettings } from "../../storage.ts";
import {
  fetchPaperSlotOverview,
  fetchPaperSlots,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
  runPaperSlotReminder,
  savePaperSlot,
  type PaperSlotOverviewRow,
  type PaperSlotRow,
} from "../auth/session.ts";

export type AdminBotPaperSlotsHost = {
  settings: UiSettings;
  adminBotPaperSlotOverview: PaperSlotOverviewRow[];
  /** Slots by paper id, filled in the first time a card is opened. */
  adminBotPaperSlots: Record<string, PaperSlotRow[]>;
  /** Which cards are expanded. Several may be open at once -- papers get compared side by side. */
  adminBotPaperSlotsOpen: string[];
  adminBotPaperSlotsLoading: boolean;
  adminBotPaperSlotsError: string | null;
  adminBotPaperSlotsLoadedAt: number | null;
  adminBotPaperSlotsNudging: boolean;
  adminBotPaperSlotsNotice: string | null;
  /** The paper whose slots are mid-flight, so one card can show a spinner without freezing the rest. */
  adminBotPaperSlotsBusyId: string | null;
};

function failureText(result: { kind: string; message?: string }, baseUrl: string): string {
  if (result.kind === "unreachable") {
    return t("paperSlots.error.unreachable", { url: baseUrl });
  }
  if (result.kind === "forbidden") {
    return t("paperSlots.error.forbidden");
  }
  return result.message ?? t("paperSlots.error.failed");
}

function session(host: AdminBotPaperSlotsHost): { token: string; baseUrl: string } | null {
  const stored = loadStoredMemberSession();
  return stored
    ? {
        token: stored.sessionToken,
        baseUrl: resolveAdminBotBaseUrl(host.settings),
      }
    : null;
}

export async function loadAdminBotPaperSlotOverview(host: AdminBotPaperSlotsHost): Promise<void> {
  const wire = session(host);
  if (!wire) {
    host.adminBotPaperSlotsError = t("paperSlots.error.signIn");
    return;
  }
  host.adminBotPaperSlotsLoading = true;
  host.adminBotPaperSlotsError = null;
  try {
    const result = await fetchPaperSlotOverview(wire.token, wire.baseUrl);
    if (!result.ok) {
      host.adminBotPaperSlotOverview = [];
      host.adminBotPaperSlotsError = failureText(result, wire.baseUrl);
      return;
    }
    host.adminBotPaperSlotOverview = result.value;
  } finally {
    host.adminBotPaperSlotsLoading = false;
  }
}

/**
 * Open or close one card.
 *
 * Opening fetches the slots once and keeps them: closing a card is a display decision, and
 * re-fetching on every toggle would make expanding a paper feel slower the second time than the
 * first.
 */
export async function toggleAdminBotPaperCard(
  host: AdminBotPaperSlotsHost,
  paperId: string,
): Promise<void> {
  const open = host.adminBotPaperSlotsOpen.includes(paperId);
  host.adminBotPaperSlotsOpen = open
    ? host.adminBotPaperSlotsOpen.filter((id) => id !== paperId)
    : [...host.adminBotPaperSlotsOpen, paperId];
  if (open || host.adminBotPaperSlots[paperId]) {
    return;
  }
  await loadAdminBotPaperSlots(host, paperId);
}

export async function loadAdminBotPaperSlots(
  host: AdminBotPaperSlotsHost,
  paperId: string,
): Promise<void> {
  const wire = session(host);
  if (!wire) {
    host.adminBotPaperSlotsError = t("paperSlots.error.signIn");
    return;
  }
  host.adminBotPaperSlotsBusyId = paperId;
  try {
    const result = await fetchPaperSlots(paperId, wire.token, wire.baseUrl);
    if (!result.ok) {
      host.adminBotPaperSlotsError = failureText(result, wire.baseUrl);
      return;
    }
    host.adminBotPaperSlots = {
      ...host.adminBotPaperSlots,
      [paperId]: result.value,
    };
  } finally {
    host.adminBotPaperSlotsBusyId = null;
  }
}

/**
 * Write one slot and take the service's answer as the new truth.
 *
 * The response is what lands in state, not the value that was typed: a link the service judged
 * malformed comes back `invalid` with a reason, and echoing the optimistic version instead would
 * show a green tick on an artifact nobody can open.
 */
export async function saveAdminBotPaperSlot(
  host: AdminBotPaperSlotsHost,
  paperId: string,
  slot: string,
  input: {
    url?: string;
    value_text?: string;
    done?: boolean;
    snoozed_until?: string;
  },
): Promise<void> {
  const wire = session(host);
  if (!wire) {
    host.adminBotPaperSlotsError = t("paperSlots.error.signIn");
    return;
  }
  host.adminBotPaperSlotsError = null;
  const result = await savePaperSlot(paperId, slot, input, wire.token, wire.baseUrl);
  if (!result.ok) {
    host.adminBotPaperSlotsError = failureText(result, wire.baseUrl);
    return;
  }
  const rows = host.adminBotPaperSlots[paperId] ?? [];
  host.adminBotPaperSlots = {
    ...host.adminBotPaperSlots,
    [paperId]: rows.map((row) => (row.slot === slot ? result.value : row)),
  };
  // The header counts and the outstanding list are computed by the service, so a write only
  // reaches them through a re-read.
  host.adminBotPaperSlotsLoadedAt = null;
}

/**
 * The global nudge.
 *
 * It composes nothing and picks nobody: the service walks every live paper, finds the slots whose
 * upstream evidence is already in, and messages whoever the registry says owes each one -- first
 * authors for nearly all of them. The button only says how many papers are outstanding, which is
 * why it can be pressed without writing a message first.
 */
export async function nudgeAdminBotPaperAuthors(host: AdminBotPaperSlotsHost): Promise<void> {
  const wire = session(host);
  if (!wire) {
    host.adminBotPaperSlotsError = t("paperSlots.error.signIn");
    return;
  }
  host.adminBotPaperSlotsNudging = true;
  host.adminBotPaperSlotsError = null;
  host.adminBotPaperSlotsNotice = null;
  try {
    const result = await runPaperSlotReminder(wire.token, wire.baseUrl);
    if (!result.ok) {
      host.adminBotPaperSlotsError = failureText(result, wire.baseUrl);
      return;
    }
    host.adminBotPaperSlotsNotice = result.value.created
      ? t("paperSlots.nudgedCount", { count: String(result.value.created) })
      : t("paperSlots.nudgedNone");
    // Re-read so "last nudged" reflects what just happened.
    host.adminBotPaperSlotsLoadedAt = null;
  } finally {
    host.adminBotPaperSlotsNudging = false;
  }
}
