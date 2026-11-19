// Poster print batches: who answers, what the printer sees, and the daily sweep that chases both.
//
// The batch itself is derived in workflows/papers/poster-printing.ts; this module reads the records
// it needs, writes the two things people decide (an author's answer, an admin's batch settings),
// and sends Slack DMs. Every DM is a `poster_print.notify` action, auto-approved (see its policy in
// service.ts), so it still goes propose -> policy -> execute -> audit and shows in the action log,
// but nobody has to approve a reminder before its deadline passes. Each one is sent at most once:
// the idempotency key names the stage (reminders) or the exact list (handoffs).
import {
  adminBotIsAlumniMember,
  type AdminBotActionProposal,
  type AdminBotAuditEvent,
  type AdminBotExecutionRequest,
  type AdminBotExecutionResult,
  type AdminBotLabMember,
  type AdminBotPaperRecord,
  type AdminBotStoredProposal,
} from "../contracts/actions.js";
import { resolveAdminBotControlUiUrl } from "../contracts/control-ui.js";
import type { AdminBotPaperSlotInput } from "../contracts/paper-slots.js";
import {
  ADMINBOT_POSTER_PRINT_DEFAULTS_KEY,
  adminBotPosterPrintSizes,
  isAdminBotPosterOrientation,
  isAdminBotPosterPrintChoice,
  isAdminBotPosterPrintSize,
  type AdminBotPosterPrintBatchInput,
  type AdminBotPosterPrintBatchRecord,
  type AdminBotPosterPrintBatchView,
  type AdminBotPosterPrintOverview,
  type AdminBotPosterPrintPaperOptions,
  type AdminBotPosterPrintRequestInput,
  type AdminBotPosterPrintRequestRecord,
} from "../contracts/poster-printing.js";
import type { AdminBotPosterPrintStore } from "../persistence/poster-printing.js";
import type { TravelConferenceSite } from "../workflows/members/lab-travel.js";
import { canonicalConferenceTrips } from "../workflows/papers/conference-attendance.js";
import {
  buildPosterPrintBatches,
  duePosterPrintReminders,
  POSTER_PRINT_HANDOFF_KEY_PREFIX,
  POSTER_PRINT_REMINDER_KEY_PREFIX,
  posterPrintConferenceKey,
  posterPrintHandoff,
  type PosterPrintConferenceSite,
} from "../workflows/papers/poster-printing.js";
import type { AdminBotServiceResponse, AdminBotServiceStore } from "./service.js";

export type PosterPrintHost = {
  store: AdminBotServiceStore;
  createProposal(proposal: AdminBotActionProposal): AdminBotServiceResponse<AdminBotStoredProposal>;
  removePending(id: string, request: { note: string }): unknown;
  execute(
    actionId: string,
    request: AdminBotExecutionRequest,
  ): Promise<AdminBotServiceResponse<AdminBotExecutionResult>>;
  setPaperSlot(params: {
    paperId: string;
    slot: string;
    input: AdminBotPaperSlotInput;
    memberId: string;
    privileged: boolean;
  }): AdminBotServiceResponse<unknown>;
  recordAudit(event: Omit<AdminBotAuditEvent, "id" | "timestamp">): void;
  /** Whether the member is a lab author of the paper (the same rule as editing its slots). */
  ownsPaper(memberId: string, paper: AdminBotPaperRecord): boolean;
  /** Every conference site in the deadline dataset, past ones included. */
  sites(): TravelConferenceSite[];
  now(): Date;
};

export type PosterPrintViewer = { memberId: string; admin: boolean };

export type PosterPrintSweepResult = {
  reminders_sent: number;
  handoffs_sent: number;
  /** Filed but not delivered (the Slack send failed); the next run retries the same message. */
  failed: number;
  /** Undelivered messages from an earlier run that no longer apply. */
  withdrawn: number;
  skipped_unreachable: number;
};

const MAX_COPIES = 5;
const MAX_TEXT = 500;
const SEND = "poster_print.notify" as const;

