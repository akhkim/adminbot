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
import type { PublishedDeadlineRecord } from "../contracts/deadline-proposals.js";
import type { AdminBotFeedbackEntry } from "../contracts/feedback.js";
import type {
  AdminBotConferenceAttendeeRecord,
  AdminBotNudgeLedgerRecord,
  AdminBotPaperReimbursementRecord,
  AdminBotSocialConsentRecord,
  AdminBotSocialDraftRecord,
} from "../contracts/paper-cycle.js";
import type { AdminBotPaperSlotRecord } from "../contracts/paper-slots.js";
import type { AdminBotPaperWeeklyUpdate } from "../contracts/paper-weekly-updates.js";
import type { AdminBotPaperflowEvidenceRecord } from "../contracts/paperflow-stages.js";
import type { AdminBotServiceStore, AdminBotSlackChannelNamingRecord } from "../kernel/service.js";

export class AdminBotMemoryStore implements AdminBotServiceStore {
  private readonly proposals = new Map<string, AdminBotStoredProposal>();
  private readonly deadlineSubmissionActions = new Map<string, string>();
  private readonly publishedDeadlines = new Map<string, PublishedDeadlineRecord>();
  private readonly executionResults = new Map<string, AdminBotExecutionResult>();
  private readonly executionResultsByIdempotencyKey = new Map<string, AdminBotExecutionResult>();
  private readonly labMembers = new Map<string, AdminBotLabMember>();
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

  deleteLabMember(memberId: string): boolean {
    return this.labMembers.delete(memberId);
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
    for (const [key, draft] of [...this.socialDrafts]) {
      if (draft.generated_by_member_id === fromMemberId) {
        this.socialDrafts.set(key, { ...draft, generated_by_member_id: toMemberId });
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
