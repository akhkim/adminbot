/**
 * In-memory service store.
 *
 * The reference implementation of AdminBotServiceStore, used by tests and by any run without a
 * SQLite path. The persistent implementation lives in store/sqlite.ts; both satisfy the same
 * interface, so the service never knows which one it has.
 */
import { cvEntryKey } from "../contracts/actions.js";
import type {
  AdminBotAccountRegistration,
  AdminBotAuditEvent,
  AdminBotAuthSession,
  AdminBotCvChangeEvent,
  AdminBotVenueIndexStatus,
  AdminBotVenuePaper,
  AdminBotExecutionResult,
  AdminBotLabMember,
  AdminBotLogisticsRequest,
  AdminBotMemberCredential,
  AdminBotOpenReviewCycleRecord,
  AdminBotOpenReviewMilestoneRecord,
  AdminBotMeetingRecord,
  AdminBotMemberNotification,
  AdminBotMemberLocationEntry,
  AdminBotPaperRecord,
  AdminBotPasswordReset,
  AdminBotRegistrationStatus,
  AdminBotSettings,
} from "../contracts/actions.js";
import type { AdminBotStoredProposal } from "../contracts/actions.js";
import type { AdminBotLoginEvent, AdminBotUpdateEvent } from "../contracts/activity-log.js";
import type {
  AdminBotBadgeAssignment,
  AdminBotBadgeDefinition,
  AdminBotBadgeNomination,
  AdminBotBadgeNominationStatus,
} from "../contracts/badges.js";
import type { PublishedDeadlineRecord } from "../contracts/deadline-proposals.js";
import type { AdminBotFeedbackEntry } from "../contracts/feedback.js";
import type { AdminBotOpportunity, AdminBotOpportunityStatus } from "../contracts/opportunities.js";
import type {
  AdminBotConferenceAttendeeRecord,
  AdminBotNudgeLedgerRecord,
  AdminBotPaperReimbursementRecord,
  AdminBotSocialConsentRecord,
  AdminBotSocialDraftRecord,
  AdminBotWorkshopMatchRun,
} from "../contracts/paper-cycle.js";
import type { AdminBotPaperSlotRecord } from "../contracts/paper-slots.js";
import type { AdminBotPaperWeeklyUpdate } from "../contracts/paper-weekly-updates.js";
import type { AdminBotPaperflowEvidenceRecord } from "../contracts/paperflow-stages.js";
import type {
  AdminBotServiceStore,
  AdminBotSlackChannelNamingRecord,
  AdminBotSlackConnectInvite,
} from "../kernel/service.js";

/** Addresses are matched case-insensitively, as they are in the SQLite store. */
function slackConnectInviteKey(email: string, channelId: string): string {
  return `${email.trim().toLowerCase()}\u0000${channelId}`;
}

export class AdminBotMemoryStore implements AdminBotServiceStore {
  private readonly proposals = new Map<string, AdminBotStoredProposal>();
  private readonly deadlineSubmissionActions = new Map<string, string>();
  private readonly publishedDeadlines = new Map<string, PublishedDeadlineRecord>();
  private readonly executionResults = new Map<string, AdminBotExecutionResult>();
  private readonly executionResultsByIdempotencyKey = new Map<string, AdminBotExecutionResult>();
  private readonly executionClaims = new Map<string, string>();
  private readonly labMembers = new Map<string, AdminBotLabMember>();
  private readonly badgeDefinitions = new Map<string, AdminBotBadgeDefinition>();
  private readonly badgeAssignments = new Map<string, AdminBotBadgeAssignment>();
  private readonly badgeNominations = new Map<string, AdminBotBadgeNomination>();
  private readonly opportunities = new Map<string, AdminBotOpportunity>();
  private readonly papers = new Map<string, AdminBotPaperRecord>();
  // Keyed `paperId\u0000slot`, matching the SQLite composite primary key so both stores collapse a
  // re-save onto the same row.
  private readonly paperSlots = new Map<string, AdminBotPaperSlotRecord>();
  // Keyed `paperId\u0000stage`, matching the SQLite composite primary key.
  private readonly paperflowEvidence = new Map<string, AdminBotPaperflowEvidenceRecord>();
  // Keyed exactly as their SQLite primary keys are, so a re-save collapses onto the same row in
  // both stores rather than accumulating duplicates in one of them.
  private readonly nudgeLedger = new Map<string, AdminBotNudgeLedgerRecord>();
  private readonly socialDrafts = new Map<string, AdminBotSocialDraftRecord>();
  private readonly socialConsents = new Map<string, AdminBotSocialConsentRecord>();
  private readonly conferenceAttendees = new Map<string, AdminBotConferenceAttendeeRecord>();
  private readonly paperReimbursements = new Map<string, AdminBotPaperReimbursementRecord>();
  private readonly meetings = new Map<string, AdminBotMeetingRecord>();
  private readonly memberNotifications = new Map<string, AdminBotMemberNotification>();
  // Keyed by member + entry, matching the SQLite primary key, so both stores dedupe identically.
  private readonly cvChanges = new Map<string, AdminBotCvChangeEvent>();
  private readonly logisticsRequests = new Map<string, AdminBotLogisticsRequest>();
  // Append-only, in insertion order. The sqlite store sorts on read; this one relies on the array
  // order being the insertion order, which is the same thing for a store that never updates a row.
  private readonly memberLocations: AdminBotMemberLocationEntry[] = [];
  // Append-only, like their SQLite tables: nothing in normal operation updates or removes an
  // event, so a plain array is the whole implementation.
  private readonly workshopMatchRuns = new Map<string, AdminBotWorkshopMatchRun>();
  private readonly loginEvents: AdminBotLoginEvent[] = [];
  private readonly updateEvents: AdminBotUpdateEvent[] = [];
  private readonly openReviewCycles = new Map<string, AdminBotOpenReviewCycleRecord>();
  private readonly openReviewMilestones = new Map<string, AdminBotOpenReviewMilestoneRecord>();
  private settings: AdminBotSettings | undefined;
  private readonly auditEvents: AdminBotAuditEvent[] = [];
  private readonly credentialsByMemberId = new Map<string, AdminBotMemberCredential>();
  private readonly credentialsByEmail = new Map<string, AdminBotMemberCredential>();
  private readonly registrations = new Map<string, AdminBotAccountRegistration>();
  private readonly sessions = new Map<string, AdminBotAuthSession>();
  private readonly passwordResets = new Map<string, AdminBotPasswordReset>();
  private readonly slackChannelNaming = new Map<string, AdminBotSlackChannelNamingRecord>();
  private readonly slackConnectInvites = new Map<string, AdminBotSlackConnectInvite>();
  // Keyed by adminBotFeedbackId, matching the SQLite primary key, so a re-rating collapses onto
  // the same row in both stores.
  private readonly feedback = new Map<string, AdminBotFeedbackEntry>();
  // Keyed `paperId\u0000memberId\u0000weekStart`, matching the SQLite composite primary key.
  private readonly paperWeeklyUpdates = new Map<string, AdminBotPaperWeeklyUpdate>();