const ok = <T>(payload: T): AdminBotServiceResponse<T> => ({ ok: true, status: 200, payload });
const fail = (status: number, message: string): AdminBotServiceResponse<never> => ({
  ok: false,
  status,
  error: { message },
});

function memberName(member: AdminBotLabMember): string {
  return member.preferred_name?.trim() || member.name;
}

/** A member AdminBot may DM: Slack linked, not opted out by an admin, not alumni. */
function reachable(member: AdminBotLabMember | undefined): member is AdminBotLabMember & {
  slack_user_id: string;
} {
  return Boolean(
    member?.slack_user_id?.trim() && !member.do_not_contact && !adminBotIsAlumniMember(member),
  );
}

function cleanText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_TEXT) : undefined;
}

function isDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

/** The handoff key is `<prefix><site key>:<digest>`; site keys contain a colon themselves. */
function handoffSiteKey(idempotencyKey: string): string {
  const rest = idempotencyKey.slice(POSTER_PRINT_HANDOFF_KEY_PREFIX.length);
  return rest.slice(0, rest.lastIndexOf(":"));
}

/** The paper's Talk tab, where the print question sits under the Poster rows. */
export function paperPageUrl(paperId: string): string {
  return `${resolveAdminBotControlUiUrl()}/my-work/${encodeURIComponent(paperId)}/talk`;
}

export function posterPrintingPageUrl(): string {
  return `${resolveAdminBotControlUiUrl()}/conference-papers?view=posters`;
}

export class PosterPrintingService {
  constructor(private readonly host: PosterPrintHost) {}

  private get records(): AdminBotPosterPrintStore | undefined {
    return this.host.store.posterPrintStore?.();
  }

  private today(): string {
    return this.host.now().toISOString().slice(0, 10);
  }

  private sites(): PosterPrintConferenceSite[] {
    return this.host.sites().map((site) => ({
      key: site.key,
      group_key: site.group_key,
      label: site.label,
      multi_site: site.multi_site,
      ...(site.starts ? { starts: site.starts } : {}),
      ...(site.location || site.city ? { location: site.location ?? site.city } : {}),
    }));
  }

  /** site key -> when its latest print list was delivered. Pending lists do not count as sent. */
  private handoffs(): Map<string, string> {
    const sent = new Map<string, string>();
    for (const proposal of this.host.store.listProposalsByType(SEND)) {
      const key = proposal.idempotency_key;
      if (proposal.status !== "executed" || !key?.startsWith(POSTER_PRINT_HANDOFF_KEY_PREFIX)) {
        continue;
      }
      const site = handoffSiteKey(key);
      if ((sent.get(site) ?? "") < proposal.updated_at) {
        sent.set(site, proposal.updated_at);
      }
    }
    return sent;
  }

  /** Every batch, unfiltered. Callers decide who sees what. */
  batches(store: AdminBotPosterPrintStore): AdminBotPosterPrintBatchView[] {
    const members = this.host.store.listLabMembers();
    const going = new Map<string, Set<string>>();
    for (const trip of canonicalConferenceTrips(this.host.store.listConferenceTrips())) {
      if (trip.intent === "going") {
        going.set(trip.conference_key, (going.get(trip.conference_key) ?? new Set()).add(trip.member_id));
      }
    }
    const posterSlots = new Map<string, { poster_url?: string; physical?: string }>();
    for (const slot of this.host.store.listPaperSlots()) {
      const entry = posterSlots.get(slot.paper_id) ?? {};
      if (slot.slot === "poster" && slot.url) {
        entry.poster_url = slot.url;
      } else if (slot.slot === "poster_physical" && slot.value_text) {
        entry.physical = slot.value_text;
      }
      posterSlots.set(slot.paper_id, entry);
    }
    return buildPosterPrintBatches({
      papers: this.host.store.listPapers(),
      batches: store.listBatches(),
      requests: store.listRequests(),
      sites: this.sites(),
      posterSlots,
      members: new Map(members.map((member) => [member.id, { name: memberName(member) }])),
      going,
      handoffs: this.handoffs(),
      today: this.today(),
    });
  }

