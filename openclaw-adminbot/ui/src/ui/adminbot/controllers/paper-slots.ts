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
  circulatePaperSocialDraft,
  fetchPaperNudgeBatches,
  fetchPaperSlotOverview,
  fetchPaperSlots,
  loadStoredMemberSession,
  recordPaperSocialConsent,
  resolveAdminBotBaseUrl,
  runPaperSlotReminder,
  savePaperAttendee,
  savePaperReimbursementStatus,
  savePaperSlot,
  savePaperWeeklyUpdate,
  savePaperSocialDraft,
  type PaperCycle,
  type PaperNudgeBatch,
  type PaperSlotOverviewRow,
} from "../auth/session.ts";

export type AdminBotPaperSlotsHost = {
  settings: UiSettings;
  /** The roster, for deciding who may be nudged. See `nudgeableBatches`. */
  adminBotData?: {
    members?: {
      id: string;
      name?: string;
      privilege_level?: string;
      status?: string;
    }[];
    // `| null` because that is what the app view state actually holds: the settings row is read
    // asynchronously and is null until it arrives. Declaring it `undefined`-only made every call
    // site in app-render.ts fail to typecheck against this host -- twelve identical errors for a
    // shape mismatch that has never been a runtime problem, because every reader here already
    // treats a missing row as "no head professor on file".
    settings?: { head_professor_member_id?: string } | null;
  } | null;
  adminBotPaperSlotOverview: PaperSlotOverviewRow[];
  /** The whole cycle by paper id -- slots, drafts, consents, attendees, reimbursements. */
  adminBotPaperSlots: Record<string, PaperCycle>;
  /** Which cards are expanded. Several may be open at once -- papers get compared side by side. */
  adminBotPaperSlotsOpen: string[];
  adminBotPaperSlotsLoading: boolean;
  adminBotPaperSlotsError: string | null;
  adminBotPaperSlotsLoadedAt: number | null;
  adminBotPaperSlotsNudging: boolean;
  adminBotPaperSlotsNotice: string | null;
  /** The preview. Null until an admin asks to see what would go out. */
  adminBotPaperNudgeBatches: PaperNudgeBatch[] | null;
  adminBotPaperNudgeLoading: boolean;
  /** Who is ticked. Everyone deliverable, until the admin unticks somebody. */
  adminBotPaperNudgeSelected: string[];
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

/**
 * The lab's head, who is chased by nobody.
 *
 * Read from settings when they name one. The fallback is here because that setting is not
 * populated on the live service yet and "do not nudge the PI" is not a rule anyone wants to
 * discover by having sent one -- set `head_professor_member_id` in Settings and this constant
 * stops being consulted.
 */
const FALLBACK_HEAD_PROFESSOR_MEMBER_ID = "zhijing-jin";

function headProfessorMemberId(host: AdminBotPaperSlotsHost): string {
  return (
    host.adminBotData?.settings?.head_professor_member_id?.trim() ||
    FALLBACK_HEAD_PROFESSOR_MEMBER_ID
  );
}

/**
 * Who this pass is allowed to message.
 *
 * The service computes batches for whoever owes something; this narrows them to the people the
 * lab actually chases. Trial members, external collaborators, alumni and anyone off the roster
 * are excluded on the same rule `isFullMember` applies server-side -- AdminBot has no standing to
 * chase an outside coauthor -- and the head professor is excluded because the escalation path runs
 * towards them, not at them.
 *
 * Filtered rather than hidden-and-sent: a name that is not on this list never reaches the preview,
 * so what an admin reads before pressing is exactly who gets a message.
 */
export function nudgeableBatches(
  host: AdminBotPaperSlotsHost,
  batches: PaperNudgeBatch[],
): PaperNudgeBatch[] {
  const head = headProfessorMemberId(host);
  const byId = new Map((host.adminBotData?.members ?? []).map((member) => [member.id, member]));
  return batches.filter((batch) => {
    if (batch.member_id === head) {
      return false;
    }
    const member = byId.get(batch.member_id);
    if (!member) {
      return false;
    }
    const full = member.privilege_level === "member" || member.privilege_level === "admin";
    return full && member.status !== "alumni" && member.status !== "external";
  });
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
/**
 * Writes the signed-in member's own line for this week, and folds it into the cached cycle.
 *
 * Local merge rather than a re-read: the log is the one part of the card whose new row the client
 * already has in full, and re-fetching the whole cycle to see a sentence you just typed is a
 * visible pause for no new information.
 */
export async function saveAdminBotPaperWeeklyUpdate(
  host: AdminBotPaperSlotsHost,
  paperId: string,
  body: string,
): Promise<void> {
  const wire = session(host);
  if (!wire) {
    host.adminBotPaperSlotsError = t("paperSlots.error.signIn");
    return;
  }
  host.adminBotPaperSlotsError = null;
  host.adminBotPaperSlotsBusyId = paperId;
  try {
    const result = await savePaperWeeklyUpdate(paperId, body, wire.token, wire.baseUrl);
    if (!result.ok) {
      host.adminBotPaperSlotsError = failureText(result, wire.baseUrl);
      return;
    }
    const cycle = host.adminBotPaperSlots[paperId];
    if (cycle) {
      const saved = result.value.update;
      const others = cycle.weeklyUpdates.filter(
        (update) =>
          !(update.member_id === saved.member_id && update.week_start === saved.week_start),
      );
      host.adminBotPaperSlots = {
        ...host.adminBotPaperSlots,
        [paperId]: { ...cycle, weeklyUpdates: [saved, ...others] },
      };
    }
  } finally {
    host.adminBotPaperSlotsBusyId = null;
  }
}

export async function saveAdminBotPaperSlot(
  host: AdminBotPaperSlotsHost,
  paperId: string,
  slot: string,
  input: { url?: string; value_text?: string; value_note?: string; done?: boolean },
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
  const cycle = host.adminBotPaperSlots[paperId];
  if (cycle) {
    host.adminBotPaperSlots = {
      ...host.adminBotPaperSlots,
      [paperId]: {
        ...cycle,
        slots: cycle.slots.map((row) => (row.slot === slot ? result.value : row)),
      },
    };
  }
  // The header counts and the outstanding list are computed by the service, so a write only
  // reaches them through a re-read.
  host.adminBotPaperSlotsLoadedAt = null;
}

/**
 * Everything that changes a paper's cycle rather than one slot.
 *
 * All five re-read the paper afterwards rather than patching state in place. Each of them moves
 * something the service derives -- a draft approval flips a slot gate, an attendee changes who
 * owes a reimbursement, a reimbursement can close the whole paper -- and guessing at those in the
 * browser is how two sources of truth start.
 */
async function mutateCycle(
  host: AdminBotPaperSlotsHost,
  paperId: string,
  run: (
    token: string,
    baseUrl: string,
  ) => Promise<{ ok: boolean; kind?: string; message?: string }>,
): Promise<void> {
  const wire = session(host);
  if (!wire) {
    host.adminBotPaperSlotsError = t("paperSlots.error.signIn");
    return;
  }
  host.adminBotPaperSlotsError = null;
  host.adminBotPaperSlotsBusyId = paperId;
  try {
    const result = await run(wire.token, wire.baseUrl);
    if (!result.ok) {
      host.adminBotPaperSlotsError = failureText(
        result as { kind: string; message?: string },
        wire.baseUrl,
      );
      return;
    }
  } finally {
    host.adminBotPaperSlotsBusyId = null;
  }
  await loadAdminBotPaperSlots(host, paperId);
  host.adminBotPaperSlotsLoadedAt = null;
}

export function saveAdminBotSocialDraft(
  host: AdminBotPaperSlotsHost,
  paperId: string,
  platform: string,
  body: string,
): Promise<void> {
  return mutateCycle(host, paperId, (token, baseUrl) =>
    savePaperSocialDraft(paperId, { platform, body }, token, baseUrl),
  );
}

export function circulateAdminBotSocialDraft(
  host: AdminBotPaperSlotsHost,
  paperId: string,
  draftId: string,
): Promise<void> {
  return mutateCycle(host, paperId, (token, baseUrl) =>
    circulatePaperSocialDraft(draftId, token, baseUrl),
  );
}

export function recordAdminBotSocialConsent(
  host: AdminBotPaperSlotsHost,
  paperId: string,
  draftId: string,
  decision: string,
  comment?: string,
): Promise<void> {
  return mutateCycle(host, paperId, (token, baseUrl) =>
    recordPaperSocialConsent(
      draftId,
      { decision, ...(comment ? { comment } : {}) },
      token,
      baseUrl,
    ),
  );
}

export function setAdminBotPaperAttendee(
  host: AdminBotPaperSlotsHost,
  paperId: string,
  name: string,
  memberId: string | undefined,
  attending: string,
): Promise<void> {
  return mutateCycle(host, paperId, (token, baseUrl) =>
    savePaperAttendee(
      paperId,
      { name, ...(memberId ? { member_id: memberId } : {}), attending },
      token,
      baseUrl,
    ),
  );
}

export function setAdminBotPaperReimbursement(
  host: AdminBotPaperSlotsHost,
  paperId: string,
  memberId: string,
  status: string,
): Promise<void> {
  return mutateCycle(host, paperId, (token, baseUrl) =>
    savePaperReimbursementStatus(paperId, memberId, status, token, baseUrl),
  );
}

/**
 * The global nudge.
 *
 * It composes nothing and picks nobody: the service walks every live paper, finds the slots whose
 * upstream evidence is already in, and messages whoever the registry says owes each one -- first
 * authors for nearly all of them. The button only says how many papers are outstanding, which is
 * why it can be pressed without writing a message first.
 */
/**
 * Open the preview, or close it.
 *
 * Nothing is sent by opening it. The batches are read fresh every time rather than cached: they
 * move as people fill fields in, and a stale preview would be a list of messages that no longer
 * matches what pressing Send would deliver.
 */
export async function loadAdminBotNudgeBatches(host: AdminBotPaperSlotsHost): Promise<void> {
  if (host.adminBotPaperNudgeBatches) {
    host.adminBotPaperNudgeBatches = null;
    return;
  }
  const wire = session(host);
  if (!wire) {
    host.adminBotPaperSlotsError = t("paperSlots.error.signIn");
    return;
  }
  host.adminBotPaperNudgeLoading = true;
  host.adminBotPaperSlotsError = null;
  host.adminBotPaperSlotsNotice = null;
  try {
    const result = await fetchPaperNudgeBatches(wire.token, wire.baseUrl);
    if (!result.ok) {
      host.adminBotPaperSlotsError = failureText(result, wire.baseUrl);
      return;
    }
    const eligible = nudgeableBatches(host, result.value);
    host.adminBotPaperNudgeBatches = eligible;
    // Everyone who can actually be reached starts ticked: the common case is "send the lot", and
    // somebody with no Slack id would only be an unsendable row to untick later.
    host.adminBotPaperNudgeSelected = eligible
      .filter((batch) => batch.deliverable)
      .map((batch) => batch.member_id);
  } finally {
    host.adminBotPaperNudgeLoading = false;
  }
}

export function toggleAdminBotPaperNudgeRecipient(
  host: AdminBotPaperSlotsHost,
  memberId: string,
): void {
  host.adminBotPaperNudgeSelected = host.adminBotPaperNudgeSelected.includes(memberId)
    ? host.adminBotPaperNudgeSelected.filter((id) => id !== memberId)
    : [...host.adminBotPaperNudgeSelected, memberId];
}

/**
 * Send the ticked batches.
 *
 * Manual by design -- there is no schedule behind this. The selection only ever narrows what the
 * service computes for itself, so a stale preview cannot cause a message that state does not
 * currently justify.
 */
export async function nudgeAdminBotPaperAuthors(host: AdminBotPaperSlotsHost): Promise<void> {
  const wire = session(host);
  if (!wire) {
    host.adminBotPaperSlotsError = t("paperSlots.error.signIn");
    return;
  }
  const recipients = [...host.adminBotPaperNudgeSelected];
  if (recipients.length === 0) {
    return;
  }
  host.adminBotPaperSlotsNudging = true;
  host.adminBotPaperSlotsError = null;
  host.adminBotPaperSlotsNotice = null;
  let created = 0;
  const unreachable: string[] = [];
  try {
    // One request per recipient rather than one for the whole run.
    //
    // The service messages people in a loop and answers when the last one is done, so a full pass
    // holds a single request open for as long as every Slack call takes together. Reached over the
    // public tunnel that is long enough for the edge to give up on it, and the error page it
    // substitutes carries no CORS header -- so the browser discards the response and the page can
    // only say it could not reach AdminBot, whether or not the messages went out. Sending one at a
    // time keeps every request short, and makes a failure name the person it belongs to instead of
    // condemning the batch.
    for (const [index, memberId] of recipients.entries()) {
      host.adminBotPaperSlotsNotice = t("paperSlots.nudgingProgress", {
        done: String(index),
        total: String(recipients.length),
      });
      const result = await runPaperSlotReminder(wire.token, wire.baseUrl, [memberId]);
      if (!result.ok) {
        // Keep going: one unreachable recipient is not a reason to leave the rest unchased, and
        // the ledger is stamped per person, so the ones that landed stay landed.
        unreachable.push(memberId);
        continue;
      }
      created += result.value.created;
    }
    host.adminBotPaperSlotsNotice = created
      ? t("paperSlots.nudgedCount", { count: String(created) })
      : t("paperSlots.nudgedNone");
    if (unreachable.length > 0) {
      host.adminBotPaperSlotsError = t("paperSlots.error.someUnsent", {
        count: String(unreachable.length),
        url: wire.baseUrl,
      });
    }
    // The preview is spent: those people are now inside the cadence window and would not appear
    // in a fresh one. Leaving it on screen would invite a second press that sends nothing.
    host.adminBotPaperNudgeBatches = null;
    host.adminBotPaperNudgeSelected = [];
    // Re-read so "last nudged" reflects what just happened.
    host.adminBotPaperSlotsLoadedAt = null;
  } finally {
    host.adminBotPaperSlotsNudging = false;
  }
}