  saveProposal(proposal: AdminBotStoredProposal): void {
    this.proposals.set(proposal.id, proposal);
  }

  getProposal(actionId: string): AdminBotStoredProposal | undefined {
    return this.proposals.get(actionId);
  }

  updateProposal(proposal: AdminBotStoredProposal): void {
    this.proposals.set(proposal.id, proposal);
  }

  listPending(limit?: number): AdminBotStoredProposal[] {
    const max = Number.isFinite(limit) && typeof limit === "number" ? limit : this.proposals.size;
    return [...this.proposals.values()].filter((entry) => entry.status === "pending").slice(0, max);
  }

  listProposalsByType(type: AdminBotStoredProposal["type"]): AdminBotStoredProposal[] {
    return [...this.proposals.values()].filter((proposal) => proposal.type === type);
  }

  saveDeadlineProposalSubmission(
    proposal: AdminBotStoredProposal,
    submitterMemberId: string,
    idempotencyKey: string,
  ): { proposal: AdminBotStoredProposal; created: boolean } {
    const key = `${submitterMemberId}\u0000${idempotencyKey}`;
    const existingId = this.deadlineSubmissionActions.get(key);
    const existing = existingId ? this.proposals.get(existingId) : undefined;
    if (existing) {
      return { proposal: existing, created: false };
    }
    this.proposals.set(proposal.id, proposal);
    this.deadlineSubmissionActions.set(key, proposal.id);
    return { proposal, created: true };
  }

  replaceDeadlineProposalRevision(
    previous: AdminBotStoredProposal,
    next: AdminBotStoredProposal,
  ): void {
    this.proposals.set(previous.id, previous);
    this.proposals.set(next.id, next);
  }

  savePublishedDeadline(record: PublishedDeadlineRecord): void {
    this.publishedDeadlines.set(record.action_id, record);
  }

  listPublishedDeadlines(): PublishedDeadlineRecord[] {
    return [...this.publishedDeadlines.values()].toSorted((left, right) =>
      left.published_at.localeCompare(right.published_at),
    );
  }

  saveExecutionResult(result: AdminBotExecutionResult): void {
    this.executionResults.set(result.action_id, result);
    if (result.idempotency_key) {
      this.executionResultsByIdempotencyKey.set(result.idempotency_key, result);
    }
  }

  getExecutionResult(actionId: string): AdminBotExecutionResult | undefined {
    return this.executionResults.get(actionId);
  }

  getExecutionResultByIdempotencyKey(idempotencyKey: string): AdminBotExecutionResult | undefined {
    return this.executionResultsByIdempotencyKey.get(idempotencyKey);
  }

  claimExecution(effectKey: string, actionId: string): boolean {
    if (this.executionClaims.has(effectKey)) {
      return false;
    }
    this.executionClaims.set(effectKey, actionId);
    return true;
  }

  releaseExecutionClaim(effectKey: string, actionId: string): void {
    if (this.executionClaims.get(effectKey) === actionId) {
      this.executionClaims.delete(effectKey);
    }
  }

  saveLabMember(member: AdminBotLabMember): void {
    this.labMembers.set(member.id, member);
  }

  getLabMember(memberId: string): AdminBotLabMember | undefined {
    return this.labMembers.get(memberId);
  }