  /**
   * Admins see every batch and the settings. The printer sees the batches they print in full. Any
   * other member sees only their own papers, inside the batch those papers belong to -- enough to
   * know the deadline and what they still owe, without a list of everyone else's titles.
   */
  overview(viewer: PosterPrintViewer): AdminBotServiceResponse<AdminBotPosterPrintOverview> {
    const store = this.records;
    if (!store) {
      return fail(501, "poster printing is not available on this store");
    }
    const all = this.batches(store);
    if (viewer.admin) {
      const printer_candidates = this.host.store
        .listLabMembers()
        .filter((member) => !adminBotIsAlumniMember(member))
        .map((member) => ({ member_id: member.id, name: memberName(member) }))
        .toSorted((a, b) => a.name.localeCompare(b.name));
      return ok({
        batches: all,
        settings: store.listBatches(),
        printer_candidates,
        can_manage: true,
        printable: all.map((view) => view.conference_key),
      });
    }
    const papers = new Map(this.host.store.listPapers().map((paper) => [paper.id, paper]));
    const batches: AdminBotPosterPrintBatchView[] = [];
    const printable: string[] = [];
    for (const view of all) {
      if (view.printer?.member_id === viewer.memberId) {
        batches.push(view);
        printable.push(view.conference_key);
        continue;
      }
      const mine = view.papers.filter((entry) => {
        const paper = papers.get(entry.paper_id);
        return paper ? this.host.ownsPaper(viewer.memberId, paper) : false;
      });
      if (mine.length) {
        batches.push({ ...view, papers: mine });
      }
    }
    return ok({ batches, can_manage: false, printable });
  }

  /**
   * The paper page's section. A `null` payload (sent as JSON `null`, so the page can tell "nothing
   * to print" from a failed read) when the paper owes no poster at an upcoming conference.
   */
  paperOptions(
    paperId: string,
    viewer: PosterPrintViewer,
  ): AdminBotServiceResponse<AdminBotPosterPrintPaperOptions | null> {
    const store = this.records;
    if (!store) {
      return fail(501, "poster printing is not available on this store");
    }
    const paper = this.host.store.getPaper(paperId);
    if (!paper) {
      return fail(404, "paper not found");
    }
    if (!viewer.admin && !this.host.ownsPaper(viewer.memberId, paper)) {
      return fail(403, "only the paper's authors can see its poster printing");
    }
    const group = posterPrintConferenceKey(paper);
    if (!group) {
      return ok(null);
    }
    const views = this.batches(store).filter((view) => view.group_key === group);
    const placed = views.find((view) =>
      view.papers.some((entry) => entry.paper_id === paperId && entry.site_source !== "unknown"),
    );
    const view = placed ?? views[0];
    const entry = view?.papers.find((candidate) => candidate.paper_id === paperId);
    if (!view || !entry) {
      return ok(null);
    }
    return ok({
      paper_id: paperId,
      conference_key: group,
      conference_label: view.multi_site ? view.label.split(" — ")[0]! : view.label,
      sites: views.map((site) => ({
        key: site.conference_key,
        label: site.label,
        ...(site.conference_starts ? { starts: site.conference_starts } : {}),
      })),
      ...(placed ? { site_key: placed.conference_key } : {}),
      ...(entry.request ? { request: entry.request } : {}),
      state: entry.state,
      // A paper not placed yet has no single deadline; the earliest is the honest one to show.
      ...(view.deadline_on ? { deadline_on: view.deadline_on } : {}),
      ...(view.printer ? { printer_name: view.printer.name } : {}),
      ...(view.print_location ? { print_location: view.print_location } : {}),
      ...(view.notes ? { notes: view.notes } : {}),
      status: view.status,
    });
  }

  /**
   * An author's answer. Validated whole before anything is written, then mirrored onto the paper's
   * `poster_physical` slot so the checklist and the batch never disagree: `lab_print` is
   * "to print", `no_poster` is "not needed". `self_print` leaves the slot alone -- where the poster
   * ends up is the author's to record.
   */
  setRequest(
    paperId: string,
    input: AdminBotPosterPrintRequestInput,
    viewer: PosterPrintViewer,
  ): AdminBotServiceResponse<AdminBotPosterPrintPaperOptions | null> {
    const store = this.records;
    if (!store) {
      return fail(501, "poster printing is not available on this store");
    }
    const paper = this.host.store.getPaper(paperId);
    if (!paper) {
      return fail(404, "paper not found");
    }
    if (!viewer.admin && !this.host.ownsPaper(viewer.memberId, paper)) {
      return fail(403, "only the paper's authors can answer for its poster");
    }
    const group = posterPrintConferenceKey(paper);
    if (!group) {
      return fail(409, "the paper is not accepted at a conference, so there is no poster to print");
    }
    if (!isAdminBotPosterPrintChoice(input?.choice)) {
      return fail(400, "choice must be lab_print, self_print or no_poster");
    }
    const record: AdminBotPosterPrintRequestRecord = {
      conference_key: group,
      paper_id: paperId,
      choice: input.choice,
      updated_at: this.host.now().toISOString(),
      updated_by: viewer.memberId,
    };
    const sites = this.sites().filter((site) => site.group_key === group);
    if (input.site_key !== undefined && input.site_key !== "") {
      if (!sites.some((site) => site.key === input.site_key)) {
        return fail(400, "site_key is not one of this conference's cities");
      }
      record.site_key = input.site_key;
    }
    if (input.choice === "lab_print") {
      if (sites.length > 1 && !record.site_key) {
        return fail(400, "this conference runs in more than one city; say which one you present in");
      }
      if (input.size !== undefined && !isAdminBotPosterPrintSize(input.size)) {
        return fail(400, `size must be one of ${adminBotPosterPrintSizes.join(", ")}`);
      }
      if (input.size === "custom" && !cleanText(input.custom_size)) {
        return fail(400, "a custom size needs its dimensions, e.g. 36x48 in");
      }
      if (input.orientation !== undefined && !isAdminBotPosterOrientation(input.orientation)) {
        return fail(400, "orientation must be portrait or landscape");
      }
      if (
        input.copies !== undefined &&
        (!Number.isInteger(input.copies) || input.copies < 1 || input.copies > MAX_COPIES)
      ) {
        return fail(400, `copies must be a whole number from 1 to ${MAX_COPIES}`);
      }
      record.size = input.size ?? "A0";
      if (record.size === "custom") {
        record.custom_size = cleanText(input.custom_size);
      }
      record.orientation = input.orientation ?? "portrait";
      record.copies = input.copies ?? 1;
    }
    const notes = cleanText(input.notes);
    if (notes) {
      record.notes = notes;
    }
    const physical =
      input.choice === "lab_print" ? "to_print" : input.choice === "no_poster" ? "not_needed" : undefined;
    if (physical) {
      const mirrored = this.host.setPaperSlot({
        paperId,
        slot: "poster_physical",
        input: { value_text: physical },
        memberId: viewer.memberId,
        privileged: viewer.admin,
      });
      if (!mirrored.ok) {
        return mirrored;
      }
    }
    store.saveRequest(record);
    this.host.recordAudit({
      type: "poster_print.request_saved",
      actor: viewer.memberId,
      details: { paper_id: paperId, conference_key: group, choice: record.choice, site_key: record.site_key },
    });
    return this.paperOptions(paperId, viewer);
  }