  listLabMembers(): AdminBotLabMember[] {
    return [...this.labMembers.values()].toSorted((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  saveBadgeDefinition(badge: AdminBotBadgeDefinition): void {
    this.badgeDefinitions.set(badge.id, badge);
  }

  getBadgeDefinition(badgeId: string): AdminBotBadgeDefinition | undefined {
    return this.badgeDefinitions.get(badgeId);
  }

  listBadgeDefinitions(): AdminBotBadgeDefinition[] {
    return [...this.badgeDefinitions.values()].toSorted(
      (left, right) =>
        left.sort_order - right.sort_order ||
        left.category.localeCompare(right.category) ||
        left.name.localeCompare(right.name) ||
        (left.tier ?? "").localeCompare(right.tier ?? ""),
    );
  }

  saveBadgeAssignment(assignment: AdminBotBadgeAssignment): void {
    for (const [key, existing] of [...this.badgeAssignments]) {
      if (
        existing.member_id === assignment.member_id &&
        existing.family_key === assignment.family_key &&
        key !== badgeAssignmentKey(assignment.member_id, assignment.badge_id)
      ) {
        this.badgeAssignments.delete(key);
      }
    }
    this.badgeAssignments.set(
      badgeAssignmentKey(assignment.member_id, assignment.badge_id),
      assignment,
    );
  }

  getBadgeAssignment(memberId: string, familyKey: string): AdminBotBadgeAssignment | undefined {
    return [...this.badgeAssignments.values()].find(
      (assignment) => assignment.member_id === memberId && assignment.family_key === familyKey,
    );
  }

  listBadgeAssignments(memberId?: string): AdminBotBadgeAssignment[] {
    return [...this.badgeAssignments.values()]
      .filter((assignment) => !memberId || assignment.member_id === memberId)
      .toSorted((left, right) => left.awarded_at.localeCompare(right.awarded_at));
  }

  deleteBadgeAssignment(memberId: string, badgeId: string): boolean {
    return this.badgeAssignments.delete(badgeAssignmentKey(memberId, badgeId));
  }

  saveBadgeNomination(nomination: AdminBotBadgeNomination): void {
    this.badgeNominations.set(nomination.id, nomination);
  }

  getBadgeNomination(nominationId: string): AdminBotBadgeNomination | undefined {
    return this.badgeNominations.get(nominationId);
  }

  listBadgeNominations(params?: {
    memberId?: string;
    status?: AdminBotBadgeNominationStatus;
  }): AdminBotBadgeNomination[] {
    return [...this.badgeNominations.values()]
      .filter(
        (nomination) =>
          (!params?.memberId || nomination.member_id === params.memberId) &&
          (!params?.status || nomination.status === params.status),
      )
      .toSorted((left, right) => right.created_at.localeCompare(left.created_at));
  }

  saveOpportunity(opportunity: AdminBotOpportunity): void {
    this.opportunities.set(opportunity.id, opportunity);
  }

  getOpportunity(opportunityId: string): AdminBotOpportunity | undefined {
    return this.opportunities.get(opportunityId);
  }

  listOpportunities(params?: {
    memberId?: string;
    status?: AdminBotOpportunityStatus;
  }): AdminBotOpportunity[] {
    return [...this.opportunities.values()]
      .filter(
        (opportunity) =>
          (!params?.memberId || opportunity.submitted_by_member_id === params.memberId) &&
          (!params?.status || opportunity.status === params.status),
      )
      .toSorted((left, right) => right.created_at.localeCompare(left.created_at));
  }

  deleteOpportunity(opportunityId: string): boolean {
    return this.opportunities.delete(opportunityId);
  }

  deleteLabMember(memberId: string): boolean {
    return this.labMembers.delete(memberId);
  }

  /**
   * The in-memory mirror of the SQLite purge.
   *
   * Same list as the store's `MEMBER_OWNED_COLUMNS`: everything a merge would repoint, plus the
   * rows a merge deliberately keeps because a survivor inherits them and a delete has nobody to.
   * Sessions stay out here too -- the service revokes them before calling this.
   */
  purgeMemberReferences(memberId: string): Record<string, number> {
    const removed: Record<string, number> = {};
    const drop = (label: string, count: number) => {
      if (count > 0) {
        removed[label] = (removed[label] ?? 0) + count;
      }
    };
    const purgeMap = <T extends { member_id?: string }>(map: Map<string, T>, label: string) => {
      let count = 0;
      for (const [key, record] of [...map]) {
        if (record.member_id === memberId) {
          map.delete(key);
          count += 1;
        }
      }
      drop(label, count);
    };
    const purgeList = <T>(list: T[], label: string, owned: (entry: T) => boolean) => {
      let count = 0;
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const entry = list[index];
        if (entry !== undefined && owned(entry)) {
          list.splice(index, 1);
          count += 1;
        }
      }
      drop(label, count);
    };

    purgeMap(this.cvChanges, "cv_changes");
    purgeMap(this.logisticsRequests, "logistics_requests");
    purgeMap(this.nudgeLedger, "nudge_ledger");
    purgeMap(this.socialConsents, "social_draft_consents");
    purgeMap(this.conferenceAttendees, "conference_attendees");
    purgeMap(this.paperReimbursements, "paper_reimbursements");
    purgeMap(this.badgeAssignments, "badge_assignments");
    purgeMap(this.badgeNominations, "badge_nominations");
    {
      let dropped = 0;
      for (const [key, opportunity] of [...this.opportunities]) {
        if (opportunity.submitted_by_member_id !== memberId) {
          continue;
        }
        // An approved entry is on the board for the whole lab and is not this member's to take
        // with them; it keeps its row and loses only the name attached to it. Anything never
        // published goes with them.
        if (opportunity.status === "approved") {
          const { submitted_by_member_id: _purged, ...rest } = opportunity;
          this.opportunities.set(key, rest);
          continue;
        }
        this.opportunities.delete(key);
        dropped += 1;
      }
      drop("opportunities", dropped);
    }
    purgeMap(this.registrations, "account_registrations");
    purgeMap(this.passwordResets, "password_resets");
    // The rows a merge keeps and a delete cannot.
    purgeMap(this.memberNotifications, "member_notifications");
    purgeMap(this.feedback, "feedback");
    purgeMap(this.paperWeeklyUpdates, "paper_weekly_updates");

    for (const [credentialMemberId, credential] of [...this.credentialsByMemberId]) {
      if (credentialMemberId !== memberId) {
        continue;
      }
      this.credentialsByMemberId.delete(credentialMemberId);
      this.credentialsByEmail.delete(credential.email);
      drop("member_credentials", 1);
    }
    purgeList(this.memberLocations, "member_locations", (entry) => entry.member_id === memberId);
    purgeList(this.loginEvents, "login_events", (entry) => entry.member_id === memberId);
    // Either column makes the row this member's, unlike the merge, which repoints them
    // independently: there is no survivor to attribute the other half to.
    purgeList(
      this.updateEvents,
      "update_events",
      (entry) => entry.member_id === memberId || entry.subject_member_id === memberId,
    );
    for (const [key, draft] of [...this.socialDrafts]) {
      if (draft.generated_by_member_id === memberId) {
        this.socialDrafts.set(key, {
          ...draft,
          generated_by_member_id: undefined,
        });
        drop("social_drafts.generated_by", 1);
      }
    }
    for (const [key, slot] of [...this.paperSlots]) {
      let updated = slot;
      if (slot.provided_by_member_id === memberId) {
        updated = { ...updated, provided_by_member_id: undefined };
        drop("paper_slots.provided_by", 1);
      }
      if (slot.waived_by_member_id === memberId) {
        updated = { ...updated, waived_by_member_id: undefined };
        drop("paper_slots.waived_by", 1);
      }
      if (updated !== slot) {
        this.paperSlots.set(key, updated);
      }
    }
    for (const [key, submitter] of [...this.deadlineSubmissionActions]) {
      if (submitter === memberId) {
        this.deadlineSubmissionActions.delete(key);
        drop("deadline_submission_keys", 1);
      }
    }
    return removed;
  }

  /**
   * The in-memory mirror of the SQLite sweep.
   *
   * Every map here is keyed by something that includes the subject rather than the member, so a
   * repoint is a rewrite of the value and, where the key itself names the member, a re-key. The
   * collision rule matches SQLite's `UPDATE OR IGNORE` + delete: if the survivor already has a row
   * for the same subject, theirs stands and the duplicate's is dropped.
   */
  reassignMemberReferences(fromMemberId: string, toMemberId: string): Record<string, number> {
    const moved: Record<string, number> = {};
    const bump = (label: string) => {
      moved[label] = (moved[label] ?? 0) + 1;
    };
    const remap = <T extends { member_id?: string }>(
      map: Map<string, T>,
      label: string,
      rekey: (key: string, record: T) => string,
    ) => {
      for (const [key, record] of [...map]) {
        if (record.member_id !== fromMemberId) {
          continue;
        }
        map.delete(key);
        const updated = { ...record, member_id: toMemberId } as T;
        const nextKey = rekey(key, updated);
        if (!map.has(nextKey)) {
          map.set(nextKey, updated);
          bump(label);
        }
      }
    };
    remap(this.cvChanges, "cv_changes", (key) => key.replace(fromMemberId, toMemberId));
    remap(this.logisticsRequests, "logistics_requests", (key) => key);
    remap(this.nudgeLedger, "nudge_ledger", (key) => key.replace(fromMemberId, toMemberId));
    remap(this.socialConsents, "social_draft_consents", (key) =>
      key.replace(fromMemberId, toMemberId),
    );
    remap(this.conferenceAttendees, "conference_attendees", (key) =>
      key.replace(fromMemberId, toMemberId),
    );
    remap(this.paperReimbursements, "paper_reimbursements", (key) =>
      key.replace(fromMemberId, toMemberId),
    );
    remap(this.badgeAssignments, "badge_assignments", (_key, record) =>
      badgeAssignmentKey(record.member_id, record.badge_id),
    );
    remap(this.badgeNominations, "badge_nominations", (key) => key);
    for (const [key, opportunity] of [...this.opportunities]) {
      if (opportunity.submitted_by_member_id !== fromMemberId) {
        continue;
      }
      this.opportunities.set(key, { ...opportunity, submitted_by_member_id: toMemberId });
      bump("opportunities");
    }
    remap(this.registrations, "account_registrations", (key) => key);
    remap(this.passwordResets, "password_resets", (key) => key);
    // Sessions are not repointed -- see the note in the SQLite store; the service revokes the
    // retired member's instead. Credentials are, and the survivor's own wins a collision.
    for (const [memberId, credential] of [...this.credentialsByMemberId]) {
      if (memberId !== fromMemberId) {
        continue;
      }
      this.credentialsByMemberId.delete(memberId);
      if (this.credentialsByMemberId.has(toMemberId)) {
        this.credentialsByEmail.delete(credential.email);
        continue;
      }
      const moved_credential = { ...credential, member_id: toMemberId };
      this.credentialsByMemberId.set(toMemberId, moved_credential);
      this.credentialsByEmail.set(credential.email, moved_credential);
      bump("member_credentials");
    }
    for (const [index, entry] of this.memberLocations.entries()) {
      if (entry.member_id === fromMemberId) {
        this.memberLocations[index] = { ...entry, member_id: toMemberId };
        bump("member_locations");
      }
    }
    for (const [index, entry] of this.loginEvents.entries()) {
      if (entry.member_id === fromMemberId) {
        this.loginEvents[index] = { ...entry, member_id: toMemberId };
        bump("login_events");
      }
    }
    // Both columns, for the reason the SQLite sweep spells out: moving who typed without moving
    // whose record was touched would flip a self-edit into an admin edit.
    for (const [index, entry] of this.updateEvents.entries()) {
      const moved = {
        ...entry,
        ...(entry.member_id === fromMemberId ? { member_id: toMemberId } : {}),
        ...(entry.subject_member_id === fromMemberId ? { subject_member_id: toMemberId } : {}),
      };
      if (
        moved.member_id !== entry.member_id ||
        moved.subject_member_id !== entry.subject_member_id
      ) {
        this.updateEvents[index] = moved;
        bump("update_events");
      }
    }
    for (const [key, draft] of [...this.socialDrafts]) {
      if (draft.generated_by_member_id === fromMemberId) {
        this.socialDrafts.set(key, {
          ...draft,
          generated_by_member_id: toMemberId,
        });
        bump("social_drafts");
      }
    }
    for (const [key, slot] of [...this.paperSlots]) {
      let updated = slot;
      if (slot.provided_by_member_id === fromMemberId) {
        updated = { ...updated, provided_by_member_id: toMemberId };
        bump("paper_slots.provided_by");
      }
      if (slot.waived_by_member_id === fromMemberId) {
        updated = { ...updated, waived_by_member_id: toMemberId };
        bump("paper_slots.waived_by");
      }
      if (updated !== slot) {
        this.paperSlots.set(key, updated);
      }
    }
    return moved;
  }

  savePaper(paper: AdminBotPaperRecord): void {
    this.papers.set(paper.id, paper);
  }

  getPaper(paperId: string): AdminBotPaperRecord | undefined {
    return this.papers.get(paperId);
  }

  listPapers(): AdminBotPaperRecord[] {
    return [...this.papers.values()].toSorted((left, right) =>
      left.title.localeCompare(right.title),
    );
  }

  deletePaper(paperId: string): boolean {
    for (const draft of this.listSocialDrafts(paperId)) {
      for (const [key, consent] of [...this.socialConsents.entries()]) {
        if (consent.draft_id === draft.id) {
          this.socialConsents.delete(key);
        }
      }
    }
    for (const map of [
      this.paperSlots,
      this.socialDrafts,
      this.conferenceAttendees,
      this.paperReimbursements,
      this.paperflowEvidence,
      this.paperWeeklyUpdates,
    ] as Array<Map<string, { paper_id: string }>>) {
      for (const [key, record] of [...map.entries()]) {
        if (record.paper_id === paperId) {
          map.delete(key);
        }
      }
    }
    for (const [key, entry] of [...this.nudgeLedger.entries()]) {
      if (
        (entry.domain === "paper_slot" || entry.domain === "paperflow_stage") &&
        entry.subject_id.startsWith(`${paperId}:`)
      ) {
        this.nudgeLedger.delete(key);
      }
    }
    return this.papers.delete(paperId);
  }

  saveNudgeLedgerEntry(record: AdminBotNudgeLedgerRecord): void {
    this.nudgeLedger.set(`${record.domain}|${record.subject_id}|${record.member_id}`, record);
  }

  listNudgeLedger(domain?: string): AdminBotNudgeLedgerRecord[] {
    return [...this.nudgeLedger.values()].filter(
      (entry) => domain === undefined || entry.domain === domain,
    );
  }

  saveSocialDraft(record: AdminBotSocialDraftRecord): void {
    this.socialDrafts.set(record.id, record);
  }

  listSocialDrafts(paperId?: string): AdminBotSocialDraftRecord[] {
    return [...this.socialDrafts.values()]
      .filter((draft) => paperId === undefined || draft.paper_id === paperId)
      .toSorted((left, right) => right.generated_at.localeCompare(left.generated_at));
  }

  saveSocialConsent(record: AdminBotSocialConsentRecord): void {
    this.socialConsents.set(`${record.draft_id}|${record.member_id}`, record);
  }

  listSocialConsents(draftId?: string): AdminBotSocialConsentRecord[] {
    return [...this.socialConsents.values()].filter(
      (consent) => draftId === undefined || consent.draft_id === draftId,
    );
  }

  saveConferenceAttendee(record: AdminBotConferenceAttendeeRecord): void {
    this.conferenceAttendees.set(`${record.paper_id}|${record.attendee_key}`, record);
  }

  listConferenceAttendees(paperId?: string): AdminBotConferenceAttendeeRecord[] {
    return [...this.conferenceAttendees.values()]
      .filter((entry) => paperId === undefined || entry.paper_id === paperId)
      .toSorted((left, right) => left.name.localeCompare(right.name));
  }

  savePaperReimbursement(record: AdminBotPaperReimbursementRecord): void {
    this.paperReimbursements.set(`${record.paper_id}|${record.member_id}`, record);
  }

  listPaperReimbursements(paperId?: string): AdminBotPaperReimbursementRecord[] {
    return [...this.paperReimbursements.values()].filter(
      (entry) => paperId === undefined || entry.paper_id === paperId,
    );
  }

  savePaperSlot(record: AdminBotPaperSlotRecord): void {
    this.paperSlots.set(`${record.paper_id}\u0000${record.slot}`, record);
  }

  listPaperSlots(paperId?: string): AdminBotPaperSlotRecord[] {
    return [...this.paperSlots.values()]
      .filter((record) => paperId === undefined || record.paper_id === paperId)
      .toSorted(
        (left, right) =>
          left.paper_id.localeCompare(right.paper_id) || left.slot.localeCompare(right.slot),
      );
  }

  savePaperflowEvidence(record: AdminBotPaperflowEvidenceRecord): void {
    // First sighting wins, matching the sqlite store's ON CONFLICT DO NOTHING: a stage that
    // already closed keeps the mail that closed it.
    const key = `${record.paper_id}\u0000${record.stage}`;
    if (this.paperflowEvidence.has(key)) {
      return;
    }
    this.paperflowEvidence.set(key, record);
  }

  listPaperflowEvidence(paperId?: string): AdminBotPaperflowEvidenceRecord[] {
    return [...this.paperflowEvidence.values()]
      .filter((record) => paperId === undefined || record.paper_id === paperId)
      .toSorted(
        (left, right) =>
          left.paper_id.localeCompare(right.paper_id) || left.stage.localeCompare(right.stage),
      );
  }

  appendMemberLocation(entry: AdminBotMemberLocationEntry): void {
    this.memberLocations.push(entry);
  }

  listMemberLocations(memberId: string, limit?: number): AdminBotMemberLocationEntry[] {
    const entries = this.memberLocations
      .filter((entry) => entry.member_id === memberId)
      .toSorted((left, right) => right.observed_at.localeCompare(left.observed_at));
    return typeof limit === "number" ? entries.slice(0, limit) : entries;
  }

  listMemberLocationsSince(since: string): AdminBotMemberLocationEntry[] {
    return this.memberLocations.filter((entry) => entry.observed_at >= since);
  }

  saveWorkshopMatchRun(run: AdminBotWorkshopMatchRun): void {
    // Stamped here as well as in SQLite, so a caller that reads `progress_at` to tell a live pass
    // from an abandoned one behaves the same against either store.
    this.workshopMatchRuns.set(run.id, {
      ...run,
      calls_failed: run.calls_failed ?? 0,
      progress_at: new Date().toISOString(),
    });
  }

  latestWorkshopMatchRun(): AdminBotWorkshopMatchRun | undefined {
    // Insertion order breaks a tie on `started_at`, which is a millisecond stamp two runs really
    // can share: replacing a wedged pass writes the old row off and starts the new one in the same
    // tick. A stable sort on the timestamp alone hands back whichever was inserted first -- the
    // dead one -- so the replacement is invisible and the tab stays wedged on the run it replaced.
    return [...this.workshopMatchRuns.values()]
      .map((run, index) => ({ run, index }))
      .toSorted(
        (left, right) =>
          right.run.started_at.localeCompare(left.run.started_at) || right.index - left.index,
      )[0]?.run;
  }

  appendLoginEvent(event: AdminBotLoginEvent): void {
    this.loginEvents.push(event);
  }

  listLoginEvents(memberId: string, limit?: number): AdminBotLoginEvent[] {
    return recentFirst(
      this.loginEvents.filter((event) => event.member_id === memberId),
      limit,
    );
  }

  listLoginEventsSince(since: string): AdminBotLoginEvent[] {
    return recentFirst(this.loginEvents.filter((event) => event.at >= since));
  }

  appendUpdateEvent(event: AdminBotUpdateEvent): void {
    this.updateEvents.push(event);
  }

  listUpdateEventsByMember(memberId: string, limit?: number): AdminBotUpdateEvent[] {
    return recentFirst(
      this.updateEvents.filter((event) => event.member_id === memberId),
      limit,
    );
  }

  listUpdateEventsBySlot(slotId: string, limit?: number): AdminBotUpdateEvent[] {
    return recentFirst(
      this.updateEvents.filter((event) => event.slot_id === slotId),
      limit,
    );
  }

  listUpdateEventsSince(since: string): AdminBotUpdateEvent[] {
    return recentFirst(this.updateEvents.filter((event) => event.at >= since));
  }

  saveMeeting(meeting: AdminBotMeetingRecord): void {
    this.meetings.set(meeting.id, meeting);
  }

  getMeeting(meetingId: string): AdminBotMeetingRecord | undefined {
    return this.meetings.get(meetingId);
  }

  listMeetings(): AdminBotMeetingRecord[] {
    return [...this.meetings.values()];
  }

  deleteMeeting(meetingId: string): boolean {
    return this.meetings.delete(meetingId);
  }

  saveMemberNotification(notification: AdminBotMemberNotification): void {
    this.memberNotifications.set(notification.id, notification);
  }

  listMemberNotifications(memberId: string): AdminBotMemberNotification[] {
    return [...this.memberNotifications.values()]
      .filter((notification) => notification.member_id === memberId)
      .toSorted((left, right) => right.created_at.localeCompare(left.created_at));
  }

  listEscalatedMemberNotifications(): AdminBotMemberNotification[] {
    return [...this.memberNotifications.values()]
      .filter((notification) => notification.escalated_at && !notification.read_at)
      .toSorted((left, right) => (left.escalated_at ?? "").localeCompare(right.escalated_at ?? ""));
  }

  deleteMemberNotification(notificationId: string): boolean {
    return this.memberNotifications.delete(notificationId);
  }

  saveOpenReviewCycle(cycle: AdminBotOpenReviewCycleRecord): void {
    this.openReviewCycles.set(`${cycle.venue_id} ${cycle.role}`, cycle);
  }

  listOpenReviewCycles(): AdminBotOpenReviewCycleRecord[] {
    return [...this.openReviewCycles.values()].toSorted(
      (left, right) => left.deadline_ms - right.deadline_ms,
    );
  }

  recordOpenReviewMilestone(milestone: AdminBotOpenReviewMilestoneRecord): boolean {
    const key = `${milestone.venue_id} ${milestone.role} ${milestone.milestone_key}`;
    if (this.openReviewMilestones.has(key)) {
      return false;
    }
    this.openReviewMilestones.set(key, milestone);
    return true;
  }

  listOpenReviewMilestones(venueId?: string): AdminBotOpenReviewMilestoneRecord[] {
    return [...this.openReviewMilestones.values()]
      .filter((milestone) => !venueId || milestone.venue_id === venueId)
      .toSorted((left, right) => left.fired_at.localeCompare(right.fired_at));
  }

  recordCvChanges(events: AdminBotCvChangeEvent[]): AdminBotCvChangeEvent[] {
    const inserted: AdminBotCvChangeEvent[] = [];
    for (const event of events) {
      const key = `${event.member_id} ${cvEntryKey(event.entry)}`;
      if (this.cvChanges.has(key)) {
        continue;
      }
      this.cvChanges.set(key, event);
      inserted.push(event);
    }
    return inserted;
  }

  listCvChangesSince(sinceIso: string): AdminBotCvChangeEvent[] {
    return [...this.cvChanges.values()]
      .filter((event) => event.detected_at >= sinceIso)
      .toSorted((left, right) => left.detected_at.localeCompare(right.detected_at));
  }

  private readonly venueIndexes = new Map<
    string,
    { papers: AdminBotVenuePaper[]; indexedAt: string; model: string }
  >();

  replaceVenueIndex(
    venueId: string,
    papers: AdminBotVenuePaper[],
    indexedAt: string,
    model: string,
  ): void {
    this.venueIndexes.set(venueId, { papers: [...papers], indexedAt, model });
  }

  listVenuePapers(venueId: string): AdminBotVenuePaper[] {
    return [...(this.venueIndexes.get(venueId)?.papers ?? [])];
  }

  listVenueIndexStatuses(): Omit<AdminBotVenueIndexStatus, "label">[] {
    return [...this.venueIndexes.entries()].map(([venueId, entry]) => ({
      venue_id: venueId,
      paper_count: entry.papers.length,
      indexed_at: entry.indexedAt,
      embedding_model: entry.model,
    }));
  }

  saveLogisticsRequest(request: AdminBotLogisticsRequest): void {
    this.logisticsRequests.set(request.id, request);
  }

  getLogisticsRequest(requestId: string): AdminBotLogisticsRequest | undefined {
    return this.logisticsRequests.get(requestId);
  }

  /** Newest first, matching the sqlite store's ORDER BY so the two agree before the service sorts. */
  listLogisticsRequests(memberId?: string): AdminBotLogisticsRequest[] {
    return [...this.logisticsRequests.values()]
      .filter((request) => !memberId || request.member_id === memberId)
      .toSorted((left, right) => right.submitted_at.localeCompare(left.submitted_at));
  }

  deleteLogisticsRequest(requestId: string): boolean {
    return this.logisticsRequests.delete(requestId);
  }

  getSettings(): AdminBotSettings | undefined {
    return this.settings;
  }

  saveSettings(settings: AdminBotSettings): void {
    this.settings = settings;
  }

  recordAudit(event: AdminBotAuditEvent): void {
    this.auditEvents.push(event);
  }

  listAuditEvents(): AdminBotAuditEvent[] {
    return [...this.auditEvents];
  }

  pruneAuditEventsBefore(cutoffIso: string): number {
    const before = this.auditEvents.length;
    const retained = this.auditEvents.filter((event) => event.timestamp >= cutoffIso);
    this.auditEvents.length = 0;
    this.auditEvents.push(...retained);
    return before - retained.length;
  }

  getCredentialByEmail(email: string): AdminBotMemberCredential | undefined {
    return this.credentialsByEmail.get(email.toLowerCase());
  }

  getCredentialByMemberId(memberId: string): AdminBotMemberCredential | undefined {
    return this.credentialsByMemberId.get(memberId);
  }

  saveCredential(credential: AdminBotMemberCredential): void {
    this.credentialsByMemberId.set(credential.member_id, credential);
    this.credentialsByEmail.set(credential.email.toLowerCase(), credential);
  }

  updateCredentialEmail(memberId: string, newEmail: string, updatedAt: string): void {
    const existing = this.credentialsByMemberId.get(memberId);
    if (!existing) {
      return;
    }
    // Drop the stale email->credential mapping so the old login email no longer resolves.
    this.credentialsByEmail.delete(existing.email.toLowerCase());
    const updated = {
      ...existing,
      email: newEmail.toLowerCase(),
      updated_at: updatedAt,
    };
    this.credentialsByMemberId.set(memberId, updated);
    this.credentialsByEmail.set(updated.email, updated);
  }

  saveAccountRegistration(registration: AdminBotAccountRegistration): void {
    this.registrations.set(registration.id, registration);
  }

  getAccountRegistration(id: string): AdminBotAccountRegistration | undefined {
    return this.registrations.get(id);
  }

  listAccountRegistrations(status?: AdminBotRegistrationStatus): AdminBotAccountRegistration[] {
    const all = [...this.registrations.values()].toSorted((left, right) =>
      left.created_at.localeCompare(right.created_at),
    );
    return status ? all.filter((entry) => entry.status === status) : all;
  }

  updateAccountRegistrationDecision(
    id: string,
    status: AdminBotRegistrationStatus,
    decidedBy: string,
    decidedAt: string,
  ): void {
    const registration = this.registrations.get(id);
    if (registration) {
      registration.status = status;
      registration.decided_by = decidedBy;
      registration.decided_at = decidedAt;
    }
  }

  getPendingRegistrationByEmail(email: string): AdminBotAccountRegistration | undefined {
    const lowered = email.toLowerCase();
    return [...this.registrations.values()].find(
      (entry) => entry.status === "pending" && entry.email.toLowerCase() === lowered,
    );
  }

  getPendingRegistrationByMemberId(memberId: string): AdminBotAccountRegistration | undefined {
    return [...this.registrations.values()].find(
      (entry) => entry.status === "pending" && entry.member_id === memberId,
    );
  }

  saveSession(session: AdminBotAuthSession): void {
    this.sessions.set(session.token_hash, session);
  }

  getSession(tokenHash: string): AdminBotAuthSession | undefined {
    return this.sessions.get(tokenHash);
  }

  touchSession(tokenHash: string, lastSeenAt: string): void {
    const session = this.sessions.get(tokenHash);
    if (session) {
      session.last_seen_at = lastSeenAt;
    }
  }

  revokeSession(tokenHash: string, revokedAt: string): void {
    const session = this.sessions.get(tokenHash);
    if (session) {
      session.revoked_at = revokedAt;
    }
  }

  revokeSessionsForMember(memberId: string, revokedAt: string): void {
    for (const session of this.sessions.values()) {
      if (session.member_id === memberId && !session.revoked_at) {
        session.revoked_at = revokedAt;
      }
    }
  }

  savePasswordReset(reset: AdminBotPasswordReset): void {
    this.passwordResets.set(reset.token_hash, { ...reset });
  }

  getPasswordResetByTokenHash(tokenHash: string): AdminBotPasswordReset | undefined {
    return this.passwordResets.get(tokenHash);
  }

  markPasswordResetsUsedForMember(memberId: string, usedAt: string): void {
    for (const reset of this.passwordResets.values()) {
      if (reset.member_id === memberId && !reset.used_at) {
        reset.used_at = usedAt;
      }
    }
  }

  pruneSessionsBefore(cutoffIso: string): number {
    let removed = 0;
    for (const [tokenHash, session] of this.sessions) {
      if (session.expires_at < cutoffIso) {
        this.sessions.delete(tokenHash);
        removed += 1;
      }
    }
    return removed;
  }

  savePaperWeeklyUpdate(update: AdminBotPaperWeeklyUpdate): void {
    this.paperWeeklyUpdates.set(
      `${update.paper_id}\u0000${update.member_id}\u0000${update.week_start}`,
      update,
    );
  }

  listPaperWeeklyUpdates(params?: {
    paperId?: string;
    weekStart?: string;
  }): AdminBotPaperWeeklyUpdate[] {
    return [...this.paperWeeklyUpdates.values()]
      .filter(
        (update) =>
          (!params?.paperId || update.paper_id === params.paperId) &&
          (!params?.weekStart || update.week_start === params.weekStart),
      )
      .toSorted(
        (left, right) =>
          right.week_start.localeCompare(left.week_start) ||
          left.member_id.localeCompare(right.member_id),
      );
  }

  saveFeedback(entry: AdminBotFeedbackEntry): void {
    this.feedback.set(entry.id, entry);
  }

  listFeedback(featureId?: string): AdminBotFeedbackEntry[] {
    return [...this.feedback.values()]
      .filter((entry) => !featureId || entry.feature_id === featureId)
      .toSorted((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  saveSlackConnectInvite(invite: AdminBotSlackConnectInvite): void {
    this.slackConnectInvites.set(slackConnectInviteKey(invite.email, invite.channel_id), invite);
  }

  getSlackConnectInvite(email: string, channelId: string): AdminBotSlackConnectInvite | undefined {
    return this.slackConnectInvites.get(slackConnectInviteKey(email, channelId));
  }

  saveSlackChannelNamingRecord(record: AdminBotSlackChannelNamingRecord): void {
    this.slackChannelNaming.set(record.channel_id, record);
  }

  getSlackChannelNamingRecord(channelId: string): AdminBotSlackChannelNamingRecord | undefined {
    return this.slackChannelNaming.get(channelId);
  }

  listSlackChannelNamingRecords(): AdminBotSlackChannelNamingRecord[] {
    return [...this.slackChannelNaming.values()].toSorted((left, right) =>
      left.first_seen_at.localeCompare(right.first_seen_at),
    );
  }

  deleteSlackChannelNamingRecord(channelId: string): boolean {
    return this.slackChannelNaming.delete(channelId);
  }
}

function badgeAssignmentKey(memberId: string, badgeId: string): string {
  return `${memberId}\u0000${badgeId}`;
}

// Both logs read newest-first everywhere, matching the `ORDER BY at DESC, rowid DESC` their SQLite
// tables are indexed for -- the two stores are meant to be indistinguishable to the service.
//
// The tie-break is not decoration. Two writes inside the same millisecond are ordinary here: one
// profile save stamps every changed field with a single `now`, so a member editing three fields
// produces three rows that compare equal. Ordering those by timestamp alone leaves the newest row
// undefined, and "who touched this last" is exactly the question this table exists to answer. The
// caller's insertion order is the real sequence, so equal timestamps fall back to it, reversed.
function recentFirst<T extends { at: string }>(events: T[], limit?: number): T[] {
  const sorted = events
    .map((event, index) => ({ event, index }))
    .toSorted(
      (left, right) => right.event.at.localeCompare(left.event.at) || right.index - left.index,
    )
    .map((entry) => entry.event);
  return typeof limit === "number" ? sorted.slice(0, limit) : sorted;
}