  /** Admin only (the route enforces it). `key` is a site key or "default". */
  saveBatch(
    key: string,
    input: AdminBotPosterPrintBatchInput,
    actor: string,
  ): AdminBotServiceResponse<AdminBotPosterPrintBatchRecord> {
    const store = this.records;
    if (!store) {
      return fail(501, "poster printing is not available on this store");
    }
    const conferenceKey = key.trim();
    if (!conferenceKey) {
      return fail(400, "a conference key is required");
    }
    // A row under a key no batch reads would save without error and change nothing.
    if (
      conferenceKey !== ADMINBOT_POSTER_PRINT_DEFAULTS_KEY &&
      !this.sites().some((site) => site.key === conferenceKey)
    ) {
      return fail(404, `no conference site ${conferenceKey}`);
    }
    const record: AdminBotPosterPrintBatchRecord = {
      conference_key: conferenceKey,
      updated_at: this.host.now().toISOString(),
      updated_by: actor,
    };
    if (input.printer_member_id) {
      const printer = this.host.store.getLabMember(input.printer_member_id);
      if (!printer || adminBotIsAlumniMember(printer)) {
        return fail(400, "the printer must be a current lab member");
      }
      record.printer_member_id = printer.id;
    }
    if (input.deadline_on) {
      if (conferenceKey === ADMINBOT_POSTER_PRINT_DEFAULTS_KEY) {
        return fail(400, "a fixed deadline belongs to one conference; set lead days on the defaults");
      }
      if (!isDay(input.deadline_on)) {
        return fail(400, "deadline_on must be a date, YYYY-MM-DD");
      }
      record.deadline_on = input.deadline_on;
    }
    if (input.lead_days !== undefined && input.lead_days !== null) {
      if (!Number.isInteger(input.lead_days) || input.lead_days < 0 || input.lead_days > 120) {
        return fail(400, "lead_days must be a whole number from 0 to 120");
      }
      record.lead_days = input.lead_days;
    }
    const location = cleanText(input.print_location);
    if (location) {
      record.print_location = location;
    }
    const notes = cleanText(input.notes);
    if (notes) {
      record.notes = notes;
    }
    store.saveBatch(record);
    this.host.recordAudit({
      type: "poster_print.batch_saved",
      actor,
      details: {
        conference_key: conferenceKey,
        printer_member_id: record.printer_member_id,
        deadline_on: record.deadline_on,
        lead_days: record.lead_days,
      },
    });
    return ok(record);
  }

  /**
   * The printer (or an admin) saying the batch is printed: every poster on the list moves its
   * `poster_physical` slot to "printed", which is what the paper card and the author read.
   */
  markPrinted(
    siteKey: string,
    viewer: PosterPrintViewer,
  ): AdminBotServiceResponse<{ printed: string[] }> {
    const store = this.records;
    if (!store) {
      return fail(501, "poster printing is not available on this store");
    }
    const view = this.batches(store).find((candidate) => candidate.conference_key === siteKey);
    if (!view) {
      return fail(404, "no upcoming poster batch for that conference");
    }
    if (!viewer.admin && view.printer?.member_id !== viewer.memberId) {
      return fail(403, "only the batch's printer or an admin can mark it printed");
    }
    const printed: string[] = [];
    for (const paper of view.papers) {
      if (paper.state !== "ready" || paper.site_source === "unknown") {
        continue;
      }
      // Privileged: the printer is not an author, and this is the printer's fact to record.
      const result = this.host.setPaperSlot({
        paperId: paper.paper_id,
        slot: "poster_physical",
        input: { value_text: "printed" },
        memberId: viewer.memberId,
        privileged: true,
      });
      if (result.ok) {
        printed.push(paper.paper_id);
      }
    }
    this.host.recordAudit({
      type: "poster_print.printed",
      actor: viewer.memberId,
      details: { conference_key: siteKey, paper_ids: printed },
    });
    return ok({ printed });
  }

  /**
   * The daily run. Sends the reminders due today and the print list for every batch at its
   * deadline, each one straight away. A message is settled once it was delivered (or an admin
   * removed it from the log); one that failed to send is retried next run, or withdrawn if the
   * author has answered since or the list changed.
   */
  async sweep(): Promise<AdminBotServiceResponse<PosterPrintSweepResult>> {
    const store = this.records;
    if (!store) {
      return fail(501, "poster printing is not available on this store");
    }
    const result: PosterPrintSweepResult = {
      reminders_sent: 0,
      handoffs_sent: 0,
      failed: 0,
      withdrawn: 0,
      skipped_unreachable: 0,
    };
    const views = this.batches(store);
    const history = this.host.store.listProposalsByType(SEND);
    const latest = (key: string) => history.findLast((proposal) => proposal.idempotency_key === key);
    const wanted = new Set<string>();
    const undelivered = (proposal: AdminBotStoredProposal) =>
      proposal.status === "pending" || proposal.status === "approved";

    /** True when this run delivered it; false when it was already settled or the send failed. */
    const send = async (params: {
      member: AdminBotLabMember & { slack_user_id: string };
      text: string;
      key: string;
      summary: string;
      rationale: string;
    }): Promise<boolean> => {
      wanted.add(params.key);
      const previous = latest(params.key);
      if (previous && !undelivered(previous)) {
        return false;
      }
      const target = `user:${params.member.slack_user_id}`;
      const payload = { tool: "message", action: "send", channel: "slack", target, message: params.text };
      let actionId =
        previous && JSON.stringify(previous.proposed_payload) === JSON.stringify(payload)
          ? previous.id
          : undefined;
      if (previous && !actionId) {
        this.host.removePending(previous.id, { note: "Poster print message text changed." });
      }
      if (!actionId) {
        const created = this.host.createProposal({
          type: SEND,
          risk_tier: "T1",
          summary: params.summary,
          target: {
            service: "slack",
            channel: "slack",
            target,
            recipientName: memberName(params.member),
            recipientMemberId: params.member.id,
          },
          proposed_payload: payload,
          rationale: params.rationale,
          undo_plan: "A Slack DM cannot be unsent by AdminBot; send a follow-up correction in Slack.",
          idempotency_key: params.key,
        });
        if (!created.ok) {
          result.failed += 1;
          return false;
        }
        actionId = created.payload.id;
      }
      try {
        const executed = await this.host.execute(actionId, {
          dry_run: false,
          idempotency_key: params.key,
        });
        if (executed.ok && executed.payload.status === "executed") {
          return true;
        }
      } catch {
        // Recorded by execute's own audit; the proposal stays approved and the next run retries.
      }
      result.failed += 1;
      return false;
    };

    for (const reminder of duePosterPrintReminders(views, paperPageUrl)) {
      const member = this.host.store.getLabMember(reminder.member_id);
      if (!reachable(member)) {
        result.skipped_unreachable += 1;
        continue;
      }
      const title =
        views.flatMap((view) => view.papers).find((paper) => paper.paper_id === reminder.paper_id)
          ?.title ?? reminder.paper_id;
      if (
        await send({
          member,
          text: reminder.text,
          key: reminder.idempotency_key,
          summary: `Poster print reminder (${reminder.stage}) to ${memberName(member)}: ${title}`,
          rationale: `The poster print deadline is ${reminder.deadline_on}; this paper has not answered or has no poster file linked.`,
        })
      ) {
        result.reminders_sent += 1;
      }
    }

    for (const view of views) {
      const handoff = posterPrintHandoff(view, posterPrintingPageUrl());
      if (!handoff) {
        continue;
      }
      const printer = this.host.store.getLabMember(view.printer!.member_id);
      if (!reachable(printer)) {
        result.skipped_unreachable += 1;
        continue;
      }
      if (
        await send({
          member: printer,
          text: handoff.text,
          key: handoff.idempotency_key,
          summary: `Poster print list for ${view.label} to ${memberName(printer)} (${handoff.paper_ids.length})`,
          rationale: `The ${view.label} poster deadline (${view.deadline_on}) has arrived.`,
        })
      ) {
        result.handoffs_sent += 1;
      }
    }

    // An earlier failed send that today's run did not ask for again is out of date.
    for (const proposal of history) {
      const key = proposal.idempotency_key;
      if (
        undelivered(proposal) &&
        key &&
        (key.startsWith(POSTER_PRINT_REMINDER_KEY_PREFIX) ||
          key.startsWith(POSTER_PRINT_HANDOFF_KEY_PREFIX)) &&
        !wanted.has(key)
      ) {
        this.host.removePending(proposal.id, { note: "No longer needed: answered, superseded or past." });
        result.withdrawn += 1;
      }
    }
    return ok(result);
  }
}
