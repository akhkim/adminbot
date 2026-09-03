import { createHash, randomUUID } from "node:crypto";
import { resolveAdminBotControlUiUrl } from "../contracts/control-ui.js";
import { collaboratorSubgroupAccess } from "../workflows/members/collaborator-subgroups.js";
import type { AdminBotExternalCollaboratorSubgroup } from "../contracts/actions.js";
import {
  matchThemedMeetings,
  matchTopicChannels,
  topicOfChannel,
  type AdminBotTopicChannelPrefix,
} from "../workflows/members/topic-channels.js";
import {
  adminBotIsAlumniType,
  adminBotIsFullMemberType,
  adminBotTimelineEntryTarget,
  ADMINBOT_REC_LETTER_CHANNEL,
  adminBotDormantChaseMemberTypes,
  adminBotIsAlumniMember,
  adminBotProjectChannelName,
  adminBotLogisticsSettledStatuses,
  adminBotRecLetterChannelRetentionDays,
  adminBotNormalizePaperAlias,
  adminBotPaperAliasMaxLength,
  adminBotNudgeRosterDecision,
  adminBotReceivesNudges,
  isAdminBotFullMember,
  type AdminBotMandatoryProfileField,
  type AdminBotProfileReminderScope,
} from "../contracts/actions.js";
import type {
  AdminBotAccessGrant,
  AdminBotAccountRegistration,
  AdminBotActionProposal,
  AdminBotActionType,
  AdminBotApprovalRequest,
  AdminBotAuditEvent,
  AdminBotAuthSession,
  AdminBotCvChangeEvent,
  AdminBotRegistrationStatus,
  AdminBotExecutionRequest,
  AdminBotExecutionResult,
  AdminBotLabMember,
  AdminBotLabMemberInput,
  AdminBotLogisticsAttachment,
  AdminBotLogisticsRequest,
  AdminBotLogisticsRequestInput,
  AdminBotLogisticsRequestStatus,
  AdminBotMemberCredential,
  AdminBotMemberOnboardingStep,
  AdminBotMemberActivityCounts,
  AdminBotMemberProfileOverviewRow,
  AdminBotMemberTimelineCounts,
  AdminBotMemberNudgeChannel,
  AdminBotOnboardingCycleReason,
  AdminBotMemberNudgeRequest,
  AdminBotMemberNudgeResult,
  AdminBotMemberNudgeSkip,
  AdminBotMemberOnboarding,
  AdminBotLocationDrift,
  AdminBotLocationSource,
  AdminBotMemberLocationEntry,
  AdminBotMeetingAttendee,
  AdminBotMeetingRecord,
  AdminBotMeetingRecordInput,
  AdminBotMemberNotification,
  AdminBotOpenReviewCycleRecord,
  AdminBotOpenReviewMilestoneRecord,
  AdminBotPaperArtifactLinks,
  AdminBotPaperNudge,
  AdminBotPaperRecord,
  AdminBotPasswordReset,
  AdminBotPaperRecordInput,
  AdminBotPaperStep,
  AdminBotPaperTimeline,
  AdminBotProfilePhotoAssessment,
  AdminBotProfilePhotoPolishVariant,
  AdminBotRemovePendingRequest,
  AdminBotRiskTier,
  AdminBotSettings,
  AdminBotSettingsInput,
  AdminBotVenueIndexStatus,
  AdminBotVenuePaper,
  AdminBotVenueSource,
  AdminBotStoredProposal,
  AdminBotPrivilegeLevel,
} from "../contracts/actions.js";
import {
  adminBotNudgeEscalateAfterDays,
  adminBotOnboardingFirstChaseDays,
  adminBotOnboardingRepeatChaseDays,
  adminBotExternalCollaboratorSubgroups,
  adminBotMandatoryProfileFieldLabels,
  adminBotMemberAnswerableProfileFields,
  adminBotMemberRoles,
  adminBotMemberStatuses,
  ADMINBOT_DEADLINE_TIME_PATTERN,
  ADMINBOT_MAX_LABEL_LENGTH,
  adminBotTimeOffKinds,
  isAdminBotTimezone,
} from "../contracts/actions.js";
import {
  paperRecordSlotId,
  paperSlotId,
  profileSlotId,
  type AdminBotLoginEvent,
  type AdminBotUpdateEvent,
  type AdminBotUpdateSource,
  type AdminBotUpdateSubject,
} from "../contracts/activity-log.js";
import {
  deadlineProposalDuplicateKey,
  isDeadlinePublicationPayload,
  validateDeadlineProposalInput,
  type DeadlineProposalInput,
  type DeadlineProposalView,
  type DeadlinePublicationPayload,
  type PublishedDeadlineRecord,
} from "../contracts/deadline-proposals.js";
import {
  adminBotFeedbackCommentMax,
  adminBotFeedbackId,
  adminBotFeedbackMaxRating,
  adminBotFeedbackMinRating,
  summarizeAdminBotFeedback,
  type AdminBotFeedbackEntry,
  type AdminBotFeedbackSummary,
} from "../contracts/feedback.js";
import {
  ADMINBOT_BADGE_CATEGORY_MAX,
  ADMINBOT_BADGE_DESCRIPTION_MAX,
  ADMINBOT_BADGE_EVIDENCE_MAX,
  adminBotDefaultBadgeDefinitions,
  normalizeBadgeFamilyKey,
  type AdminBotAssignedBadge,
  type AdminBotBadgeAssignment,
  type AdminBotBadgeDefinition,
  type AdminBotBadgeDefinitionInput,
  type AdminBotBadgeNomination,
  type AdminBotBadgeNominationStatus,
  type AdminBotBadgeNominationView,
} from "../contracts/badges.js";
import {
  adminBotDefaultGroupMeeting,
  adminBotGroupMeetingNudgeWindowHours,
  hoursUntilGroupMeeting,
  isGroupMeetingNudgeDue,
  type GroupMeetingSchedule,
} from "../contracts/group-meeting.js";
import {
  findDuplicateMembers,
  planMemberMerge,
  type MemberDuplicatePair,
  type MemberMergeConflict,
} from "../contracts/member-duplicates.js";
import {
  adminBotAttendanceStates,
  adminBotAttendeeKey,
  adminBotNudgeDomains,
  adminBotReimbursementStates,
  type AdminBotConferenceAttendeeRecord,
  ADMINBOT_ALUMNI_TEMPLATE_ID,
  adminBotAlumniSlackInviteDelayDays,
  type AdminBotNudgeDomain,
  type AdminBotNudgeLedgerRecord,
  type AdminBotPaperReimbursementRecord,
  type AdminBotSocialConsentRecord,
  type AdminBotSocialDraftRecord,
  type AdminBotWorkshopMatchRun,
} from "../contracts/paper-cycle.js";
import {
  adminBotPaperSlotBranchPriority,
  type AdminBotPaperSlot,
  type AdminBotPaperSlotInput,
  type AdminBotPaperSlotOwner,
  type AdminBotPaperSlotRecord,
} from "../contracts/paper-slots.js";
import {
  adminBotWeeklyUpdateBodyMax,
  adminBotWeekStart,
  buildWeeklyUpdateMessage,
  findWeeklyUpdateGaps,
  type AdminBotPaperWeeklyUpdate,
  type AdminBotWeeklyUpdateGap,
} from "../contracts/paper-weekly-updates.js";
import {
  adminBotPaperflowEvidenceMinConfidence,
  adminBotPaperflowStageRegistry,
  adminBotPaperflowStages,
  adminBotPaperflowSubjectId,
  isAdminBotPaperflowStage,
  type AdminBotPaperflowEvidenceRecord,
  type AdminBotPaperflowStage,
} from "../contracts/paperflow-stages.js";
import { paperTargetsVenue } from "../contracts/venue-targets.js";
import {
  isDeadlineMilestoneId,
  reconcileDeadlineMilestones,
} from "../workflows/deadlines/member-milestones.js";
import {
  byUrgency,
  prepareLogisticsRequest,
  withoutAttachmentBytes,
} from "../workflows/logistics/requests.js";
import {
  clearSettledRequestFiles,
  signedDocumentEmailBody,
  signedDocumentEmailSubject,
  storedRequestBytes,
  validateSignedDocuments,
} from "../workflows/logistics/signed-documents.js";
import {
  absenceStreakKey,
  adminBotMeetingAbsenceStreak,
  buildMeetingAttendanceMessage,
  consecutiveAbsences,
  meetingAudience,
  streakMeetings,
  type AdminBotMeetingAbsence,
} from "../workflows/meetings/attendance-nudge.js";
import { mergeAttendance } from "../workflows/meetings/attendance.js";
import {
  byMostRecent,
  meetsDurationFloor,
  mergeMeeting,
  redactMeetingForMember,
  validateMeeting,
} from "../workflows/meetings/records.js";
import {
  adoptionSummary,
  lastSelfEditAt,
  projectAdoption,
  selfFilledFieldCount,
  changedProfileFields,
  stampFieldProvenance,
  type AdminBotWriteOrigin,
} from "../workflows/members/adoption.js";
import {
  dormantChaseDue,
  isChaseableMember,
  planOnboardingFollowUp,
  type OnboardingFollowUpStep,
} from "../workflows/members/onboarding-followup.js";
import {
  detectLocationDrift,
  isNewObservation,
  latestBySource,
  observationFor,
  selfReportedChange,
} from "../workflows/members/location-history.js";
import { buildMemberMap, type AdminBotMemberMap } from "../workflows/members/member-map.js";
import {
  acknowledgeOnboardingStep,
  buildInitialOnboarding,
  findOnboardingStep,
  isOnboardingStepComplete,
  onboardingStepIds,
  onboardingReopenReason,
  resolveMemberOnboarding,
  setOnboardingStepStatus,
} from "../workflows/onboarding/onboarding.js";
import {
  authorMemberIds,
  authorNamesFromLinks,
  buildAuthorLinks,
} from "../workflows/papers/author-links.js";
import {
  memberRelevanceNeedles,
  textMatchesNeedles,
} from "../workflows/papers/openreview-matching.js";
import { planPaperBackfill } from "../workflows/papers/paper-slot-backfill.js";
import {
  actionablePaperSlots,
  applyPaperSlotWrite,
  blankPaperSlot,
  boundSnooze,
  buildNudgeMessage,
  draftConsentState,
  isAdminBotPaperSlot,
  isConferenceBranchOpen,
  isCycleClosed,
  isNudgeDue,
  isPaperClosed,
  isPaperDormant,
  missingAcceptanceDetails,
  paperSlotProgress,
  paperSlotRows,
  redactPaperSlots,
  resolveConsentAudience,
  shouldEscalate,
  waivePaperSlot,
  type NudgeItem,
} from "../workflows/papers/paper-slots.js";
import {
  openPaperflowStage,
  paperflowRecipient,
  paperflowStageEmail,
} from "../workflows/papers/paperflow-stages.js";

// Approver roles are privilege levels from the member roster, not a separate vocabulary: the
// service can only ever verify the level on the authenticated session, so anything else here
// would be unenforceable decoration.
type AdminBotApproverRole = Extract<AdminBotPrivilegeLevel, "admin">;

type AdminBotActionPolicy = {
  risk_tier: AdminBotRiskTier;
  requires_approval: boolean;
  approver_roles: AdminBotApproverRole[];
  min_approvals: number;
  auto_allowed?: boolean;
};

export type AdminBotServiceResponse<T> =
  | { ok: true; status: number; payload: T }
  | { ok: false; status: number; error: { message: string } };

export type AdminBotServiceStore = {
  saveProposal(proposal: AdminBotStoredProposal): void;
  getProposal(actionId: string): AdminBotStoredProposal | undefined;
  updateProposal(proposal: AdminBotStoredProposal): void;
  listPending(limit?: number): AdminBotStoredProposal[];
  listProposalsByType(type: AdminBotActionType): AdminBotStoredProposal[];
  saveDeadlineProposalSubmission(
    proposal: AdminBotStoredProposal,
    submitterMemberId: string,
    idempotencyKey: string,
  ): { proposal: AdminBotStoredProposal; created: boolean };
  replaceDeadlineProposalRevision(
    previous: AdminBotStoredProposal,
    next: AdminBotStoredProposal,
  ): void;
  savePublishedDeadline(record: PublishedDeadlineRecord): void;
  listPublishedDeadlines(): PublishedDeadlineRecord[];
  saveExecutionResult(result: AdminBotExecutionResult): void;
  getExecutionResult(actionId: string): AdminBotExecutionResult | undefined;
  getExecutionResultByIdempotencyKey(idempotencyKey: string): AdminBotExecutionResult | undefined;
  saveLabMember(member: AdminBotLabMember): void;
  getLabMember(memberId: string): AdminBotLabMember | undefined;
  listLabMembers(): AdminBotLabMember[];
  saveBadgeDefinition(badge: AdminBotBadgeDefinition): void;
  getBadgeDefinition(badgeId: string): AdminBotBadgeDefinition | undefined;
  listBadgeDefinitions(): AdminBotBadgeDefinition[];
  saveBadgeAssignment(assignment: AdminBotBadgeAssignment): void;
  getBadgeAssignment(memberId: string, familyKey: string): AdminBotBadgeAssignment | undefined;
  listBadgeAssignments(memberId?: string): AdminBotBadgeAssignment[];
  deleteBadgeAssignment(memberId: string, badgeId: string): boolean;
  saveBadgeNomination(nomination: AdminBotBadgeNomination): void;
  getBadgeNomination(nominationId: string): AdminBotBadgeNomination | undefined;
  listBadgeNominations(params?: {
    memberId?: string;
    status?: AdminBotBadgeNominationStatus;
  }): AdminBotBadgeNomination[];
  /** Removes one roster row. False when there was nothing to remove. */
  deleteLabMember(memberId: string): boolean;
  /**
   * Repoints every record that names one member at another, returning what moved per table.
   *
   * The store owns this rather than the service because the store is the only layer that knows
   * which tables carry a member id -- a merge that missed one would leave a reimbursement or a
   * consent row pointing at an id that no longer exists, which reads downstream as the person
   * never having been asked.
   */
  reassignMemberReferences(fromMemberId: string, toMemberId: string): Record<string, number>;
  /**
   * Deletes every record that names one member, returning what went per table.
   *
   * The delete-side counterpart to `reassignMemberReferences`, and a separate list on purpose: a
   * merge repoints a person's rows at whoever they turned out to be, so the tables it walks are
   * the ones whose rows still mean something under a new owner. A delete has no survivor, so it
   * also has to take the rows a merge deliberately leaves alone -- the notifications, feedback,
   * weekly updates and submission keys that belong to nobody once the member is gone.
   */
  purgeMemberReferences(memberId: string): Record<string, number>;
  // Returns the events actually inserted. A change already on record is ignored rather than
  // re-dated, so re-scanning cannot make an old move look like it just happened.
  recordCvChanges(events: AdminBotCvChangeEvent[]): AdminBotCvChangeEvent[];
  listCvChangesSince(sinceIso: string): AdminBotCvChangeEvent[];
  // Replaces a venue's index in one go. A rebuild is all-or-nothing: half an old conference mixed
  // with half a new one would rank against a corpus that never existed.
  replaceVenueIndex(
    venueId: string,
    papers: AdminBotVenuePaper[],
    indexedAt: string,
    model: string,
  ): void;
  listVenuePapers(venueId: string): AdminBotVenuePaper[];
  listVenueIndexStatuses(): Omit<AdminBotVenueIndexStatus, "label">[];
  savePaper(paper: AdminBotPaperRecord): void;
  getPaper(paperId: string): AdminBotPaperRecord | undefined;
  listPapers(): AdminBotPaperRecord[];
  deletePaper(paperId: string): boolean;
  savePaperSlot(record: AdminBotPaperSlotRecord): void;
  /** One paper's slots, or every paper's when the id is omitted. */
  listPaperSlots(paperId?: string): AdminBotPaperSlotRecord[];
  /** First sighting wins: a stage that already closed keeps the mail that closed it. */
  savePaperflowEvidence(record: AdminBotPaperflowEvidenceRecord): void;
  /** One paper's stage evidence, or every paper's when the id is omitted. */
  listPaperflowEvidence(paperId?: string): AdminBotPaperflowEvidenceRecord[];
  saveNudgeLedgerEntry(record: AdminBotNudgeLedgerRecord): void;
  /** The whole ledger, or one domain's slice. */
  listNudgeLedger(domain?: string): AdminBotNudgeLedgerRecord[];
  saveSocialDraft(record: AdminBotSocialDraftRecord): void;
  listSocialDrafts(paperId?: string): AdminBotSocialDraftRecord[];
  saveSocialConsent(record: AdminBotSocialConsentRecord): void;
  listSocialConsents(draftId?: string): AdminBotSocialConsentRecord[];
  saveConferenceAttendee(record: AdminBotConferenceAttendeeRecord): void;
  listConferenceAttendees(paperId?: string): AdminBotConferenceAttendeeRecord[];
  savePaperReimbursement(record: AdminBotPaperReimbursementRecord): void;
  listPaperReimbursements(paperId?: string): AdminBotPaperReimbursementRecord[];
  appendMemberLocation(entry: AdminBotMemberLocationEntry): void;
  /** Newest first. `limit` is a cap, not a page: nothing here needs to walk a member's whole history. */
  listMemberLocations(memberId: string, limit?: number): AdminBotMemberLocationEntry[];
  /** Every member's entries since a timestamp, so the admin view is one query rather than one per member. */
  listMemberLocationsSince(since: string): AdminBotMemberLocationEntry[];
  saveWorkshopMatchRun(run: AdminBotWorkshopMatchRun): void;
  latestWorkshopMatchRun(): AdminBotWorkshopMatchRun | undefined;
  appendLoginEvent(event: AdminBotLoginEvent): void;
  listLoginEvents(memberId: string, limit?: number): AdminBotLoginEvent[];
  listLoginEventsSince(since: string): AdminBotLoginEvent[];
  appendUpdateEvent(event: AdminBotUpdateEvent): void;
  listUpdateEventsByMember(memberId: string, limit?: number): AdminBotUpdateEvent[];
  listUpdateEventsBySlot(slotId: string, limit?: number): AdminBotUpdateEvent[];
  listUpdateEventsSince(since: string): AdminBotUpdateEvent[];
  saveMeeting(meeting: AdminBotMeetingRecord): void;
  getMeeting(meetingId: string): AdminBotMeetingRecord | undefined;
  listMeetings(): AdminBotMeetingRecord[];
  deleteMeeting(meetingId: string): boolean;
  /**
   * One row per thing the lab has told one person. Upsert by id, so a resend of the same nudge
   * replaces its own row rather than stacking a second copy of the same sentence.
   */
  saveMemberNotification(notification: AdminBotMemberNotification): void;
  /** Newest first, one member's own. There is no all-members read: nothing needs one. */
  listMemberNotifications(memberId: string): AdminBotMemberNotification[];
  /**
   * Every escalated nudge still outstanding, across the whole roster, oldest first.
   *
   * The one read that deliberately crosses member boundaries, and narrow on purpose: an escalation
   * is something the lab already decided to raise to the head professor, which is not the same as
   * her being able to read anyone's notification stream. `/notifications` stays strictly the
   * caller's own.
   */
  listEscalatedMemberNotifications(): AdminBotMemberNotification[];
  deleteMemberNotification(notificationId: string): boolean;
  saveLogisticsRequest(request: AdminBotLogisticsRequest): void;
  getLogisticsRequest(requestId: string): AdminBotLogisticsRequest | undefined;
  /** Every request, or one member's. Newest first; the service re-sorts by urgency on read. */
  listLogisticsRequests(memberId?: string): AdminBotLogisticsRequest[];
  deleteLogisticsRequest(requestId: string): boolean;
  saveOpenReviewCycle(cycle: AdminBotOpenReviewCycleRecord): void;
  listOpenReviewCycles(): AdminBotOpenReviewCycleRecord[];
  // Returns false when the milestone had already fired, which is how the caller
  // knows not to send.
  recordOpenReviewMilestone(milestone: AdminBotOpenReviewMilestoneRecord): boolean;
  listOpenReviewMilestones(venueId?: string): AdminBotOpenReviewMilestoneRecord[];
  getSettings(): AdminBotSettings | undefined;
  saveSettings(settings: AdminBotSettings): void;
  recordAudit(event: AdminBotAuditEvent): void;
  listAuditEvents(): AdminBotAuditEvent[];
  pruneAuditEventsBefore(cutoffIso: string): number;
  getCredentialByEmail(email: string): AdminBotMemberCredential | undefined;
  getCredentialByMemberId(memberId: string): AdminBotMemberCredential | undefined;
  saveCredential(credential: AdminBotMemberCredential): void;
  updateCredentialEmail(memberId: string, newEmail: string, updatedAt: string): void;
  savePasswordReset(reset: AdminBotPasswordReset): void;
  getPasswordResetByTokenHash(tokenHash: string): AdminBotPasswordReset | undefined;
  markPasswordResetsUsedForMember(memberId: string, usedAt: string): void;
  saveAccountRegistration(registration: AdminBotAccountRegistration): void;
  getAccountRegistration(id: string): AdminBotAccountRegistration | undefined;
  listAccountRegistrations(status?: AdminBotRegistrationStatus): AdminBotAccountRegistration[];
  updateAccountRegistrationDecision(
    id: string,
    status: AdminBotRegistrationStatus,
    decidedBy: string,
    decidedAt: string,
  ): void;
  getPendingRegistrationByEmail(email: string): AdminBotAccountRegistration | undefined;
  getPendingRegistrationByMemberId(memberId: string): AdminBotAccountRegistration | undefined;
  saveSession(session: AdminBotAuthSession): void;
  getSession(tokenHash: string): AdminBotAuthSession | undefined;
  touchSession(tokenHash: string, lastSeenAt: string): void;
  revokeSession(tokenHash: string, revokedAt: string): void;
  revokeSessionsForMember(memberId: string, revokedAt: string): void;
  pruneSessionsBefore(cutoffIso: string): number;
  /** Upserts one author's account of one week on one paper. Re-saving the same week replaces. */
  savePaperWeeklyUpdate(update: AdminBotPaperWeeklyUpdate): void;
  listPaperWeeklyUpdates(params?: {
    paperId?: string;
    weekStart?: string;
  }): AdminBotPaperWeeklyUpdate[];
  /** Upserts one member's verdict on one surface. Re-rating replaces; see contracts/feedback.ts. */
  saveFeedback(entry: AdminBotFeedbackEntry): void;
  listFeedback(featureId?: string): AdminBotFeedbackEntry[];
  saveSlackConnectInvite(invite: AdminBotSlackConnectInvite): void;
  getSlackConnectInvite(email: string, channelId: string): AdminBotSlackConnectInvite | undefined;
  saveSlackChannelNamingRecord(record: AdminBotSlackChannelNamingRecord): void;
  getSlackChannelNamingRecord(channelId: string): AdminBotSlackChannelNamingRecord | undefined;
  listSlackChannelNamingRecords(): AdminBotSlackChannelNamingRecord[];
  deleteSlackChannelNamingRecord(channelId: string): boolean;
};

export type AdminBotLabMemberView = AdminBotLabMember & {
  assigned_badges?: AdminBotAssignedBadge[];
};

/**
 * One paper's line in the sweep: how much evidence is in, what is outstanding, and who owes it.
 *
 * Nothing here is stored. `provided_count`, `missing_slots` and `escalating` are all computed from
 * the slot rows on read -- storing them would create a second source of truth that drifts the
 * moment somebody writes a slot without going through this service.
 */
export type AdminBotPaperSlotOverviewRow = {
  paper_id: string;
  title: string;
  venue?: string;
  deadline?: string;
  current_step: string;
  provided_count: number;
  required_count: number;
  dormant: boolean;
  closed: boolean;
  missing_slots: AdminBotPaperSlot[];
  /** Which acceptance details the author still owes, once the venue said yes. */
  missing_acceptance_details: string[];
  /**
   * Who is travelling, counted.
   *
   * Carried on the overview rather than left to a per-paper read because the question an admin
   * asks is "who is going to EMNLP", which spans every accepted paper at once -- and answering it
   * by fetching one cycle per paper would be a request per row of a table. The attendee rows are
   * already loaded here to decide what to chase, so counting them is free.
   */
  attendance: {
    yes: number;
    no: number;
    unknown: number;
    /** Names of the people actually going, which is what a travel plan is made of. */
    going: string[];
  };
  /** Every artifact in, and every attending author square on expenses. Derived, never stored. */
  cycle_closed: boolean;
  escalating: boolean;
  first_author_member_id?: string;
  last_nudged_at?: string;
};

/**
 * One person's nudge, as the preview shows it and as the send would deliver it.
 *
 * Carries the composed message rather than a summary of it: the point of a manual send is that
 * somebody reads what is about to go out in their name, and a paraphrase would not be that.
 */
/**
 * One rung of the venue ladder as the paper card draws it.
 *
 * Read-only by construction: there is no write path for these, because the only thing that closes
 * one is the mail arriving. That is the point of returning them alongside the editable slots --
 * the card can show the whole cycle while making it obvious which half a person fills in and
 * which half fills itself in.
 */
export type AdminBotPaperflowStageView = {
  stage: AdminBotPaperflowStage;
  label: string;
  /** The PaperFlow node id, so the card and the chart can be read side by side. */
  node: string;
  state: "closed" | "waiting" | "upcoming";
  closed_at?: string;
  /** The bcc'd mail's subject, so a closed rung says what closed it. */
  closed_by_subject?: string;
  closed_by?: "email_bcc" | "admin";
};

/**
 * One paper's outstanding venue-cycle stage, as the preview shows it and as the send would mail it.
 *
 * `unroutable_reason` rather than omission: a paper with no lab member on the author list has
 * nobody to chase, and dropping it from the list would make it indistinguishable from a paper
 * with nothing outstanding -- which is exactly the paper an admin needs to see.
 */
export type AdminBotPaperflowStageNudge = {
  paper_id: string;
  title: string;
  stage: AdminBotPaperflowStage;
  stage_label: string;
  reason: string;
  deadline_bearing: boolean;
  venue?: string;
  recipient_member_id?: string;
  recipient_name?: string;
  /** Where in the author list the recipient sits, 0-based, so a surprising pick is visible. */
  recipient_author_index?: number;
  /** True when the configured priority member was taken ahead of an earlier author. */
  prioritized?: boolean;
  unroutable_reason?: string;
  last_nudged_at?: string;
  nudge_count: number;
  /** False when the cadence or a snooze says this one is not going out on this pass. */
  due: boolean;
};

export type AdminBotNudgeBatch = {
  member_id: string;
  member_name: string;
  /** False when there is no Slack id on file, so the preview can say so before the send. */
  deliverable: boolean;
  item_count: number;
  paper_titles: string[];
  message: string;
};

export type AdminBotSlackChannelNamingEvent = {
  event_type: "channel_created" | "channel_rename";
  channel_id: string;
  channel_name: string;
  owner_user_id?: string;
  purpose?: string;
  topic?: string;
};

/**
 * A Slack Connect invite that has already been minted, so a re-send reuses it.
 *
 * Kept per address and channel: the same person invited to the onboarding channel and to a
 * project channel holds two different invitations.
 */
export type AdminBotSlackConnectInvite = {
  email: string;
  channel_id: string;
  url: string;
  created_at: string;
};

/**
 * How long a minted invite is handed out again before a fresh one is asked for.
 *
 * Slack's shared-invite links do not last forever, and a link that has gone stale is worse than no
 * link: the recipient clicks it, is told it is invalid, and has nothing to fall back on. Fourteen
 * days is comfortably inside Slack's own window while still being long enough that the ordinary
 * case -- an onboarding mail re-sent a day or two later after a correction -- reuses one link
 * rather than filling the channel with invitations.
 */
export const ADMINBOT_SLACK_CONNECT_INVITE_DAYS = 14;

export function adminBotSlackConnectInviteIsFresh(
  invite: Pick<AdminBotSlackConnectInvite, "created_at">,
  now: Date = new Date(),
): boolean {
  const created = Date.parse(invite.created_at);
  if (Number.isNaN(created)) {
    // An unreadable date is not evidence of freshness; mint a new one rather than hand out a link
    // nobody can date.
    return false;
  }
  const ageDays = (now.getTime() - created) / 86_400_000;
  return ageDays >= 0 && ageDays < ADMINBOT_SLACK_CONNECT_INVITE_DAYS;
}

export type AdminBotSlackChannelNamingRecord = {
  channel_id: string;
  latest_channel_name: string;
  owner_user_id?: string;
  expected_prefix: SlackChannelNamingPrefix;
  suggested_name: string;
  first_seen_at: string;
  last_seen_at: string;
  reminder_sent_at?: string;
  reminder_action_id?: string;
  /**
   * The rename proposal filed for this channel, once the reminder window has elapsed.
   *
   * Recorded for the same reason `reminder_action_id` is, and load-bearing in one more way: the
   * sweep is re-runnable on demand, and without this a second press would file a second rename
   * for a channel already waiting on the Actions tab.
   */
  rename_action_id?: string;
};

import { AdminBotMemoryStore } from "../persistence/memory.js";
import {
  adminBotCityChannelMinimumMembers,
  buildCityChannelMessage,
  cityChannelPlan,
} from "../workflows/members/city-channels.js";
// The in-memory store implementation lives in store/memory.ts alongside store/sqlite.ts;
// re-exported so callers that import it from the service keep working.
import {
  adminBotGraduationConfirmLeadMonths,
  buildGraduationCeremonyMessage,
  buildGraduationConfirmMessage,
  buildGraduationTransitionMessage,
  graduationActions,
  graduationCeremony,
} from "../workflows/members/graduation.js";
import {
  surfaceMembershipPlan,
  type AdminBotInviteSurface,
  type AdminBotSurfaceRemoval,
} from "../workflows/members/surface-membership.js";
import {
  adminBotThesisGradingDelayDays,
  adminBotThesisGuidanceLeadDays,
  buildThesisGradingMessage,
  buildThesisGuidanceMessage,
  thesisLedgerSubject,
  thesisMilestoneActions,
  thesisMilestones,
} from "../workflows/members/thesis-milestones.js";

// Re-exported so callers that imported the store from the service keep working.
export { AdminBotMemoryStore };

/**
 * What a connector reports back about one proposal.
 *
 * `handled` answers "is this mine", and on its own it used to answer "did it happen" too. Those
 * came apart the moment a connector gained a delivery kill switch: the OpenReview bridge composes
 * and validates a reminder, deliberately does not post it, and had no way to say so except
 * `handled: true` -- which the service could only read as delivered, so an approved reminder that
 * never left the building was stored as `executed` and written into the audit trail as a delivery.
 *
 * `delivered: false` is that missing answer. It means the connector recognized the action and
 * declined to perform it, which the service records as a simulation rather than an execution --
 * the state that already existed for `dry_run` requests, and the one thing that must never be
 * confused with success. Omitting the field means delivered, so every connector that really does
 * the work keeps returning `{ handled: true }` unchanged.
 */
export type AdminBotExecutorOutcome = {
  handled: boolean;
  delivered?: boolean;
  /** Why it was not delivered, shown to whoever approved it. Only read when `delivered` is false. */
  reason?: string;
};

export type AdminBotActionExecutor = {
  execute(proposal: AdminBotStoredProposal): Promise<AdminBotExecutorOutcome>;
};

export type AdminBotServiceOptions = {
  auditRetentionDays?: number;
  executor?: AdminBotActionExecutor;
  reviewSlackProfilePhoto?: (params: { slackUserId: string }) => Promise<{
    compliant: boolean;
    issues: string[];
    summary: string;
    photoUrl?: string;
    source?: "ai" | "heuristic";
  }>;
  polishSlackProfilePhoto?: (params: {
    slackUserId: string;
    instructions: string;
    iteration: number;
  }) => Promise<{ image_data_url: string; note?: string }>;
  /**
   * The mailbox authors are told to bcc so a venue-cycle stage closes itself. Absent means the
   * deployment has no bot mailbox configured, and the PaperFlow stage sweep declines to send:
   * a nudge whose whole payload is "bcc us at" is worse than silence without an address to name.
   */
  paperflowBotEmail?: string;
  /**
   * A roster member who takes the venue cycle ahead of author order when they are on the paper.
   * Configuration rather than a name in a conditional, so the day it stops being true it is one
   * env var to unset rather than a code change.
   */
  paperflowPriorityMemberId?: string;
};

const DEFAULT_ACTION_POLICIES = {
  "slack.send_message": approvalPolicy("T3", ["admin"]),
  "slack.profile_photo_update": autoPolicy("T1"),
  // The reminder DM stays automatic: it is server-composed, tells one person their channel does
  // not match the policy, and asks them to fix it themselves.
  "slack.channel_naming_notify_owner": autoPolicy("T1"),
  // The rename does not. Renaming a channel somebody made is visible to everyone in it and reads
  // as a judgement about their work, which is the same reason `calendar.remove_attendees` sits at
  // T3 -- and unlike a calendar removal it cannot be undone quietly, because the old name is what
  // every link, bookmark and cross-post already points at. As an auto policy this was the one
  // action in the system that proposed and approved itself in the same tick.
  "slack.rename_channel": approvalPolicy("T3", ["admin"]),
  "calendar.create_tentative_hold": approvalPolicy("T2", ["admin"]),
  "calendar.send_invite": approvalPolicy("T3", ["admin"]),
  "calendar.add_attendees": approvalPolicy("T3", ["admin"]),
  // Uninviting somebody is visible to them and reads as a judgement about whether they belong, so
  // it sits with the other T3 calendar writes behind an admin approval and never runs unattended.
  "calendar.remove_attendees": approvalPolicy("T3", ["admin"]),
  "calendar.reschedule": approvalPolicy("T3", ["admin"]),
  "calendar.cancel": approvalPolicy("T3", ["admin"]),
  "email.draft": approvalPolicy("T1", ["admin"]),
  "email.send": approvalPolicy("T3", ["admin"]),
  "social_media.post_publicly": approvalPolicy("T4", ["admin"], 2),
  "paper_publish.prepare": autoPolicy("T1"),
  "paper.overleaf_edit": approvalPolicy("T4", ["admin"], 2),
  "paper_publish.submit": approvalPolicy("T4", ["admin"], 2),
  "paper_publish.nudge_author": approvalPolicy("T3", ["admin"]),
  "paper_publish.escalate_to_pi": approvalPolicy("T3", ["admin"]),
  "join_form.classify": autoPolicy("T0"),
  // Auto-approved for the same reason member_nudge.send is: the only way to create one of these is
  // POST /logistics/requests/:id/signed, which is admin-gated, so the admin gate is the approval.
  // The recipient is never chosen by the caller either -- it is the address of the member who asked
  // for the signature, read off the roster. resolvePolicy only honors auto_allowed below T2.
  "logistics.send_signed_document": autoPolicy("T1"),
  // Deliberately auto-approved, unlike every other outbound-message type (slack.send_message,
  // email.send, paper_publish.nudge_author are all T3/approval-required): creating this proposal
  // already requires a real admin session via POST /nudges/send (never reachable
  // through the shared service principal an agent chat authenticates as), so that admin gate is
  // the approval. resolvePolicy only honors auto_allowed below T2, hence T1 here.
  "member_nudge.send": autoPolicy("T1"),
  // Auto-approved on the same reasoning as member_nudge.send, and T1 for the same mechanical
  // reason: resolvePolicy only honors auto_allowed below T2. The recipients and the entire text are
  // computed here from the notification log and the head-professor setting, so there is no
  // caller-supplied content or targeting for an approval gate to protect against. What makes it
  // safe is that nothing can create one of these except the sweep -- see escalateStaleNudges --
  // and an escalation that waited on an admin's approval would be a reminder nobody sent.
  "member_nudge.escalate": autoPolicy("T1"),
  // Auto-approved on the same reasoning: the member and the channel are computed here from the
  // roster and the city threshold, so nothing about who goes where comes from a caller. T1 for the
  // mechanical reason -- resolvePolicy only honors auto_allowed below T2.
  "slack.invite_to_channel": autoPolicy("T1"),
  // Not auto-approved, unlike the invite above, and the asymmetry is the point. An unwanted invite
  // is noise somebody can leave; an unwanted removal takes a conversation away from someone who was
  // part of it, and they find out by noticing a room is gone. The sweep that drives this reads a
  // three-month-old settled date, so a wrong answer is silent until it has already happened -- an
  // admin sees the name before anyone is removed.
  "slack.remove_from_channel": approvalPolicy("T3", ["admin"]),
  // Auto, unlike the removal above, and bounded structurally rather than by policy: the connector
  // refuses any name that is not `proj-<alias>`, so the worst this can do is open a project channel
  // for a project that exists. Gating it on approval instead would stall every new project behind
  // somebody pressing a button, which is the opposite of what "or creating it" asked for.
  "slack.create_channel": autoPolicy("T1"),
  // Routine cycle reminders auto-send for the same reason member_nudge.send does: the
  // run route is admin-gated, the recipients are the venue's own committee groups, and
  // the cadence fires each milestone at most once.
  "openreview.nudge": autoPolicy("T1"),
  // Overdue warnings carry real social weight and go out under Zhijing's name, so they
  // wait in Pending actions for a human however the run was triggered. Approver roles are
  // privilege levels because that is the only thing the session can be checked against.
  "openreview.warning": approvalPolicy("T2", ["admin"]),
  // Publishing changes the lab's public deadline catalogue. One authenticated administrator
  // reviews the exact payload hash before the internal publication executor can project it.
  "deadline.publish": approvalPolicy("T2", ["admin"]),
  // Writing the member roster back to Google. The sheet is what the onboarding and nudge sweeps
  // read, and several people work in it directly, so an overwrite is felt by more than its author.
  // An administrator reviews the exact cells first, which is also the point at which a Member Type
  // or access edit made in the grid gets a second pair of eyes -- the poller has always refused to
  // let the sheet act as an authorization surface on its own.
  "sheet.update_cells": approvalPolicy("T2", ["admin"]),
} as const satisfies Record<AdminBotActionType, AdminBotActionPolicy>;

const PRIVILEGE_ACCESS: Record<AdminBotPrivilegeLevel, AdminBotAccessGrant[]> = {
  external_collaborator: [
    { service: "slack", access: "view", scope: "shared channels" },
    { service: "google_drive", access: "view", scope: "shared paper folders" },
    { service: "overleaf", access: "view", scope: "explicitly shared projects" },
  ],
  trial: [
    { service: "slack", access: "comment", scope: "trial channels" },
    { service: "google_drive", access: "comment", scope: "trial and shared paper folders" },
    { service: "overleaf", access: "edit", scope: "assigned paper projects" },
    { service: "calendar", access: "view", scope: "lab events" },
  ],
  // Full members hold what `core_member` used to: the tier was retired and its lab-wide scopes
  // folded down here, so a member edits at lab scope rather than assigned-only scope. Governance
  // did not come with it — approvals and operator scopes are `admin` alone (AdminBotApproverRole).
  member: [
    { service: "slack", access: "comment", scope: "core channels" },
    { service: "google_drive", access: "edit", scope: "core lab folders" },
    { service: "overleaf", access: "edit", scope: "lab projects" },
    { service: "calendar", access: "edit", scope: "lab events" },
    { service: "github", access: "edit", scope: "lab repos" },
    { service: "paper_pipeline", access: "edit", scope: "paper records" },
  ],
  admin: [
    { service: "slack", access: "admin", scope: "lab workspace" },
    { service: "google_drive", access: "admin", scope: "lab drive" },
    { service: "overleaf", access: "admin", scope: "lab projects" },
    { service: "calendar", access: "admin", scope: "lab calendars" },
    { service: "github", access: "admin", scope: "lab org" },
    { service: "paper_pipeline", access: "admin", scope: "all records" },
  ],
};

// How far back listLocationDrifts looks. Long enough that a member who moved a month ago and has
// not been asked yet still shows up; short enough that the query stays one index scan.
const LOCATION_DRIFT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

const DEFAULT_SETTINGS = {
  paper_escalation_business_days: 3,
  // Ten minutes: long enough to drop test calls and accidental rejoins, short enough to keep a
  // genuinely quick stand-up. Admin-editable through /settings, so changing it needs no deploy.
  meeting_minimum_minutes: 10,
  cv_recency_window_months: 3,
} as const satisfies Omit<AdminBotSettings, "updated_at">;

const SLACK_CHANNEL_NAME_ALLOWED_PREFIXES = [
  "proj",
  "meeting",
  "group",
  "lab",
  "students",
  "etc",
] as const;
type SlackChannelNamingPrefix = (typeof SLACK_CHANNEL_NAME_ALLOWED_PREFIXES)[number];

const SLACK_CHANNEL_NAME_RE = /^(proj|meeting|group|lab|students|etc)-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SLACK_CHANNEL_NAMING_RENAME_AFTER_MS = 48 * 60 * 60 * 1000;

// Least-privilege baseline for a member created without an explicit tier.
const DEFAULT_MEMBER_PRIVILEGE_LEVEL: AdminBotPrivilegeLevel = "external_collaborator";

/**
 * What the three-way DM says.
 *
 * Addressed to the member, in front of the professor, rather than about them. It names what is
 * outstanding and how long it has been, because the professor has to be able to act on it without
 * asking AdminBot a follow-up question, and it says plainly that a reply here closes it -- the
 * point is the thing getting done, not a record of having asked.
 */
/** Whole days between an instant and now. Floored: nine and a half days is not yet ten. */
function daysBetween(fromIso: string, now: Date): number {
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) {
    return 0;
  }
  return Math.floor((now.getTime() - from) / (24 * 60 * 60 * 1000));
}

/**
 * What the follow-up says.
 *
 * Names the steps rather than counting them: "two steps outstanding" is a number somebody has to go
 * look up, and the whole point of chasing is to make the next action obvious from the message. It
 * also says why the checklist is open, because a member who finished onboarding two years ago and
 * has just been promoted will otherwise read this as a bug.
 */
export function buildOnboardingChaseMessage(params: {
  openLabels: readonly string[];
  days: number;
  reason: AdminBotOnboardingCycleReason;
}): string {
  const opening =
    params.reason === "registration"
      ? `Your setup checklist has been open for ${params.days} days.`
      : `Your standing in the lab changed ${params.days} days ago, so a couple of setup steps are worth reading again.`;
  return [
    opening,
    "",
    ...params.openLabels.map((label) => `• ${label}`),
    "",
    "They are on Getting Set Up in the Control UI.",
  ].join("\n");
}

/**
 * The onboarding ladder's two Slack reminders.
 *
 * The second says it is the second. A follow-up that reads identically to the message three days
 * before it is how somebody learns the sender is not keeping track, and the point of naming it is
 * that the *next* thing that happens is a person -- which the second message says out loud, so the
 * escalation is never a surprise.
 *
 * Neither message asks for anything the welcome did not already ask for. It names the one action
 * that clears it (sign in), because a reminder that re-explains onboarding is a second onboarding
 * email nobody asked for.
 */
export function buildOnboardingFollowUpMessage(params: {
  step: "first_reminder" | "second_reminder";
  days: number;
}): string {
  if (params.step === "first_reminder") {
    return [
      `Your onboarding email went out ${params.days} days ago and the portal has not seen you yet.`,
      "",
      "Signing in once is all this needs — it is what unlocks your profile, your papers and the calendar.",
    ].join("\n");
  }
  return [
    `Still nothing on your account ${params.days} days after your onboarding email — this is the second reminder.`,
    "",
    "Signing in once clears it. If something is in the way (no access, wrong address, wrong person), say so here and I will sort it out rather than keep asking.",
  ].join("\n");
}

/**
 * The standing reminder for an account nobody has ever opened.
 *
 * Deliberately not the onboarding copy. This one goes to people whose welcome was months ago, and
 * a message saying "your onboarding email went out 90 days ago" reads as an accusation rather than
 * as an offer.
 */
export function buildDormantAccountMessage(): string {
  return [
    "Your AdminBot account is set up but has never been signed into.",
    "",
    "One sign-in is all it takes, and it is what puts your profile, papers and deadlines in front of you. If you cannot get in, reply here.",
  ].join("\n");
}

export function buildNudgeEscalationMessage(params: {
  memberName: string;
  professorName: string;
  outstanding: readonly string[];
  days: number;
}): string {
  const first = params.memberName.trim().split(/\s+/u)[0] || params.memberName;
  const list = params.outstanding.map((title) => `• ${title}`).join("\n");
  return [
    // Says where it has gone rather than pretending the professor is reading this thread. They are
    // not in the DM any more -- it is on their page -- and a message claiming an audience that is
    // not here is the kind of small lie that makes the rest of the sentence untrustworthy.
    `Hi ${first} — these have been outstanding for ${params.days} days, so they are now on ${params.professorName}'s list:`,
    "",
    list,
    "",
    "If any of them are already done or no longer apply, say so here and I will close them out.",
  ].join("\n");
}

export class AdminBotService {
  constructor(
    private readonly store: AdminBotServiceStore = new AdminBotMemoryStore(),
    private readonly options: AdminBotServiceOptions = {},
  ) {
    this.pruneRetainedAuditEvents();
    this.refreshStoredDeadlineMilestones();
    this.seedDefaultBadges();
  }

  private refreshStoredDeadlineMilestones(): void {
    for (const member of this.store.listLabMembers()) {
      const milestones = reconcileDeadlineMilestones(member.milestones);
      if (milestones === member.milestones) {
        continue;
      }
      const updated = { ...member, milestones };
      if (!milestones?.length) {
        delete updated.milestones;
      }
      this.store.saveLabMember(updated);
    }
  }

  private seedDefaultBadges(): void {
    const now = new Date().toISOString();
    for (const seed of adminBotDefaultBadgeDefinitions) {
      if (this.store.getBadgeDefinition(seed.id)) {
        continue;
      }
      const familyKey =
        seed.family_key ?? this.findExistingBadgeFamilyKey(seed.category, seed.name) ?? normalizeBadgeFamilyKey(seed.category, seed.name);
      this.store.saveBadgeDefinition({
        id: seed.id,
        category: seed.category,
        name: seed.name,
        description: seed.description,
        ...(seed.criteria_url ? { criteria_url: seed.criteria_url } : {}),
        ...(seed.tier ? { tier: seed.tier } : {}),
        family_key: familyKey,
        sort_order: seed.sort_order ?? 0,
        created_at: now,
        updated_at: now,
      });
    }
  }

  private findExistingBadgeFamilyKey(category: string, name: string): string | undefined {
    const needleCategory = category.trim().toLowerCase();
    const needleName = name.trim().toLowerCase();
    return this.store
      .listBadgeDefinitions()
      .find(
        (badge) =>
          badge.category.trim().toLowerCase() === needleCategory &&
          badge.name.trim().toLowerCase() === needleName,
      )?.family_key;
  }

  // One connector call may mutate an external service. Share it across concurrent retries so
  // the durable idempotency record is written exactly once after the connector succeeds.
  private readonly executionsInFlight = new Map<
    string,
    Promise<AdminBotServiceResponse<AdminBotExecutionResult>>
  >();
  createProposal(
    proposal: AdminBotActionProposal,
  ): AdminBotServiceResponse<AdminBotStoredProposal> {
    if (!proposal.summary.trim()) {
      return serviceError(400, "summary is required");
    }
    const stored = this.prepareProposal(proposal);
    this.store.saveProposal(stored);
    this.auditProposalCreation(stored);
    return { ok: true, status: 200, payload: stored };
  }

  private prepareProposal(proposal: AdminBotActionProposal): AdminBotStoredProposal {
    const now = new Date().toISOString();
    const policy = resolvePolicy(proposal);
    return {
      ...proposal,
      id: `act_${randomUUID()}`,
      risk_tier: policy.risk_tier,
      payload_hash: payloadHash({ ...proposal, risk_tier: policy.risk_tier }),
      status: policy.requires_approval ? "pending" : "approved",
      approval_requirement: {
        requires_approval: policy.requires_approval,
        approver_roles: policy.approver_roles,
        min_approvals: policy.min_approvals,
      },
      approvals: [],
      created_at: now,
      updated_at: now,
    };
  }

  private auditProposalCreation(proposal: AdminBotStoredProposal): void {
    this.recordAudit({
      type: "proposal.created",
      action_id: proposal.id,
      details: {
        action_type: proposal.type,
        risk_tier: proposal.risk_tier,
        status: proposal.status,
      },
    });
    if (!proposal.approval_requirement.requires_approval) {
      this.recordAudit({
        type: "proposal.auto_approved",
        action_id: proposal.id,
        details: { risk_tier: proposal.risk_tier },
      });
    }
  }

  listPending(limit?: number): AdminBotServiceResponse<{ proposals: AdminBotStoredProposal[] }> {
    return {
      ok: true,
      status: 200,
      payload: { proposals: this.store.listPending(limit) },
    };
  }

  submitDeadlineProposal(
    input: DeadlineProposalInput,
    submitterMemberId: string,
    idempotencyKey: string,
    existingDeadlines: readonly unknown[] = [],
  ): AdminBotServiceResponse<DeadlineProposalView> {
    const memberId = submitterMemberId.trim();
    const key = idempotencyKey.trim();
    if (!memberId) {
      return serviceError(401, "member session required");
    }
    if (!key || key.length > 200) {
      return serviceError(400, "a valid idempotency key is required");
    }
    const validation = validateDeadlineProposalInput(input);
    if (!validation.ok) {
      return serviceError(400, firstDeadlineValidationError(validation.errors));
    }
    const proposalId = `dlp_${randomUUID()}`;
    const deadlineId = `community_${randomUUID()}`;
    const duplicateIds = this.findDeadlineDuplicates(validation.value, existingDeadlines);
    const action = this.prepareDeadlinePublication({
      proposalId,
      deadlineId,
      revision: 1,
      submitterMemberId: memberId,
      duplicateIds,
      deadline: validation.value,
      createdByMemberId: memberId,
      idempotencyKey: `deadline-submit:${memberId}:${key}`,
    });
    const saved = this.store.saveDeadlineProposalSubmission(action, memberId, key);
    if (saved.created) {
      this.auditProposalCreation(saved.proposal);
      this.recordAudit({
        type: "deadline_proposal.submitted",
        action_id: saved.proposal.id,
        actor: memberId,
        details: { proposal_id: proposalId, duplicate_deadline_ids: duplicateIds },
      });
    }
    const view = this.deadlineProposalViewForAction(saved.proposal);
    return view
      ? { ok: true, status: saved.created ? 201 : 200, payload: view }
      : serviceError(500, "could not read deadline proposal");
  }

  listDeadlineProposals(
    submitterMemberId?: string,
  ): AdminBotServiceResponse<{ proposals: DeadlineProposalView[] }> {
    const proposals = this.deadlineProposalViews().filter(
      (proposal) =>
        submitterMemberId === undefined || proposal.submitter_member_id === submitterMemberId,
    );
    return { ok: true, status: 200, payload: { proposals } };
  }

  reviseDeadlineProposal(
    proposalId: string,
    input: DeadlineProposalInput,
    actorMemberId: string,
    existingDeadlines: readonly unknown[] = [],
  ): AdminBotServiceResponse<DeadlineProposalView> {
    const current = this.currentDeadlineProposalAction(proposalId);
    if (!current) {
      return serviceError(404, "deadline proposal not found");
    }
    const currentPayload = deadlinePayload(current);
    if (!currentPayload) {
      return serviceError(500, "deadline proposal payload is invalid");
    }
    const validation = validateDeadlineProposalInput(input);
    if (!validation.ok) {
      return serviceError(400, firstDeadlineValidationError(validation.errors));
    }
    const duplicateIds = this.findDeadlineDuplicates(
      validation.value,
      existingDeadlines,
      currentPayload.deadline_id,
    );
    const next = this.prepareDeadlinePublication({
      proposalId,
      deadlineId: currentPayload.deadline_id,
      revision: currentPayload.revision + 1,
      submitterMemberId: currentPayload.submitter_member_id,
      duplicateIds,
      deadline: validation.value,
      createdByMemberId: actorMemberId,
    });
    if (current.status === "pending" || current.status === "approved") {
      const replaced: AdminBotStoredProposal = {
        ...current,
        status: "rejected",
        updated_at: new Date().toISOString(),
      };
      this.store.replaceDeadlineProposalRevision(replaced, next);
    } else {
      this.store.saveProposal(next);
    }
    this.auditProposalCreation(next);
    this.recordAudit({
      type: "deadline_proposal.revised",
      action_id: next.id,
      actor: actorMemberId,
      details: {
        proposal_id: proposalId,
        revision: currentPayload.revision + 1,
        previous_action_id: current.id,
        duplicate_deadline_ids: duplicateIds,
      },
    });
    return { ok: true, status: 200, payload: this.deadlineProposalViewForAction(next)! };
  }

  rejectDeadlineProposal(
    proposalId: string,
    actorMemberId: string,
    note?: string,
  ): AdminBotServiceResponse<DeadlineProposalView> {
    const current = this.currentDeadlineProposalAction(proposalId);
    if (!current) {
      return serviceError(404, "deadline proposal not found");
    }
    const rejected = this.removePending(current.id, {
      actor: actorMemberId,
      ...(note ? { note } : {}),
    });
    if (!rejected.ok) {
      return rejected;
    }
    return {
      ok: true,
      status: 200,
      payload: this.deadlineProposalViewForAction(rejected.payload)!,
    };
  }

  async publishDeadlineProposal(
    proposalId: string,
    payloadHash_: string,
    approver: AdminBotApprovalRequest,
  ): Promise<AdminBotServiceResponse<DeadlineProposalView>> {
    const current = this.currentDeadlineProposalAction(proposalId);
    if (!current) {
      return serviceError(404, "deadline proposal not found");
    }
    const approved = this.approve(current.id, { ...approver, payload_hash: payloadHash_ });
    if (!approved.ok) {
      return approved;
    }
    const executed = await this.execute(current.id, {
      dry_run: false,
      idempotency_key: `deadline-publication:${current.id}`,
    });
    if (!executed.ok) {
      return executed;
    }
    const refreshed = this.store.getProposal(current.id);
    return refreshed
      ? { ok: true, status: 200, payload: this.deadlineProposalViewForAction(refreshed)! }
      : serviceError(500, "published deadline proposal could not be reloaded");
  }

  deadlineReadModel(generated: readonly unknown[]): unknown[] {
    const published = this.store.listPublishedDeadlines();
    const byDeadline = new Map<string, PublishedDeadlineRecord[]>();
    for (const record of published) {
      const records = byDeadline.get(record.deadline_id) ?? [];
      records.push(record);
      byDeadline.set(record.deadline_id, records);
    }
    return [
      ...generated,
      ...[...byDeadline.values()].map((records) => publishedDeadlineVenue(records)),
    ];
  }

  private prepareDeadlinePublication(params: {
    proposalId: string;
    deadlineId: string;
    revision: number;
    submitterMemberId: string;
    duplicateIds: string[];
    deadline: DeadlineProposalInput;
    createdByMemberId: string;
    idempotencyKey?: string;
  }): AdminBotStoredProposal {
    const payload: DeadlinePublicationPayload = {
      proposal_id: params.proposalId,
      deadline_id: params.deadlineId,
      revision: params.revision,
      submitter_member_id: params.submitterMemberId,
      duplicate_deadline_ids: params.duplicateIds,
      deadline: params.deadline,
    };
    return this.prepareProposal({
      type: "deadline.publish",
      summary: `Publish ${params.deadline.name} deadline`,
      target: {
        proposal_id: params.proposalId,
        deadline_id: params.deadlineId,
        revision: params.revision,
        created_by_member_id: params.createdByMemberId,
      },
      evidence: [
        { source: "homepage", url: params.deadline.homepageUrl },
        ...(params.deadline.cfpUrl
          ? [{ source: "call for papers", url: params.deadline.cfpUrl }]
          : []),
        ...(params.deadline.openReviewUrl
          ? [{ source: "OpenReview", url: params.deadline.openReviewUrl }]
          : []),
      ],
      proposed_payload: payload,
      rationale: "Publish a member-submitted deadline after administrator review.",
      undo_plan: "Publish a corrected revision; prior revisions remain in the audit history.",
      ...(params.idempotencyKey ? { idempotency_key: params.idempotencyKey } : {}),
    });
  }

  private deadlineProposalViews(): DeadlineProposalView[] {
    const actions = this.store.listProposalsByType("deadline.publish");
    const currentById = new Map<string, AdminBotStoredProposal>();
    for (const action of actions) {
      const payload = deadlinePayload(action);
      if (!payload) {
        continue;
      }
      const previous = currentById.get(payload.proposal_id);
      const previousPayload = previous ? deadlinePayload(previous) : undefined;
      if (!previousPayload || payload.revision > previousPayload.revision) {
        currentById.set(payload.proposal_id, action);
      }
    }
    return [...currentById.values()]
      .map((action) => this.deadlineProposalViewForAction(action))
      .filter((view): view is DeadlineProposalView => Boolean(view))
      .toSorted((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  private currentDeadlineProposalAction(proposalId: string): AdminBotStoredProposal | undefined {
    return this.store
      .listProposalsByType("deadline.publish")
      .filter((action) => deadlinePayload(action)?.proposal_id === proposalId)
      .toSorted(
        (left, right) =>
          (deadlinePayload(right)?.revision ?? 0) - (deadlinePayload(left)?.revision ?? 0),
      )[0];
  }

  private deadlineProposalViewForAction(
    current: AdminBotStoredProposal,
  ): DeadlineProposalView | undefined {
    const payload = deadlinePayload(current);
    if (!payload) {
      return undefined;
    }
    const revisions = this.store
      .listProposalsByType("deadline.publish")
      .filter((action) => deadlinePayload(action)?.proposal_id === payload.proposal_id)
      .map((action) => {
        const revisionPayload = deadlinePayload(action)!;
        return {
          revision: revisionPayload.revision,
          action_id: action.id,
          payload_hash: action.payload_hash,
          status: action.status,
          deadline: revisionPayload.deadline,
          created_at: action.created_at,
          created_by_member_id:
            typeof action.target?.created_by_member_id === "string"
              ? action.target.created_by_member_id
              : revisionPayload.submitter_member_id,
        };
      })
      .toSorted((left, right) => left.revision - right.revision);
    const publication = this.store
      .listPublishedDeadlines()
      .filter((record) => record.proposal_id === payload.proposal_id)
      .toSorted((left, right) => right.revision - left.revision)[0];
    return {
      id: payload.proposal_id,
      deadline_id: payload.deadline_id,
      submitter_member_id: payload.submitter_member_id,
      submitter_name:
        this.store.getLabMember(payload.submitter_member_id)?.name.trim() || "Lab member",
      status: current.status === "executed" ? "published" : current.status,
      current_revision: payload.revision,
      action_id: current.id,
      payload_hash: current.payload_hash,
      duplicate_deadline_ids: payload.duplicate_deadline_ids,
      deadline: payload.deadline,
      revisions,
      created_at: revisions[0]?.created_at ?? current.created_at,
      updated_at: current.updated_at,
      ...(publication ? { published_at: publication.published_at } : {}),
    };
  }

  private findDeadlineDuplicates(
    input: DeadlineProposalInput,
    generated: readonly unknown[],
    excludeDeadlineId?: string,
  ): string[] {
    const key = deadlineProposalDuplicateKey(input);
    if (!key) {
      return [];
    }
    const ids = new Set<string>();
    for (const row of [...generated, ...this.deadlineReadModel([])]) {
      const candidate = deadlineInputFromBoardEntry(row);
      const id = deadlineBoardEntryId(row);
      if (
        id &&
        id !== excludeDeadlineId &&
        candidate &&
        deadlineProposalDuplicateKey(candidate) === key
      ) {
        ids.add(id);
      }
    }
    for (const action of this.store.listProposalsByType("deadline.publish")) {
      const payload = deadlinePayload(action);
      if (
        payload &&
        payload.deadline_id !== excludeDeadlineId &&
        deadlineProposalDuplicateKey(payload.deadline) === key
      ) {
        ids.add(payload.deadline_id);
      }
    }
    return [...ids].toSorted();
  }

  removePending(
    actionId: string,
    request: AdminBotRemovePendingRequest,
  ): AdminBotServiceResponse<AdminBotStoredProposal> {
    const proposal = this.store.getProposal(actionId);
    if (!proposal) {
      return serviceError(404, "proposal not found");
    }
    if (proposal.status !== "pending" && proposal.status !== "approved") {
      return serviceError(409, "only pending or approved unexecuted proposals can be removed");
    }
    proposal.status = "rejected";
    proposal.updated_at = new Date().toISOString();
    this.store.updateProposal(proposal);
    this.recordAudit({
      type: "proposal.removed",
      action_id: proposal.id,
      actor: request.actor,
      details: {
        action_type: proposal.type,
        risk_tier: proposal.risk_tier,
        ...(request.note ? { note: request.note } : {}),
      },
    });
    return { ok: true, status: 200, payload: proposal };
  }

  approve(
    actionId: string,
    request: AdminBotApprovalRequest,
  ): AdminBotServiceResponse<AdminBotStoredProposal> {
    const proposal = this.store.getProposal(actionId);
    if (!proposal) {
      return serviceError(404, "proposal not found");
    }
    if (proposal.status === "executed") {
      return serviceError(409, "proposal is already executed");
    }
    if (proposal.status === "rejected") {
      return serviceError(409, "proposal is removed");
    }
    if (request.payload_hash !== proposal.payload_hash) {
      return serviceError(409, "payload hash mismatch");
    }
    const requirement = proposal.approval_requirement;
    if (
      requirement.requires_approval &&
      !requirement.approver_roles.includes(request.approver_role)
    ) {
      return serviceError(403, `approver role not allowed: ${request.approver_role}`);
    }
    if (!hasApproval(proposal.approvals, request)) {
      proposal.approvals.push(request);
    }
    // Quorum counts distinct approvers, not rows: a two-person rule that the same person can
    // satisfy twice by varying the role or note is not a two-person rule.
    if (distinctApprovers(proposal.approvals) >= requirement.min_approvals) {
      proposal.status = "approved";
    }
    proposal.updated_at = new Date().toISOString();
    this.store.updateProposal(proposal);
    this.recordAudit({
      type: "approval.recorded",
      action_id: proposal.id,
      actor: request.approver_id ?? request.approver_role,
      details: {
        approver_role: request.approver_role,
        approvals_recorded: proposal.approvals.length,
        min_approvals: requirement.min_approvals,
        status: proposal.status,
      },
    });
    return { ok: true, status: 200, payload: proposal };
  }

  async execute(
    actionId: string,
    request: AdminBotExecutionRequest,
  ): Promise<AdminBotServiceResponse<AdminBotExecutionResult>> {
    if (request.dry_run !== false) {
      return await this.executeOnce(actionId, request);
    }
    const existing = this.executionsInFlight.get(actionId);
    if (existing) {
      return await existing;
    }
    const pending = this.executeOnce(actionId, request).finally(() => {
      if (this.executionsInFlight.get(actionId) === pending) {
        this.executionsInFlight.delete(actionId);
      }
    });
    this.executionsInFlight.set(actionId, pending);
    return await pending;
  }

  private async executeOnce(
    actionId: string,
    request: AdminBotExecutionRequest,
  ): Promise<AdminBotServiceResponse<AdminBotExecutionResult>> {
    const proposal = this.store.getProposal(actionId);
    if (!proposal) {
      return serviceError(404, "proposal not found");
    }
    const idempotencyKey = request.idempotency_key;
    if (idempotencyKey) {
      const replay = this.store.getExecutionResultByIdempotencyKey(idempotencyKey);
      if (replay) {
        this.recordAudit({
          type: "execution.idempotent_replay",
          action_id: actionId,
          details: { idempotency_key: idempotencyKey },
        });
        return { ok: true, status: 200, payload: replay };
      }
    }
    const existingResult = this.store.getExecutionResult(actionId);
    if (existingResult) {
      return { ok: true, status: 200, payload: existingResult };
    }
    if (proposal.status !== "approved") {
      return serviceError(409, "proposal is not approved");
    }
    const requirement = proposal.approval_requirement;
    // Re-check quorum at execution rather than trusting the stored status: the requirement is
    // the contract, and a proposal marked approved under a weaker one must not execute.
    if (
      requirement.requires_approval &&
      distinctApprovers(proposal.approvals) < requirement.min_approvals
    ) {
      return serviceError(409, "proposal does not have the required approvals");
    }
    const now = new Date().toISOString();
    const dryRun = request.dry_run !== false;
    const baseResult = {
      action_id: actionId,
      dry_run: dryRun,
      executed_at: now,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    };
    if (dryRun) {
      const result: AdminBotExecutionResult = { ...baseResult, status: "simulated" };
      this.recordAudit({
        type: "execution.simulated",
        action_id: actionId,
        details: {
          action_type: proposal.type,
          risk_tier: proposal.risk_tier,
          idempotency_key: idempotencyKey,
        },
      });
      return { ok: true, status: 200, payload: result };
    }
    let handled: boolean;
    let delivered = true;
    let notDeliveredReason = "";
    if (proposal.type === "deadline.publish") {
      const publication = deadlinePayload(proposal);
      if (!publication) {
        return this.executionFailure(proposal, 400, "deadline publication payload is invalid");
      }
      const publishedBy = proposal.approvals.at(-1)?.approver_id;
      if (!publishedBy) {
        return this.executionFailure(proposal, 409, "deadline publication has no named approver");
      }
      this.store.savePublishedDeadline({
        action_id: proposal.id,
        proposal_id: publication.proposal_id,
        deadline_id: publication.deadline_id,
        revision: publication.revision,
        deadline: publication.deadline,
        published_at: now,
        published_by_member_id: publishedBy,
      });
      this.recordAudit({
        type: "deadline_proposal.published",
        action_id: proposal.id,
        actor: publishedBy,
        details: {
          proposal_id: publication.proposal_id,
          deadline_id: publication.deadline_id,
          revision: publication.revision,
        },
      });
      handled = true;
    } else {
      if (!this.options.executor) {
        return this.executionFailure(proposal, 501, "no live connector is configured");
      }
      try {
        const outcome = await this.options.executor.execute(proposal);
        handled = outcome.handled;
        delivered = outcome.delivered !== false;
        notDeliveredReason = outcome.reason ?? "";
      } catch (error) {
        const message = error instanceof Error ? error.message : "connector execution failed";
        return this.executionFailure(proposal, 502, message);
      }
    }
    if (!handled) {
      return this.executionFailure(
        proposal,
        501,
        `no live connector handles action type ${proposal.type}`,
      );
    }
    // Recognized but deliberately not performed -- a connector's delivery kill switch. Recorded
    // exactly like a dry run, and for the same reason: nothing reached the outside world, so
    // nothing may be stored as executed. The proposal stays approved and no execution result is
    // saved, so flipping the switch and executing again really delivers rather than replaying a
    // cached answer.
    if (!delivered) {
      const result: AdminBotExecutionResult = { ...baseResult, status: "simulated" };
      this.recordAudit({
        type: "execution.simulated",
        action_id: actionId,
        details: {
          action_type: proposal.type,
          risk_tier: proposal.risk_tier,
          idempotency_key: idempotencyKey,
          not_delivered_reason: notDeliveredReason || "connector declined to deliver",
        },
      });
      return { ok: true, status: 200, payload: result };
    }
    const result: AdminBotExecutionResult = {
      ...baseResult,
      status: "executed",
    };
    proposal.status = "executed";
    proposal.updated_at = now;
    this.store.updateProposal(proposal);
    this.store.saveExecutionResult(result);
    this.recordAudit({
      type: "execution.executed",
      action_id: actionId,
      details: {
        action_type: proposal.type,
        risk_tier: proposal.risk_tier,
        idempotency_key: idempotencyKey,
      },
    });
    return { ok: true, status: 200, payload: result };
  }

  private executionFailure(
    proposal: AdminBotStoredProposal,
    status: number,
    message: string,
  ): AdminBotServiceResponse<AdminBotExecutionResult> {
    this.recordAudit({
      type: "execution.failed",
      action_id: proposal.id,
      details: {
        action_type: proposal.type,
        risk_tier: proposal.risk_tier,
        error: message,
      },
    });
    return serviceError(status, message);
  }

  listAuditEvents(): AdminBotAuditEvent[] {
    return this.store.listAuditEvents();
  }

  // Anonymous reimbursement use has no member to attribute it to, so the audit trail is the only
  // record that a submission happened and the only way to spot abuse of the open endpoint.
  recordAnonymousReimbursementUse(details: {
    route: string;
    ip?: string;
    outcome: "accepted" | "rate_limited";
  }): void {
    this.recordAudit({ type: "reimbursement.anonymous_use", actor: "anonymous", details });
  }

  getProposal(actionId: string): AdminBotStoredProposal | undefined {
    return this.store.getProposal(actionId);
  }

  getSettings(): AdminBotServiceResponse<AdminBotSettings> {
    return { ok: true, status: 200, payload: this.resolveSettings() };
  }

  /**
   * The Slack Connect invite already minted for this address and channel, if any.
   *
   * Returns the row whatever its age; freshness is the caller's question, and
   * `adminBotSlackConnectInviteIsFresh` is how it is asked. Keeping a stale row lets an operator
   * see when somebody was last invited, which is what gets asked when a link stops working.
   */
  getSlackConnectInvite(email: string, channelId: string): AdminBotSlackConnectInvite | undefined {
    return this.store.getSlackConnectInvite(email, channelId);
  }

  saveSlackConnectInvite(invite: AdminBotSlackConnectInvite): void {
    this.store.saveSlackConnectInvite(invite);
  }

  updateSettings(settings: AdminBotSettingsInput): AdminBotServiceResponse<AdminBotSettings> {
    const validation = validateSettings(settings);
    if (validation) {
      return serviceError(400, validation);
    }
    const current = this.resolveSettings();
    const headProfessorMemberId = normalizeOptionalString(settings.head_professor_member_id);
    const headProfessorWhatsapp = normalizeOptionalString(settings.head_professor_whatsapp);
    const labManagerMemberId = normalizeOptionalString(settings.lab_manager_member_id);
    const applicantSheetId = normalizeOptionalString(settings.applicant_sheet_id);
    const applicantLastReviewedAt = normalizeOptionalString(settings.applicant_last_reviewed_at);
    const groupMeetingTime = normalizeOptionalString(settings.group_meeting_time);
    const groupMeetingTimezone = normalizeOptionalString(settings.group_meeting_timezone);
    const next: AdminBotSettings = {
      ...current,
      ...(typeof settings.cv_recency_window_months === "number"
        ? { cv_recency_window_months: settings.cv_recency_window_months }
        : {}),
      ...(typeof settings.paper_escalation_business_days === "number"
        ? { paper_escalation_business_days: settings.paper_escalation_business_days }
        : {}),
      ...(typeof settings.meeting_minimum_minutes === "number"
        ? { meeting_minimum_minutes: settings.meeting_minimum_minutes }
        : {}),
      ...(headProfessorMemberId ? { head_professor_member_id: headProfessorMemberId } : {}),
      ...(headProfessorWhatsapp ? { head_professor_whatsapp: headProfessorWhatsapp } : {}),
      ...(labManagerMemberId ? { lab_manager_member_id: labManagerMemberId } : {}),
      ...(applicantSheetId ? { applicant_sheet_id: applicantSheetId } : {}),
      ...(applicantLastReviewedAt ? { applicant_last_reviewed_at: applicantLastReviewedAt } : {}),
      // The meeting the pre-meeting reminders are aimed at. These were declared on the settings
      // type but never accepted here, so a write appeared to succeed and changed nothing -- the
      // reminder kept using the compiled-in default, which is the one failure a settings field
      // must not have.
      ...(typeof settings.group_meeting_weekday === "number" &&
      settings.group_meeting_weekday >= 0 &&
      settings.group_meeting_weekday <= 6
        ? { group_meeting_weekday: settings.group_meeting_weekday }
        : {}),
      ...(groupMeetingTime ? { group_meeting_time: groupMeetingTime } : {}),
      ...(groupMeetingTimezone ? { group_meeting_timezone: groupMeetingTimezone } : {}),
      // Replaced wholesale rather than merged: the list is ordered and an admin removing a venue
      // has to be able to express that, which a merge cannot.
      ...(settings.venue_sources
        ? { venue_sources: normalizeVenueSources(settings.venue_sources) }
        : {}),
      updated_at: new Date().toISOString(),
    };
    if (settings.head_professor_member_id !== undefined && !headProfessorMemberId) {
      delete next.head_professor_member_id;
    }
    if (settings.lab_manager_member_id !== undefined && !labManagerMemberId) {
      delete next.lab_manager_member_id;
    }
    if (settings.applicant_sheet_id !== undefined && !applicantSheetId) {
      delete next.applicant_sheet_id;
    }
    if (settings.applicant_last_reviewed_at !== undefined && !applicantLastReviewedAt) {
      delete next.applicant_last_reviewed_at;
    }
    this.store.saveSettings(next);
    this.recordAudit({
      type: "settings.updated",
      details: {
        paper_escalation_business_days: next.paper_escalation_business_days,
        cv_recency_window_months: next.cv_recency_window_months,
        has_head_professor_member_id: Boolean(next.head_professor_member_id),
        has_lab_manager_member_id: Boolean(next.lab_manager_member_id),
        has_applicant_sheet_id: Boolean(next.applicant_sheet_id),
        ...(next.applicant_last_reviewed_at
          ? { applicant_last_reviewed_at: next.applicant_last_reviewed_at }
          : {}),
      },
    });
    return { ok: true, status: 200, payload: next };
  }

  /**
   * The one funnel every profile write goes through -- the member's own form, an admin, the
   * spreadsheet importer, the CV scan.
   *
   * `origin` is how the record learns which of those it was. It defaults to `import`, deliberately:
   * every caller that has not been taught to say is a script or a sweep, and the conservative
   * failure is to under-count adoption rather than to credit a member with a field a machine wrote.
   * Only the two routes that authenticate a human pass anything else.
   */
  upsertLabMember(
    member: AdminBotLabMemberInput,
    origin: AdminBotWriteOrigin = {},
  ): AdminBotServiceResponse<AdminBotLabMember> {
    if (Array.isArray(member.milestones)) {
      member = {
        ...member,
        milestones: reconcileDeadlineMilestones(member.milestones) ?? [],
      };
    }
    const existing = this.store.getLabMember(member.id);
    const privilegeLevel =
      member.privilege_level ?? existing?.privilege_level ?? DEFAULT_MEMBER_PRIVILEGE_LEVEL;
    // This is a patch, not a replace: `stored` below is {...existing, ...member}, and callers send
    // only the fields they are changing. So a *required* field has to be checked against what will
    // actually be stored rather than against the patch -- an admin saving their schedule sends
    // `availability` and nothing else, and validating the patch alone read that as a member with no
    // name at all. Every other check in validateLabMember is already guarded on `!== undefined`, so
    // it still only inspects what this request actually sent.
    const validation = validateLabMember(
      { ...member, name: member.name ?? existing?.name ?? "" },
      privilegeLevel,
      existing?.email,
    );
    if (validation) {
      return serviceError(400, validation);
    }
    const now = new Date().toISOString();
    // The merged value, not the patch. A profile save carries only what it is changing, so
    // comparing the patch would read every save that omits `status` as a status change and re-open
    // the checklist on somebody editing their own timezone.
    const reopenReason = onboardingReopenReason(existing, {
      status: member.status ?? existing?.status,
      privilege_level: privilegeLevel,
    });
    const accessOverrides = member.access_overrides ?? existing?.access_overrides;
    const collaboratorSubgroup =
      privilegeLevel === "external_collaborator"
        ? (member.collaborator_subgroup ?? existing?.collaborator_subgroup)
        : undefined;
    const stored: AdminBotLabMember = {
      ...existing,
      ...member,
      privilege_level: privilegeLevel,
      ...(accessOverrides ? { access_overrides: accessOverrides } : {}),
      access: mergeAccessGrants(PRIVILEGE_ACCESS[privilegeLevel], accessOverrides),
      // Step text always comes from the current definitions; only the member's acknowledgements
      // survive, so editing a profile never resets their progress and never leaves them reading a
      // checklist frozen at the shape it had when they signed up.
      //
      // A change of standing is the exception. Somebody promoted from trial to full member has
      // already ticked a checklist that said something different to them at the time, and the two
      // steps that are *about* standing -- what compute they may request, what the lab expects of
      // them -- are re-asked. The clock restarts with them, so the follow-up chases the new cycle
      // rather than an account creation date years old.
      onboarding: resolveMemberOnboarding(existing?.onboarding, {
        ...(reopenReason ? { reopen: { reason: reopenReason, at: now } } : {}),
      }),
      created_at: existing?.created_at ?? now,
      updated_at: now,
      ...availabilityStamp(existing, member, now),
      // Stamped from `member` (the patch) rather than from `stored`: a patch carries only what this
      // request is changing, so spreading the whole merged record here would re-attribute every
      // field on the profile to whoever last saved any part of it.
      field_provenance: stampFieldProvenance({
        existing,
        next: member as Record<string, unknown>,
        source: origin.source ?? "import",
        at: now,
        ...(origin.actor ? { actor: origin.actor } : {}),
      }),
    };
    // Promoting someone out of external_collaborator drops the subgroup instead of letting a stale
    // one ride along on ...existing: the access matrix only means anything for external
    // collaborators, and a hidden value would come back if they were ever demoted again.
    if (collaboratorSubgroup) {
      stored.collaborator_subgroup = collaboratorSubgroup;
    } else {
      delete stored.collaborator_subgroup;
    }
    // An empty list clears the schedule outright; keeping [] would render as an empty
    // chart rather than "nothing recorded".
    if (stored.availability && stored.availability.length === 0) {
      delete stored.availability;
    }
    if (stored.time_off && stored.time_off.length === 0) {
      delete stored.time_off;
    }
    // Same reason for the note that goes with them: an emptied box means "nothing to explain", and
    // storing "" would leave admins reading a blank note as though something had been written.
    if (stored.availability_notes !== undefined && !stored.availability_notes.trim()) {
      delete stored.availability_notes;
    }
    this.store.saveLabMember(stored);
    // Same patch, same rules, same instant as the provenance stamp above -- see
    // changedProfileFields for why these two must not drift. Provenance keeps the latest writer
    // per field; this keeps every writer, which is the half that survives a bulk re-import.
    this.recordUpdateEvents({
      subject: "profile",
      slotIds: changedProfileFields(existing, member as Record<string, unknown>).map(profileSlotId),
      memberId: origin.actor ?? stored.id,
      subjectMemberId: stored.id,
      source: origin.source ?? "import",
      at: now,
    });
    // One hook covers every path that edits a profile — the member's own form, an admin, the
    // roster importer — because they all land here. Recording it at the three call sites instead
    // is how one of them ends up forgotten.
    const moved = selfReportedChange(existing, stored);
    if (moved) {
      this.recordMemberLocation({
        memberId: stored.id,
        source: "self_reported",
        raw: moved.raw,
        ...(moved.timezone ? { timezone: moved.timezone } : {}),
      });
    }
    this.recordAudit({
      type: "lab_member.upserted",
      actor: member.id,
      details: {
        privilege_level: privilegeLevel,
      },
    });
    return { ok: true, status: 200, payload: stored };
  }

  listLabMembers(): AdminBotServiceResponse<{ members: AdminBotLabMemberView[] }> {
    return {
      ok: true,
      status: 200,
      payload: { members: this.store.listLabMembers().map((member) => this.memberView(member)) },
    };
  }

  listBadgeDefinitions(): AdminBotServiceResponse<{ badges: AdminBotBadgeDefinition[] }> {
    return { ok: true, status: 200, payload: { badges: this.store.listBadgeDefinitions() } };
  }

  createBadgeDefinition(
    input: AdminBotBadgeDefinitionInput,
    actor: string,
  ): AdminBotServiceResponse<{ badge: AdminBotBadgeDefinition }> {
    return this.saveBadgeDefinition(input, actor);
  }

  updateBadgeDefinition(
    badgeId: string,
    input: Partial<AdminBotBadgeDefinitionInput>,
    actor: string,
  ): AdminBotServiceResponse<{ badge: AdminBotBadgeDefinition }> {
    const existing = this.store.getBadgeDefinition(badgeId);
    if (!existing) {
      return serviceError(404, "badge not found");
    }
    return this.saveBadgeDefinition({ ...existing, ...input, id: badgeId }, actor, existing);
  }

  private saveBadgeDefinition(
    input: AdminBotBadgeDefinitionInput,
    actor: string,
    existing?: AdminBotBadgeDefinition,
  ): AdminBotServiceResponse<{ badge: AdminBotBadgeDefinition }> {
    const badgeId = existing?.id ?? input.id?.trim() ?? `badge_${randomUUID()}`;
    const category = input.category?.trim() ?? "";
    const name = input.name?.trim() ?? "";
    const description = input.description?.trim() ?? "";
    const tier = input.tier?.trim() || undefined;
    const criteriaUrl = input.criteria_url?.trim() || undefined;
    if (!category) {
      return serviceError(400, "badge category is required");
    }
    if (category.length > ADMINBOT_BADGE_CATEGORY_MAX) {
      return serviceError(
        400,
        `badge category cannot exceed ${ADMINBOT_BADGE_CATEGORY_MAX} characters`,
      );
    }
    if (!name) {
      return serviceError(400, "badge name is required");
    }
    const nameError = validateLabel(name, "badge name");
    if (nameError) {
      return serviceError(400, nameError);
    }
    if (tier) {
      const tierError = validateLabel(tier, "badge tier");
      if (tierError) {
        return serviceError(400, tierError);
      }
    }
    if (!description) {
      return serviceError(400, "badge description is required");
    }
    if (description.includes("\n") || description.includes("\r")) {
      return serviceError(400, "badge description must be a single line");
    }
    if (description.length > ADMINBOT_BADGE_DESCRIPTION_MAX) {
      return serviceError(
        400,
        `badge description cannot exceed ${ADMINBOT_BADGE_DESCRIPTION_MAX} characters`,
      );
    }
    const criteriaError = validateExternalLink(criteriaUrl, "badge criteria");
    if (criteriaError) {
      return serviceError(400, criteriaError);
    }
    const now = new Date().toISOString();
    const familyKey =
      existing?.family_key ??
      input.family_key?.trim() ??
      this.findExistingBadgeFamilyKey(category, name) ??
      normalizeBadgeFamilyKey(category, name);
    const duplicate = this.store
      .listBadgeDefinitions()
      .find(
        (badge) =>
          badge.id !== badgeId &&
          badge.family_key === familyKey &&
          (badge.tier?.trim().toLowerCase() ?? "") === (tier?.trim().toLowerCase() ?? ""),
      );
    if (duplicate) {
      return serviceError(409, "badge tier already exists in this badge family");
    }
    const badge: AdminBotBadgeDefinition = {
      id: badgeId,
      category,
      name,
      description,
      ...(criteriaUrl ? { criteria_url: criteriaUrl } : {}),
      ...(tier ? { tier } : {}),
      family_key: familyKey,
      sort_order: input.sort_order ?? existing?.sort_order ?? 0,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.store.saveBadgeDefinition(badge);
    this.recordAudit({
      type: "badge.definition_saved",
      actor,
      details: { badge_id: badge.id, family_key: badge.family_key },
    });
    return { ok: true, status: 200, payload: { badge } };
  }

  assignBadge(
    memberId: string,
    badgeId: string,
    actor: string,
    evidenceInput?: string,
  ): AdminBotServiceResponse<{ assignment: AdminBotAssignedBadge }> {
    const member = this.store.getLabMember(memberId);
    if (!member) {
      return serviceError(404, "member not found");
    }
    const badge = this.store.getBadgeDefinition(badgeId);
    if (!badge) {
      return serviceError(404, "badge not found");
    }
    const pending = this.store
      .listBadgeNominations({ memberId, status: "pending" })
      .find((nomination) => nomination.family_key === badge.family_key);
    if (pending) {
      return serviceError(409, "decide the pending nomination for this badge family first");
    }
    const evidence = evidenceInput?.trim();
    if (evidence && evidence.length > ADMINBOT_BADGE_EVIDENCE_MAX) {
      return serviceError(
        400,
        `badge evidence cannot exceed ${ADMINBOT_BADGE_EVIDENCE_MAX} characters`,
      );
    }
    const now = new Date().toISOString();
    this.store.saveBadgeAssignment({
      member_id: memberId,
      badge_id: badge.id,
      family_key: badge.family_key,
      awarded_at: now,
      awarded_by: actor,
      source: "admin",
      ...(evidence ? { evidence } : {}),
    });
    const assignment = this.assignedBadgesFor(memberId).find((entry) => entry.badge_id === badge.id);
    this.recordAudit({
      type: "badge.assigned",
      actor,
      details: { member_id: memberId, badge_id: badge.id, family_key: badge.family_key },
    });
    if (!assignment) {
      return serviceError(500, "badge assignment could not be read back");
    }
    return { ok: true, status: 200, payload: { assignment } };
  }

  removeBadge(
    memberId: string,
    badgeId: string,
    actor: string,
  ): AdminBotServiceResponse<{ removed: boolean }> {
    const badge = this.store.getBadgeDefinition(badgeId);
    if (!badge) {
      return serviceError(404, "badge not found");
    }
    const removed = this.store.deleteBadgeAssignment(memberId, badgeId);
    if (!removed) {
      return serviceError(404, "badge assignment not found");
    }
    this.recordAudit({
      type: "badge.removed",
      actor,
      details: { member_id: memberId, badge_id: badgeId, family_key: badge.family_key },
    });
    return { ok: true, status: 200, payload: { removed: true } };
  }

  listBadgeNominations(params: {
    memberId?: string;
    status?: AdminBotBadgeNominationStatus;
  } = {}): AdminBotServiceResponse<{ nominations: AdminBotBadgeNominationView[] }> {
    const nominations = this.store
      .listBadgeNominations(params)
      .map((nomination) => this.badgeNominationView(nomination))
      .filter((nomination): nomination is AdminBotBadgeNominationView => Boolean(nomination));
    return { ok: true, status: 200, payload: { nominations } };
  }

  submitBadgeNomination(
    memberId: string,
    input: { badge_id: string; evidence?: string },
  ): AdminBotServiceResponse<{ nomination: AdminBotBadgeNominationView }> {
    const member = this.store.getLabMember(memberId);
    if (!member) {
      return serviceError(404, "member not found");
    }
    const badgeId = input.badge_id?.trim() ?? "";
    if (!badgeId) {
      return serviceError(400, "badge_id is required");
    }
    const badge = this.store.getBadgeDefinition(badgeId);
    if (!badge) {
      return serviceError(404, "badge not found");
    }
    if (this.store.getBadgeAssignment(memberId, badge.family_key)) {
      return serviceError(409, "you already hold a badge in this badge family");
    }
    const existing = this.store
      .listBadgeNominations({ memberId, status: "pending" })
      .find((nomination) => nomination.family_key === badge.family_key);
    if (existing) {
      return serviceError(409, "you already have a pending nomination for this badge family");
    }
    const evidence = input.evidence?.trim();
    if (!evidence) {
      return serviceError(400, "badge evidence is required");
    }
    if (evidence.length > ADMINBOT_BADGE_EVIDENCE_MAX) {
      return serviceError(
        400,
        `badge evidence cannot exceed ${ADMINBOT_BADGE_EVIDENCE_MAX} characters`,
      );
    }
    const nomination: AdminBotBadgeNomination = {
      id: `badge_nom_${randomUUID()}`,
      badge_id: badge.id,
      family_key: badge.family_key,
      member_id: memberId,
      evidence,
      status: "pending",
      created_at: new Date().toISOString(),
    };
    this.store.saveBadgeNomination(nomination);
    this.recordAudit({
      type: "badge.nomination_submitted",
      actor: memberId,
      details: { member_id: memberId, badge_id: badge.id, family_key: badge.family_key },
    });
    const view = this.badgeNominationView(nomination);
    if (!view) {
      return serviceError(500, "badge nomination could not be read back");
    }
    return { ok: true, status: 200, payload: { nomination: view } };
  }

  decideBadgeNomination(
    nominationId: string,
    decision: Extract<AdminBotBadgeNominationStatus, "approved" | "rejected">,
    actor: string,
  ): AdminBotServiceResponse<{ nomination: AdminBotBadgeNominationView; assignment?: AdminBotAssignedBadge }> {
    const nomination = this.store.getBadgeNomination(nominationId);
    if (!nomination || nomination.status !== "pending") {
      return serviceError(404, "badge nomination not found");
    }
    const badge = this.store.getBadgeDefinition(nomination.badge_id);
    if (!badge) {
      return serviceError(404, "badge not found");
    }
    const now = new Date().toISOString();
    const decided: AdminBotBadgeNomination = {
      ...nomination,
      status: decision,
      decided_at: now,
      decided_by: actor,
    };
    this.store.saveBadgeNomination(decided);
    let assignment: AdminBotAssignedBadge | undefined;
    if (decision === "approved") {
      this.store.saveBadgeAssignment({
        member_id: nomination.member_id,
        badge_id: badge.id,
        family_key: badge.family_key,
        awarded_at: now,
        awarded_by: actor,
        source: "nomination",
        nomination_id: nomination.id,
        ...(nomination.evidence ? { evidence: nomination.evidence } : {}),
      });
      assignment = this.assignedBadgesFor(nomination.member_id).find(
        (entry) => entry.badge_id === badge.id,
      );
    }
    this.recordAudit({
      type:
        decision === "approved" ? "badge.nomination_approved" : "badge.nomination_rejected",
      actor,
      details: {
        nomination_id: nomination.id,
        member_id: nomination.member_id,
        badge_id: badge.id,
        family_key: badge.family_key,
      },
    });
    const view = this.badgeNominationView(decided);
    if (!view) {
      return serviceError(500, "badge nomination could not be read back");
    }
    return {
      ok: true,
      status: 200,
      payload: { nomination: view, ...(assignment ? { assignment } : {}) },
    };
  }

  private memberView(member: AdminBotLabMember): AdminBotLabMemberView {
    const assigned = this.assignedBadgesFor(member.id);
    return { ...member, ...(assigned.length ? { assigned_badges: assigned } : {}) };
  }

  private assignedBadgesFor(memberId: string): AdminBotAssignedBadge[] {
    const badgesById = new Map(this.store.listBadgeDefinitions().map((badge) => [badge.id, badge]));
    return this.store
      .listBadgeAssignments(memberId)
      .flatMap((assignment) => {
        const badge = badgesById.get(assignment.badge_id);
        if (!badge) {
          return [];
        }
        return [
          {
            ...assignment,
            category: badge.category,
            name: badge.name,
            description: badge.description,
            ...(badge.criteria_url ? { criteria_url: badge.criteria_url } : {}),
            ...(badge.tier ? { tier: badge.tier } : {}),
            sort_order: badge.sort_order,
          },
        ];
      })
      .toSorted((left, right) =>
        left.sort_order - right.sort_order ||
        left.category.localeCompare(right.category) ||
        left.name.localeCompare(right.name) ||
        (left.tier ?? "").localeCompare(right.tier ?? ""),
      );
  }

  private badgeNominationView(
    nomination: AdminBotBadgeNomination,
  ): AdminBotBadgeNominationView | undefined {
    const badge = this.store.getBadgeDefinition(nomination.badge_id);
    if (!badge) {
      return undefined;
    }
    return {
      ...nomination,
      badge_category: badge.category,
      badge_name: badge.name,
      badge_description: badge.description,
      ...(badge.tier ? { badge_tier: badge.tier } : {}),
      ...(badge.criteria_url ? { badge_criteria_url: badge.criteria_url } : {}),
      ...(this.store.getLabMember(nomination.member_id)?.name
        ? { member_name: this.store.getLabMember(nomination.member_id)?.name }
        : {}),
    };
  }

  /**
   * One author's account of their own week on one paper.
   *
   * A member writes their own entry and nobody else's -- not even an admin, who gets no exception
   * here for the same reason they get none on a reimbursement they did not make: the value of the
   * log is that each line is first-hand. What an admin can do is read it and chase a missing one.
   *
   * The week is the caller's only when they say so: an entry defaults to the week containing
   * `now`, so the ordinary case (writing on Sunday about the week just ending) needs no date at
   * all, and back-filling last week is possible but deliberate.
   */
  savePaperWeeklyUpdate(params: {
    paperId: string;
    memberId: string;
    body: string;
    weekStart?: string;
    nowIso?: string;
  }): AdminBotServiceResponse<{ update: AdminBotPaperWeeklyUpdate }> {
    const paper = this.store.getPaper(params.paperId);
    if (!paper) {
      return serviceError(404, "paper not found");
    }
    const member = this.store.getLabMember(params.memberId);
    if (!member) {
      return serviceError(404, "member not found");
    }
    const body = params.body.trim().slice(0, adminBotWeeklyUpdateBodyMax);
    if (!body) {
      return serviceError(400, "a weekly update needs something in it");
    }
    const now = params.nowIso ?? new Date().toISOString();
    const weekStart = params.weekStart ?? adminBotWeekStart(now);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(weekStart)) {
      return serviceError(400, "week_start must be a YYYY-MM-DD date");
    }
    const existing = this.store
      .listPaperWeeklyUpdates({ paperId: params.paperId, weekStart })
      .find((update) => update.member_id === params.memberId);
    const update: AdminBotPaperWeeklyUpdate = {
      paper_id: params.paperId,
      member_id: params.memberId,
      week_start: weekStart,
      body,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.store.savePaperWeeklyUpdate(update);
    this.recordAudit({
      type: "paper_weekly_update.saved",
      actor: params.memberId,
      // The prose stays out of the audit line: it is somebody's account of their own week, and
      // the audit log is read by more people than the paper card is.
      details: { paper_id: params.paperId, week_start: weekStart },
    });
    return { ok: true, status: 200, payload: { update } };
  }

  listPaperWeeklyUpdates(
    paperId: string,
  ): AdminBotServiceResponse<{ updates: AdminBotPaperWeeklyUpdate[] }> {
    return {
      ok: true,
      status: 200,
      payload: { updates: this.store.listPaperWeeklyUpdates({ paperId }) },
    };
  }

  /**
   * Who has not written their entry for the week containing `nowIso`.
   *
   * The preview behind the Sunday sweep, and the same walk it sends from. Dormant and closed
   * papers are left out: nobody owes a weekly line on a paper that is resting or rejected, and a
   * sweep that asked would teach people to ignore it.
   */
  collectWeeklyUpdateGaps(nowIso?: string): AdminBotServiceResponse<{
    week_start: string;
    gaps: AdminBotWeeklyUpdateGap[];
  }> {
    const now = nowIso ? new Date(nowIso) : new Date();
    const weekStart = adminBotWeekStart(now);
    const papers = this.store
      .listPapers()
      .filter((paper) => !isPaperDormant(paper, now) && !isPaperClosed(paper))
      .map((paper) => ({
        id: paper.id,
        title: paper.title,
        // Everyone on the author list the roster can name, first author included. A weekly line is
        // asked of the people doing the work, which is not the same set as the one slot ownership
        // picks out -- that one names a single person to chase for an artifact.
        member_ids: [
          ...this.resolvePaperSlotOwner(paper, "first_author"),
          ...this.resolvePaperSlotOwner(paper, "coauthors"),
        ],
      }));
    const gaps = findWeeklyUpdateGaps({
      papers,
      updates: this.store.listPaperWeeklyUpdates({ weekStart }),
      weekStart,
    });
    return { ok: true, status: 200, payload: { week_start: weekStart, gaps } };
  }

  /**
   * The Sunday pass: one Slack message per person, listing every paper they owe a line on.
   *
   * Cadence is a property of the product, not of whatever schedule invokes it -- the audit ledger
   * records who was asked about which week, so a crontab that fires hourly, a manual press and two
   * hosts running the same job cannot turn this into a nag. That is also why the week is in the
   * ledger key: the same person is asked again next week, and only next week.
   */
  async sendWeeklyUpdateNudges(
    actor: string,
    nowIso?: string,
  ): Promise<
    AdminBotServiceResponse<AdminBotMemberNudgeResult & { week_start: string; asked: string[] }>
  > {
    const collected = this.collectWeeklyUpdateGaps(nowIso);
    if (!collected.ok) {
      return collected;
    }
    const { week_start: weekStart, gaps } = collected.payload;
    const alreadyAsked = this.weeklyUpdateAskedFor(weekStart);
    const byMember = new Map<string, string[]>();
    for (const gap of gaps) {
      if (alreadyAsked.has(gap.member_id)) {
        continue;
      }
      byMember.set(gap.member_id, [...(byMember.get(gap.member_id) ?? []), gap.paper_title]);
    }
    const created: AdminBotMemberNudgeResult["created"] = [];
    const skipped: AdminBotMemberNudgeResult["skipped"] = [];
    const asked: string[] = [];
    for (const [memberId, titles] of byMember) {
      const result = await this.sendMemberNudge(
        {
          channel: "slack",
          recipient_member_ids: [memberId],
          message: buildWeeklyUpdateMessage({ titles, weekStart }),
          kind: "nudge",
          title: "This week's paper update",
          tab: "myWork",
          // Not important: a skipped week is a gap in a log, and next Monday asks again.
        },
        actor,
      );
      if (!result.ok) {
        skipped.push({ member_id: memberId, reason: result.error.message });
        continue;
      }
      created.push(...result.payload.created);
      skipped.push(...result.payload.skipped);
      if (result.payload.created.length > 0) {
        asked.push(memberId);
      }
    }
    if (asked.length > 0) {
      this.recordAudit({
        type: "paper_weekly_updates.nudged",
        actor,
        details: { week_start: weekStart, member_ids: asked },
      });
    }
    return { ok: true, status: 200, payload: { created, skipped, week_start: weekStart, asked } };
  }

  /** Members already asked about this week, from the audit ledger. */
  private weeklyUpdateAskedFor(weekStart: string): Set<string> {
    const asked = new Set<string>();
    for (const event of this.store.listAuditEvents()) {
      if (event.type !== "paper_weekly_updates.nudged") {
        continue;
      }
      const details = event.details as { week_start?: unknown; member_ids?: unknown } | undefined;
      if (details?.week_start !== weekStart || !Array.isArray(details.member_ids)) {
        continue;
      }
      for (const id of details.member_ids) {
        if (typeof id === "string") {
          asked.add(id);
        }
      }
    }
    return asked;
  }

  /**
   * Who the lab is chasing about the ICLR pre-registration, and what each of them is owed.
   *
   * The addressable set is "batch 1, 2 or 3", where an explicit batch comes from the spreadsheet's
   * Test Onboard column and every full member counts as batch 3. A member with neither -- no batch
   * and not a full member -- is deliberately untouched: those are the people the lab has not
   * started onboarding, and a nudge about a submission plan would be the first thing AdminBot ever
   * said to them.
   *
   * Two outcomes, because two different things are wanted from these people:
   *   - no paper aimed at ICLR: they are asked to pre-register, with the reason spelled out.
   *   - some paper aimed at ICLR: they are asked to bring the *rest* of their papers up to date,
   *     which is the thing that is actually outstanding for them.
   *
   * Dormant and closed papers are left out of both counts. A rejected paper is not a plan.
   */
  collectPreRegistrationNudges(
    params: { venue?: string; nowIso?: string } = {},
  ): AdminBotServiceResponse<{
    venue: string;
    hours_until_meeting: number;
    due: boolean;
    missing: Array<{ member_id: string; name: string; paper_count: number }>;
    stale: Array<{ member_id: string; name: string; registered: number; unregistered: number }>;
    /** Who the sweep deliberately skipped, so the exclusion is visible rather than assumed. */
    excluded: string[];
    /**
     * False when no head professor is configured, in which case nobody is exempt.
     *
     * Surfaced rather than left implicit: the exemption is keyed on a settings field, and a
     * settings field that is unset makes an exclusion silently do nothing. A preview that says
     * "excluded: none, head professor not configured" is the difference between choosing not to
     * exempt the PI and not noticing that you failed to.
     */
    head_professor_configured: boolean;
  }> {
    const venue = params.venue?.trim() || "ICLR";
    const now = params.nowIso ? new Date(params.nowIso) : new Date();
    const schedule = this.groupMeetingSchedule();
    // The head professor runs the meeting this reminder is aimed at. They are on nearly every
    // paper in the lab as the supervisor rather than as the person who would register it, so
    // chasing them about "your 84 active papers" is both wrong and the fastest way to make the
    // whole reminder look untrustworthy.
    const headProfessor = this.resolveSettings().head_professor_member_id?.trim() ?? "";
    const excluded: string[] = [];
    const papers = this.store
      .listPapers()
      .filter((paper) => !isPaperDormant(paper, now) && !isPaperClosed(paper));
    const missing: Array<{ member_id: string; name: string; paper_count: number }> = [];
    const stale: Array<{
      member_id: string;
      name: string;
      registered: number;
      unregistered: number;
    }> = [];
    for (const member of this.store.listLabMembers()) {
      if (member.status === "alumni" || member.status === "external") {
        continue;
      }
      // Columns R and S of the lab spreadsheet, and nothing else. `privilege_level` was the first
      // attempt at "full member" and is not that question: the roster marks nearly everyone the
      // lab has ever collaborated with as `member`, so it swept in alumni, one-paper coauthors and
      // two visiting professors. Somebody who is in neither column is deliberately untouched --
      // they are not somebody this lab plans its term around.
      const batch = member.test_onboard_batch;
      const addressable =
        ((typeof batch === "number" && batch >= 1 && batch <= 3) ||
          adminBotIsFullMemberType(member.member_type)) &&
        // Alumni are out even when they carry a batch. The spreadsheet keeps the batch after
        // somebody leaves, so reading it alone sent a message about next term's submissions to
        // three people who have already gone.
        !adminBotIsAlumniType(member.member_type);
      if (!addressable) {
        continue;
      }
      if (headProfessor && member.id === headProfessor) {
        excluded.push(member.id);
        continue;
      }
      const own = papers.filter((paper) => this.memberOwnsPaper(member, paper));
      if (own.length === 0) {
        continue;
      }
      const registered = own.filter((paper) => paperTargetsVenue(paper, venue));
      if (registered.length === 0) {
        missing.push({ member_id: member.id, name: member.name, paper_count: own.length });
        continue;
      }
      if (registered.length < own.length) {
        stale.push({
          member_id: member.id,
          name: member.name,
          registered: registered.length,
          unregistered: own.length - registered.length,
        });
      }
    }
    return {
      ok: true,
      status: 200,
      payload: {
        venue,
        hours_until_meeting: Math.round(hoursUntilGroupMeeting(now, schedule) * 10) / 10,
        due: isGroupMeetingNudgeDue(now, schedule),
        missing,
        stale,
        excluded,
        head_professor_configured: Boolean(headProfessor),
      },
    };
  }

  /**
   * The meeting every group-meeting sweep is aimed at, from settings or the lab's default.
   *
   * Public because the API layer needs it too: resolving the Monday invite means asking the
   * calendar which events land on the scheduled weekday, and a route that guessed "Monday" for
   * itself would drift the moment an admin moved the meeting in settings.
   */
  groupMeetingSchedule(): GroupMeetingSchedule {
    const settings = this.resolveSettings();
    return {
      weekday:
        typeof settings.group_meeting_weekday === "number"
          ? settings.group_meeting_weekday
          : adminBotDefaultGroupMeeting.weekday,
      time: settings.group_meeting_time?.trim() || adminBotDefaultGroupMeeting.time,
      timezone: settings.group_meeting_timezone?.trim() || adminBotDefaultGroupMeeting.timezone,
    };
  }

  /**
   * Send the pre-meeting pre-registration reminders.
   *
   * Refuses outside the twenty-hour window unless `force` says otherwise: the window is the whole
   * point of the message ("before Monday's meeting"), and one sent on a Wednesday is a different,
   * worse message. `force` exists so an admin can send deliberately after checking the preview.
   *
   * One reminder per member per meeting, from the audit ledger -- an hourly cron, a retry and a
   * manual press all collapse into one.
   */
  async sendPreRegistrationNudges(
    actor: string,
    params: { venue?: string; nowIso?: string; force?: boolean } = {},
  ): Promise<
    AdminBotServiceResponse<
      AdminBotMemberNudgeResult & { skipped_reason?: string; asked: string[] }
    >
  > {
    const collected = this.collectPreRegistrationNudges(params);
    if (!collected.ok) {
      return collected;
    }
    const { venue, due, missing, stale } = collected.payload;
    if (!due && params.force !== true) {
      return {
        ok: true,
        status: 200,
        payload: {
          created: [],
          skipped: [],
          asked: [],
          skipped_reason: `not within ${adminBotGroupMeetingNudgeWindowHours} hours of the group meeting`,
        },
      };
    }
    const now = params.nowIso ? new Date(params.nowIso) : new Date();
    const meetingKey = this.groupMeetingKey(now);
    const alreadyAsked = this.preRegistrationAskedFor(meetingKey);
    const created: AdminBotMemberNudgeResult["created"] = [];
    const skipped: AdminBotMemberNudgeResult["skipped"] = [];
    const asked: string[] = [];
    const send = async (memberId: string, message: string) => {
      if (alreadyAsked.has(memberId)) {
        return;
      }
      const result = await this.sendMemberNudge(
        {
          channel: "slack",
          recipient_member_ids: [memberId],
          message,
          kind: "paper_slot",
          title: "Register your paper's target venue",
          tab: "myWork",
          // Important: the sweep runs before the group meeting, and a paper nobody registered is a
          // paper the meeting cannot plan around -- which is only discovered in the meeting.
          important: true,
        },
        actor,
      );
      if (!result.ok) {
        skipped.push({ member_id: memberId, reason: result.error.message });
        return;
      }
      created.push(...result.payload.created);
      skipped.push(...result.payload.skipped);
      if (result.payload.created.length > 0) {
        asked.push(memberId);
      }
    };
    for (const row of missing) {
      await send(
        row.member_id,
        buildPreRegistrationMessage({ venue, paperCount: row.paper_count }),
      );
    }
    for (const row of stale) {
      await send(
        row.member_id,
        buildRegistrationUpdateMessage({ venue, unregistered: row.unregistered }),
      );
    }
    if (asked.length > 0) {
      this.recordAudit({
        type: "prereg.nudged",
        actor,
        details: { meeting: meetingKey, venue, member_ids: asked },
      });
    }
    return { ok: true, status: 200, payload: { created, skipped, asked } };
  }

  /** The meeting a moment belongs to, as a stable key for the ledger. */
  private groupMeetingKey(now: Date): string {
    const hours = hoursUntilGroupMeeting(now, this.groupMeetingSchedule());
    const meeting = new Date(now.getTime() + hours * 60 * 60 * 1000);
    return meeting.toISOString().slice(0, 10);
  }

  private preRegistrationAskedFor(meetingKey: string): Set<string> {
    const asked = new Set<string>();
    for (const event of this.store.listAuditEvents()) {
      if (event.type !== "prereg.nudged") {
        continue;
      }
      const details = event.details as { meeting?: unknown; member_ids?: unknown } | undefined;
      if (details?.meeting !== meetingKey || !Array.isArray(details.member_ids)) {
        continue;
      }
      for (const id of details.member_ids) {
        if (typeof id === "string") {
          asked.add(id);
        }
      }
    }
    return asked;
  }

  /**
   * Every pair of roster rows that looks like one person.
   *
   * Read-only and computed on demand -- see findDuplicateMembers for why it is not an index. This
   * is the list behind the Lab Members duplicates panel; nothing merges without an admin naming
   * both ids.
   */
  listDuplicateMembers(): AdminBotServiceResponse<{
    pairs: MemberDuplicatePair<AdminBotLabMember>[];
  }> {
    return {
      ok: true,
      status: 200,
      payload: { pairs: findDuplicateMembers(this.store.listLabMembers()) },
    };
  }

  /**
   * Fold one roster row into another and retire it.
   *
   * The lab's two ingestion paths -- the Quick-Start survey and the Slack member export -- write
   * different halves of the same person under different ids, so "Terry Jingchen Zhang" holds the
   * career detail and "Terry Zhang" holds the Slack id and the address. Neither page shows the
   * whole person, and every count that walks the roster counts them twice.
   *
   * Three things happen, in this order, and the order matters:
   *
   *   1. the survivor gains everything only the duplicate knew (planMemberMerge; a disagreement
   *      is kept as the survivor's answer and reported, never silently resolved)
   *   2. every row that named the duplicate is repointed at the survivor, including the login
   *      credential -- if the survivor has none of their own
   *   3. the duplicate's sessions are revoked and the row is deleted
   *
   * Reversible only from the audit line, which is why that line carries the whole retired record
   * rather than its id: undoing a merge means re-creating it, and a merge is easy to regret when
   * two people really do share a name.
   */
  mergeLabMembers(params: {
    survivorId: string;
    duplicateId: string;
    actorId: string;
  }): AdminBotServiceResponse<{
    member: AdminBotLabMember;
    conflicts: MemberMergeConflict[];
    moved: Record<string, number>;
  }> {
    if (params.survivorId === params.duplicateId) {
      return serviceError(400, "a member cannot be merged into themselves");
    }
    const survivor = this.store.getLabMember(params.survivorId);
    if (!survivor) {
      return serviceError(404, "member not found");
    }
    const duplicate = this.store.getLabMember(params.duplicateId);
    if (!duplicate) {
      return serviceError(404, "duplicate member not found");
    }
    const now = new Date().toISOString();
    const { patch, conflicts } = planMemberMerge(
      survivor as unknown as Record<string, unknown>,
      duplicate as unknown as Record<string, unknown>,
    );
    const merged: AdminBotLabMember = {
      ...survivor,
      ...(patch as Partial<AdminBotLabMember>),
      id: survivor.id,
      updated_at: now,
    };
    this.store.saveLabMember(merged);
    const moved = this.store.reassignMemberReferences(params.duplicateId, params.survivorId);
    this.store.revokeSessionsForMember(params.duplicateId, now);
    this.store.deleteLabMember(params.duplicateId);
    this.recordAudit({
      type: "lab_member.merged",
      actor: params.actorId,
      details: {
        survivor_id: params.survivorId,
        duplicate_id: params.duplicateId,
        moved,
        conflicts,
        // The whole retired record: a merge has no undo, and an id alone would not be enough to
        // put back what was folded in.
        retired_record: duplicate,
      },
    });
    return { ok: true, status: 200, payload: { member: merged, conflicts, moved } };
  }

  /**
   * Remove one member's record and everything that named them.
   *
   * Distinct from a merge, which is the right tool whenever the person still exists somewhere on
   * the roster: a merge keeps their history under the surviving id, and this does not keep it at
   * all. So this is for rows that should never have been people -- an import artefact, a test row,
   * a duplicate with nothing worth folding in -- and the audit line carries the whole record
   * because, exactly as with a merge, there is no undo and an id alone would not be enough to put
   * back what went.
   *
   * Three refusals, none of them overridable:
   *
   * `self` -- an admin deleting their own record signs themselves out of the tool they are holding
   * and leaves the lab one admin short, and the recovery for it is a database edit.
   *
   * `head professor` -- the escalation path terminates at them (see escalateStaleNudges, which
   * 409s without one), so deleting them silently breaks every important nudge in the system rather
   * than failing anywhere visible.
   *
   * `sign-in credential` -- an account somebody can still log into is an account somebody is still
   * using, whatever the roster says about them. This is the one refusal a caller can lift, with
   * `force`, because an admin retiring a real departed account is the case it would otherwise
   * block; lifting it is recorded in the audit line.
   */
  deleteLabMember(params: {
    memberId: string;
    actorId: string;
    force?: boolean;
  }): AdminBotServiceResponse<{
    deleted_id: string;
    deleted_name: string;
    removed: Record<string, number>;
  }> {
    const member = this.store.getLabMember(params.memberId);
    if (!member) {
      return serviceError(404, "member not found");
    }
    const refusal = this.refuseMemberDeletion(member, params.actorId, params.force === true);
    if (refusal) {
      return serviceError(refusal.status, refusal.message);
    }
    const now = new Date().toISOString();
    const hadCredential = Boolean(this.store.getCredentialByMemberId(member.id));
    // Sessions first and through the revoke path rather than the purge, so a signed-in browser
    // stops working by the route that records that it did -- same order as the merge.
    this.store.revokeSessionsForMember(member.id, now);
    const removed = this.store.purgeMemberReferences(member.id);
    this.store.deleteLabMember(member.id);
    this.recordAudit({
      type: "lab_member.deleted",
      actor: params.actorId,
      details: {
        member_id: member.id,
        removed,
        forced: params.force === true,
        had_credential: hadCredential,
        // The whole record, for the same reason the merge keeps one: this has no undo.
        deleted_record: member,
      },
    });
    return {
      ok: true,
      status: 200,
      payload: { deleted_id: member.id, deleted_name: member.name, removed },
    };
  }

  /**
   * The shared refusal, so the single delete and the bulk purge cannot drift apart on who is safe
   * to remove. Returns the reason, or undefined when the member may go.
   */
  private refuseMemberDeletion(
    member: AdminBotLabMember,
    actorId: string,
    force: boolean,
  ): { status: number; message: string } | undefined {
    if (member.id === actorId) {
      return { status: 400, message: "an admin cannot delete their own member record" };
    }
    const headProfessorId = this.resolveSettings().head_professor_member_id?.trim();
    if (headProfessorId && member.id === headProfessorId) {
      return {
        status: 409,
        message: "the head professor cannot be deleted while nudge escalation points at them",
      };
    }
    if (!force && this.store.getCredentialByMemberId(member.id)) {
      return {
        status: 409,
        message:
          "this member has a sign-in credential; delete it deliberately with force if the account is genuinely retired",
      };
    }
    return undefined;
  }

  /**
   * The roster rows carrying no address of any kind, and whether each may be deleted.
   *
   * "No email" means all three columns blank *and* no alternates: `email` is the identity the lab
   * keys a person by, but a bulk-imported row routinely has only a `correspondence_email` or a
   * `calendar_email`, and treating those rows as address-less would delete people the lab can
   * still write to. Checked against the same trio `sendMemberNudge` would try, so "we cannot reach
   * this person" and "this row is a candidate" are the same question.
   *
   * A read, so it is safe to call from the page that offers the delete -- the preview and the
   * purge run the same walk, and the purge takes nothing from the caller but the confirmation.
   */
  listMembersWithoutEmail(actorId: string): AdminBotServiceResponse<{
    deletable: Array<{ id: string; name: string; attached_rows: number }>;
    blocked: Array<{ id: string; name: string; reason: string }>;
  }> {
    const deletable: Array<{ id: string; name: string; attached_rows: number }> = [];
    const blocked: Array<{ id: string; name: string; reason: string }> = [];
    for (const member of this.store.listLabMembers()) {
      if (memberHasAnyEmail(member)) {
        continue;
      }
      const refusal = this.refuseMemberDeletion(member, actorId, false);
      if (refusal) {
        blocked.push({ id: member.id, name: member.name, reason: refusal.message });
        continue;
      }
      deletable.push({
        id: member.id,
        name: member.name,
        // Counted from the notification table alone rather than every owned table: it is the one
        // that accumulates on a row nobody has ever signed into, so it is what an admin is
        // actually deciding to throw away.
        attached_rows: this.store.listMemberNotifications(member.id).length,
      });
    }
    return { ok: true, status: 200, payload: { deletable, blocked } };
  }

  /**
   * Delete every member the lab has no address for.
   *
   * Never forces. The single delete takes `force` because an admin naming one person has looked at
   * that person; a sweep has not, and a credentialed row is exactly the one this must not take --
   * on this roster the row with no email and a password is the shared `admin` login, which a bulk
   * "delete everyone we cannot email" would otherwise remove. Those come back in `blocked` for an
   * admin to handle one at a time.
   *
   * `dryRun` is the default. This is not undoable and it is not small, so the caller has to ask
   * for the write explicitly.
   */
  deleteMembersWithoutEmail(params: { actorId: string; dryRun?: boolean }): AdminBotServiceResponse<{
    deleted: Array<{ id: string; name: string }>;
    blocked: Array<{ id: string; name: string; reason: string }>;
    removed: Record<string, number>;
    dry_run: boolean;
  }> {
    const dryRun = params.dryRun !== false;
    const listed = this.listMembersWithoutEmail(params.actorId);
    if (!listed.ok) {
      return listed;
    }
    const { deletable, blocked } = listed.payload;
    const deleted: Array<{ id: string; name: string }> = [];
    const removed: Record<string, number> = {};
    if (!dryRun) {
      for (const candidate of deletable) {
        // Through the single delete rather than around it, so the guards are re-checked against
        // the state this loop is leaving behind rather than the snapshot it started from.
        const result = this.deleteLabMember({ memberId: candidate.id, actorId: params.actorId });
        if (!result.ok) {
          blocked.push({ id: candidate.id, name: candidate.name, reason: result.error.message });
          continue;
        }
        deleted.push({ id: candidate.id, name: candidate.name });
        for (const [key, count] of Object.entries(result.payload.removed)) {
          removed[key] = (removed[key] ?? 0) + count;
        }
      }
      this.recordAudit({
        type: "lab_members.purged_without_email",
        actor: params.actorId,
        details: { deleted: deleted.length, blocked: blocked.length, removed },
      });
    }
    return {
      ok: true,
      status: 200,
      payload: {
        deleted: dryRun ? deletable.map(({ id, name }) => ({ id, name })) : deleted,
        blocked,
        removed,
        dry_run: dryRun,
      },
    };
  }

  /**
   * Record what somebody thought of one surface.
   *
   * Any principal may write one, including an anonymous caller: the widget sits behind a login
   * today, but refusing unauthenticated feedback would mean the first public surface to carry it
   * silently drops every rating. What an anonymous row cannot do is accumulate -- it keys on the
   * feature alone, so the last one stands (see adminBotFeedbackId).
   *
   * The rating is validated rather than clamped. A 0 or a 7 means the caller and this service
   * disagree about the scale, and quietly turning it into a 1 or a 5 would put a number nobody
   * chose into the average.
   */
  recordFeedback(input: {
    featureId: string;
    rating: number;
    comment?: string;
    githubFile?: string;
    memberId?: string;
    memberName?: string;
  }): AdminBotServiceResponse<{ entry: AdminBotFeedbackEntry }> {
    const featureId = input.featureId.trim();
    if (!featureId) {
      return serviceError(400, "feedback needs a feature id");
    }
    if (
      !Number.isInteger(input.rating) ||
      input.rating < adminBotFeedbackMinRating ||
      input.rating > adminBotFeedbackMaxRating
    ) {
      return serviceError(
        400,
        `rating must be a whole number from ${adminBotFeedbackMinRating} to ${adminBotFeedbackMaxRating}`,
      );
    }
    const now = new Date().toISOString();
    const id = adminBotFeedbackId(featureId, input.memberId);
    const existing = this.store.listFeedback(featureId).find((entry) => entry.id === id);
    const comment = input.comment?.trim().slice(0, adminBotFeedbackCommentMax);
    const entry: AdminBotFeedbackEntry = {
      id,
      feature_id: featureId,
      rating: input.rating,
      ...(comment ? { comment } : {}),
      ...(input.githubFile ? { github_file: input.githubFile } : {}),
      ...(input.memberId ? { member_id: input.memberId } : {}),
      ...(input.memberName ? { member_name: input.memberName } : {}),
      // Kept from the first submission: "when did this person first tell us" is the question a
      // changed rating should not be able to reset.
      submitted_at: existing?.submitted_at ?? now,
      updated_at: now,
    };
    this.store.saveFeedback(entry);
    this.recordAudit({
      type: "feedback.recorded",
      ...(input.memberId ? { actor: input.memberId } : {}),
      details: { feature_id: featureId, rating: input.rating, has_comment: Boolean(comment) },
    });
    return { ok: true, status: 200, payload: { entry } };
  }

  /**
   * Every verdict, and the per-surface summary over them.
   *
   * Worst-rated first: the list exists to find what is not working, and a table sorted by feature
   * name buries that under whatever happens to start with an A.
   */
  listFeedback(featureId?: string): AdminBotServiceResponse<{
    entries: AdminBotFeedbackEntry[];
    summaries: AdminBotFeedbackSummary[];
  }> {
    const entries = this.store.listFeedback(featureId);
    return {
      ok: true,
      status: 200,
      payload: { entries, summaries: summarizeAdminBotFeedback(entries) },
    };
  }

  // Self-service profile edit for a member principal. Only the whitelisted profile fields are
  // writable here; privilege_level/access_overrides/status/email are governance-owned and never
  // accepted from the member's own request so a member cannot escalate their own access.
  /**
   * A member editing their own record.
   *
   * Every field this writes is stamped `member`, which is what the adoption rate counts. The stamp
   * comes from the route's authentication, not from the body -- a client cannot claim authorship of
   * a field by asking to.
   */
  updateOwnProfile(
    memberId: string,
    input: Record<string, unknown>,
  ): AdminBotServiceResponse<AdminBotLabMember> {
    const existing = this.store.getLabMember(memberId);
    if (!existing) {
      return serviceError(404, "member not found");
    }
    for (const field of SELF_PROFILE_PRIVILEGED_FIELDS) {
      if (input[field] !== undefined) {
        return serviceError(400, `${field} cannot be changed from a self profile update`);
      }
    }
    const patch: Partial<AdminBotLabMemberInput> = {};
    for (const field of SELF_PROFILE_EDITABLE_FIELDS) {
      if (input[field] !== undefined) {
        (patch as Record<string, unknown>)[field] = input[field];
      }
    }
    // Drop the parsed availability when rebuilding the input: leaving it undefined makes
    // upsertLabMember keep what is stored unless this request actually sent new text.
    const { availability: _stored, ...existingFields } = existing;
    const merged: AdminBotLabMemberInput = {
      ...existingFields,
      ...patch,
      id: memberId,
      privilege_level: existing.privilege_level,
    };
    const saved = this.upsertLabMember(merged, { source: "member", actor: memberId });
    // The member has just answered; anything still chasing them for an answer they have now given
    // is noise. Retracted here rather than only on the next sweep so the bell, the dashboard card
    // and the toast all go quiet on the save that fixed them, which is when the member is looking.
    if (saved.ok) {
      this.retractSettledProfileNudges(memberId);
    }
    return saved;
  }

  /**
   * Close out profile reminders the member has since acted on.
   *
   * A notification is a point-in-time copy of a sentence, not a live view of the gap that produced
   * it, and nothing used to take one back. So a member who filled in the last blank kept the unread
   * copy forever: the bell stayed lit, the dashboard card stayed up, `popNotification` re-toasted it
   * on every new session, and -- because profile reminders are filed `important` -- escalateStaleNudges
   * eventually group-DMed the head professor to chase somebody who had already done it. That is the
   * "my profile says 100% and it still tells me it is incomplete" report, and the 100% was right.
   *
   * Marked read rather than deleted. Read is the watermark every one of those readers already
   * honours, and the member keeps the record of what they were asked and when -- which is the half
   * of a notification log that is worth keeping.
   */
  private retractSettledProfileNudges(memberId: string): void {
    const member = this.store.getLabMember(memberId);
    if (!member) {
      return;
    }
    // Both halves, because one message can carry both and it is filed once. Still-outstanding gaps
    // leave their notification alone: this retracts what is settled, it does not mark things read.
    const stillMissing = missingMandatoryProfileFields(member).length > 0;
    const stillShort =
      isAdminBotFullMember(member) &&
      countTimelineEntries(member).total < adminBotTimelineEntryTarget;
    if (stillMissing || stillShort) {
      return;
    }
    const readAt = new Date().toISOString();
    for (const notification of this.store.listMemberNotifications(memberId)) {
      if (notification.kind !== "profile" || notification.read_at) {
        continue;
      }
      this.store.saveMemberNotification({ ...notification, read_at: readAt });
    }
  }

  // Creates or edits a paper on behalf of the member themselves, so authors can file and maintain
  // their own submissions without an admin. Ownership is checked against the *stored* record, so a
  // member cannot take over someone else's paper by adding their own name to the authors they send.
  upsertOwnPaper(
    memberId: string,
    input: Record<string, unknown>,
  ): AdminBotServiceResponse<AdminBotPaperRecord> {
    const member = this.store.getLabMember(memberId);
    if (!member) {
      return serviceError(404, "member not found");
    }
    for (const field of OWN_PAPER_PRIVILEGED_FIELDS) {
      if (input[field] !== undefined) {
        return serviceError(400, `${field} cannot be set from a member paper update`);
      }
    }
    const paperId = typeof input.id === "string" ? input.id.trim() : "";
    if (!paperId) {
      return serviceError(400, "paper id is required");
    }
    const existing = this.store.getPaper(paperId);
    if (existing && !this.memberOwnsPaper(member, existing)) {
      return serviceError(403, "members can only edit papers they authored");
    }
    const patch: Record<string, unknown> = {};
    for (const field of OWN_PAPER_EDITABLE_FIELDS) {
      if (input[field] !== undefined) {
        patch[field] = input[field];
      }
    }
    return this.upsertPaper(
      {
        ...existing,
        ...(patch as Partial<AdminBotPaperRecordInput>),
        id: paperId,
        title: typeof patch.title === "string" ? patch.title : (existing?.title ?? ""),
        authors: Array.isArray(patch.authors)
          ? (patch.authors as string[])
          : (existing?.authors ?? []),
        current_step: (patch.current_step ??
          existing?.current_step ??
          "brainstorming_docs") as AdminBotPaperStep,
        artifacts: { ...existing?.artifacts, ...(patch.artifacts as AdminBotPaperArtifactLinks) },
        // Stamped once, on the create. Re-stamping on every edit would let the last member to
        // touch a shared paper claim it.
        submitted_by_member_id: existing?.submitted_by_member_id ?? memberId,
      },
      { source: "member", actor: memberId },
    );
  }

  // A member owns a paper they filed, or one that names them in `authors`. Author entries are free
  // text, so an id or email matches outright while a bare name only counts when it is unambiguous
  // on the roster — otherwise two people sharing a name would inherit each other's edit rights.
  /**
   * Whose paper is this?
   *
   * Everyone who wrote it, not whoever filed it. `author_links` is the answer somebody recorded
   * when they picked the author, and it is checked first because it is the only one of these that
   * is not a guess. The name matching below it survives for papers written before the picker
   * existed -- it is why the first save on an old paper quietly links it, after which this method
   * never has to guess about that paper again.
   */
  private memberOwnsPaper(member: AdminBotLabMember, paper: AdminBotPaperRecord): boolean {
    if (paper.submitted_by_member_id === member.id) {
      return true;
    }
    if (paper.first_author_member_id === member.id) {
      return true;
    }
    if (authorMemberIds(paper.author_links ?? []).includes(member.id)) {
      return true;
    }
    const authors = paper.authors.map((author) => author.trim().toLocaleLowerCase());
    const unique = [member.id, member.email]
      .flatMap((value) => (value ? [value.toLocaleLowerCase()] : []))
      .some((value) => authors.includes(value));
    if (unique) {
      return true;
    }
    const name = member.name.trim().toLocaleLowerCase();
    if (!name || !authors.includes(name)) {
      return false;
    }
    return (
      this.store.listLabMembers().filter((entry) => entry.name.trim().toLocaleLowerCase() === name)
        .length === 1
    );
  }

  // Records a member reading one onboarding step. Members act only on their own checklist, so the
  // caller's id is the record we touch -- there is no step-id path that reaches anyone else's.
  acknowledgeOwnOnboardingStep(
    memberId: string,
    stepId: string,
  ): AdminBotServiceResponse<{ onboarding: AdminBotMemberOnboarding }> {
    const member = this.store.getLabMember(memberId);
    if (!member) {
      return serviceError(404, "member not found");
    }
    if (!member.onboarding) {
      return serviceError(404, "member has no onboarding checklist");
    }
    const onboarding = acknowledgeOnboardingStep(
      member.onboarding,
      stepId,
      new Date().toISOString(),
    );
    if (!onboarding) {
      return serviceError(404, "onboarding step not found");
    }
    this.store.saveLabMember({ ...member, onboarding, updated_at: new Date().toISOString() });
    return { ok: true, status: 200, payload: { onboarding } };
  }

  // Case-insensitive relevance match of a member's research focus against paper metadata.
  listPapersRelevantToMember(
    memberId: string,
  ): AdminBotServiceResponse<{ papers: AdminBotPaperRecord[] }> {
    const member = this.store.getLabMember(memberId);
    if (!member) {
      return serviceError(404, "member not found");
    }
    const needles = memberRelevanceNeedles(member);
    const papers = this.store.listPapers().filter((paper) => paperMatchesNeedles(paper, needles));
    return { ok: true, status: 200, payload: { papers: papers.map(withPaperTimeline) } };
  }

  /**
   * `origin` names the person, not the paper.
   *
   * This used to record `actor: paper.id` -- the audit row said which paper changed and had no
   * room left to say who changed it, so "a member updated their paper and I cannot see it on my
   * side" was unanswerable from the trail. The paper id moves into `details` where it always
   * belonged, and the actor becomes the member the route authenticated.
   */
  upsertPaper(
    paper: AdminBotPaperRecordInput,
    origin: AdminBotWriteOrigin = {},
  ): AdminBotServiceResponse<AdminBotPaperRecord> {
    const validation = validatePaper(paper);
    if (validation) {
      return serviceError(400, validation);
    }
    const existing = this.store.getPaper(paper.id);
    const settings = this.resolveSettings();
    const now = new Date().toISOString();
    const headProfessorMemberId =
      paper.reminder?.head_professor_member_id ??
      existing?.reminder?.head_professor_member_id ??
      settings.head_professor_member_id;
    const stored: AdminBotPaperRecord = {
      ...existing,
      ...paper,
      // Both name lists are trimmed and de-blanked on write rather than on read. The stage sweep
      // matches authors by name and an empty row would look like an author nobody can resolve,
      // which reads as "this paper has no lab member on it" -- the one state that stops the chase.
      // The author list, resolved to people. `authors` is regenerated from the links rather than
      // stored alongside them, so the printed spelling and the identities behind it cannot drift;
      // a caller that sent only names gets whatever the roster can unambiguously name linked for
      // them, which is what repairs every paper filed before the picker existed.
      ...(() => {
        const links = buildAuthorLinks({
          ...(paper.author_links ? { links: paper.author_links } : {}),
          names: paper.authors,
          roster: this.store.listLabMembers(),
        });
        return { author_links: links, authors: authorNamesFromLinks(links) };
      })(),
      // Stored in the shape the Slack channel name is read off directly, so `proj-<alias>` is
      // knowable from the record without transforming it at the point of use. validatePaper has
      // already refused anything this cannot normalize, so the fallback here only ever handles the
      // deliberate clear ("" removes the alias).
      ...(paper.alias === undefined
        ? {}
        : { alias: adminBotNormalizePaperAlias(paper.alias) ?? undefined }),
      ...(paper.started_on === undefined
        ? {}
        : { started_on: String(paper.started_on).trim() || undefined }),
      ...(paper.feedback_givers === undefined
        ? {}
        : { feedback_givers: normalizeNameList(paper.feedback_givers) }),
      // Trimmed on write like the name lists, so "cleared" is an empty string rather than a field
      // holding a newline that reads as filled in everywhere it is checked.
      ...(paper.author_roles === undefined ? {} : { author_roles: paper.author_roles.trim() }),
      artifacts: {
        ...existing?.artifacts,
        ...paper.artifacts,
      },
      checks: {
        ...existing?.checks,
        ...paper.checks,
      },
      reminder: {
        ...existing?.reminder,
        ...paper.reminder,
        escalation_after_business_days:
          paper.reminder?.escalation_after_business_days ??
          existing?.reminder?.escalation_after_business_days ??
          settings.paper_escalation_business_days,
        ...(headProfessorMemberId ? { head_professor_member_id: headProfessorMemberId } : {}),
      },
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.store.savePaper(stored);
    this.recordAudit({
      type: "paper.upserted",
      // Automation and the importer still write papers with nobody to name; those keep an absent
      // actor rather than borrowing the paper's id, so "unattributed" stays visibly unattributed.
      ...(origin.actor ? { actor: origin.actor } : {}),
      details: {
        paper_id: paper.id,
        current_step: paper.current_step,
        author_count: paper.authors.length,
      },
    });
    // Only when somebody is named. A row whose member_id is blank answers nothing this table is
    // for, and it would quietly inflate any count of who has touched a paper.
    if (origin.actor) {
      this.recordUpdateEvents({
        subject: "paper",
        slotIds: [paperRecordSlotId(paper.id)],
        memberId: origin.actor,
        source: origin.source ?? "import",
        at: now,
      });
    }
    return { ok: true, status: 200, payload: stored };
  }

  /**
   * One paper's evidence slots, every one of the 23, stored or not.
   *
   * The blanks are part of the answer: the card is a checklist, and a checklist that only lists
   * the boxes somebody already ticked is not one.
   */
  /**
   * One paper's evidence slots, every one of the 25, stored or not.
   *
   * The blanks are part of the answer: the card is a checklist, and a checklist that only lists
   * the boxes somebody already ticked is not one. Credentials come back only for an author of the
   * paper or an admin.
   */
  listPaperSlots(
    paperId: string,
    viewer?: { memberId?: string; isAdmin?: boolean },
  ): AdminBotServiceResponse<{
    paper: AdminBotPaperRecord;
    slots: AdminBotPaperSlotRecord[];
    drafts: AdminBotSocialDraftRecord[];
    consents: AdminBotSocialConsentRecord[];
    attendees: AdminBotConferenceAttendeeRecord[];
    reimbursements: AdminBotPaperReimbursementRecord[];
    /** The venue ladder, in order, with the mail that closed each rung. */
    paperflow_stages: AdminBotPaperflowStageView[];
    /** Who wrote what about their own week, newest week first. */
    weekly_updates: AdminBotPaperWeeklyUpdate[];
    cycle_closed: boolean;
    missing_acceptance_details: string[];
  }> {
    const paper = this.store.getPaper(paperId);
    if (!paper) {
      return serviceError(404, "paper not found");
    }
    const drafts = this.store.listSocialDrafts(paperId);
    const stored = this.store.listPaperSlots(paperId);
    const attendees = this.store.listConferenceAttendees(paperId);
    const reimbursements = this.store.listPaperReimbursements(paperId);
    const entitled = Boolean(
      viewer?.isAdmin || (viewer?.memberId && this.memberOwnsPaperId(viewer.memberId, paper)),
    );
    return {
      ok: true,
      status: 200,
      payload: {
        paper,
        slots: redactPaperSlots(paperSlotRows(paperId, stored, drafts), entitled),
        drafts,
        consents: drafts.flatMap((draft) => this.store.listSocialConsents(draft.id)),
        attendees,
        reimbursements,
        paperflow_stages: this.paperflowStageViews(paper, stored),
        // Carried on the same read as the rest of the cycle: the card opens once and the weekly
        // log is part of what "this paper right now" means, so a second fetch would only add a
        // second thing that can be stale.
        weekly_updates: this.store.listPaperWeeklyUpdates({ paperId }),
        cycle_closed: isCycleClosed({
          paper,
          slots: stored,
          drafts,
          attendees,
          reimbursements,
        }),
        missing_acceptance_details: missingAcceptanceDetails(paper),
      },
    };
  }

  /**
   * The venue ladder for one paper: every stage, in order, and what closed it.
   *
   * All five rungs are returned whether or not they have happened, for the same reason the slot
   * read returns blanks -- the card is a picture of the whole cycle, and one that only listed the
   * rungs already climbed would keep growing as the paper progressed, which reads as the venue
   * inventing new requirements rather than the paper moving through known ones.
   */
  private paperflowStageViews(
    paper: AdminBotPaperRecord,
    slots: AdminBotPaperSlotRecord[],
  ): AdminBotPaperflowStageView[] {
    const evidence = this.store.listPaperflowEvidence(paper.id);
    const open = openPaperflowStage({ paper, slots, evidence, now: new Date() });
    return adminBotPaperflowStages.map((stage) => {
      const closed = evidence.find((row) => row.stage === stage);
      const definition = adminBotPaperflowStageRegistry[stage];
      const view: AdminBotPaperflowStageView = {
        stage,
        label: definition.label,
        node: definition.node,
        // Three states, never two: "closed", "this is the one we are waiting on", and "not yet
        // reached". Collapsing the last two would make a paper that has not been submitted look
        // like a paper whose decision is overdue.
        state: closed ? "closed" : open?.stage === stage ? "waiting" : "upcoming",
      };
      if (closed?.recorded_at) {
        view.closed_at = closed.recorded_at;
      }
      if (closed?.subject) {
        view.closed_by_subject = closed.subject;
      }
      if (closed?.recorded_by) {
        view.closed_by = closed.recorded_by;
      }
      return view;
    });
  }

  /**
   * Write one slot on one paper.
   *
   * `status` is never taken from the caller -- applyPaperSlotWrite derives it from the value, so
   * "provided" always means something was actually provided. Ownership is the same rule the paper
   * itself uses: an admin writes any paper, a member writes one they filed or are named on.
   */
  setPaperSlot(params: {
    paperId: string;
    slot: string;
    input: AdminBotPaperSlotInput;
    memberId: string;
    privileged: boolean;
  }): AdminBotServiceResponse<{ slot: AdminBotPaperSlotRecord }> {
    const context = this.paperSlotContext(params);
    if (!context.ok) {
      return context.error;
    }
    const result = applyPaperSlotWrite({
      existing: context.existing,
      input: params.input,
      memberId: params.memberId,
      now: new Date(),
    });
    if (!result.ok) {
      return serviceError(400, result.error);
    }
    this.store.savePaperSlot(result.record);
    // Finishing a slot is a change to the paper, so the paper has to say it changed. Without this
    // the checklist advanced while `paper.updated_at` sat still, and every reader that sorts or
    // reports on recency -- the admin's paper card, any "what moved this week" digest -- showed a
    // paper as untouched while its author was working through it.
    const slotWriteAt = result.record.provided_at ?? new Date().toISOString();
    if ((context.paper.updated_at ?? "") < slotWriteAt) {
      this.store.savePaper({ ...context.paper, updated_at: slotWriteAt });
    }
    // The slot row keeps only the latest writer; this keeps all of them. `privileged` is the same
    // flag the ownership check above ran on, so an admin filling in somebody else's slot is
    // recorded as an admin edit and never counts as that author adopting the checklist.
    this.recordUpdateEvents({
      subject: "paper_slot",
      slotIds: [paperSlotId(params.paperId, result.record.slot)],
      memberId: params.memberId,
      source: params.privileged ? "admin" : "member",
      at: result.record.provided_at ?? new Date().toISOString(),
    });
    // Deliberately no value in the audit details: one of these slots holds a credential, and an
    // audit trail is read by more people than the paper is.
    this.recordAudit({
      type: "paper_slot.updated",
      actor: params.memberId,
      details: {
        paper_id: params.paperId,
        slot: result.record.slot,
        status: result.record.status,
      },
    });
    return { ok: true, status: 200, payload: { slot: result.record } };
  }

  /**
   * Waive a slot. Admin-only: it is the one way a required artifact stops being required, so it is
   * the one write a member must not be able to make on their own paper.
   *
   * This is also what stops the checklist from deadlocking a paper that legitimately has no poster
   * or gets no submission id -- nothing hard-blocks a step, but a slot left open forever is a
   * standing false claim that somebody still owes something.
   */
  waivePaperSlot(params: {
    paperId: string;
    slot: string;
    reason: string;
    memberId: string;
  }): AdminBotServiceResponse<{ slot: AdminBotPaperSlotRecord }> {
    const context = this.paperSlotContext({ ...params, privileged: true });
    if (!context.ok) {
      return context.error;
    }
    const result = waivePaperSlot({
      existing: context.existing,
      memberId: params.memberId,
      reason: params.reason,
      now: new Date(),
    });
    if (!result.ok) {
      return serviceError(400, result.error);
    }
    this.store.savePaperSlot(result.record);
    this.recordAudit({
      type: "paper_slot.waived",
      actor: params.memberId,
      details: { paper_id: params.paperId, slot: result.record.slot, reason: params.reason },
    });
    return { ok: true, status: 200, payload: { slot: result.record } };
  }

  /** Shared lookup and permission check behind both slot writes. */
  private paperSlotContext(params: {
    paperId: string;
    slot: string;
    memberId: string;
    privileged: boolean;
  }):
    | { ok: true; paper: AdminBotPaperRecord; existing: AdminBotPaperSlotRecord }
    | { ok: false; error: AdminBotServiceResponse<never> } {
    const paper = this.store.getPaper(params.paperId);
    if (!paper) {
      return { ok: false, error: serviceError(404, "paper not found") };
    }
    if (!isAdminBotPaperSlot(params.slot)) {
      return { ok: false, error: serviceError(400, "unknown slot") };
    }
    if (!params.privileged && !this.memberOwnsPaperId(params.memberId, paper)) {
      return {
        ok: false,
        error: serviceError(403, "members can only edit papers they authored"),
      };
    }
    const stored = this.store
      .listPaperSlots(params.paperId)
      .find((record) => record.slot === params.slot);
    return { ok: true, paper, existing: stored ?? blankPaperSlot(params.paperId, params.slot) };
  }

  private memberOwnsPaperId(memberId: string, paper: AdminBotPaperRecord): boolean {
    const member = this.store.getLabMember(memberId);
    return Boolean(member && this.memberOwnsPaper(member, paper));
  }

  /**
   * Save a social draft, superseding whatever it replaces.
   *
   * The previous approved-or-circulated draft for the same platform is marked `superseded` rather
   * than deleted, because the question "what did they actually agree to" has to stay answerable
   * after somebody regenerates the copy.
   */
  saveSocialDraft(params: {
    paperId: string;
    platform: string;
    body: string;
    model?: string;
    memberId: string;
    privileged: boolean;
  }): AdminBotServiceResponse<{ draft: AdminBotSocialDraftRecord }> {
    const paper = this.store.getPaper(params.paperId);
    if (!paper) {
      return serviceError(404, "paper not found");
    }
    if (!params.privileged && !this.memberOwnsPaperId(params.memberId, paper)) {
      return serviceError(403, "members can only edit papers they authored");
    }
    if (params.platform !== "x" && params.platform !== "linkedin") {
      return serviceError(400, "platform must be x or linkedin");
    }
    const body = params.body.trim();
    if (!body) {
      return serviceError(400, "a draft needs a body");
    }
    const now = new Date().toISOString();
    const draft: AdminBotSocialDraftRecord = {
      // Random suffix, not just the clock: two saves inside the same millisecond would otherwise
      // share an id, and the second would upsert over the first instead of superseding it --
      // losing the very version somebody may already have consented to.
      id: `${params.paperId}-${params.platform}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      paper_id: params.paperId,
      platform: params.platform,
      body,
      generated_at: now,
      generated_by_member_id: params.memberId,
      status: "draft",
      ...(params.model ? { model: params.model } : {}),
    };
    for (const existing of this.store.listSocialDrafts(params.paperId)) {
      if (existing.platform !== params.platform || existing.status === "superseded") {
        continue;
      }
      this.store.saveSocialDraft({
        ...existing,
        status: "superseded",
        superseded_by: draft.id,
      });
    }
    this.store.saveSocialDraft(draft);
    this.recordAudit({
      type: "paper_social_draft.saved",
      actor: params.memberId,
      details: { paper_id: params.paperId, platform: params.platform, draft_id: draft.id },
    });
    return { ok: true, status: 200, payload: { draft } };
  }

  /**
   * Ask the paper's lab-member authors to sign off on a draft.
   *
   * Only authors who resolve to a roster member get a row. AdminBot cannot reach an external
   * coauthor, and a consent row for somebody it can never ask is a draft that can never be
   * approved -- the first author handles those by email, as they already do.
   */
  circulateSocialDraft(params: {
    draftId: string;
    memberId: string;
    privileged: boolean;
  }): AdminBotServiceResponse<{ draft: AdminBotSocialDraftRecord; asked: string[] }> {
    const draft = this.store.listSocialDrafts().find((row) => row.id === params.draftId);
    if (!draft) {
      return serviceError(404, "draft not found");
    }
    const paper = this.store.getPaper(draft.paper_id);
    if (!paper) {
      return serviceError(404, "paper not found");
    }
    if (!params.privileged && !this.memberOwnsPaperId(params.memberId, paper)) {
      return serviceError(403, "members can only edit papers they authored");
    }
    if (draft.status === "superseded") {
      return serviceError(400, "that draft has been replaced by a newer one");
    }
    const audience = resolveConsentAudience({
      authors: paper.authors,
      roster: this.store.listLabMembers(),
      // The person circulating it does not consent to their own draft.
      exclude: params.memberId,
    });
    const now = new Date().toISOString();
    const existing = new Map(
      this.store.listSocialConsents(draft.id).map((row) => [row.member_id, row]),
    );
    for (const memberId of audience) {
      if (existing.has(memberId)) {
        continue;
      }
      this.store.saveSocialConsent({
        draft_id: draft.id,
        member_id: memberId,
        decision: "pending",
        asked_at: now,
      });
    }
    const circulated: AdminBotSocialDraftRecord = { ...draft, status: "circulated" };
    this.store.saveSocialDraft(circulated);
    this.recordAudit({
      type: "paper_social_draft.circulated",
      actor: params.memberId,
      details: { paper_id: paper.id, draft_id: draft.id, asked: audience.length },
    });
    // Nobody on the roster to ask means nothing to wait for; approve it rather than parking the
    // paper behind a consent round with no participants.
    return {
      ok: true,
      status: 200,
      payload: { draft: this.refreshDraftApproval(circulated), asked: audience },
    };
  }

  /** One author's answer on one draft. Only that author may give it. */
  recordSocialConsent(params: {
    draftId: string;
    memberId: string;
    decision: string;
    comment?: string;
  }): AdminBotServiceResponse<{ draft: AdminBotSocialDraftRecord }> {
    const draft = this.store.listSocialDrafts().find((row) => row.id === params.draftId);
    if (!draft) {
      return serviceError(404, "draft not found");
    }
    if (params.decision !== "ok" && params.decision !== "changes_requested") {
      return serviceError(400, "decision must be ok or changes_requested");
    }
    const existing = this.store
      .listSocialConsents(draft.id)
      .find((row) => row.member_id === params.memberId);
    if (!existing) {
      return serviceError(403, "you were not asked to review this draft");
    }
    this.store.saveSocialConsent({
      ...existing,
      decision: params.decision,
      decided_at: new Date().toISOString(),
      ...(params.comment?.trim() ? { comment: params.comment.trim() } : {}),
    });
    this.recordAudit({
      type: "paper_social_consent.recorded",
      actor: params.memberId,
      details: { draft_id: draft.id, decision: params.decision },
    });
    return { ok: true, status: 200, payload: { draft: this.refreshDraftApproval(draft) } };
  }

  /** Promote a circulated draft to approved once no consent row is outstanding. */
  private refreshDraftApproval(draft: AdminBotSocialDraftRecord): AdminBotSocialDraftRecord {
    if (draft.status === "superseded" || draft.status === "draft") {
      return draft;
    }
    const state = draftConsentState(this.store.listSocialConsents(draft.id));
    const next: AdminBotSocialDraftRecord = {
      ...draft,
      status: state.approved ? "approved" : "circulated",
    };
    if (next.status !== draft.status) {
      this.store.saveSocialDraft(next);
    }
    return next;
  }

  /** Who is going. Author-provided; nothing here infers travel. */
  setConferenceAttendee(params: {
    paperId: string;
    name: string;
    memberId?: string;
    attending: string;
    actorId: string;
    privileged: boolean;
  }): AdminBotServiceResponse<{ attendee: AdminBotConferenceAttendeeRecord }> {
    const paper = this.store.getPaper(params.paperId);
    if (!paper) {
      return serviceError(404, "paper not found");
    }
    if (!params.privileged && !this.memberOwnsPaperId(params.actorId, paper)) {
      return serviceError(403, "members can only edit papers they authored");
    }
    if (!isAdminBotAttendanceState(params.attending)) {
      return serviceError(400, "attending must be yes, no or unknown");
    }
    const name = params.name.trim();
    if (!name && !params.memberId) {
      return serviceError(400, "an attendee needs a name");
    }
    const attendee: AdminBotConferenceAttendeeRecord = {
      paper_id: params.paperId,
      attendee_key: adminBotAttendeeKey(params.memberId, name),
      name: name || (this.store.getLabMember(params.memberId ?? "")?.name ?? ""),
      attending: params.attending,
      ...(params.memberId ? { member_id: params.memberId } : {}),
      ...(params.attending === "unknown" ? {} : { confirmed_at: new Date().toISOString() }),
    };
    this.store.saveConferenceAttendee(attendee);
    this.recordAudit({
      type: "paper_attendee.updated",
      actor: params.actorId,
      details: { paper_id: params.paperId, attending: params.attending },
    });
    return { ok: true, status: 200, payload: { attendee } };
  }

  /**
   * One author's reimbursement status on one paper.
   *
   * Status only: the claim itself is filed through the logistics flow, which knows about receipts.
   * This is the lab's answer to "is that person square yet", and every attending author being
   * square is the single condition that closes the paper.
   */
  setPaperReimbursement(params: {
    paperId: string;
    memberId: string;
    status: string;
    actorId: string;
    privileged: boolean;
  }): AdminBotServiceResponse<{ reimbursement: AdminBotPaperReimbursementRecord }> {
    const paper = this.store.getPaper(params.paperId);
    if (!paper) {
      return serviceError(404, "paper not found");
    }
    // Your own row, the paper you authored, or an admin. A reimbursement is somebody's money, so
    // an unrelated member must not be able to declare it settled.
    const isOwn = params.actorId === params.memberId;
    if (!params.privileged && !isOwn && !this.memberOwnsPaperId(params.actorId, paper)) {
      return serviceError(403, "that is not your reimbursement to set");
    }
    if (!isAdminBotReimbursementState(params.status)) {
      return serviceError(400, "unknown reimbursement status");
    }
    const now = new Date().toISOString();
    const existing = this.store
      .listPaperReimbursements(params.paperId)
      .find((row) => row.member_id === params.memberId);
    const reimbursement: AdminBotPaperReimbursementRecord = {
      paper_id: params.paperId,
      member_id: params.memberId,
      status: params.status,
      ...(existing?.submitted_at ? { submitted_at: existing.submitted_at } : {}),
      ...(params.status === "submitted" && !existing?.submitted_at ? { submitted_at: now } : {}),
      ...(params.status === "reimbursed" || params.status === "not_applicable"
        ? { completed_at: existing?.completed_at ?? now }
        : {}),
    };
    this.store.savePaperReimbursement(reimbursement);
    this.recordAudit({
      type: "paper_reimbursement.updated",
      actor: params.actorId,
      details: { paper_id: params.paperId, member_id: params.memberId, status: params.status },
    });
    return { ok: true, status: 200, payload: { reimbursement } };
  }

  /**
   * Every live paper, how much evidence it has, and what is outstanding on it right now.
   *
   * This is the read behind the My Projects & Papers header and the admin sweep: the same
   * computation the nudge pass runs, returned instead of sent. Keeping them on one code path is
   * what makes the button's count honest -- it says what pressing it would actually chase.
   */
  listPaperSlotOverview(nowIso?: string): AdminBotServiceResponse<{
    papers: AdminBotPaperSlotOverviewRow[];
  }> {
    const now = nowIso ? new Date(nowIso) : new Date();
    const ledger = this.nudgeLedgerIndex();
    const papers = this.store.listPapers().map((paper) => {
      const stored = this.store.listPaperSlots(paper.id);
      const drafts = this.store.listSocialDrafts(paper.id);
      const attendees = this.store.listConferenceAttendees(paper.id);
      const reimbursements = this.store.listPaperReimbursements(paper.id);
      const actionable = actionablePaperSlots(paper, stored, now, drafts);
      const progress = paperSlotProgress(paper.id, stored, drafts);
      const lastNudged = actionable
        .map((item) => ledger.get(`paper_slot|${item.subjectId}`)?.last_nudged_at)
        .filter((value): value is string => Boolean(value))
        .toSorted()
        .at(-1);
      const owed = this.resolvePaperSlotOwner(paper, "first_author");
      return {
        paper_id: paper.id,
        title: paper.title,
        ...(paper.venue ? { venue: paper.venue } : {}),
        ...(paper.deadline ? { deadline: paper.deadline } : {}),
        current_step: paper.current_step,
        provided_count: progress.provided,
        required_count: progress.total,
        dormant: isPaperDormant(paper, now),
        closed: isPaperClosed(paper),
        cycle_closed: isCycleClosed({ paper, slots: stored, drafts, attendees, reimbursements }),
        missing_slots: actionable
          .map((item) => item.slot)
          .filter((slot): slot is AdminBotPaperSlot => Boolean(slot)),
        missing_acceptance_details: missingAcceptanceDetails(paper),
        attendance: {
          yes: attendees.filter((row) => row.attending === "yes").length,
          no: attendees.filter((row) => row.attending === "no").length,
          unknown: attendees.filter((row) => row.attending === "unknown").length,
          going: attendees.filter((row) => row.attending === "yes").map((row) => row.name),
        },
        escalating: actionable.some((item) =>
          shouldEscalate(item, ledger.get(`paper_slot|${item.subjectId}`)),
        ),
        ...(owed[0] ? { first_author_member_id: owed[0] } : {}),
        ...(lastNudged ? { last_nudged_at: lastNudged } : {}),
      };
    });
    return { ok: true, status: 200, payload: { papers } };
  }

  /** The ledger as a lookup, keyed the way the sweep asks for it. */
  private nudgeLedgerIndex(): Map<string, AdminBotNudgeLedgerRecord> {
    return new Map(
      this.store
        .listNudgeLedger()
        .map((entry) => [`${entry.domain}|${entry.subject_id}|${entry.member_id}`, entry] as const)
        .flatMap(([key, entry]) => [
          [key, entry] as const,
          // Also indexed without the member, so a caller that only knows the subject (the overview
          // row, which reports the paper rather than one person) can still find the latest stamp.
          [`${entry.domain}|${entry.subject_id}`, entry] as const,
        ]),
    );
  }

  /**
   * Record that a sweep asked somebody about a subject, advancing the count.
   *
   * Every counting sweep stamps identically -- and must, because the count is what
   * `isNudgeDue` reads back to space the next ask and what the escalation pass reads to decide
   * somebody has been asked enough times. Two sweeps that stamp differently would drift apart
   * silently: nothing fails, the cadence just stops meaning the same thing on different domains.
   *
   * The ledger is re-read here rather than passed in, because a caller that indexed the ledger
   * before sending would stamp against counts the send itself has already moved.
   *
   * `snoozed_until` is carried forward deliberately. A snooze is the member's answer, not the
   * sweep's state, so asking again must never quietly clear it.
   */
  private stampNudgeLedger(
    stamps: ReadonlyArray<{ domain: AdminBotNudgeDomain; subjectId: string; memberId: string }>,
    nowIso: string,
  ): void {
    if (stamps.length === 0) {
      return;
    }
    const ledger = this.nudgeLedgerIndex();
    for (const { domain, subjectId, memberId } of stamps) {
      const entry = ledger.get(`${domain}|${subjectId}|${memberId}`);
      this.store.saveNudgeLedgerEntry({
        domain,
        subject_id: subjectId,
        member_id: memberId,
        last_nudged_at: nowIso,
        nudge_count: (entry?.nudge_count ?? 0) + 1,
        ...(entry?.snoozed_until ? { snoozed_until: entry.snoozed_until } : {}),
      });
    }
  }

  /**
   * The say-once ledger: has this subject ever been announced?
   *
   * Distinct from the counting sweeps on purpose. A graduation or a thesis milestone is an event
   * announced once rather than a request repeated until it is answered, so the question is
   * "did we say it" and not "when did we last ask". Looked up by subject alone, because the
   * announcement belongs to the event and not to whoever happened to receive it.
   */
  private hasNudgeBeenSaid(
    ledger: Map<string, AdminBotNudgeLedgerRecord>,
    domain: AdminBotNudgeDomain,
    subjectId: string,
  ): boolean {
    return Boolean(ledger.get(`${domain}|${subjectId}`)?.last_nudged_at);
  }

  /** The write half of `hasNudgeBeenSaid`. Fixed count: a thing said once cannot be said twice. */
  private markNudgeSaid(
    domain: AdminBotNudgeDomain,
    subjectId: string,
    memberId: string,
    nowIso: string,
  ): void {
    this.store.saveNudgeLedgerEntry({
      domain,
      subject_id: subjectId,
      member_id: memberId,
      last_nudged_at: nowIso,
      nudge_count: 1,
    });
  }

  /**
   * Fold one `sendMemberNudge` outcome into a sweep's running result.
   *
   * Returns whether a message actually reached the member, which is the condition every sweep
   * uses to decide whether to stamp the ledger. Keeping that judgement here is the point: a
   * member with no address or no Slack id on file has not been asked, and a sweep that stamped
   * them anyway would count an ask nobody ever received and escalate on it later.
   */
  private absorbNudgeSend(
    result: AdminBotServiceResponse<AdminBotMemberNudgeResult>,
    memberId: string,
    into: { created: AdminBotStoredProposal[]; skipped: AdminBotMemberNudgeSkip[] },
  ): boolean {
    if (!result.ok) {
      into.skipped.push({ member_id: memberId, reason: result.error.message });
      return false;
    }
    into.created.push(...result.payload.created);
    into.skipped.push(...result.payload.skipped);
    return result.payload.created.length > 0;
  }

  /**
   * The global nudge: one Slack message per person, naming exactly what they owe, across every
   * paper they are on.
   *
   * It composes nothing from caller input and picks nobody -- recipients and text are both derived
   * from state and the registry, which is why it can run from a cron script as well as from an
   * admin's button (same reasoning as sendMandatoryFieldsReminders).
   *
   * The cadence lives in the nudge ledger, keyed by (domain, subject, person). That is what makes
   * "one message instead of four" true rather than aspirational: every gatherer below writes into
   * the same clock, so a person is asked about their poster and their unfilled profile in the same
   * breath and is not asked again about either for three days.
   */
  /**
   * Who currently owes what, batched one message per person.
   *
   * The gathering half of the sweep, split out from the sending half so the same walk can answer
   * "what would go out" without anything going out. That split is the whole point of the manual
   * flow: an admin reads the batches, sees the actual wording, and then decides -- rather than
   * pressing a button that composes and sends in one motion and only afterwards says what it did.
   *
   * Recipients and text are derived entirely from state and the registry. Nothing here reads
   * caller input, which is why the preview is trustworthy: it is not a rehearsal of the send, it
   * is the same computation.
   */
  collectPaperNudgeBatches(nowIso?: string): AdminBotServiceResponse<{
    batches: AdminBotNudgeBatch[];
    papers_considered: number;
  }> {
    const now = nowIso ? new Date(nowIso) : new Date();
    const gathered = this.gatherPaperNudges(now);
    const roster = new Map(this.store.listLabMembers().map((member) => [member.id, member]));
    const batches = [...gathered.byRecipient.entries()]
      .map(([memberId, groups]) => {
        const member = roster.get(memberId);
        return {
          member_id: memberId,
          member_name: member?.name ?? memberId,
          // Surfaced so the preview can say why somebody will be skipped *before* the send, rather
          // than reporting it afterwards in a list of failures.
          deliverable: Boolean(member?.slack_user_id),
          item_count: [...groups.values()].reduce((total, group) => total + group.items.length, 0),
          paper_titles: [...groups.keys()],
          message: this.composeNudgeMessage(groups, now),
        };
      })
      .toSorted((left, right) => right.item_count - left.item_count);
    return {
      ok: true,
      status: 200,
      payload: { batches, papers_considered: gathered.papersConsidered },
    };
  }

  /** One person's batch as the message they would actually receive. */
  private composeNudgeMessage(
    groups: Map<string, { venue?: string; deadline?: string; items: NudgeItem[] }>,
    now: Date,
  ): string {
    return buildNudgeMessage({
      groups: [...groups.entries()].map(([title, group]) => ({
        title,
        ...(group.venue ? { venue: group.venue } : {}),
        ...(group.deadline ? { deadline: group.deadline } : {}),
        items: group.items.toSorted((left, right) => left.priority - right.priority),
      })),
      now,
    });
  }

  /**
   * The walk itself: every live paper, everything actionable on it, grouped by who owes it.
   *
   * Filtered against the ledger, so a person who was chased about the same thing two days ago does
   * not appear at all -- the cadence protects people from a repeated manual press exactly as it
   * protected them from a doubled crontab.
   */
  private gatherPaperNudges(now: Date): {
    byRecipient: Map<
      string,
      Map<string, { venue?: string; deadline?: string; items: NudgeItem[] }>
    >;
    stamped: Array<{ item: NudgeItem; memberId: string }>;
    papersConsidered: number;
  } {
    const ledger = this.nudgeLedgerIndex();
    const papers = this.store.listPapers();
    const byRecipient = new Map<
      string,
      Map<string, { venue?: string; deadline?: string; items: NudgeItem[] }>
    >();
    const stamped: Array<{ item: NudgeItem; memberId: string }> = [];

    const enqueue = (memberId: string, paper: AdminBotPaperRecord, item: NudgeItem) => {
      const key = `${item.domain}|${item.subjectId}|${memberId}`;
      if (!isNudgeDue(ledger.get(key), now, PAPER_SLOT_NUDGE_INTERVAL_MS)) {
        return;
      }
      const forMember = byRecipient.get(memberId) ?? new Map();
      const group = forMember.get(paper.title) ?? {
        ...(paper.venue ? { venue: paper.venue } : {}),
        ...(paper.deadline ? { deadline: paper.deadline } : {}),
        items: [],
      };
      group.items.push(item);
      forMember.set(paper.title, group);
      byRecipient.set(memberId, forMember);
      stamped.push({ item, memberId });
    };

    for (const paper of papers) {
      if (isPaperDormant(paper, now) || isPaperClosed(paper)) {
        continue;
      }
      const stored = this.store.listPaperSlots(paper.id);
      const drafts = this.store.listSocialDrafts(paper.id);

      for (const item of actionablePaperSlots(paper, stored, now, drafts)) {
        for (const memberId of this.resolvePaperSlotOwner(paper, item.owner)) {
          enqueue(memberId, paper, item);
        }
      }

      // A circulated draft is waiting on named people, and they are the only ones who can move it.
      for (const draft of drafts) {
        if (draft.status !== "circulated") {
          continue;
        }
        for (const consent of this.store.listSocialConsents(draft.id)) {
          if (consent.decision !== "pending") {
            continue;
          }
          enqueue(consent.member_id, paper, {
            domain: "social_consent",
            subjectId: draft.id,
            owner: "coauthors",
            label: `Sign off on the ${draft.platform === "x" ? "X" : "LinkedIn"} post draft`,
            priority: adminBotPaperSlotBranchPriority.social,
            deadlineBearing: false,
          });
        }
      }

      // The conference half only opens once the acceptance details are in, so a paper nobody has
      // finished recording is not yet asked who is travelling.
      if (!isConferenceBranchOpen(paper)) {
        continue;
      }
      for (const attendee of this.store.listConferenceAttendees(paper.id)) {
        if (attendee.attending !== "unknown") {
          continue;
        }
        for (const memberId of this.resolvePaperSlotOwner(paper, "first_author")) {
          enqueue(memberId, paper, {
            domain: "conference_attendance",
            subjectId: `${paper.id}:${attendee.attendee_key}`,
            owner: "first_author",
            label: `Confirm whether ${attendee.name} is attending`,
            priority: adminBotPaperSlotBranchPriority.venue,
            deadlineBearing: false,
          });
        }
      }
      for (const row of this.store.listPaperReimbursements(paper.id)) {
        if (row.status !== "pending" && row.status !== "submitted") {
          continue;
        }
        enqueue(row.member_id, paper, {
          domain: "paper_reimbursement",
          subjectId: `${paper.id}:${row.member_id}`,
          owner: "first_author",
          label:
            row.status === "pending"
              ? "File your conference reimbursement"
              : "Your reimbursement is submitted and still open",
          priority: adminBotPaperSlotBranchPriority.venue,
          deadlineBearing: false,
        });
      }
    }

    return { byRecipient, stamped, papersConsidered: papers.length };
  }

  /**
   * Send the batches. One Slack message per person, whatever they owe and on however many papers.
   *
   * Manual only: there is no cron behind this. Nudging the lab is a judgement about timing --
   * whether a deadline week is the right moment to chase somebody about a poster -- and the person
   * making that judgement should be looking at the batches when they make it. The route is still
   * gated to a genuine admin session, and the message is still composed entirely from state, so
   * pressing the button asks for the standing rule to be applied now rather than composing
   * anything.
   *
   * `recipientIds` narrows a send to the people an admin picked out of the preview. Omitted, it
   * sends every batch. Either way the batches themselves are recomputed here rather than taken
   * from the caller -- the preview is a view of this computation, never an input to it.
   */
  async sendPaperSlotNudges(
    actor: string,
    options: { recipientIds?: string[] } = {},
  ): Promise<AdminBotServiceResponse<AdminBotMemberNudgeResult & { papers_considered: number }>> {
    const now = new Date();
    const { byRecipient, stamped, papersConsidered } = this.gatherPaperNudges(now);
    const chosen = options.recipientIds?.length ? new Set(options.recipientIds) : undefined;

    if (byRecipient.size === 0) {
      return {
        ok: true,
        status: 200,
        payload: { created: [], skipped: [], papers_considered: papersConsidered },
      };
    }

    const created: AdminBotStoredProposal[] = [];
    const skipped: AdminBotMemberNudgeSkip[] = [];
    const delivered = new Set<string>();
    for (const [memberId, groups] of byRecipient) {
      if (chosen && !chosen.has(memberId)) {
        continue;
      }
      const result = await this.sendMemberNudge(
        {
          channel: "slack",
          recipient_member_ids: [memberId],
          message: this.composeNudgeMessage(groups, now),
          kind: "paper_slot",
          title: "Evidence still missing on your paper",
          tab: "myWork",
          // Important: a missing submission link or camera-ready is the kind of gap that costs a
          // paper its venue, and the deadline does not move because nobody read the DM.
          important: true,
        },
        actor,
      );
      if (this.absorbNudgeSend(result, memberId, { created, skipped })) {
        delivered.add(memberId);
      }
    }

    // Only stamp the people a message actually reached. Somebody with no Slack id on file has not
    // been asked, and must not accumulate an escalation nobody ever told them about.
    this.stampNudgeLedger(
      stamped
        .filter(({ memberId }) => delivered.has(memberId))
        .map(({ item, memberId }) => ({
          domain: item.domain,
          subjectId: item.subjectId,
          memberId,
        })),
      now.toISOString(),
    );
    if (delivered.size > 0) {
      this.recordAudit({
        type: "paper_slots.nudged",
        actor,
        details: { member_ids: [...delivered], item_count: stamped.length },
      });
    }
    return {
      ok: true,
      status: 200,
      payload: { created, skipped, papers_considered: papersConsidered },
    };
  }

  /**
   * Every paper currently waiting on a venue-cycle stage, with who would hear about it.
   *
   * The same computation the stage sweep runs, returned instead of sent -- the same arrangement
   * `collectPaperNudgeBatches` has with `sendPaperSlotNudges`, and for the same reason: a preview
   * that is a different calculation from the send is a preview that lies.
   */
  collectPaperflowStageNudges(nowIso?: string): AdminBotServiceResponse<{
    items: AdminBotPaperflowStageNudge[];
  }> {
    const now = nowIso ? new Date(nowIso) : new Date();
    if (Number.isNaN(now.getTime())) {
      return serviceError(400, "now must be a date");
    }
    return { ok: true, status: 200, payload: { items: this.gatherPaperflowStages(now).items } };
  }

  private gatherPaperflowStages(now: Date): { items: AdminBotPaperflowStageNudge[] } {
    const ledger = this.nudgeLedgerIndex();
    const roster = this.store.listLabMembers();
    const priorityMemberId = this.options.paperflowPriorityMemberId;
    const items: AdminBotPaperflowStageNudge[] = [];

    for (const paper of this.store.listPapers()) {
      const evidence = this.store.listPaperflowEvidence(paper.id);
      const open = openPaperflowStage({
        paper,
        slots: this.store.listPaperSlots(paper.id),
        evidence,
        now,
      });
      if (!open) {
        continue;
      }
      const recipient = paperflowRecipient(paper, roster, priorityMemberId);
      const entry = recipient
        ? ledger.get(`paperflow_stage|${open.subjectId}|${recipient.member.id}`)
        : ledger.get(`paperflow_stage|${open.subjectId}`);
      // The cadence belongs to the paper, not to the rung of the ladder it happens to be on. Each
      // stage carries its own ledger row, so closing one opened the next with a fresh row and no
      // history -- and the author who had just answered got a mail about the same paper the very
      // next morning. Evidence counts as recently-heard-from for the same reason a nudge does:
      // somebody who has just told us where the paper is has earned the same quiet a nudge buys.
      const heardFrom = [
        ...adminBotPaperflowStages.map((stage) => {
          const key = `paperflow_stage|${adminBotPaperflowSubjectId(paper.id, stage)}`;
          return (recipient ? ledger.get(`${key}|${recipient.member.id}`) : ledger.get(key))
            ?.last_nudged_at;
        }),
        ...evidence.map((row) => row.recorded_at),
      ]
        .filter((value): value is string => Boolean(value))
        .map((value) => Date.parse(value))
        .filter((value) => !Number.isNaN(value));
      // -Infinity on a paper nobody has ever been asked about, which is due by definition.
      const lastHeardFrom = Math.max(...heardFrom, Number.NEGATIVE_INFINITY);
      items.push({
        paper_id: paper.id,
        title: paper.title,
        stage: open.stage,
        stage_label: adminBotPaperflowStageRegistry[open.stage].label,
        reason: open.reason,
        deadline_bearing: open.deadlineBearing,
        // A paper with no full member on it is reported rather than dropped. Silently skipping it
        // makes an unowned paper indistinguishable from a paper with nothing outstanding, which is
        // exactly the paper somebody needs to look at.
        ...(recipient
          ? {
              recipient_member_id: recipient.member.id,
              recipient_name: recipient.member.name,
              recipient_author_index: recipient.authorIndex,
              prioritized: recipient.prioritized,
            }
          : { unroutable_reason: "no full member on the author list" }),
        ...(paper.venue ? { venue: paper.venue } : {}),
        ...(entry?.last_nudged_at ? { last_nudged_at: entry.last_nudged_at } : {}),
        nudge_count: entry?.nudge_count ?? 0,
        due:
          isNudgeDue(entry, now, PAPERFLOW_STAGE_NUDGE_INTERVAL_MS) &&
          lastHeardFrom <= now.getTime() - PAPERFLOW_STAGE_NUDGE_INTERVAL_MS,
      });
    }
    return { items };
  }

  /**
   * Email the author holding each paper's venue cycle about the stage it is waiting on.
   *
   * Email rather than Slack, and separate from `sendPaperSlotNudges`, because the answer is an
   * email: the whole loop is "we ask, the venue writes to you, you bcc us and this stops". A Slack
   * DM asking somebody to bcc a mailbox makes them switch apps to answer, and the reply path is
   * where these die.
   *
   * Composes nothing from caller input and picks nobody -- recipients come from the author list and
   * the text from the registry -- so it runs from cron on the same footing as
   * `sendMandatoryFieldsReminders`.
   */
  async sendPaperflowStageNudges(
    actor: string,
  ): Promise<
    AdminBotServiceResponse<
      AdminBotMemberNudgeResult & { papers_considered: number; unroutable: string[] }
    >
  > {
    const botEmail = this.options.paperflowBotEmail?.trim();
    if (!botEmail) {
      return serviceError(
        503,
        "paperflow stage nudges need a bot mailbox to name; set ADMINBOT_BOT_EMAIL",
      );
    }
    const now = new Date();
    const { items } = this.gatherPaperflowStages(now);
    const created: AdminBotStoredProposal[] = [];
    const skipped: AdminBotMemberNudgeSkip[] = [];
    const unroutable: string[] = [];
    const stamped: Array<{ subjectId: string; memberId: string }> = [];

    for (const item of items) {
      if (!item.recipient_member_id) {
        unroutable.push(item.paper_id);
        continue;
      }
      if (!item.due) {
        continue;
      }
      const paper = this.store.getPaper(item.paper_id);
      const member = this.store.getLabMember(item.recipient_member_id);
      if (!paper || !member) {
        continue;
      }
      const entry = this.nudgeLedgerIndex().get(
        `paperflow_stage|${item.paper_id}:${item.stage}|${member.id}`,
      );
      const mail = paperflowStageEmail({
        paper,
        stage: item.stage,
        recipient: {
          member,
          authorIndex: item.recipient_author_index ?? 0,
          prioritized: item.prioritized ?? false,
        },
        botEmail,
        ...(entry ? { entry } : {}),
      });
      // One mail per paper per stage rather than one per person: unlike the slot sweep, two papers
      // at different stages have nothing to say to each other, and a single digest would bury the
      // one bcc instruction that is the entire point of the message.
      const result = await this.sendMemberNudge(
        {
          channel: "email",
          recipient_member_ids: [member.id],
          subject: mail.subject,
          message: mail.body,
        },
        actor,
      );
      if (this.absorbNudgeSend(result, member.id, { created, skipped })) {
        stamped.push({ subjectId: `${item.paper_id}:${item.stage}`, memberId: member.id });
      }
    }

    // Only people a message actually reached. Somebody with no address on file has not been asked
    // and must not accumulate a count nobody ever told them about -- same rule as the slot sweep.
    this.stampNudgeLedger(
      stamped.map(({ subjectId, memberId }) => ({
        domain: "paperflow_stage" as const,
        subjectId,
        memberId,
      })),
      now.toISOString(),
    );
    if (stamped.length > 0 || unroutable.length > 0) {
      this.recordAudit({
        type: "paperflow_stages.nudged",
        actor,
        details: { sent: stamped.length, unroutable: unroutable.length },
      });
    }
    return {
      ok: true,
      status: 200,
      payload: { created, skipped, papers_considered: items.length, unroutable },
    };
  }

  /**
   * Close a venue-cycle stage because the mail that proves it happened arrived.
   *
   * This is the other half of the nudge: the ask names a mailbox, and a bcc to that mailbox lands
   * here. Recording it is what stops the chase, so the confidence floor matters -- a false close is
   * silent by construction, because the failure mode is a message that never gets sent.
   *
   * Idempotent on (paper, stage): a second bcc on the same decision is the author forwarding the
   * thread again, not a second decision.
   */
  recordPaperflowEvidence(params: {
    paperId: string;
    stage: string;
    messageId?: string;
    subject?: string;
    sender?: string;
    confidence?: number;
    recordedBy?: AdminBotPaperflowEvidenceRecord["recorded_by"];
    actor: string;
  }): AdminBotServiceResponse<{ recorded: boolean; record: AdminBotPaperflowEvidenceRecord }> {
    if (!isAdminBotPaperflowStage(params.stage)) {
      return serviceError(400, `${params.stage} is not a PaperFlow stage`);
    }
    const paper = this.store.getPaper(params.paperId);
    if (!paper) {
      return serviceError(404, "paper not found");
    }
    const recordedBy = params.recordedBy ?? "email_bcc";
    if (
      recordedBy === "email_bcc" &&
      (params.confidence ?? 0) < adminBotPaperflowEvidenceMinConfidence
    ) {
      return serviceError(
        422,
        `the match was only ${Math.round((params.confidence ?? 0) * 100)}% confident; a human should confirm which paper and stage this closes`,
      );
    }
    const existing = this.store
      .listPaperflowEvidence(params.paperId)
      .find((row) => row.stage === params.stage);
    if (existing) {
      return { ok: true, status: 200, payload: { recorded: false, record: existing } };
    }
    const record: AdminBotPaperflowEvidenceRecord = {
      paper_id: params.paperId,
      stage: params.stage,
      recorded_at: new Date().toISOString(),
      recorded_by: recordedBy,
      ...(params.messageId ? { message_id: params.messageId } : {}),
      ...(params.subject ? { subject: params.subject } : {}),
      ...(params.sender ? { sender: params.sender } : {}),
      ...(typeof params.confidence === "number" ? { confidence: params.confidence } : {}),
    };
    this.store.savePaperflowEvidence(record);
    this.recordAudit({
      type: "paperflow_stage.evidenced",
      actor: params.actor,
      details: { paper_id: params.paperId, stage: params.stage, recorded_by: recordedBy },
    });
    return { ok: true, status: 200, payload: { recorded: true, record } };
  }

  /**
   * The ledger, for tests and for the admin sweep view.
   *
   * Exposed rather than reached for through the store, so a caller cannot accidentally write it:
   * the only thing that stamps a nudge is the sweep itself.
   */
  listNudgeLedgerForTest(domain?: string): AdminBotNudgeLedgerRecord[] {
    return this.store.listNudgeLedger(domain);
  }

  /** Push one thing off for a while. The author's own call, and bounded by the service. */
  snoozeNudge(params: {
    domain: string;
    subjectId: string;
    memberId: string;
    until: string;
  }): AdminBotServiceResponse<{ snoozed_until: string }> {
    if (!(adminBotNudgeDomains as readonly string[]).includes(params.domain)) {
      return serviceError(400, "unknown nudge domain");
    }
    const bounded = boundSnooze(params.until, new Date());
    if (!bounded.ok) {
      return serviceError(400, bounded.error);
    }
    const existing = this.store
      .listNudgeLedger(params.domain)
      .find(
        (entry) => entry.subject_id === params.subjectId && entry.member_id === params.memberId,
      );
    this.store.saveNudgeLedgerEntry({
      domain: params.domain as AdminBotNudgeDomain,
      subject_id: params.subjectId,
      member_id: params.memberId,
      nudge_count: existing?.nudge_count ?? 0,
      ...(existing?.last_nudged_at ? { last_nudged_at: existing.last_nudged_at } : {}),
      snoozed_until: bounded.until,
    });
    return { ok: true, status: 200, payload: { snoozed_until: bounded.until } };
  }

  /**
   * Turn the artifacts already on the roster's papers into slot rows.
   *
   * Runs once, by hand, at the point evidence tracking is switched on -- and idempotently, so
   * running it twice is safe. Without it the first sweep asks the author of every published paper
   * in the lab for a brainstorm doc, which is how a lab learns to ignore AdminBot.
   */
  backfillPaperSlots(
    actor: string,
    options: { dryRun?: boolean; quietDays?: number } = {},
  ): AdminBotServiceResponse<{
    papers_scanned: number;
    papers_changed: number;
    slots_written: number;
    venues_filled: number;
    papers_settled: number;
    dry_run: boolean;
  }> {
    const now = new Date();
    let changed = 0;
    let slotsWritten = 0;
    let venuesFilled = 0;
    let settled = 0;
    const papers = this.store.listPapers();
    for (const paper of papers) {
      const plan = planPaperBackfill({
        paper,
        existing: this.store.listPaperSlots(paper.id),
        now,
        ...(options.quietDays === undefined ? {} : { quietDays: options.quietDays }),
      });
      if (plan.settled) {
        settled += 1;
      }
      if (plan.slots.length === 0 && !plan.venue) {
        continue;
      }
      changed += 1;
      slotsWritten += plan.slots.length;
      if (plan.venue) {
        venuesFilled += 1;
      }
      if (options.dryRun) {
        continue;
      }
      for (const slot of plan.slots) {
        this.store.savePaperSlot(slot);
      }
      if (plan.venue) {
        this.store.savePaper({ ...paper, venue: plan.venue, updated_at: now.toISOString() });
      }
    }
    if (!options.dryRun && changed > 0) {
      this.recordAudit({
        type: "paper_slots.backfilled",
        actor,
        details: { papers: changed, slots: slotsWritten, venues: venuesFilled },
      });
    }
    return {
      ok: true,
      status: 200,
      payload: {
        papers_scanned: papers.length,
        papers_changed: changed,
        slots_written: slotsWritten,
        venues_filled: venuesFilled,
        papers_settled: settled,
        dry_run: Boolean(options.dryRun),
      },
    };
  }

  /**
   * Who a slot's owner role resolves to on this paper.
   *
   * `first_author` prefers the explicit field, falls back to whoever filed the paper, and only
   * then tries to match the first free-text author name against the roster -- names are how the
   * paper spells them, so a match is a convenience, never an identity.
   */
  private resolvePaperSlotOwner(
    paper: AdminBotPaperRecord,
    owner: AdminBotPaperSlotOwner,
  ): string[] {
    const roster = this.store.listLabMembers();
    const byName = new Map(
      roster.map((member) => [member.name.trim().toLocaleLowerCase(), member]),
    );
    // The recorded links first, name matching only for the papers that have none. External
    // coauthors carry no roster id, so they fall out of every one of these lists by construction
    // -- which is the whole point of recording them as emails rather than as half-members.
    const linked = authorMemberIds(paper.author_links ?? []);
    const firstAuthor =
      paper.first_author_member_id ??
      paper.submitted_by_member_id ??
      linked[0] ??
      byName.get((paper.authors[0] ?? "").trim().toLocaleLowerCase())?.id;
    switch (owner) {
      case "first_author":
        return firstAuthor ? [firstAuthor] : [];
      case "coauthors":
        return (
          linked.length > 0
            ? linked
            : paper.authors
                .map((name) => byName.get(name.trim().toLocaleLowerCase())?.id)
                .filter((id): id is string => Boolean(id))
        ).filter((id) => id !== firstAuthor);
      case "pi": {
        const head =
          paper.reminder?.head_professor_member_id ??
          this.resolveSettings().head_professor_member_id;
        return head ? [head] : [];
      }
      case "admin":
        return roster
          .filter((member) => member.privilege_level === "admin")
          .map((member) => member.id);
    }
  }

  /**
   * Append an observation of where a member is, when it says something new.
   *
   * Every source funnels through here — the login geolocation, a profile edit, an admin — so the
   * "only record a change" rule is enforced in one place rather than at three call sites that
   * would drift apart.
   */
  /**
   * Append one row per changed field. No-ops on an empty list, which is the common case: most
   * saves are a form being re-submitted unchanged, and a log that recorded those would say a
   * member had been active on a day they only looked.
   */
  private recordUpdateEvents(params: {
    subject: AdminBotUpdateSubject;
    slotIds: readonly string[];
    memberId: string;
    source: AdminBotUpdateSource;
    at: string;
    subjectMemberId?: string;
  }): void {
    for (const slotId of params.slotIds) {
      this.store.appendUpdateEvent({
        id: randomUUID(),
        subject: params.subject,
        slot_id: slotId,
        member_id: params.memberId,
        at: params.at,
        source: params.source,
        // Absent on a self-edit, so "did they do it themselves" stays a null check.
        ...(params.subjectMemberId && params.subjectMemberId !== params.memberId
          ? { subject_member_id: params.subjectMemberId }
          : {}),
      });
    }
  }

  /**
   * The newest workshop-matching pass, or undefined before the first one.
   *
   * Plain pass-throughs: the pass is orchestrated in the route because it outlives the request,
   * and the service's job here is only to own the storage.
   */
  latestWorkshopMatchRun(): AdminBotWorkshopMatchRun | undefined {
    return this.store.latestWorkshopMatchRun();
  }

  saveWorkshopMatchRun(run: AdminBotWorkshopMatchRun): void {
    this.store.saveWorkshopMatchRun(run);
  }

  /** Every sign-in this member has made, newest first. */
  listLoginEvents(
    memberId: string,
    limit?: number,
  ): AdminBotServiceResponse<{ logins: AdminBotLoginEvent[] }> {
    if (!this.store.getLabMember(memberId)) {
      return serviceError(404, "member not found");
    }
    return {
      ok: true,
      status: 200,
      payload: { logins: this.store.listLoginEvents(memberId, limit) },
    };
  }

  /** Everything this member has changed, newest first. */
  listUpdateEventsByMember(
    memberId: string,
    limit?: number,
  ): AdminBotServiceResponse<{ updates: AdminBotUpdateEvent[] }> {
    if (!this.store.getLabMember(memberId)) {
      return serviceError(404, "member not found");
    }
    return {
      ok: true,
      status: 200,
      payload: { updates: this.store.listUpdateEventsByMember(memberId, limit) },
    };
  }

  /** Everyone who has ever changed this one slot, newest first. */
  listUpdateEventsBySlot(
    slotId: string,
    limit?: number,
  ): AdminBotServiceResponse<{ updates: AdminBotUpdateEvent[] }> {
    return {
      ok: true,
      status: 200,
      payload: { updates: this.store.listUpdateEventsBySlot(slotId, limit) },
    };
  }

  recordMemberLocation(params: {
    memberId: string;
    source: AdminBotLocationSource;
    raw: string;
    timezone?: string;
  }): AdminBotServiceResponse<{ recorded: boolean; entry?: AdminBotMemberLocationEntry }> {
    const entry = observationFor({
      memberId: params.memberId,
      source: params.source,
      raw: params.raw,
      observedAt: new Date().toISOString(),
      ...(params.timezone ? { timezone: params.timezone } : {}),
    });
    if (!entry) {
      return { ok: true, status: 200, payload: { recorded: false } };
    }
    const latest = latestBySource(this.store.listMemberLocations(params.memberId, 50)).get(
      params.source,
    );
    if (!isNewObservation(latest, entry)) {
      return { ok: true, status: 200, payload: { recorded: false } };
    }
    this.store.appendMemberLocation(entry);
    this.recordAudit({
      type: "member.location_observed",
      actor: params.memberId,
      details: { source: entry.source, country: entry.country, place: entry.place_label },
    });
    return { ok: true, status: 200, payload: { recorded: true, entry } };
  }

  listMemberLocations(
    memberId: string,
    limit?: number,
  ): AdminBotServiceResponse<{ locations: AdminBotMemberLocationEntry[] }> {
    if (!this.store.getLabMember(memberId)) {
      return serviceError(404, `unknown member ${memberId}`);
    }
    return {
      ok: true,
      status: 200,
      payload: { locations: this.store.listMemberLocations(memberId, limit) },
    };
  }

  /** The question to put to one member, if there is one. Drives the banner on their own profile. */
  memberLocationDrift(
    memberId: string,
  ): AdminBotServiceResponse<{ drift: AdminBotLocationDrift | null }> {
    const member = this.store.getLabMember(memberId);
    if (!member) {
      return serviceError(404, `unknown member ${memberId}`);
    }
    const drift = detectLocationDrift(
      member,
      this.store.listMemberLocations(memberId, 50),
      new Date(),
    );
    return { ok: true, status: 200, payload: { drift: drift ?? null } };
  }

  /**
   * Everyone the lab should re-check before scheduling something. Admin surface.
   *
   * One query over the recent window rather than one per member: the roster is ~160 people and
   * this is rendered on a tab, not a cron.
   */
  listLocationDrifts(): AdminBotServiceResponse<{ drifts: AdminBotLocationDrift[] }> {
    const since = new Date(Date.now() - LOCATION_DRIFT_WINDOW_MS).toISOString();
    const byMember = new Map<string, AdminBotMemberLocationEntry[]>();
    for (const entry of this.store.listMemberLocationsSince(since)) {
      const held = byMember.get(entry.member_id);
      if (held) {
        held.push(entry);
      } else {
        byMember.set(entry.member_id, [entry]);
      }
    }
    const now = new Date();
    const drifts: AdminBotLocationDrift[] = [];
    for (const [memberId, entries] of byMember) {
      const member = this.store.getLabMember(memberId);
      const drift = member ? detectLocationDrift(member, entries, now) : undefined;
      if (drift) {
        drifts.push(drift);
      }
    }
    return { ok: true, status: 200, payload: { drifts } };
  }

  /**
   * The member's answer to "you seem to have moved".
   *
   * Both answers are answers. A confirmation writes the location the member typed through the same
   * self-edit whitelist as any profile field — so it stays self-reported, and the observation it
   * produces is recorded as such. A dismissal writes no location at all and only stamps that the
   * question was asked and settled for that country.
   */
  answerLocationPrompt(
    memberId: string,
    answer: { current_city?: string; timezone?: string },
  ): AdminBotServiceResponse<AdminBotLabMember> {
    const existing = this.store.getLabMember(memberId);
    if (!existing) {
      return serviceError(404, "member not found");
    }
    const drift = detectLocationDrift(
      existing,
      this.store.listMemberLocations(memberId, 50),
      new Date(),
    );
    const city = answer.current_city?.trim();
    if (city) {
      const updated = this.updateOwnProfile(memberId, {
        current_city: city,
        ...(answer.timezone?.trim() ? { timezone: answer.timezone.trim() } : {}),
      });
      if (!updated.ok) {
        return updated;
      }
    }
    // Re-read: updateOwnProfile above wrote a new record, and stamping the answer onto the stale
    // copy would undo it.
    const current = this.store.getLabMember(memberId);
    if (!current) {
      return serviceError(404, "member not found");
    }
    const now = new Date().toISOString();
    const stamped: AdminBotLabMember = {
      ...current,
      location_prompt_answered_at: now,
      ...(drift?.observed_country
        ? { location_prompt_answered_country: drift.observed_country }
        : {}),
      updated_at: now,
    };
    this.store.saveLabMember(stamped);
    this.recordAudit({
      type: "member.location_prompt_answered",
      actor: memberId,
      details: { moved: Boolean(city), asked_about: drift?.observed_country },
    });
    return { ok: true, status: 200, payload: stamped };
  }

  /**
   * File a meeting, or fold an update into one already filed.
   *
   * Sparse by design: the hourly pass sends the notice first and the transcript and attendance
   * whenever they turn up, so this is called several times per meeting with a different subset
   * each time. mergeMeeting is what keeps the earlier fields.
   */
  upsertMeeting(input: AdminBotMeetingRecordInput): AdminBotServiceResponse<AdminBotMeetingRecord> {
    const validation = validateMeeting(input);
    if (validation) {
      return serviceError(400, validation);
    }
    const existing = this.store.getMeeting(input.id);
    const stored = mergeMeeting(existing, input, new Date().toISOString());
    this.store.saveMeeting(stored);
    this.recordAudit({
      type: existing ? "meeting.updated" : "meeting.recorded",
      actor: input.source,
      details: {
        meeting_id: stored.id,
        started_at: stored.started_at,
        has_summary: Boolean(stored.summary),
        attendee_count: stored.attendees?.length ?? 0,
      },
    });
    return { ok: true, status: 200, payload: stored };
  }

  /**
   * Every meeting with its full roster. Callers must have checked for admin first.
   *
   * `includeShort` exists for the artifact cron, not for the UI: a transcript dropped for a short
   * meeting still has to find its record, and a matcher that cannot see the record would leave the
   * file unattached forever — including the very file that would have proved the meeting was long
   * enough to list after all.
   */
  listMeetings(options?: {
    includeShort?: boolean;
  }): AdminBotServiceResponse<{ meetings: AdminBotMeetingRecord[] }> {
    return {
      ok: true,
      status: 200,
      payload: { meetings: this.listedMeetings(options?.includeShort ?? false) },
    };
  }

  /**
   * Every meeting as one member may see it: their own attendance line and a headcount, never the
   * roster. The redaction happens here rather than in the route so no future caller can reach the
   * unredacted list by picking a different entry point.
   */
  listMeetingsForMember(
    memberId: string,
  ): AdminBotServiceResponse<{ meetings: AdminBotMeetingRecord[] }> {
    const member = this.store.getLabMember(memberId);
    if (!member) {
      return serviceError(404, `unknown member ${memberId}`);
    }
    return {
      ok: true,
      status: 200,
      payload: {
        meetings: this.listedMeetings(false).map((meeting) =>
          redactMeetingForMember(meeting, memberId),
        ),
      },
    };
  }

  /**
   * Correct the roster by hand.
   *
   * Every line written here is stamped `manual`, which is what makes it survive the next import:
   * the person who was there but never unmuted has to stay ticked when the transcript pass runs
   * again. Callers must have checked for admin first.
   */
  setMeetingAttendance(
    meetingId: string,
    attendees: readonly AdminBotMeetingAttendee[],
    actor: string,
  ): AdminBotServiceResponse<AdminBotMeetingRecord> {
    const existing = this.store.getMeeting(meetingId);
    if (!existing) {
      return serviceError(404, `unknown meeting ${meetingId}`);
    }
    const corrected = attendees.map((attendee) => ({ ...attendee, source: "manual" as const }));
    const stored: AdminBotMeetingRecord = {
      ...existing,
      attendees: mergeAttendance(existing.attendees ?? [], corrected),
      updated_at: new Date().toISOString(),
    };
    this.store.saveMeeting(stored);
    this.recordAudit({
      type: "meeting.attendance_updated",
      actor,
      details: { meeting_id: meetingId, changed: corrected.length },
    });
    return { ok: true, status: 200, payload: stored };
  }

  private listedMeetings(includeShort: boolean): AdminBotMeetingRecord[] {
    const floor = this.resolveSettings().meeting_minimum_minutes ?? 0;
    return this.store
      .listMeetings()
      .filter((meeting) => includeShort || meetsDurationFloor(meeting, floor))
      .toSorted(byMostRecent);
  }

  deleteMeeting(
    meetingId: string,
    actor: string,
  ): AdminBotServiceResponse<{ deleted: true; meeting_id: string }> {
    if (!this.store.deleteMeeting(meetingId)) {
      return serviceError(404, `unknown meeting ${meetingId}`);
    }
    this.recordAudit({
      type: "meeting.deleted",
      actor,
      details: { meeting_id: meetingId },
    });
    return { ok: true, status: 200, payload: { deleted: true, meeting_id: meetingId } };
  }

  /**
   * Who has missed the last two group meetings, without telling anybody yet.
   *
   * Separate from the send for the same reason every other sweep here is: an admin gets to read
   * the list before the lab does. It is also what the Meeting Recordings tab renders, so the
   * preview and the message are computed once and cannot disagree.
   *
   * `inviteEmails` is passed in rather than fetched: reading the calendar means shelling out to
   * gog, which is the API layer's job and can fail. When it does, the audience falls back to the
   * roster's own full members and `invite_resolved` says so, so a failed calendar read narrows the
   * nudge rather than stopping it.
   */
  collectMeetingAttendanceNudges(
    params: { inviteEmails?: readonly string[] } = {},
  ): AdminBotServiceResponse<{
    streak: number;
    meeting_label: string;
    /** The meetings the streak was measured over, newest first. Fewer than `streak` means nobody can qualify yet. */
    meetings: Array<{ id: string; topic: string; started_at: string }>;
    absent: AdminBotMeetingAbsence[];
    invite_resolved: boolean;
    audience_size: number;
  }> {
    const inviteEmails = params.inviteEmails ?? [];
    const members = this.store.listLabMembers();
    const meetings = this.listedMeetings(false);
    const counted = streakMeetings(meetings, adminBotMeetingAbsenceStreak);
    return {
      ok: true,
      status: 200,
      payload: {
        streak: adminBotMeetingAbsenceStreak,
        meeting_label: this.groupMeetingLabel(),
        meetings: counted.map((meeting) => ({
          id: meeting.id,
          topic: meeting.topic,
          started_at: meeting.started_at,
        })),
        absent: consecutiveAbsences({ meetings, members, inviteEmails }),
        invite_resolved: inviteEmails.length > 0,
        audience_size: meetingAudience(members, inviteEmails).length,
      },
    };
  }

  /**
   * Tell everyone who has missed the last two, on every channel at once.
   *
   * Three deliveries per person and they are not interchangeable. The Slack DM is the one that
   * reaches somebody who is not looking at the Control UI. The stored notification is what the
   * dashboard card and the top-right popup both read, so the message survives the DM scrolling
   * away and reaches a member who never linked Slack at all. And the audit row is what stops the
   * lab saying it twice: the ledger is keyed on the *pair of meetings*, so an hourly cron, a retry
   * and an admin pressing the button collapse into one message, while the next meeting makes a new
   * pair and so a third absence in a row is worth saying something about again.
   *
   * A Slack failure is not a failure of the send. Somebody with no linked Slack account still gets
   * the notification, and reporting that as "skipped" would hide the fact that they were told.
   */
  async sendMeetingAttendanceNudges(
    actor: string,
    params: { inviteEmails?: readonly string[]; nowIso?: string } = {},
  ): Promise<
    AdminBotServiceResponse<{
      notified: string[];
      /** Already told about this same pair of meetings, so left alone. */
      already_told: string[];
      slack_skipped: AdminBotMemberNudgeSkip[];
      invite_resolved: boolean;
    }>
  > {
    const collected = this.collectMeetingAttendanceNudges(params);
    if (!collected.ok) {
      return collected;
    }
    const { absent, meeting_label: meetingLabel } = collected.payload;
    const notified: string[] = [];
    const alreadyTold: string[] = [];
    const slackSkipped: AdminBotMemberNudgeSkip[] = [];
    for (const row of absent) {
      const streakKey = absenceStreakKey(row.missed_meeting_ids);
      if (this.meetingAttendanceAskedFor(streakKey).has(row.member_id)) {
        alreadyTold.push(row.member_id);
        continue;
      }
      const message = buildMeetingAttendanceMessage({
        missedTopics: row.missed_topics,
        meetingLabel,
      });
      // The notification is filed by sendMemberNudge itself, which is what every nudge in the
      // service now does; this call only says what to put on it.
      const sent = await this.sendMemberNudge(
        {
          channel: "slack",
          recipient_member_ids: [row.member_id],
          message,
          kind: "meeting_attendance",
          title: `Please join the next ${meetingLabel}`,
          tab: "adminbotMeetings",
        },
        actor,
      );
      if (!sent.ok) {
        slackSkipped.push({ member_id: row.member_id, reason: sent.error.message });
      } else {
        slackSkipped.push(...sent.payload.skipped);
      }
      notified.push(row.member_id);
      this.recordAudit({
        type: "meeting_attendance.nudged",
        actor,
        details: { streak: streakKey, member_ids: [row.member_id] },
      });
    }
    return {
      ok: true,
      status: 200,
      payload: {
        notified,
        already_told: alreadyTold,
        slack_skipped: slackSkipped,
        invite_resolved: collected.payload.invite_resolved,
      },
    };
  }

  /** Everyone already told about this exact pair of meetings. */
  private meetingAttendanceAskedFor(streakKey: string): Set<string> {
    const asked = new Set<string>();
    for (const event of this.store.listAuditEvents()) {
      if (event.type !== "meeting_attendance.nudged") {
        continue;
      }
      const details = event.details as { streak?: unknown; member_ids?: unknown } | undefined;
      if (details?.streak !== streakKey || !Array.isArray(details.member_ids)) {
        continue;
      }
      for (const id of details.member_ids) {
        if (typeof id === "string") {
          asked.add(id);
        }
      }
    }
    return asked;
  }

  /** "Monday meeting", from the configured schedule, so the message names the real day. */
  private groupMeetingLabel(): string {
    const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const { weekday } = this.groupMeetingSchedule();
    return `${weekdays[weekday] ?? "group"} meeting`;
  }

  /**
   * One member's own notifications, newest first.
   *
   * Scoped by the caller's session, never by a body field: a notification is something the lab
   * said to one person, and the route hands this the member id it authenticated.
   */
  listMemberNotifications(
    memberId: string,
  ): AdminBotServiceResponse<{ notifications: AdminBotMemberNotification[] }> {
    if (!this.store.getLabMember(memberId)) {
      return serviceError(404, `unknown member ${memberId}`);
    }
    return {
      ok: true,
      status: 200,
      payload: { notifications: this.store.listMemberNotifications(memberId) },
    };
  }

  /**
   * The escalation queue: every nudge that went unanswered long enough to be raised, and still is.
   *
   * escalateStaleNudges has been stamping `escalated_at` and sending one group DM per member since
   * it was written, and nothing ever read those stamps back. So the pass computed exactly this list
   * every weekday, said it once in Slack, and kept no record anybody could work through -- miss the
   * message and the day's escalations were invisible.
   *
   * Grouped by member rather than listed flat, because that is the unit of the professor's actual
   * next move: she writes to a person about everything they are sitting on, which is the same
   * reason the escalation itself sends one DM per member however many items are overdue.
   *
   * Drains on its own. An entry is outstanding while it is escalated and unread, so a member
   * acknowledging the nudge takes them off this list through the path they already use -- there is
   * no second "handled" flag here to forget to set.
   */
  listEscalatedNudges(): AdminBotServiceResponse<{
    members: Array<{
      member_id: string;
      name: string;
      slack_user_id?: string;
      /** Oldest escalation for this member, which is what the list is ordered by. */
      escalated_at: string;
      notifications: AdminBotMemberNotification[];
    }>;
  }> {
    const byMember = new Map<string, AdminBotMemberNotification[]>();
    for (const notification of this.store.listEscalatedMemberNotifications()) {
      const existing = byMember.get(notification.member_id);
      if (existing) {
        existing.push(notification);
      } else {
        byMember.set(notification.member_id, [notification]);
      }
    }
    const members = [...byMember.entries()]
      .flatMap(([memberId, notifications]) => {
        const member = this.store.getLabMember(memberId);
        // A notification whose member is gone from the roster is not somebody to chase. It is left
        // in place rather than deleted -- this is a read.
        if (!member || member.status === "alumni") {
          return [];
        }
        const escalatedAt = notifications
          .map((notification) => notification.escalated_at ?? "")
          .toSorted()[0];
        return [
          {
            member_id: memberId,
            name: member.name,
            ...(member.slack_user_id ? { slack_user_id: member.slack_user_id } : {}),
            escalated_at: escalatedAt ?? "",
            notifications,
          },
        ];
      })
      .toSorted((left, right) => left.escalated_at.localeCompare(right.escalated_at));
    return { ok: true, status: 200, payload: { members } };
  }

  /**
   * Mark notifications read. All of the member's own, or the ids given.
   *
   * Read rather than deleted: the popup fires on unread, so acknowledging one has to stop the
   * popup without taking the sentence off the dashboard, where somebody may still want to act on
   * it. Ids that are not this member's are ignored rather than refused -- the list is scoped on
   * read, so an id from somewhere else simply matches nothing.
   */
  markMemberNotificationsRead(
    memberId: string,
    notificationIds?: readonly string[],
  ): AdminBotServiceResponse<{ read: number }> {
    if (!this.store.getLabMember(memberId)) {
      return serviceError(404, `unknown member ${memberId}`);
    }
    const wanted = notificationIds?.length ? new Set(notificationIds) : undefined;
    const readAt = new Date().toISOString();
    let read = 0;
    for (const notification of this.store.listMemberNotifications(memberId)) {
      if (notification.read_at || (wanted && !wanted.has(notification.id))) {
        continue;
      }
      this.store.saveMemberNotification({ ...notification, read_at: readAt });
      read += 1;
    }
    return { ok: true, status: 200, payload: { read } };
  }

  /**
   * A member asking the lab for something.
   *
   * The requester is taken from the authenticated session the route resolved, never from the body:
   * a request is signed by whoever sent it, and a client that could name someone else could file a
   * letter request in a colleague's name. Storing it reaches nothing outside this service, so there
   * is no approval gate between a member and their own ask.
   */
  submitLogisticsRequest(
    memberId: string,
    input: AdminBotLogisticsRequestInput,
  ): AdminBotServiceResponse<AdminBotLogisticsRequest> {
    const member = this.store.getLabMember(memberId);
    if (!member) {
      return serviceError(404, `unknown member ${memberId}`);
    }
    const prepared = prepareLogisticsRequest(
      input,
      { id: `logreq_${randomUUID()}`, member_id: member.id, member_name: member.name },
      new Date().toISOString(),
    );
    if (!prepared.ok) {
      return serviceError(400, prepared.error);
    }
    this.store.saveLogisticsRequest(prepared.request);
    this.recordAudit({
      type: "logistics_request.submitted",
      actor: member.id,
      details: {
        request_id: prepared.request.id,
        kind: prepared.request.kind,
        ...(prepared.request.deadline_at ? { deadline_at: prepared.request.deadline_at } : {}),
      },
    });
    // Echoed back without the bytes the caller just sent us: the client has the files already, and
    // a submit that replied with 20MB of its own upload would double the cost of every send.
    return { ok: true, status: 201, payload: withoutAttachmentBytes(prepared.request) };
  }

  /**
   * The queue, most urgent first.
   *
   * `memberId` is the whole of the access decision: pass one and the reader sees their own requests
   * and nobody else's, omit it for the admin view. It is decided here rather than in the route so
   * no future caller reaches the lab-wide list by picking a different entry point -- the same
   * reason listMeetingsForMember exists.
   */
  listLogisticsRequests(
    memberId?: string,
  ): AdminBotServiceResponse<{ requests: AdminBotLogisticsRequest[] }> {
    const requests = this.store
      .listLogisticsRequests(memberId)
      .map(withoutAttachmentBytes)
      .toSorted(byUrgency);
    return { ok: true, status: 200, payload: { requests } };
  }

  /**
   * One request in full, file bytes included -- this is the only read that carries them.
   *
   * A member may open their own; an admin may open anybody's. `is_admin` comes from the session's
   * privilege level, and a member asking for someone else's request is told the same "unknown
   * request" an id that never existed gets: whether a colleague has asked for letters is itself
   * something they did not share.
   */
  getLogisticsRequest(
    requestId: string,
    viewer: { member_id: string; is_admin: boolean },
  ): AdminBotServiceResponse<AdminBotLogisticsRequest> {
    const request = this.store.getLogisticsRequest(requestId);
    if (!request || (!viewer.is_admin && request.member_id !== viewer.member_id)) {
      return serviceError(404, `unknown logistics request ${requestId}`);
    }
    return { ok: true, status: 200, payload: request };
  }

  /**
   * The lab answering: picked up, done, declined.
   *
   * Admin-only, and deliberately not the same call a member uses to withdraw -- a requester grading
   * their own request would make the column useless to the people working the queue. The note is
   * what the member reads underneath a status, so "declined" is never just a word.
   *
   * Settling a request drops its stored files: nobody is waiting on them any more, and a database
   * that backs a web UI is not where somebody's signed forms should sit indefinitely.
   */
  setLogisticsRequestStatus(
    requestId: string,
    status: AdminBotLogisticsRequestStatus,
    actor: string,
    note?: string,
  ): AdminBotServiceResponse<AdminBotLogisticsRequest> {
    const existing = this.store.getLogisticsRequest(requestId);
    if (!existing) {
      return serviceError(404, `unknown logistics request ${requestId}`);
    }
    if (status === "withdrawn") {
      return serviceError(400, "only the requester can withdraw a request");
    }
    const now = new Date().toISOString();
    const stored = clearSettledRequestFiles({
      ...existing,
      status,
      updated_at: now,
      decided_by: actor,
      decided_at: now,
      ...(note?.trim() ? { resolution_note: note.trim() } : {}),
    });
    this.store.saveLogisticsRequest(stored);
    this.recordAudit({
      type: "logistics_request.status_changed",
      actor,
      details: { request_id: requestId, from: existing.status, to: status },
    });
    this.auditClearedFiles(existing, stored, actor);
    return { ok: true, status: 200, payload: withoutAttachmentBytes(stored) };
  }

  /**
   * The requester taking it back.
   *
   * Marked rather than deleted: an admin who already started on a signature has to be able to see
   * that the ask was withdrawn, and a row that silently vanished from the queue would leave them
   * doing work nobody wants. The documents go with it -- a withdrawn request is not a place to keep
   * somebody's paperwork.
   */
  withdrawLogisticsRequest(
    requestId: string,
    memberId: string,
  ): AdminBotServiceResponse<AdminBotLogisticsRequest> {
    const existing = this.store.getLogisticsRequest(requestId);
    if (!existing || existing.member_id !== memberId) {
      return serviceError(404, `unknown logistics request ${requestId}`);
    }
    if (existing.status === "completed") {
      return serviceError(409, "a completed request cannot be withdrawn");
    }
    const stored = clearSettledRequestFiles({
      ...existing,
      status: "withdrawn",
      updated_at: new Date().toISOString(),
    });
    this.store.saveLogisticsRequest(stored);
    this.recordAudit({
      type: "logistics_request.withdrawn",
      actor: memberId,
      details: { request_id: requestId, kind: existing.kind },
    });
    this.auditClearedFiles(existing, stored, memberId);
    return { ok: true, status: 200, payload: stored };
  }

  /**
   * The member correcting what they already sent.
   *
   * A resubmit rather than a patch: the form posts the whole request back, so the record is rebuilt
   * from it exactly as a first submission would be, and the deadline is re-derived rather than left
   * pointing at a date that has since been edited away. Identity and the submitted-at stamp are
   * kept -- it is the same ask, corrected, and re-stamping it would move it down a queue it has
   * been waiting in.
   */
  updateLogisticsRequest(
    requestId: string,
    memberId: string,
    input: AdminBotLogisticsRequestInput,
  ): AdminBotServiceResponse<AdminBotLogisticsRequest> {
    const existing = this.store.getLogisticsRequest(requestId);
    if (!existing || existing.member_id !== memberId) {
      return serviceError(404, `unknown logistics request ${requestId}`);
    }
    if (existing.status !== "submitted") {
      return serviceError(409, "only a request nobody has picked up yet can be edited");
    }
    const prepared = prepareLogisticsRequest(
      { ...input, kind: existing.kind },
      { id: existing.id, member_id: existing.member_id, member_name: existing.member_name },
      existing.submitted_at,
    );
    if (!prepared.ok) {
      return serviceError(400, prepared.error);
    }
    const stored: AdminBotLogisticsRequest = {
      ...prepared.request,
      updated_at: new Date().toISOString(),
    };
    this.store.saveLogisticsRequest(stored);
    this.recordAudit({
      type: "logistics_request.submitted",
      actor: memberId,
      details: { request_id: requestId, kind: stored.kind, edited: true },
    });
    return { ok: true, status: 200, payload: withoutAttachmentBytes(stored) };
  }

  /**
   * The signed document going back to the member who asked for it.
   *
   * One call does the whole close-out, because these four things are one act and a queue where they
   * can come apart is a queue with half-finished rows in it: the signed file is attached to the
   * record, mailed to the requester, the request is marked completed, and every stored file on it
   * is dropped.
   *
   * The recipient is read off the roster, never taken from the caller: an admin uploading a signed
   * form chooses the file, not who receives it. The mail itself is a typed action -- it is the one
   * part of this feature that reaches outside the service.
   */
  async fileSignedLogisticsDocument(
    requestId: string,
    actor: string,
    signed: AdminBotLogisticsAttachment[],
    note?: string,
  ): Promise<AdminBotServiceResponse<AdminBotLogisticsRequest>> {
    const existing = this.store.getLogisticsRequest(requestId);
    if (!existing) {
      return serviceError(404, `unknown logistics request ${requestId}`);
    }
    if (existing.kind !== "document_signature") {
      return serviceError(409, "only a document signature request takes a signed document back");
    }
    const invalid = validateSignedDocuments(signed);
    if (invalid) {
      return serviceError(400, invalid);
    }
    const member = this.store.getLabMember(existing.member_id);
    const recipient = member?.email?.trim();
    if (!recipient) {
      return serviceError(
        409,
        `${existing.member_name} has no email address on the roster, so the signed document cannot be sent`,
      );
    }
    const sent = await this.sendSignedDocument(existing, recipient, signed, note);
    if (!sent.ok) {
      return sent;
    }
    const now = new Date().toISOString();
    const stored = clearSettledRequestFiles({
      ...existing,
      // Recorded before the clear so the names survive it: what the request keeps is that a file
      // called this was signed and sent, which is the part anybody looks back for.
      signed_documents: signed,
      signed_sent_at: now,
      signed_sent_to: recipient,
      status: "completed",
      updated_at: now,
      decided_by: actor,
      decided_at: now,
      ...(note?.trim() ? { resolution_note: note.trim() } : {}),
    });
    this.store.saveLogisticsRequest(stored);
    this.recordAudit({
      type: "logistics_request.signed_document_sent",
      actor,
      details: {
        request_id: requestId,
        to: recipient,
        documents: signed.length,
      },
    });
    this.recordAudit({
      type: "logistics_request.status_changed",
      actor,
      details: { request_id: requestId, from: existing.status, to: "completed" },
    });
    this.auditClearedFiles(existing, stored, actor);
    return { ok: true, status: 200, payload: withoutAttachmentBytes(stored) };
  }

  /** The mail itself: one approved action, and the request is not touched until it has gone. */
  private async sendSignedDocument(
    request: AdminBotLogisticsRequest,
    recipient: string,
    signed: AdminBotLogisticsAttachment[],
    note?: string,
  ): Promise<AdminBotServiceResponse<never>> {
    const body = signedDocumentEmailBody(request, signed, note);
    const proposal = this.createProposal({
      type: "logistics.send_signed_document",
      summary: `Email ${request.member_name} the signed documents for their request`,
      target: { service: "email", channel: "email", target: recipient },
      proposed_payload: {
        to: recipient,
        subject: signedDocumentEmailSubject(request),
        body,
        attachments: signed.map((file) => ({
          name: file.name,
          ...(file.content_type ? { content_type: file.content_type } : {}),
          data_base64: file.data_base64 ?? "",
        })),
      },
      undo_plan: "Send a follow-up email correcting or retracting the signed document.",
    });
    if (!proposal.ok) {
      return serviceError(proposal.status, proposal.error.message);
    }
    const executed = await this.execute(proposal.payload.id, { dry_run: false });
    if (!executed.ok) {
      // The request is left exactly as it was: a member who never received the document must not
      // find their request marked done.
      return serviceError(502, `could not email the signed document: ${executed.error.message}`);
    }
    return { ok: true, status: 200, payload: undefined as never };
  }

  /** One audit line when a settled request stops holding files, so the drop is on the record. */
  private auditClearedFiles(
    before: AdminBotLogisticsRequest,
    after: AdminBotLogisticsRequest,
    actor: string,
  ): void {
    if (!after.files_cleared_at || before.files_cleared_at) {
      return;
    }
    this.recordAudit({
      type: "logistics_request.files_cleared",
      actor,
      details: {
        request_id: after.id,
        status: after.status,
        bytes_freed: storedRequestBytes(before),
      },
    });
  }

  listPapers(): AdminBotServiceResponse<{ papers: AdminBotPaperRecord[] }> {
    return {
      ok: true,
      status: 200,
      payload: { papers: this.store.listPapers().map(withPaperTimeline) },
    };
  }

  listConferenceAttendance(): AdminBotServiceResponse<{
    attendees: AdminBotConferenceAttendeeRecord[];
  }> {
    return {
      ok: true,
      status: 200,
      payload: { attendees: this.store.listConferenceAttendees() },
    };
  }

  /**
   * Remove a paper and everything hanging off it.
   *
   * `origin` names the person, for the same reason upsertPaper takes one: this used to record
   * `actor: paperId`, so the audit trail said a paper deleted itself. Deletion is the one paper
   * write that cannot be inspected afterwards -- the record is gone -- which makes the actor on
   * the audit row the only surviving answer to "who did this".
   */
  deletePaper(
    paperId: string,
    origin: AdminBotWriteOrigin = {},
  ): AdminBotServiceResponse<{ deleted: true; paper_id: string }> {
    const paper = this.store.getPaper(paperId);
    if (!paper) {
      return serviceError(404, "paper not found: " + paperId);
    }
    this.store.deletePaper(paperId);
    this.recordAudit({
      type: "paper.deleted",
      ...(origin.actor ? { actor: origin.actor } : {}),
      details: { paper_id: paperId, title: paper.title },
    });
    return { ok: true, status: 200, payload: { deleted: true, paper_id: paperId } };
  }

  /**
   * A member deleting a paper they own.
   *
   * Same ownership rule as upsertOwnPaper, checked against the stored record: a member who can
   * edit a paper can also remove one they filed by mistake, and a member who cannot edit it must
   * not be able to erase somebody else's work.
   */
  deleteOwnPaper(
    memberId: string,
    paperId: string,
  ): AdminBotServiceResponse<{ deleted: true; paper_id: string }> {
    const member = this.store.getLabMember(memberId);
    if (!member) {
      return serviceError(404, "member not found");
    }
    const paper = this.store.getPaper(paperId);
    if (!paper) {
      return serviceError(404, "paper not found: " + paperId);
    }
    if (!this.memberOwnsPaper(member, paper)) {
      return serviceError(403, "members can only delete papers they authored");
    }
    return this.deletePaper(paperId, { source: "member", actor: memberId });
  }

  listPaperNudges(nowIso = new Date().toISOString()): AdminBotServiceResponse<{
    nudges: AdminBotPaperNudge[];
  }> {
    return {
      ok: true,
      status: 200,
      payload: {
        nudges: this.store
          .listPapers()
          .map(withPaperTimeline)
          .flatMap((paper) => duePaperNudges(paper, nowIso)),
      },
    };
  }

  // Where members are, Slack first and the roster location only where Slack has nothing.
  // Reads stamped state: refreshing from Slack is refreshMemberMap's job, not a page
  // load's, so opening the map never waits on 144 API calls.
  memberMap(): AdminBotServiceResponse<AdminBotMemberMap> {
    const members = this.store.listLabMembers();
    const slackLocations = new Map<string, string>();
    for (const member of members) {
      if (member.slack_user_id && member.slack_location) {
        slackLocations.set(member.slack_user_id, member.slack_location);
      }
    }
    return { ok: true, status: 200, payload: buildMemberMap(members, slackLocations) };
  }

  // Re-reads every member's Slack profile and stamps what it finds. A member Slack has
  // nothing for is cleared rather than left stale: keeping an old value would quietly
  // outrank their roster location forever.
  async refreshMemberMap(
    fetchSlackLocations: (slackUserIds: string[]) => Promise<ReadonlyMap<string, string>>,
    actor: string,
  ): Promise<AdminBotServiceResponse<{ checked: number; updated: number }>> {
    const members = this.store.listLabMembers().filter((member) => member.slack_user_id);
    const ids = members.flatMap((member) => (member.slack_user_id ? [member.slack_user_id] : []));
    const located = await fetchSlackLocations(ids);
    const now = new Date().toISOString();
    let updated = 0;
    for (const member of members) {
      const next = located.get(member.slack_user_id ?? "")?.trim() || undefined;
      if ((member.slack_location ?? undefined) === next) {
        continue;
      }
      const stored: AdminBotLabMember = { ...member, updated_at: now };
      if (next) {
        stored.slack_location = next;
        stored.slack_location_updated_at = now;
      } else {
        delete stored.slack_location;
        delete stored.slack_location_updated_at;
      }
      this.store.saveLabMember(stored);
      if (stored.slack_location) {
        // Slack is a third opinion, not the profile: recorded as its own source so the timeline
        // shows where each claim came from, and never compared against the profile for drift.
        this.recordMemberLocation({
          memberId: stored.id,
          source: "slack_profile",
          raw: stored.slack_location,
        });
      }
      updated += 1;
    }
    this.recordAudit({
      type: "member_map.refreshed",
      actor,
      details: { checked: ids.length, updated },
    });
    return { ok: true, status: 200, payload: { checked: ids.length, updated } };
  }

  // Keeps two profile fields current from Slack: backfills `slack_user_id` for members the
  // roster has never linked (by email match against the workspace directory), then re-reads
  // Slack's `tz` for every member who now has one and stamps it onto `timezone`. Like
  // refreshMemberMap, a member Slack has nothing for is cleared rather than left stale -- an
  // account that left the workspace should not keep outranking a member's own updated timezone
  // forever. slack_user_id itself is only ever added, never removed, since resolution can only
  // ever confirm a link, not disprove one.
  async refreshMemberDirectoryFromSlack(
    deps: {
      resolveSlackUserIdsByEmail?: (emails: string[]) => Promise<ReadonlyMap<string, string>>;
      // A present key means Slack answered for that user: a string is their zone, `null` is
      // "Slack has none". An *absent* key means the lookup never succeeded, which must never be
      // read as an answer -- see the clearing rule below.
      fetchSlackTimezones?: (slackUserIds: string[]) => Promise<ReadonlyMap<string, string | null>>;
      // Messages each member sent inside the activity window. Same present/absent contract as the
      // timezone reader: an absent key means the sweep could not measure that member, which must
      // never be stored as zero -- zero is "we looked and they said nothing", and the badge reads
      // the two differently.
      // Takes the channels to read as well as the members to count: Slack has no "messages by
      // user" endpoint a bot token can call, so the only route is reading channels and tallying by
      // author, and the store is what knows which channels the lab tracks.
      fetchSlackMessageCounts?: (
        slackUserIds: string[],
        channelIds: string[],
      ) => Promise<ReadonlyMap<string, number>>;
    },
    actor: string,
  ): Promise<
    AdminBotServiceResponse<{
      idsResolved: number;
      timezonesChecked: number;
      timezonesUpdated: number;
      activityChecked: number;
    }>
  > {
    const now = new Date().toISOString();
    let idsResolved = 0;
    if (deps.resolveSlackUserIdsByEmail) {
      const unlinked = this.store
        .listLabMembers()
        .filter(
          (member): member is AdminBotLabMember & { email: string } =>
            !member.slack_user_id && Boolean(member.email),
        );
      const resolved = await deps.resolveSlackUserIdsByEmail(
        unlinked.map((member) => member.email),
      );
      for (const member of unlinked) {
        const slackUserId = resolved.get(member.email.trim().toLowerCase());
        if (!slackUserId) {
          continue;
        }
        this.store.saveLabMember({ ...member, slack_user_id: slackUserId, updated_at: now });
        idsResolved += 1;
      }
    }
    let timezonesChecked = 0;
    let timezonesUpdated = 0;
    if (deps.fetchSlackTimezones) {
      const members = this.store.listLabMembers().filter((member) => member.slack_user_id);
      const ids = members.flatMap((member) => (member.slack_user_id ? [member.slack_user_id] : []));
      const timezones = await deps.fetchSlackTimezones(ids);
      for (const member of members) {
        const slackUserId = member.slack_user_id ?? "";
        // Not asked, or the ask failed. Clearing here is how a transport problem used to wipe a
        // roster: an empty result is indistinguishable from "Slack knows nothing about anyone",
        // and timezone is a mandatory field, so a failed refresh quietly made every profile
        // incomplete. Absent means unknown, and unknown leaves the stored value alone.
        if (!timezones.has(slackUserId)) {
          continue;
        }
        timezonesChecked += 1;
        const answer = timezones.get(slackUserId);
        const next = answer?.trim() || undefined;
        if ((member.timezone ?? undefined) === next) {
          continue;
        }
        const stored: AdminBotLabMember = { ...member, updated_at: now };
        if (next) {
          stored.timezone = next;
        } else {
          delete stored.timezone;
        }
        this.store.saveLabMember(stored);
        timezonesUpdated += 1;
      }
    }
    this.recordAudit({
      type: "member_directory.slack_synced",
      actor,
      details: { idsResolved, timezonesChecked, timezonesUpdated },
    });
    // Message counts, stamped last so a member linked earlier in this same pass is included.
    let activityChecked = 0;
    if (deps.fetchSlackMessageCounts) {
      const linked = this.store
        .listLabMembers()
        .filter((member): member is AdminBotLabMember & { slack_user_id: string } =>
          Boolean(member.slack_user_id?.trim()),
        );
      if (linked.length) {
        const channelIds = this.store
          .listSlackChannelNamingRecords()
          .map((record) => record.channel_id)
          .filter(Boolean);
        const counts = await deps.fetchSlackMessageCounts(
          linked.map((member) => member.slack_user_id),
          channelIds,
        );
        for (const member of linked) {
          const count = counts.get(member.slack_user_id);
          // Absent means the sweep could not measure this member. Leave the previous reading in
          // place rather than overwriting it with a zero nobody observed.
          if (count === undefined) {
            continue;
          }
          activityChecked += 1;
          this.store.saveLabMember({
            ...member,
            slack_messages_7d: count,
            slack_activity_checked_at: now,
            updated_at: now,
          });
        }
        this.recordAudit({
          type: "lab_member.upserted",
          actor,
          details: { slack_activity_checked: activityChecked },
        });
      }
    }
    return {
      ok: true,
      status: 200,
      payload: { idsResolved, timezonesChecked, timezonesUpdated, activityChecked },
    };
  }

  // Reviewing cycles and their firing history, for the admin panel. Reads persisted
  // state only — refreshing it from OpenReview is the workflow's job, not a page load's.
  listOpenReviewStatus(): AdminBotServiceResponse<{
    cycles: AdminBotOpenReviewCycleRecord[];
    milestones: AdminBotOpenReviewMilestoneRecord[];
  }> {
    return {
      ok: true,
      status: 200,
      payload: {
        cycles: this.store.listOpenReviewCycles(),
        milestones: this.store.listOpenReviewMilestones(),
      },
    };
  }

  // Composes and immediately sends one `member_nudge.send` proposal per recipient (paper-flow
  // reminder or general announcement). Unlike every other outbound-message action type, this one
  // is auto-approved (see DEFAULT_ACTION_POLICIES) and executed inline instead of waiting in
  // Pending actions for a separate pi/lab_manager approval: creating it already requires a real
  // admin session (POST /nudges/send is gated the same way as /settings), so that
  // admin gate itself *is* the approval — a second review step would just be an invisible,
  // undiscoverable extra click for a tool only admins can reach in the first place. A member
  // missing the contact field the chosen channel needs, or whose send fails, is skipped with a
  // reason rather than failing the whole batch.
  /**
   * Record that a member has (or has not) finished one onboarding step.
   *
   * Onboarding used to be write-once: it was generated at first upsert and no
   * code path ever changed it, so every checklist stayed permanently unfinished
   * and could not drive anything.
   */
  setOnboardingStep(
    memberId: string,
    stepId: string,
    complete: boolean,
    actor: string,
  ): AdminBotServiceResponse<AdminBotLabMember> {
    const member = this.store.getLabMember(memberId);
    if (!member) {
      return serviceError(404, "member not found");
    }
    const onboarding = member.onboarding ?? buildInitialOnboarding();
    if (!findOnboardingStep(onboarding, stepId)) {
      return serviceError(400, `unknown onboarding step: ${stepId}`);
    }
    const stored: AdminBotLabMember = {
      ...member,
      onboarding: setOnboardingStepStatus(onboarding, stepId, complete),
      updated_at: new Date().toISOString(),
    };
    this.store.saveLabMember(stored);
    this.recordAudit({
      type: "onboarding.step_updated",
      actor,
      details: { member_id: memberId, step_id: stepId, complete },
    });
    return { ok: true, status: 200, payload: stored };
  }

  /**
   * Members who have not finished `stepId` yet.
   *
   * Alumni and external collaborators are excluded: the checklist is for people
   * currently working in the lab, and nudging someone who has left is worse than
   * not nudging at all.
   */
  /**
   * Records that an onboarding guide went out. Audited rather than stored as state: the email is
   * the artifact, and "who onboarded whom, when" is exactly the question the audit log answers.
   */
  recordOnboardingGuideSent(params: {
    actor: string;
    template_id: string;
    email: string;
    sent: boolean;
  }): void {
    this.recordAudit({
      type: "onboarding.guide_sent",
      actor: params.actor,
      details: {
        template_id: params.template_id,
        recipient: params.email,
        sent: params.sent,
      },
    });
  }

  /**
   * Records that the guide's send filed a DCS Slack-access request, or failed to.
   *
   * The request lands on a Microsoft Form with no receipt and no callback, so this row is the only
   * evidence it was attempted. It used to be written by the approval path; the trigger moved to
   * the send, and the record moved with it.
   */
  recordDcsFormAttempt(params: {
    actor: string;
    template_id: string;
    email: string;
    submitted: boolean;
    error?: string;
  }): void {
    this.recordAudit({
      type: params.submitted ? "auth.dcs_form_submitted" : "auth.dcs_form_failed",
      actor: params.actor,
      details: {
        template_id: params.template_id,
        recipient: params.email,
        ...(params.error ? { error: params.error } : {}),
      },
    });
  }

  listOnboardingStepPending(
    stepId: string,
  ): AdminBotServiceResponse<{ step_id: string; message: string; members: AdminBotLabMember[] }> {
    if (!onboardingStepIds().includes(stepId)) {
      return serviceError(400, `unknown onboarding step: ${stepId}`);
    }
    const members = this.store
      .listLabMembers()
      .filter(isActiveRosterMember)
      .filter((member) => !isOnboardingStepComplete(member.onboarding, stepId));
    // The composed nudge text rides along so the reaction-confirm poller
    // (scripts/adminbot_onboarding_confirm.py) re-nudges with exactly the words the service
    // itself would send, instead of keeping a second copy of the message.
    const message = buildOnboardingNudgeMessage(
      findOnboardingStep(buildInitialOnboarding(), stepId),
    );
    return { ok: true, status: 200, payload: { step_id: stepId, message, members } };
  }

  // Read-only, so it carries no privilege gate of its own at the route level (same shape as
  // listPaperNudges) -- it is what the daily reminder run and the Control UI dashboard both check
  // before deciding whether there is anything to warn about.
  /**
   * One-time backfill of the `notes` line convention into the fields that now own those facts.
   *
   * ui/src/ui/adminbot/data/member-notes.ts encoded seven profile fields as "Label: value" lines
   * inside the free-text notes column, with no server-side schema. Five of them duplicated real
   * contract fields, so the same fact lived in two places and whichever one a reader consulted
   * decided the answer -- which is why making any of them mandatory was unsafe.
   *
   * Deliberately conservative, because this rewrites stored member records:
   *   - a contract field that already holds something is never overwritten; the line is dropped
   *     as the duplicate it is,
   *   - a line whose label is not one of the seven is left in notes untouched,
   *   - notes keeps whatever prose remains, and is cleared only when nothing is left.
   * Re-running it is a no-op once the lines are gone, so a partial run is safe to repeat.
   */
  /**
   * Link the author lists of every paper that predates the picker.
   *
   * Without this, an old paper only becomes visible to its coauthors the next time somebody saves
   * it -- which for a finished paper is never. One pass fixes the back catalogue; after it, the
   * links are maintained by the card.
   *
   * `dryRun` is the default. The pass rewrites the author list of every paper in the lab, and
   * seeing what it would link before it links it is worth one extra call.
   */
  backfillPaperAuthorLinks(params: { actor: string; dryRun?: boolean }): AdminBotServiceResponse<{
    dry_run: boolean;
    papers_scanned: number;
    papers_updated: number;
    authors_linked: number;
    unresolved: Array<{ paper_id: string; name: string }>;
  }> {
    const dryRun = params.dryRun !== false;
    const roster = this.store.listLabMembers();
    const papers = this.store.listPapers();
    const now = new Date().toISOString();
    let papersUpdated = 0;
    let authorsLinked = 0;
    const unresolved: Array<{ paper_id: string; name: string }> = [];
    for (const paper of papers) {
      const links = buildAuthorLinks({
        ...(paper.author_links ? { links: paper.author_links } : {}),
        names: paper.authors,
        roster,
      });
      const before = JSON.stringify(paper.author_links ?? []);
      const linkedNow = links.filter((link) => link.member_id || link.email).length;
      const linkedBefore = (paper.author_links ?? []).filter(
        (link) => link.member_id || link.email,
      ).length;
      for (const link of links) {
        if (!link.member_id && !link.email) {
          unresolved.push({ paper_id: paper.id, name: link.name });
        }
      }
      if (before === JSON.stringify(links)) {
        continue;
      }
      papersUpdated += 1;
      authorsLinked += Math.max(0, linkedNow - linkedBefore);
      if (!dryRun) {
        this.store.savePaper({
          ...paper,
          author_links: links,
          authors: authorNamesFromLinks(links),
          updated_at: now,
        });
      }
    }
    if (!dryRun && papersUpdated > 0) {
      this.recordAudit({
        type: "paper_author_links.backfilled",
        actor: params.actor,
        details: { papers_updated: papersUpdated, authors_linked: authorsLinked },
      });
    }
    return {
      ok: true,
      status: 200,
      payload: {
        dry_run: dryRun,
        papers_scanned: papers.length,
        papers_updated: papersUpdated,
        authors_linked: authorsLinked,
        // Names the roster could not place: a person who left, an external nobody has recorded an
        // address for, or two members who share a name. Each one is a row somebody should open.
        unresolved,
      },
    };
  }

  /**
   * Put the lab's own people on the nudge list, once, and leave every decision already made alone.
   *
   * The allowlist starts empty, which is the only honest default for a list whose point is that
   * somebody chose each name -- but an empty list also means the lab's real members stop being
   * chased, so there has to be a first population and this is it. `full` is the criterion because
   * it is the one the spreadsheet already carries for "this person is in the lab", and it is the
   * distinction the 124 coauthors, acquaintances and blank rows fail.
   *
   * Only members whose flag has never been set are touched. That is what makes it safe to run
   * twice: an admin who removed somebody stays removed, because `false` is a decision and this
   * only fills in the absence of one. It never removes anybody -- taking somebody off the list is
   * an admin editing a record, not a sweep.
   */
  seedNudgeListFromMemberTypes(params: { actor: string; dryRun: boolean }): AdminBotServiceResponse<{
    dry_run: boolean;
    members_scanned: number;
    members_added: number;
    added: string[];
    /** Written off the list because their access level has no portal to act on a nudge in. */
    members_silenced: number;
    silenced: string[];
    /** Already decided either way, so left as they are. Reported so the count is explicable. */
    already_decided: number;
    /** No member type on the roster, so the sheet cannot answer for them. Left for a human. */
    undecided: number;
  }> {
    const members = this.store.listLabMembers();
    const headProfessorId = this.resolveSettings().head_professor_member_id?.trim();
    const now = new Date().toISOString();
    const added: string[] = [];
    const silenced: string[] = [];
    let alreadyDecided = 0;
    let undecided = 0;
    for (const member of members) {
      if (member.receives_nudges !== undefined) {
        alreadyDecided += 1;
        continue;
      }
      // The head professor is written off the list rather than onto it, whatever the sheet says.
      // They are typed `full` like everyone else in the lab, so the member-type rule below would
      // opt them in -- and it did: the weekly paper-update sweep names every paper they coauthor,
      // which for a PI is every paper, so one Sunday pass produces a DM and a portal toast listing
      // the entire lab's output. Every nudge asks the recipient to go and do something about work
      // they owe, and the professor owes none of it; the escalation path runs towards them, not at
      // them. Stored as `false` rather than left absent so a later seeding run cannot re-add them.
      if (headProfessorId && member.id === headProfessorId) {
        silenced.push(member.id);
        if (!params.dryRun) {
          this.store.saveLabMember({ ...member, receives_nudges: false, updated_at: now });
        }
        continue;
      }
      // Off, explicitly, for anybody whose access level has no portal: every nudge AdminBot sends
      // asks somebody to go and do something in the Control UI, so mailing a person who cannot
      // sign in is asking for something they cannot give. Written as a stored `false` rather than
      // left absent because absent is "nobody has decided" -- and this is a decision, taken from
      // the access sheet, that no later import or seeding run should quietly reverse.
      // The whole rule lives in adminBotNudgeRosterDecision; this loop only applies it and counts.
      // Alumni are written off the list even though row 7 gives them a portal: the portal is for
      // reading their own record, not for being chased in. sendMemberNudge refuses them outright
      // regardless, so the stored `false` is the checkbox telling the truth rather than the
      // enforcement.
      const decision = adminBotNudgeRosterDecision(member);
      if (decision === undefined) {
        // The roster cannot answer: no member type, no batch, nothing disqualifying either. They
        // stay silent by default, and a human decides rather than this recording a guess.
        undecided += 1;
        continue;
      }
      if (decision) {
        added.push(member.id);
      } else {
        silenced.push(member.id);
      }
      if (!params.dryRun) {
        this.store.saveLabMember({ ...member, receives_nudges: decision, updated_at: now });
      }
    }
    if (!params.dryRun && (added.length > 0 || silenced.length > 0)) {
      this.recordAudit({
        type: "nudge_list.seeded",
        actor: params.actor,
        details: {
          members_added: added.length,
          member_ids: added,
          members_silenced: silenced.length,
          silenced_member_ids: silenced,
        },
      });
    }
    return {
      ok: true,
      status: 200,
      payload: {
        dry_run: params.dryRun,
        members_scanned: members.length,
        members_added: added.length,
        added,
        members_silenced: silenced.length,
        silenced,
        already_decided: alreadyDecided,
        undecided,
      },
    };
  }

  migrateMemberNotesToFields(actor: string): AdminBotServiceResponse<{
    membersScanned: number;
    membersUpdated: number;
    fieldsFilled: number;
  }> {
    // Label as written by buildMemberNotes -> the field that now owns it. `research interests`
    // lands on research_topics, which is a list, so it is split the way the roster stores it.
    const LINE_FIELDS: Array<[string, keyof AdminBotLabMember]> = [
      ["location", "location"],
      ["joined month", "joined_month"],
      ["research interests", "research_topics"],
      ["gmail for calendar", "calendar_email"],
      ["whatsapp", "whatsapp"],
      ["github", "github_url"],
      ["personal website", "personal_website"],
    ];
    const now = new Date().toISOString();
    let membersUpdated = 0;
    let fieldsFilled = 0;
    const members = this.store.listLabMembers();
    for (const member of members) {
      const notes = typeof member.notes === "string" ? member.notes : "";
      if (!notes.trim()) {
        continue;
      }
      const kept: string[] = [];
      const patch: Record<string, unknown> = {};
      let touched = false;
      for (const rawLine of notes.split("\n")) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }
        const [rawKey, ...rest] = line.split(":");
        const key = rawKey?.trim().toLowerCase() ?? "";
        const value = rest.join(":").trim();
        const match = LINE_FIELDS.find(([label]) => label === key);
        if (!match || !value) {
          kept.push(line);
          continue;
        }
        touched = true;
        const [, field] = match;
        const existing = member[field];
        const alreadySet = Array.isArray(existing)
          ? existing.filter(Boolean).length > 0
          : String(existing ?? "").trim() !== "";
        if (alreadySet) {
          // The field wins. The line was a duplicate of a fact already stored properly.
          continue;
        }
        patch[field] =
          field === "research_topics"
            ? value
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean)
            : value;
        fieldsFilled += 1;
      }
      if (!touched) {
        continue;
      }
      const remaining = kept.join("\n").trim();
      const stored: AdminBotLabMember = { ...member, ...patch, updated_at: now };
      if (remaining) {
        stored.notes = remaining;
      } else {
        delete stored.notes;
      }
      this.store.saveLabMember(stored);
      membersUpdated += 1;
    }
    this.recordAudit({
      type: "lab_member.notes_migrated",
      actor,
      details: { members_scanned: members.length, members_updated: membersUpdated, fieldsFilled },
    });
    return {
      ok: true,
      status: 200,
      payload: { membersScanned: members.length, membersUpdated, fieldsFilled },
    };
  }

  listMembersWithIncompleteMandatoryFields(): AdminBotServiceResponse<{
    members: Array<{ id: string; name: string; missing_fields: string[] }>;
  }> {
    const members = this.store
      .listLabMembers()
      .filter(isActiveRosterMember)
      .map((member) => ({ member, missing: missingMandatoryProfileFields(member) }))
      .filter(({ missing }) => missing.length > 0)
      .map(({ member, missing }) => ({
        id: member.id,
        name: member.name,
        missing_fields: missing,
      }));
    return { ok: true, status: 200, payload: { members } };
  }

  /**
   * Every active member, and how far along their own record is.
   *
   * The lab-wide read behind the profile overview: who has filled their profile in, and who has
   * actually used the timeline tool to say when they are working. Both are things a member owns
   * and nobody else can do for them, which is why the answer is a list of names rather than a
   * number -- the follow-up is a conversation with a person.
   *
   * Admin-only at the route, unlike listMembersWithIncompleteMandatoryFields: that one answers
   * "is *my* profile complete" for the member's own dashboard, so it is open to anyone signed in.
   * This one is everybody's completeness at once, which is a governance read.
   *
   * Alumni and external collaborators are left out for the same reason the reminder pass leaves
   * them out: the fields are asked of people currently working here.
   */
  /**
   * Everybody's profile, completeness *and* adoption.
   *
   * The two are different questions and the page needs both. Completeness ("12 of 12 fields") says
   * whether the lab has the data; adoption ("3 of 12, and they have never signed in") says whether
   * the member has ever been here. The roster was bulk-imported, so most rows score full marks on
   * the first and nothing on the second -- which is the list to chase.
   */
  listMemberProfileOverview(): AdminBotServiceResponse<{
    members: AdminBotMemberProfileOverviewRow[];
    mandatory_field_count: number;
    adoption: ReturnType<typeof adoptionSummary>;
  }> {
    const remindedAt = this.lastMandatoryFieldsReminderByMember();
    // Read once for the whole page rather than per member: all of these are full-table reads, and
    // doing them inside the map turns a 77-member roster into hundreds of queries.
    const papers = this.store.listPapers();
    const weeklyUpdates = this.store.listPaperWeeklyUpdates();
    const activity = this.memberActivityCounts();
    const members = this.store
      .listLabMembers()
      .filter(isActiveRosterMember)
      .map((member) => {
        const missing = missingMandatoryProfileFields(member);
        const timeline = countTimelineEntries(member);
        const reminded = remindedAt.get(member.id);
        const selfEdited = lastSelfEditAt(member);
        return {
          id: member.id,
          name: member.name,
          ...(member.status ? { status: member.status } : {}),
          ...(member.member_type ? { member_type: member.member_type } : {}),
          privilege_level: member.privilege_level,
          missing_fields: missing,
          filled_field_count: MANDATORY_PROFILE_FIELDS.length - missing.length,
          // The adoption half of the same row: filled is "is there a value", this is "did the
          // person it is about put it there".
          self_filled_field_count: selfFilledFieldCount(member, MANDATORY_PROFILE_FIELDS),
          projects: projectAdoption({
            memberId: member.id,
            paperIds: papers
              .filter((paper) => this.memberOwnsPaper(member, paper))
              .map((paper) => paper.id),
            updates: weeklyUpdates,
          }),
          timeline,
          activity: activity.get(member.id) ?? EMPTY_ACTIVITY,
          // The audit trail wins when it has something: `last_login_at` is a single field that a
          // bulk write can erase, and on this roster it has been. Falling back to it keeps rows
          // correct for anyone whose sign-in predates the retention window.
          ...((activity.get(member.id)?.last_login_at ?? member.last_login_at)
            ? {
                last_login_at: (activity.get(member.id)?.last_login_at ??
                  member.last_login_at) as string,
              }
            : {}),
          updated_at: member.updated_at,
          ...(selfEdited ? { last_self_edit_at: selfEdited } : {}),
          ...(reminded ? { last_reminded_at: new Date(reminded).toISOString() } : {}),
        };
      })
      .toSorted(byProfileProgress);
    return {
      ok: true,
      status: 200,
      payload: {
        members,
        mandatory_field_count: MANDATORY_PROFILE_FIELDS.length,
        adoption: adoptionSummary(members, MANDATORY_PROFILE_FIELDS.length),
      },
    };
  }

  /**
   * One pass over the audit trail, bucketed by member.
   *
   * The audit log is the only place that records a member *doing* something, and it records the
   * actor by id, so this is a group-by rather than a per-member query. It is also the only source
   * that has depth today: the dedicated login and update-event tables are the permanent record
   * going forward, but they start empty, and a page that showed zeros for a lab that has been
   * signing in for a month would be worse than one that showed a floor and said so.
   *
   * `lab_member.upserted` is deliberately read as the member's *own* edit. The event records the
   * subject member as the actor, so an admin correcting somebody else's record lands on the
   * subject's row -- which overcounts self-edits for exactly the rows an admin has touched. It is
   * the same conflation `field_provenance` exists to resolve, and the self_filled_field_count
   * column next to this one is the number to trust when the two disagree.
   */
  private memberActivityCounts(): Map<
    string,
    AdminBotMemberActivityCounts & { last_login_at?: string }
  > {
    const counts = new Map<string, AdminBotMemberActivityCounts & { last_login_at?: string }>();
    const bulkSeconds = this.bulkMemberWriteSeconds();
    const bucket = (actor: string) => {
      const existing = counts.get(actor);
      if (existing) {
        return existing;
      }
      const created = { logins: 0, profile_edits: 0, paper_updates: 0 };
      counts.set(actor, created);
      return created;
    };
    for (const event of this.store.listAuditEvents()) {
      const actor = event.actor;
      if (!actor) {
        continue;
      }
      let row: (AdminBotMemberActivityCounts & { last_login_at?: string }) | undefined;
      if (event.type === "auth.login_succeeded") {
        row = bucket(actor);
        row.logins += 1;
        if (!row.last_login_at || event.timestamp > row.last_login_at) {
          row.last_login_at = event.timestamp;
        }
      } else if (event.type === "lab_member.upserted") {
        // An importer writing the whole roster is not 77 people editing their profiles. Without
        // this every member carries five or six phantom edits from the spreadsheet syncs, which is
        // precisely the "complete on paper, adopted by nobody" illusion this column exists to
        // break.
        if (bulkSeconds.has(event.timestamp.slice(0, 19))) {
          continue;
        }
        row = bucket(actor);
        row.profile_edits += 1;
      } else if (event.type === "paper_slot.updated" || event.type === "paper.upserted") {
        row = bucket(actor);
        row.paper_updates += 1;
      }
      if (row && (!row.last_active_at || event.timestamp > row.last_active_at)) {
        row.last_active_at = event.timestamp;
      }
    }
    return counts;
  }

  /**
   * Seconds in which so many different members were written that it can only have been one pass.
   *
   * A threshold rather than a flag on the event, because nothing in the stored audit row says
   * "this was an import" -- the writer is long gone by the time this reads it. Five distinct
   * members inside the same second is not five people typing; the largest real burst is one admin
   * correcting a handful of records, and that stays well under it.
   */
  private bulkMemberWriteSeconds(): Set<string> {
    const actorsBySecond = new Map<string, Set<string>>();
    for (const event of this.store.listAuditEvents()) {
      if (event.type !== "lab_member.upserted" || !event.actor) {
        continue;
      }
      const second = event.timestamp.slice(0, 19);
      const actors = actorsBySecond.get(second) ?? new Set<string>();
      actors.add(event.actor);
      actorsBySecond.set(second, actors);
    }
    const bulk = new Set<string>();
    for (const [second, actors] of actorsBySecond) {
      if (actors.size >= BULK_MEMBER_WRITE_THRESHOLD) {
        bulk.add(second);
      }
    }
    return bulk;
  }

  /**
   * Slack-nudge every member whose profile is missing a required field. Meant to run once a day
   * from cron (scripts/adminbot-mandatory-fields-cron.sh), not from a click: the message is fixed
   * and the recipient list is entirely server-computed from roster state, so there is no
   * admin-or-agent-controlled content or targeting for the usual "requires a genuine admin
   * session" gate to protect against (see requirePrivileged vs requireMemberPrivileged in
   * api/server.ts, and the identical reasoning already applied to /openreview/cycle/run).
   *
   * Delivery still goes through sendMemberNudge, so this is still propose -> auto-execute ->
   * audit, exactly like every other member_nudge.send -- it just computes its own recipients
   * instead of taking them from a request body.
   */
  async sendMandatoryFieldsReminders(
    actor: string,
    options: {
      /**
       * Which gap to chase. `both` is the default and the reason this parameter exists: the sweep
       * used to chase only missing profile fields, so a full member with a complete profile who
       * had never opened the timeline tool was never asked -- which is most of the people the
       * Profile Overview page was built to find.
       */
      include?: AdminBotProfileReminderScope;
      /** Narrows to people an admin picked out of the page. Only ever subtracts. */
      recipientIds?: string[];
    } = {},
  ): Promise<AdminBotServiceResponse<AdminBotMemberNudgeResult>> {
    const include = options.include ?? "both";
    const chosen = options.recipientIds?.length ? new Set(options.recipientIds) : undefined;
    // Take back what is already settled before deciding who to chase. A member can close their gap
    // without touching their own profile page -- an admin fills in a field, a trip lands on the
    // timeline -- and the reminder they were sent last week is still sitting unread until somebody
    // says otherwise. See retractSettledProfileNudges.
    for (const member of this.store.listLabMembers()) {
      this.retractSettledProfileNudges(member.id);
    }
    const attention = this.membersNeedingProfileAttention().filter((row) => {
      if (chosen && !chosen.has(row.id)) {
        return false;
      }
      const wantsProfile = include !== "timeline" && row.missing_fields.length > 0;
      const wantsTimeline = include !== "profile" && row.timeline_short;
      return wantsProfile || wantsTimeline;
    });
    // Who was reminded recently, so the cadence is a property of the product rather than of
    // whatever schedule happens to invoke the cron script. A misconfigured crontab, a manual run,
    // or two hosts running the same job cannot turn this into a daily nag.
    const remindedAt = this.lastMandatoryFieldsReminderByMember();
    const cutoff = Date.now() - MANDATORY_FIELDS_REMINDER_INTERVAL_MS;
    const due = attention.filter((row) => (remindedAt.get(row.id) ?? 0) <= cutoff);
    if (due.length === 0) {
      return { ok: true, status: 200, payload: { created: [], skipped: [] } };
    }
    // Grouped by the message they get rather than sent one request per person: everybody in a group
    // is owed exactly the same sentence, so they can share one send. The key is the gap itself now
    // that the text names it -- people missing the same fields still batch, and nobody is told about
    // a field somebody else is missing. A member missing both halves is told both in one message;
    // two separate nudges about the same page reads as a system that does not know what it already
    // sent.
    const groups = new Map<string, { missingFields: string[]; timeline: boolean; ids: string[] }>();
    for (const row of due) {
      const missingFields = include !== "timeline" ? row.missing_fields : [];
      const timeline = include !== "profile" && row.timeline_short;
      const key = `${missingFields.join(",")}|${timeline}`;
      const group = groups.get(key) ?? { missingFields, timeline, ids: [] };
      group.ids.push(row.id);
      groups.set(key, group);
    }
    const created: AdminBotMemberNudgeResult["created"] = [];
    const skipped: AdminBotMemberNudgeResult["skipped"] = [];
    const notified: string[] = [];
    for (const { missingFields, timeline, ids: recipients } of groups.values()) {
      const needsProfile = missingFields.length > 0;
      const result = await this.sendMemberNudge(
        {
          channel: "slack",
          recipient_member_ids: recipients,
          message: buildProfileReminderMessage({ missingFields, timeline }),
          kind: "profile",
          title: needsProfile
            ? missingFields.length === 1
              ? "Your profile is missing a required field"
              : "Your profile is missing required fields"
            : "Your term timeline is empty",
          tab: needsProfile ? "profile" : "adminbotTimeAvailability",
          // Important: both halves are things only the member can do, and everything downstream --
          // scheduling, travel, the calendar's timezones -- is planned from them.
          important: true,
        },
        actor,
      );
      if (!result.ok) {
        for (const id of recipients) {
          skipped.push({ member_id: id, reason: result.error.message });
        }
        continue;
      }
      created.push(...result.payload.created);
      skipped.push(...result.payload.skipped);
      // Stamp only the members a nudge was actually created for. Someone sendMemberNudge skipped
      // (no Slack id on file, say) has not been reminded, and must not wait three days to be
      // considered again.
      notified.push(
        ...recipients.filter((id) => !result.payload.skipped.some((skip) => skip.member_id === id)),
      );
    }
    if (notified.length > 0) {
      this.recordAudit({
        type: "mandatory_fields.reminded",
        actor,
        details: { member_ids: notified, include },
      });
    }
    return { ok: true, status: 200, payload: { created, skipped } };
  }

  /**
   * Everyone with a gap only they can close, and which gap it is.
   *
   * Two different questions in one walk, because they are chased in one message. The profile half
   * is asked of every active member; the timeline half only of full members (see
   * isAdminBotFullMember) -- a term plan is a thing the lab asks of its own people, and asking a
   * coauthor at another university when they are working is both useless and slightly rude.
   */
  membersNeedingProfileAttention(): Array<{
    id: string;
    name: string;
    missing_fields: string[];
    timeline_short: boolean;
  }> {
    return this.store
      .listLabMembers()
      .filter(isActiveRosterMember)
      .map((member) => ({
        id: member.id,
        name: member.name,
        missing_fields: missingMandatoryProfileFields(member),
        timeline_short:
          isAdminBotFullMember(member) &&
          countTimelineEntries(member).total < adminBotTimelineEntryTarget,
      }))
      .filter((row) => row.missing_fields.length > 0 || row.timeline_short);
  }

  /**
   * Alumni whose Slack Connect invitation is now due, and who has not had one.
   *
   * Due-ness is read off the welcome's own audit row rather than a queue table: the welcome already
   * writes `onboarding.guide_sent`, so the date it went out is recorded, and a second store to keep
   * in step with it would only be a way for the two to disagree. The ledger records the invitation
   * once it goes, which is what stops a nightly sweep minting a fresh Connect link every night for
   * somebody who already has one.
   *
   * Matched on the recipient address the welcome was actually sent to, including the alternates on
   * a member's record: alumni are mailed at whichever address they still read, which is routinely
   * not the institutional one their record is keyed by.
   */
  dueAlumniSlackInvites(options: { nowIso?: string } = {}): Array<{
    member_id: string;
    name: string;
    email: string;
    welcomed_at: string;
  }> {
    const now = options.nowIso ? new Date(options.nowIso) : new Date();
    const cutoff =
      now.getTime() - adminBotAlumniSlackInviteDelayDays * 24 * 60 * 60 * 1000;
    const byAddress = new Map<string, AdminBotLabMember>();
    for (const member of this.store.listLabMembers()) {
      for (const address of [
        member.email,
        member.correspondence_email,
        member.calendar_email,
      ]) {
        const key = address?.trim().toLowerCase();
        if (key) {
          byAddress.set(key, member);
        }
      }
    }
    const ledger = this.nudgeLedgerIndex();
    const due = new Map<string, { member_id: string; name: string; email: string; welcomed_at: string }>();
    for (const event of this.store.listAuditEvents()) {
      if (event.type !== "onboarding.guide_sent") {
        continue;
      }
      const details = event.details as
        | { template_id?: unknown; recipient?: unknown; sent?: unknown }
        | undefined;
      if (
        !details ||
        details.template_id !== ADMINBOT_ALUMNI_TEMPLATE_ID ||
        details.sent !== true ||
        typeof details.recipient !== "string"
      ) {
        continue;
      }
      const welcomedAt = Date.parse(event.timestamp);
      if (!Number.isFinite(welcomedAt) || welcomedAt > cutoff) {
        continue;
      }
      const member = byAddress.get(details.recipient.trim().toLowerCase());
      // A welcome to somebody the roster cannot name is left alone rather than guessed at: the
      // invitation needs a member to file the ledger against, and inventing one is worse than an
      // admin sending it by hand.
      if (!member || adminBotIsAlumniMember(member) === false) {
        continue;
      }
      if (this.hasNudgeBeenSaid(ledger, "alumni_slack_invite", member.id)) {
        continue;
      }
      // Oldest welcome wins when somebody was mailed twice: the delay is measured from the first
      // time they heard from us, not the most recent correction.
      const existing = due.get(member.id);
      if (!existing || Date.parse(existing.welcomed_at) > welcomedAt) {
        due.set(member.id, {
          member_id: member.id,
          name: member.name,
          email: details.recipient.trim(),
          welcomed_at: event.timestamp,
        });
      }
    }
    return [...due.values()].toSorted((left, right) =>
      left.welcomed_at.localeCompare(right.welcomed_at),
    );
  }

  /** The sweep's own row, so a run that sent nothing is still distinguishable from one that never ran. */
  recordAlumniSlackInviteSweep(params: {
    actor: string;
    sent: number;
    skipped: number;
  }): void {
    this.recordAudit({
      type: "alumni_slack_invites.swept",
      actor: params.actor,
      details: {
        after_days: adminBotAlumniSlackInviteDelayDays,
        sent: params.sent,
        skipped: params.skipped,
      },
    });
  }

  /** Record that an alumnus has had their Slack Connect invitation, so no later sweep re-sends it. */
  markAlumniSlackInviteSent(memberId: string, nowIso?: string): void {
    this.markNudgeSaid(
      "alumni_slack_invite",
      memberId,
      memberId,
      nowIso ?? new Date().toISOString(),
    );
  }

  /** Epoch millis of the last mandatory-fields reminder each member received. */
  private lastMandatoryFieldsReminderByMember(): Map<string, number> {
    const latest = new Map<string, number>();
    for (const event of this.store.listAuditEvents()) {
      if (event.type !== "mandatory_fields.reminded") {
        continue;
      }
      const ids = (event.details as { member_ids?: unknown } | undefined)?.member_ids;
      if (!Array.isArray(ids)) {
        continue;
      }
      const at = Date.parse(event.timestamp);
      if (Number.isNaN(at)) {
        continue;
      }
      for (const id of ids) {
        if (typeof id === "string" && at > (latest.get(id) ?? 0)) {
          latest.set(id, at);
        }
      }
    }
    return latest;
  }

  // Reviews Slack profile photos for active lab members and nudges non-compliant members with the
  // fixed guideline copy. Assessment can come from an injected AI reviewer or a deterministic
  // fallback when no reviewer is configured.
  async runProfilePhotoReviewAndReminders(actor: string): Promise<
    AdminBotServiceResponse<{
      reviewed: number;
      non_compliant: number;
      nudges_created: number;
      nudges_skipped: number;
    }>
  > {
    const members = this.store
      .listLabMembers()
      .filter(
        (member) =>
          member.status === "active" ||
          member.status === "part_time" ||
          member.status === "on_leave",
      );
    const now = new Date().toISOString();
    let reviewed = 0;
    const nonCompliantMemberIds: string[] = [];
    for (const member of members) {
      const assessment = await this.assessMemberProfilePhoto(member, now);
      const review = {
        ...(member.profile_photo_review ?? {}),
        assessment,
      };
      this.store.saveLabMember({
        ...member,
        profile_photo_review: review,
        updated_at: now,
      });
      reviewed += 1;
      if (!assessment.compliant) {
        nonCompliantMemberIds.push(member.id);
      }
    }
    const nudge = nonCompliantMemberIds.length
      ? await this.sendMemberNudge(
          {
            channel: "slack",
            recipient_member_ids: nonCompliantMemberIds,
            message: buildProfilePhotoGuidelineMessage(),
            kind: "profile_photo",
            title: "Your profile photo needs replacing",
            tab: "profile",
            // Not important: nothing downstream is blocked on it, and a group DM about somebody's
            // headshot is the escalation that would make every other one easy to ignore.
          },
          actor,
        )
      : ({ ok: true, status: 200, payload: { created: [], skipped: [] } } as const);
    if (!nudge.ok) {
      return nudge;
    }
    const nudgeSet = new Set(nonCompliantMemberIds);
    for (const member of members) {
      if (!nudgeSet.has(member.id)) {
        continue;
      }
      const latest = this.store.getLabMember(member.id);
      if (!latest) {
        continue;
      }
      this.store.saveLabMember({
        ...latest,
        profile_photo_review: {
          ...(latest.profile_photo_review ?? {}),
          last_guideline_dm_at: now,
        },
        updated_at: now,
      });
    }
    this.recordAudit({
      type: "profile_photo.reviewed",
      actor,
      details: { reviewed, non_compliant: nonCompliantMemberIds.length },
    });
    if (nonCompliantMemberIds.length > 0) {
      this.recordAudit({
        type: "profile_photo.guideline_nudged",
        actor,
        details: {
          targeted: nonCompliantMemberIds.length,
          created: nudge.payload.created.length,
          skipped: nudge.payload.skipped.length,
        },
      });
    }
    return {
      ok: true,
      status: 200,
      payload: {
        reviewed,
        non_compliant: nonCompliantMemberIds.length,
        nudges_created: nudge.payload.created.length,
        nudges_skipped: nudge.payload.skipped.length,
      },
    };
  }

  // Generates one AI-polished variant of the signed-in member's current Slack profile photo.
  async polishOwnProfilePhoto(memberId: string): Promise<
    AdminBotServiceResponse<{
      variant: AdminBotProfilePhotoPolishVariant;
      variants: AdminBotProfilePhotoPolishVariant[];
      assessment?: AdminBotProfilePhotoAssessment;
    }>
  > {
    const member = this.store.getLabMember(memberId);
    if (!member) {
      return serviceError(404, "member not found");
    }
    if (!member.slack_user_id) {
      return serviceError(400, "member has no slack_user_id");
    }
    if (!this.options.polishSlackProfilePhoto) {
      return serviceError(503, "profile photo polishing is not configured");
    }
    const existingVariants = member.profile_photo_review?.variants ?? [];
    const polished = await this.options.polishSlackProfilePhoto({
      slackUserId: member.slack_user_id,
      instructions: PROFILE_PHOTO_RULES_TEXT,
      iteration: existingVariants.length + 1,
    });
    const now = new Date().toISOString();
    const variant: AdminBotProfilePhotoPolishVariant = {
      id: `photo_${randomUUID()}`,
      image_data_url: polished.image_data_url,
      created_at: now,
      ...(polished.note ? { note: polished.note } : {}),
    };
    const variants = [...existingVariants, variant];
    const review = {
      ...(member.profile_photo_review ?? {}),
      variants,
    };
    this.store.saveLabMember({
      ...member,
      profile_photo_review: review,
      updated_at: now,
    });
    this.recordAudit({
      type: "profile_photo.polished",
      actor: memberId,
      details: { member_id: memberId, variant_id: variant.id, variants: variants.length },
    });
    return {
      ok: true,
      status: 200,
      payload: { variant, variants, assessment: review.assessment },
    };
  }

  // Applies one previously-generated polished photo to the signed-in member's Slack profile.
  async applyOwnPolishedProfilePhoto(
    memberId: string,
    variantId: string,
  ): Promise<
    AdminBotServiceResponse<{
      variant_id: string;
      action_id: string;
    }>
  > {
    const member = this.store.getLabMember(memberId);
    if (!member) {
      return serviceError(404, "member not found");
    }
    if (!member.slack_user_id) {
      return serviceError(400, "member has no slack_user_id");
    }
    const variants = member.profile_photo_review?.variants ?? [];
    const variant = variants.find((entry) => entry.id === variantId);
    if (!variant) {
      return serviceError(404, "profile photo variant not found");
    }
    const created = this.createProposal({
      type: "slack.profile_photo_update",
      summary: `Update Slack profile photo for ${member.name}`,
      target: {
        service: "slack",
        channel: "slack",
        target: member.slack_user_id,
        recipientMemberId: member.id,
      },
      proposed_payload: {
        channel: "slack",
        tool: "profile",
        action: "set_photo",
        target: member.slack_user_id,
        image_data_url: variant.image_data_url,
      },
      undo_plan: "Reapply the previous profile photo manually in Slack.",
    });
    if (!created.ok) {
      return created;
    }
    const executed = await this.execute(created.payload.id, { dry_run: false });
    if (!executed.ok) {
      return executed;
    }
    const now = new Date().toISOString();
    this.store.saveLabMember({
      ...member,
      profile_photo_review: {
        ...(member.profile_photo_review ?? {}),
        variants,
        selected_variant_id: variant.id,
      },
      avatar_url: variant.image_data_url,
      updated_at: now,
    });
    this.recordAudit({
      type: "profile_photo.applied",
      actor: memberId,
      details: { member_id: memberId, variant_id: variant.id, action_id: created.payload.id },
    });
    return {
      ok: true,
      status: 200,
      payload: { variant_id: variant.id, action_id: created.payload.id },
    };
  }

  /**
   * Nudge everyone who has not finished `stepId`.
   *
   * Membership is roster state, not something observed: LinkedIn exposes no API
   * that can tell you whether a given person follows or works at an
   * organization, so "has this member joined" can only ever be what they or an
   * admin recorded via setOnboardingStep.
   *
   * Delivery reuses sendMemberNudge, so each recipient still becomes its own
   * approve-then-execute proposal with its own audit row.
   */
  async nudgeOnboardingStep(
    request: { step_id: string; channel: AdminBotMemberNudgeChannel; message?: string },
    actor: string,
  ): Promise<AdminBotServiceResponse<AdminBotMemberNudgeResult>> {
    const pending = this.listOnboardingStepPending(request.step_id);
    if (!pending.ok) {
      return pending;
    }
    const recipients = pending.payload.members.map((member) => member.id);
    if (recipients.length === 0) {
      return { ok: true, status: 200, payload: { created: [], skipped: [] } };
    }
    const step = findOnboardingStep(buildInitialOnboarding(), request.step_id);
    return await this.sendMemberNudge(
      {
        channel: request.channel,
        recipient_member_ids: recipients,
        message: request.message?.trim() || pending.payload.message,
        ...(request.channel === "email"
          ? { subject: `Reminder: ${step?.label ?? "an onboarding step"}` }
          : {}),
      },
      actor,
    );
  }

  async sendMemberNudge(
    request: AdminBotMemberNudgeRequest,
    actor: string,
  ): Promise<AdminBotServiceResponse<AdminBotMemberNudgeResult>> {
    const message = request.message.trim();
    if (!message) {
      return serviceError(400, "message is required");
    }
    if (request.recipient_member_ids.length === 0) {
      return serviceError(400, "recipient_member_ids must not be empty");
    }
    if (request.channel === "email" && !request.subject?.trim()) {
      return serviceError(400, "subject is required for the email channel");
    }
    const created: AdminBotStoredProposal[] = [];
    const skipped: AdminBotMemberNudgeSkip[] = [];
    const nowIso = new Date().toISOString();
    const headProfessorMemberId = this.resolveSettings().head_professor_member_id?.trim();
    // Every nudge asks the member to go and do something in the portal, and until now none of them
    // said where the portal is. A member who has not bookmarked it -- which is most of them, most
    // of the time -- got "open your profile page in the Control UI" and no way to act on it without
    // asking somebody for the address. Appended once, here, rather than written into fifteen
    // different message builders: this is the one funnel they all pass through.
    //
    // On the outbound copy only. The stored notification is read *inside* the portal, where a link
    // telling the reader where they already are is noise.
    const portalUrl = resolveAdminBotControlUiUrl();
    const outboundMessage = `${message}\n\n${portalUrl}`;
    for (const memberId of request.recipient_member_ids) {
      const member = this.store.getLabMember(memberId);
      if (!member) {
        skipped.push({ member_id: memberId, reason: "member not found" });
        continue;
      }
      // The allowlist, checked here because here is the only place every nudge passes: fifteen
      // sweeps, the escalation pass and the admin's own hand-written nudge all funnel through this
      // loop. Gating it in the sweeps instead would mean the next sweep somebody writes is a new
      // way to mail a stranger.
      //
      // Ahead of the notification write on purpose. Somebody the lab has decided not to contact
      // does not get a portal notification about it either -- that is still AdminBot addressing
      // them, and it is what the dashboard would nag them with on their next sign-in.
      // Alumni first, and ahead of the list rather than through it: somebody who has left is not
      // chased, and that has been a rule of this system rather than a per-person choice since long
      // before there was a list. The allowlist must not become a way to undo it by ticking a box --
      // an admin who wants to reach an alumnus has their address, and this is not that path.
      if (adminBotIsAlumniMember(member)) {
        skipped.push({ member_id: memberId, reason: "member is alumni" });
        continue;
      }
      // The head professor, ahead of the allowlist for the same reason alumni are. `receives_nudges`
      // is a per-person choice an admin makes, but "AdminBot does not chase the PI" is a property of
      // the system: the escalation path runs towards them, so a sweep that DMs them is the lab
      // nagging the person the nagging is supposed to reach. It was a per-person choice for exactly
      // one release, and seedNudgeListFromMemberTypes promptly ticked the box -- the professor is
      // typed `full` like everybody else -- which put the entire lab's paper list in their Slack
      // and a toast on their dashboard. Enforced here rather than trusted to the stored flag so no
      // future import, seeding run or hand edit can turn it back on by accident.
      if (headProfessorMemberId && member.id === headProfessorMemberId) {
        skipped.push({ member_id: memberId, reason: "member is the head professor" });
        continue;
      }
      if (!adminBotReceivesNudges(member)) {
        skipped.push({ member_id: memberId, reason: "member is not on the nudge list" });
        continue;
      }
      // Filed before the send, and kept whatever the send does. Slack is where the lab talks, but
      // it is also where a message scrolls away, a DM goes to a muted app, or an outage eats the
      // whole batch -- and a member with no linked Slack account is skipped below and would
      // otherwise never be told at all. The notification is the copy the lab can still point at,
      // and it is what the portal and the dashboard warning both read.
      this.store.saveMemberNotification({
        id: `notif_${randomUUID()}`,
        member_id: member.id,
        kind: request.kind ?? "nudge",
        title: request.title?.trim() || request.subject?.trim() || "AdminBot needs something",
        body: message,
        ...(request.tab ? { tab: request.tab } : {}),
        ...(request.important ? { important: true } : {}),
        created_at: nowIso,
      });
      const proposalInput =
        request.channel === "slack"
          ? member.slack_user_id
            ? {
                summary: `Nudge ${member.name} via Slack: ${truncateForSummary(message)}`,
                target: {
                  service: "slack",
                  channel: "slack",
                  target: member.slack_user_id,
                  recipientMemberId: member.id,
                },
                proposed_payload: {
                  channel: "slack",
                  tool: "message",
                  action: "send",
                  target: member.slack_user_id,
                  message: outboundMessage,
                },
                undo_plan: "Send a Slack follow-up correcting or retracting the message.",
              }
            : undefined
          : member.email
            ? {
                summary: `Nudge ${member.name} via email: ${truncateForSummary(message)}`,
                target: {
                  service: "email",
                  channel: "email",
                  target: member.email,
                  recipientMemberId: member.id,
                },
                proposed_payload: {
                  channel: "email",
                  to: member.email,
                  subject: request.subject?.trim(),
                  body: outboundMessage,
                },
                undo_plan: "Send an email follow-up correcting or retracting the message.",
              }
            : undefined;
      if (!proposalInput) {
        skipped.push({
          member_id: memberId,
          reason:
            request.channel === "slack" ? "member has no slack_user_id" : "member has no email",
        });
        continue;
      }
      const created_ = this.createProposal({ type: "member_nudge.send", ...proposalInput });
      if (!created_.ok) {
        skipped.push({ member_id: memberId, reason: created_.error.message });
        continue;
      }
      const executed = await this.execute(created_.payload.id, { dry_run: false });
      if (!executed.ok) {
        skipped.push({ member_id: memberId, reason: executed.error.message });
        continue;
      }
      created.push(this.store.getProposal(created_.payload.id) ?? created_.payload);
    }
    this.recordAudit({
      type: "member_nudge.sent",
      actor,
      details: {
        channel: request.channel,
        requested: request.recipient_member_ids.length,
        created: created.length,
        skipped: skipped.length,
        // Every recipient that resolved to a member was notified in the portal, whether or not the
        // channel send worked, so the audit distinguishes "told" from "delivered".
        notified:
          request.recipient_member_ids.length -
          skipped.filter((entry) => entry.reason === "member not found").length,
        important: Boolean(request.important),
      },
    });
    return { ok: true, status: 200, payload: { created, skipped } };
  }

  /**
   * Leaving: the date the member keeps, the status only an admin can set, and the ceremony.
   *
   * Three messages with three audiences, because they are three different asks. The member is asked
   * whether their finishing month is still right, since they are the only one who knows and the
   * field is theirs. The admins are asked to make the transition once it has passed, because
   * `status` is privileged -- nobody declares themselves alumni -- and because flipping it has
   * access consequences a sweep should not perform on its own. And somebody is asked to book the
   * ceremony while the year's graduates are still reachable.
   *
   * Each is said once per month value, so a member who moves their date is asked again about the
   * new one and not about the old.
   */
  async sweepGraduations(
    actor: string,
    options: { nowIso?: string } = {},
  ): Promise<
    AdminBotServiceResponse<{
      confirmed: Array<{ member_id: string; month: string }>;
      transitions: Array<{ member_id: string; month: string }>;
      ceremony?: { year: number; graduates: number };
      skipped: AdminBotMemberNudgeSkip[];
    }>
  > {
    const now = options.nowIso ? new Date(options.nowIso) : new Date();
    const nowIso = now.toISOString();
    const members = this.store.listLabMembers();
    const ledger = this.nudgeLedgerIndex();
    const confirmed: Array<{ member_id: string; month: string }> = [];
    const transitions: Array<{ member_id: string; month: string }> = [];
    const skipped: AdminBotMemberNudgeSkip[] = [];

    const alreadySaid = (subject: string) => this.hasNudgeBeenSaid(ledger, "graduation", subject);
    const remember = (subject: string, memberId: string) =>
      this.markNudgeSaid("graduation", subject, memberId, nowIso);

    const actions = graduationActions(members, now);
    const dueTransitions: Array<{ member_name: string; month: string; months_since: number }> = [];
    for (const action of actions) {
      const subject = `${action.kind}|${action.member_id}|${action.month}`;
      if (alreadySaid(subject)) {
        continue;
      }
      if (action.kind === "confirm") {
        const sent = await this.sendMemberNudge(
          {
            channel: "slack",
            recipient_member_ids: [action.member_id],
            message: buildGraduationConfirmMessage(action),
            kind: "nudge",
            title: "Is your finishing month still right?",
            tab: "profile",
          },
          actor,
        );
        remember(subject, action.member_id);
        if (!sent.ok) {
          skipped.push({ member_id: action.member_id, reason: sent.error.message });
          continue;
        }
        skipped.push(...sent.payload.skipped);
        confirmed.push({ member_id: action.member_id, month: action.month });
        continue;
      }
      dueTransitions.push({
        member_name: action.member_name,
        month: action.month,
        months_since: action.months_since,
      });
      transitions.push({ member_id: action.member_id, month: action.month });
      remember(subject, action.member_id);
    }

    // The transition list and the ceremony both go to the admins. Resolved once: an installation
    // with no head professor set still has admins on the roster, and silently saying nothing about
    // people who have left is the worse failure.
    const recipients = this.adminNoticeRecipients();
    if (dueTransitions.length) {
      if (!recipients.length) {
        skipped.push({ member_id: "admins", reason: "no admin has a linked Slack account" });
      } else {
        const sent = await this.sendMemberNudge(
          {
            channel: "slack",
            recipient_member_ids: recipients,
            message: buildGraduationTransitionMessage(dueTransitions),
            kind: "nudge",
            title:
              dueTransitions.length === 1
                ? "A member's finishing month has passed"
                : "Finishing months have passed",
            tab: "adminbotMembers",
          },
          actor,
        );
        if (!sent.ok) {
          skipped.push({ member_id: "admins", reason: sent.error.message });
        } else {
          skipped.push(...sent.payload.skipped);
        }
      }
    }

    const ceremony = graduationCeremony(members, now);
    // Reported only when it was actually raised this run. Reporting the upcoming ceremony every
    // time would print it in the cron summary every week for three months, which reads as the
    // reminder having fired again.
    let ceremonyRaised: typeof ceremony;
    if (ceremony && !alreadySaid(`ceremony|${ceremony.year}`)) {
      if (!recipients.length) {
        skipped.push({ member_id: "admins", reason: "no admin has a linked Slack account" });
      } else {
        const sent = await this.sendMemberNudge(
          {
            channel: "slack",
            recipient_member_ids: recipients,
            message: buildGraduationCeremonyMessage(ceremony),
            kind: "nudge",
            title: `${ceremony.year} graduation ceremony`,
            tab: "adminbotCalendar",
          },
          actor,
        );
        for (const recipient of recipients) {
          remember(`ceremony|${ceremony.year}`, recipient);
        }
        ceremonyRaised = ceremony;
        if (!sent.ok) {
          skipped.push({ member_id: "admins", reason: sent.error.message });
        } else {
          skipped.push(...sent.payload.skipped);
        }
      }
    }

    this.recordAudit({
      type: "graduation.swept",
      actor,
      details: {
        confirm_lead_months: adminBotGraduationConfirmLeadMonths,
        confirmed: confirmed.length,
        transitions: transitions.length,
        ceremony: ceremonyRaised?.year,
        skipped: skipped.length,
      },
    });
    return {
      ok: true,
      status: 200,
      payload: {
        confirmed,
        transitions,
        ...(ceremonyRaised
          ? { ceremony: { year: ceremonyRaised.year, graduates: ceremonyRaised.graduates.length } }
          : {}),
        skipped,
      },
    };
  }

  /**
   * Who hears about the lab's administrative chores: departures, theses waiting to be graded.
   *
   * The lab manager when one is configured, and every other Slack-linked admin otherwise. Not the
   * head professor either way: a finishing month that has passed is administration, and the
   * professor is the person an ignored nudge escalates *towards* rather than the person who files
   * the paperwork. Routing it to them made AdminBot mail the professor about every departure in
   * the lab, which is the nagging `escalateStaleNudges` is careful to avoid.
   *
   * Not both branches at once: a lab whose manager is also its only other admin would otherwise
   * get each message twice.
   */
  private adminNoticeRecipients(): string[] {
    const settings = this.resolveSettings();
    const headProfessorId = settings.head_professor_member_id?.trim();
    const labManagerId = settings.lab_manager_member_id?.trim();
    if (labManagerId && this.store.getLabMember(labManagerId)?.slack_user_id) {
      return [labManagerId];
    }
    return this.store
      .listLabMembers()
      .filter(
        (member) =>
          member.privilege_level === "admin" &&
          member.slack_user_id &&
          member.status !== "alumni" &&
          member.id !== headProfessorId,
      )
      .map((member) => member.id);
  }

  /**
   * The two things a thesis date on somebody's own timeline is worth saying.
   *
   * Before it: the member is pointed at the guidebook section on submitting, two weeks out, while
   * reading it can still change what they do. After it: the head professor is asked to grade what
   * was due, five days on.
   *
   * The date is the member's own milestone rather than a field the lab keeps about them, which is
   * the right source and also the fragile one -- so moving a thesis re-arms both messages, because
   * the ledger subject carries the date. Re-saving the same timeline does not.
   *
   * The grading reminder is one message however many theses are due, addressed to the professor
   * about them. Unlike the escalation DM the member is not in it: this is a task of hers, and a
   * student who has just submitted does not need to watch their supervisor being reminded to mark
   * it.
   */
  async sweepThesisMilestones(
    actor: string,
    options: { nowIso?: string } = {},
  ): Promise<
    AdminBotServiceResponse<{
      guidance: Array<{ member_id: string; date: string; days_until: number }>;
      grading: Array<{ member_id: string; date: string; days_since: number }>;
      skipped: AdminBotMemberNudgeSkip[];
    }>
  > {
    const now = options.nowIso ? new Date(options.nowIso) : new Date();
    const nowIso = now.toISOString();
    const ledger = this.nudgeLedgerIndex();
    const actions = thesisMilestoneActions(thesisMilestones(this.store.listLabMembers()), now);
    const guidance: Array<{ member_id: string; date: string; days_until: number }> = [];
    const gradingDue: Array<{
      member_id: string;
      member_name: string;
      label: string;
      date: string;
      days_since: number;
    }> = [];
    const skipped: AdminBotMemberNudgeSkip[] = [];

    const alreadySaid = (subject: string) =>
      this.hasNudgeBeenSaid(ledger, "thesis_milestone", subject);
    const remember = (subject: string, memberId: string) =>
      this.markNudgeSaid("thesis_milestone", subject, memberId, nowIso);

    for (const action of actions) {
      const subject = thesisLedgerSubject(action);
      if (alreadySaid(subject)) {
        continue;
      }
      if (action.kind === "guidance") {
        const sent = await this.sendMemberNudge(
          {
            channel: "slack",
            recipient_member_ids: [action.member_id],
            message: buildThesisGuidanceMessage(action),
            kind: "nudge",
            title: "Your thesis deadline is coming up",
            tab: "adminbotTimeAvailability",
          },
          actor,
        );
        // Stamped either way: a member with no Slack still got the notification, and a failure that
        // re-fired nightly would be a fortnight of identical messages.
        remember(subject, action.member_id);
        if (!sent.ok) {
          skipped.push({ member_id: action.member_id, reason: sent.error.message });
          continue;
        }
        skipped.push(...sent.payload.skipped);
        guidance.push({
          member_id: action.member_id,
          date: action.date,
          days_until: action.days_until,
        });
        continue;
      }
      gradingDue.push({
        member_id: action.member_id,
        member_name: action.member_name,
        label: action.label,
        date: action.date,
        days_since: action.days_since,
      });
    }

    if (gradingDue.length) {
      // The lab manager, not the professor who will actually do the grading. The reminder still
      // exists to get a thesis graded, but AdminBot chasing the PI directly is the thing this
      // system does not do -- the desk that tracks the chore is the one that can act on a list of
      // them, and it is a person the escalation path is allowed to reach.
      const recipients = this.adminNoticeRecipients();
      if (!recipients.length) {
        skipped.push({
          member_id: "lab_manager",
          reason: "no admin with a linked Slack account to remind",
        });
      } else {
        const sent = await this.sendMemberNudge(
          {
            channel: "slack",
            recipient_member_ids: recipients,
            message: buildThesisGradingMessage(gradingDue),
            kind: "nudge",
            title: gradingDue.length === 1 ? "A thesis is ready to grade" : "Theses ready to grade",
            tab: "adminbotMembers",
          },
          actor,
        );
        // One ledger row per thesis, stamped against the desk that was asked. The key is the
        // subject, so stamping it once per recipient would be the same row rewritten.
        for (const action of gradingDue) {
          remember(`thesis|grading|${action.member_id}|${action.date}`, recipients[0] ?? "");
        }
        if (!sent.ok) {
          skipped.push({ member_id: recipients[0] ?? "lab_manager", reason: sent.error.message });
        } else {
          skipped.push(...sent.payload.skipped);
        }
      }
    }

    this.recordAudit({
      type: "thesis_milestones.swept",
      actor,
      details: {
        lead_days: adminBotThesisGuidanceLeadDays,
        grading_delay_days: adminBotThesisGradingDelayDays,
        guidance: guidance.length,
        grading: gradingDue.length,
        skipped: skipped.length,
      },
    });
    return {
      ok: true,
      status: 200,
      payload: {
        guidance,
        grading: gradingDue.map((action) => ({
          member_id: action.member_id,
          date: action.date,
          days_since: action.days_since,
        })),
        skipped,
      },
    };
  }

  /**
   * Puts people in their city's Slack channel, once per channel.
   *
   * A city gets a channel at four members, which is the point where "the Zurich people" is a group
   * rather than two colleagues who already talk. Below it, creating a room is how a workspace ends
   * up with a directory of dead ones.
   *
   * Added, not asked -- the lab's call -- but added *once per channel*. `city_channels_invited` is
   * the whole opt-out: a member who is put in a channel and leaves stays left, because without a
   * stamp the next sweep would put them back every few days, which is an argument with a person
   * that a cron job always wins. Reading channel membership instead would be the same bug in
   * better clothes: "not in the channel" is exactly what having left looks like.
   *
   * Per channel rather than one global flag, because the flag also suppressed the invite somebody
   * needs most: a member who moves from Toronto to Zürich was already stamped, so #group-zurich was
   * never offered. This sweep is additive only -- moving away from a city never removes anybody,
   * since leaving a room is the member's own call.
   *
   * The stamp goes on whether or not Slack accepted the invite, for the same reason: a workspace
   * that refuses (no such channel, the bot is not in it) must not turn into a nightly retry against
   * every member of that city.
   *
   * The member is told afterwards, with the city's guidebook section and how to leave.
   */
  /**
   * Reconcile one standing invite against the roster, and propose the removals.
   *
   * Proposes only. Every other membership sweep in here executes what it decides, and this one
   * deliberately does not: taking somebody off the lab calendar or the Monday meeting is read by
   * that person as a statement about whether they still belong, and the roster it is computed from
   * is a spreadsheet people forget to update. So the cron runs the arithmetic nightly and an admin
   * reads the names before anyone is uninvited.
   *
   * Attendees are passed in rather than read here because the calendar reader lives on the route
   * context, not the service. That also makes the whole decision testable without a Google account.
   */
  planInviteMembership(params: {
    surface: AdminBotInviteSurface;
    eventId: string;
    calendarId?: string;
    attendees: readonly string[];
    actor: string;
  }): AdminBotServiceResponse<{
    surface: AdminBotInviteSurface;
    remove: AdminBotSurfaceRemoval[];
    keep: string[];
    unrecognized: string[];
    proposal_id?: string;
  }> {
    const eventId = params.eventId.trim();
    if (!eventId) {
      return serviceError(400, "event_id is required");
    }
    // An empty attendee list is what a failed calendar read looks like, and the resulting proposal
    // would write an empty attendee set over a real meeting. Refuse rather than compute.
    if (params.attendees.length === 0) {
      return serviceError(
        422,
        "the event has no attendees to reconcile — refusing to plan a write",
      );
    }

    const plan = surfaceMembershipPlan({
      members: this.store.listLabMembers(),
      attendees: params.attendees,
      surface: params.surface,
    });

    if (plan.remove.length === 0) {
      return {
        ok: true,
        status: 200,
        payload: { surface: params.surface, ...plan },
      };
    }

    const label =
      params.surface === "group_meeting" ? "the Monday group meeting" : "the lab calendar";
    const proposed = this.createProposal({
      type: "calendar.remove_attendees",
      summary: `Remove ${plan.remove.length} ${
        plan.remove.length === 1 ? "person" : "people"
      } from ${label}: ${plan.remove.map((entry) => `${entry.member_name} (${entry.reason})`).join(", ")}`,
      target: { service: "calendar", channel: "calendar", target: eventId },
      proposed_payload: {
        ...(params.calendarId ? { calendar_id: params.calendarId } : {}),
        event_id: eventId,
        // Both lists travel: the approver reads who is being dropped, and the connector writes the
        // set that remains, because the underlying update replaces rather than subtracts.
        removed_attendees: plan.remove.map((entry) => entry.email),
        remaining_attendees: plan.keep,
      },
      undo_plan: "Re-invite the removed attendees with calendar.add_attendees.",
    });
    if (!proposed.ok) {
      return proposed;
    }

    this.recordAudit({
      type: "invite_membership.planned",
      actor: params.actor,
      details: {
        surface: params.surface,
        event_id: eventId,
        remove: plan.remove.length,
        keep: plan.keep.length,
        unrecognized: plan.unrecognized.length,
      },
    });

    return {
      ok: true,
      status: 200,
      payload: { surface: params.surface, ...plan, proposal_id: proposed.payload.id },
    };
  }

  /**
   * Who belongs in the recommendation-letter help channel right now, and who no longer does.
   *
   * In: anybody with a letter request the lab has not finished with. Out: anybody whose letters
   * have all been settled for longer than the retention window.
   *
   * The window is measured from the *latest* settled request, not the first, and that is the whole
   * subtlety. An application season runs about two months across different school deadlines, so a
   * member routinely has one request closed in November and another still open in January. Reading
   * the earliest settled date would take them out of the channel halfway through their own season,
   * which is exactly when they need it. Any unsettled request keeps them in regardless of how old
   * their others are.
   *
   * Computed, never stored: membership is a function of the request log and the clock, so there is
   * no second list to fall out of step with it. That also makes the sweep idempotent -- Slack's own
   * already_in_channel and not_in_channel are treated as success by the connector.
   */
  recLetterChannelRoster(options: { nowIso?: string } = {}): {
    add: Array<{ member_id: string; member_name: string; slack_user_id: string }>;
    remove: Array<{
      member_id: string;
      member_name: string;
      slack_user_id: string;
      settled_at: string;
    }>;
    skipped: AdminBotMemberNudgeSkip[];
  } {
    const now = options.nowIso ? new Date(options.nowIso) : new Date();
    const cutoff =
      now.getTime() - adminBotRecLetterChannelRetentionDays * 24 * 60 * 60 * 1000;
    const settled = new Set<string>(adminBotLogisticsSettledStatuses);

    /** Per member: is anything still open, and when did the most recent one settle. */
    const state = new Map<string, { open: boolean; lastSettled: number }>();
    for (const request of this.store.listLogisticsRequests()) {
      if (request.kind !== "recommendation_letters") {
        continue;
      }
      const entry = state.get(request.member_id) ?? { open: false, lastSettled: 0 };
      if (settled.has(request.status)) {
        // `updated_at` is when it reached that status, which is the moment the lab finished with
        // it. `submitted_at` would start the clock when the member asked, which is backwards.
        const at = Date.parse(request.updated_at);
        if (Number.isFinite(at) && at > entry.lastSettled) {
          entry.lastSettled = at;
        }
      } else {
        entry.open = true;
      }
      state.set(request.member_id, entry);
    }

    const add: Array<{ member_id: string; member_name: string; slack_user_id: string }> = [];
    const remove: Array<{
      member_id: string;
      member_name: string;
      slack_user_id: string;
      settled_at: string;
    }> = [];
    const skipped: AdminBotMemberNudgeSkip[] = [];
    for (const [memberId, entry] of state) {
      const member = this.store.getLabMember(memberId);
      if (!member) {
        skipped.push({ member_id: memberId, reason: "member not found" });
        continue;
      }
      if (!member.slack_user_id?.trim()) {
        // Nothing to do either way: they cannot be put in a channel or taken out of one.
        skipped.push({ member_id: memberId, reason: "member has no slack_user_id" });
        continue;
      }
      const row = {
        member_id: memberId,
        member_name: member.name,
        slack_user_id: member.slack_user_id.trim(),
      };
      if (entry.open) {
        add.push(row);
      } else if (entry.lastSettled > 0 && entry.lastSettled <= cutoff) {
        remove.push({ ...row, settled_at: new Date(entry.lastSettled).toISOString() });
      }
    }
    const byName = <T extends { member_name: string }>(left: T, right: T) =>
      left.member_name.localeCompare(right.member_name);
    return { add: add.toSorted(byName), remove: remove.toSorted(byName), skipped };
  }

  /**
   * Put the letter-request channel's membership where recLetterChannelRoster says it should be.
   *
   * Invites auto-execute; removals are proposed and wait for an admin. That asymmetry is
   * deliberate and matches the policy table: an unwanted invite is noise somebody can leave, while
   * a removal takes a conversation away from someone who was in it, decided by a three-month-old
   * timestamp they cannot see. A wrong invite is visible immediately; a wrong removal is noticed
   * when a room quietly stops being there.
   */
  async syncRecLetterChannel(
    actor: string,
    options: { nowIso?: string } = {},
  ): Promise<
    AdminBotServiceResponse<{
      channel: string;
      invited: Array<{ member_id: string; proposal_id: string }>;
      removal_proposals: Array<{ member_id: string; proposal_id: string; settled_at: string }>;
      skipped: AdminBotMemberNudgeSkip[];
    }>
  > {
    const roster = this.recLetterChannelRoster(options);
    const channel = ADMINBOT_REC_LETTER_CHANNEL;
    const invited: Array<{ member_id: string; proposal_id: string }> = [];
    const removalProposals: Array<{
      member_id: string;
      proposal_id: string;
      settled_at: string;
    }> = [];
    const skipped: AdminBotMemberNudgeSkip[] = [...roster.skipped];

    for (const person of roster.add) {
      const proposed = this.createProposal({
        type: "slack.invite_to_channel",
        summary: `Add ${person.member_name} to #${channel} (letter request open)`,
        target: {
          service: "slack",
          channel: "slack",
          target: channel,
          recipientMemberId: person.member_id,
        },
        proposed_payload: { channel, user_id: person.slack_user_id },
        undo_plan: "Leave the channel, or have an admin remove the member from it.",
      });
      if (!proposed.ok) {
        skipped.push({ member_id: person.member_id, reason: proposed.error.message });
        continue;
      }
      const executed = await this.execute(proposed.payload.id, { dry_run: false });
      if (!executed.ok) {
        skipped.push({ member_id: person.member_id, reason: executed.error.message });
        continue;
      }
      invited.push({ member_id: person.member_id, proposal_id: proposed.payload.id });
    }

    for (const person of roster.remove) {
      // Proposed only. Nothing here executes it -- see the header and the policy table.
      const proposed = this.createProposal({
        type: "slack.remove_from_channel",
        summary: `Remove ${person.member_name} from #${channel} (letters settled ${person.settled_at.slice(0, 10)})`,
        target: {
          service: "slack",
          channel: "slack",
          target: channel,
          recipientMemberId: person.member_id,
        },
        proposed_payload: { channel, user_id: person.slack_user_id },
        undo_plan: "Invite the member back to the channel.",
      });
      if (!proposed.ok) {
        skipped.push({ member_id: person.member_id, reason: proposed.error.message });
        continue;
      }
      removalProposals.push({
        member_id: person.member_id,
        proposal_id: proposed.payload.id,
        settled_at: person.settled_at,
      });
    }

    this.recordAudit({
      type: "rec_letter_channel.swept",
      actor,
      details: {
        channel,
        retention_days: adminBotRecLetterChannelRetentionDays,
        invited: invited.length,
        removals_proposed: removalProposals.length,
        skipped: skipped.length,
      },
    });
    return {
      ok: true,
      status: 200,
      payload: { channel, invited, removal_proposals: removalProposals, skipped },
    };
  }

  /**
   * Which project channel each collaborator is owed, from the papers they are on.
   *
   * The channel name comes from the project's alias -- the short name a person chose when the
   * project was created -- so `proj-cais` is knowable from the record without asking Slack what
   * exists. A paper with no alias is skipped rather than guessed at: a channel named from a slugged
   * title would be long, ugly, and wrong the moment the title changed.
   *
   * Who is owed one is the access matrix's `project_channel` row: the external subgroups the lab
   * chats to about a specific project. Full members are not enumerated here -- the row is from the
   * external-collaborator design sheet, and they are in project channels by other means.
   */
  projectChannelRoster(): Array<{
    channel: string;
    paper_id: string;
    paper_title: string;
    members: Array<{ member_id: string; member_name: string; slack_user_id: string }>;
    skipped: AdminBotMemberNudgeSkip[];
  }> {
    const owed = new Set(
      adminBotExternalCollaboratorSubgroups.filter((subgroup) =>
        collaboratorSubgroupAccess(subgroup).some(
          (grant) => grant.item === PROJECT_CHANNEL_ACCESS_ITEM,
        ),
      ),
    );
    const rows: Array<{
      channel: string;
      paper_id: string;
      paper_title: string;
      members: Array<{ member_id: string; member_name: string; slack_user_id: string }>;
      skipped: AdminBotMemberNudgeSkip[];
    }> = [];
    for (const paper of this.store.listPapers()) {
      const alias = adminBotNormalizePaperAlias(paper.alias);
      if (!alias) {
        continue;
      }
      const members: Array<{
        member_id: string;
        member_name: string;
        slack_user_id: string;
      }> = [];
      const skipped: AdminBotMemberNudgeSkip[] = [];
      const seen = new Set<string>();
      for (const link of paper.author_links ?? []) {
        const memberId = link.member_id?.trim();
        if (!memberId || seen.has(memberId)) {
          continue;
        }
        seen.add(memberId);
        const member = this.store.getLabMember(memberId);
        if (!member) {
          continue;
        }
        const subgroup = member.collaborator_subgroup;
        if (!subgroup || !owed.has(subgroup)) {
          continue;
        }
        // Alumni are not chased into a project's room, for the same reason they are not chased
        // anywhere else: having left outranks having coauthored.
        if (adminBotIsAlumniMember(member)) {
          continue;
        }
        if (!member.slack_user_id?.trim()) {
          skipped.push({ member_id: memberId, reason: "member has no slack_user_id" });
          continue;
        }
        members.push({
          member_id: memberId,
          member_name: member.name,
          slack_user_id: member.slack_user_id.trim(),
        });
      }
      if (members.length === 0 && skipped.length === 0) {
        // Nothing to open a channel for. A project whose only collaborators are full members does
        // not need one created on their behalf.
        continue;
      }
      rows.push({
        channel: adminBotProjectChannelName(alias),
        paper_id: paper.id,
        paper_title: paper.title,
        members: members.toSorted((left, right) =>
          left.member_name.localeCompare(right.member_name),
        ),
        skipped,
      });
    }
    return rows.toSorted((left, right) => left.channel.localeCompare(right.channel));
  }

  /**
   * Open each project's channel and put its collaborators in it.
   *
   * The create runs first and every time, because Slack's own `name_taken` is what tells us the
   * channel already exists -- there is no channel directory to consult, and asking Slack to ensure
   * a name exists is cheaper and more honest than keeping a second list of what we think does.
   */
  async syncProjectChannels(
    actor: string,
  ): Promise<
    AdminBotServiceResponse<{
      channels: Array<{ channel: string; paper_id: string; invited: string[] }>;
      skipped: AdminBotMemberNudgeSkip[];
    }>
  > {
    const roster = this.projectChannelRoster();
    const channels: Array<{ channel: string; paper_id: string; invited: string[] }> = [];
    const skipped: AdminBotMemberNudgeSkip[] = [];

    for (const row of roster) {
      skipped.push(...row.skipped);
      const created = this.createProposal({
        type: "slack.create_channel",
        summary: `Open #${row.channel} for ${row.paper_title}`,
        target: { service: "slack", channel: "slack", target: row.channel },
        proposed_payload: { name: row.channel },
        undo_plan: "Archive the channel in Slack.",
      });
      if (!created.ok) {
        skipped.push({ member_id: row.paper_id, reason: created.error.message });
        continue;
      }
      const opened = await this.execute(created.payload.id, { dry_run: false });
      if (!opened.ok) {
        // Without the room there is nowhere to invite anyone, so this paper is left for the next
        // run rather than half-done.
        skipped.push({ member_id: row.paper_id, reason: opened.error.message });
        continue;
      }
      const invited: string[] = [];
      for (const member of row.members) {
        const proposed = this.createProposal({
          type: "slack.invite_to_channel",
          summary: `Add ${member.member_name} to #${row.channel} (${row.paper_title})`,
          target: {
            service: "slack",
            channel: "slack",
            target: row.channel,
            recipientMemberId: member.member_id,
          },
          proposed_payload: { channel: row.channel, user_id: member.slack_user_id },
          undo_plan: "Leave the channel, or have an admin remove the member from it.",
        });
        if (!proposed.ok) {
          skipped.push({ member_id: member.member_id, reason: proposed.error.message });
          continue;
        }
        const executed = await this.execute(proposed.payload.id, { dry_run: false });
        if (!executed.ok) {
          skipped.push({ member_id: member.member_id, reason: executed.error.message });
          continue;
        }
        invited.push(member.member_id);
      }
      channels.push({ channel: row.channel, paper_id: row.paper_id, invited });
    }

    this.recordAudit({
      type: "project_channels.swept",
      actor,
      details: {
        channels: channels.length,
        invited: channels.reduce((total, row) => total + row.invited.length, 0),
        skipped: skipped.length,
      },
    });
    return { ok: true, status: 200, payload: { channels, skipped } };
  }

  /**
   * Who belongs in which topic channel, given the channels Slack actually has.
   *
   * The channel list is passed in rather than read here: the service has no Slack client, and the
   * lab decides its topics by opening channels, so the list is a fact to be supplied rather than a
   * decision to be made. Who matches is still computed here, from the member's stated interests and
   * the projects they are on -- see matchTopicChannels for why the rule is a conservative one.
   */
  topicChannelRoster(channels: readonly string[]): Array<{
    member_id: string;
    member_name: string;
    slack_user_id: string;
    channels: string[];
  }> {
    const owedBy = new Map<AdminBotExternalCollaboratorSubgroup, Set<string>>();
    for (const subgroup of adminBotExternalCollaboratorSubgroups) {
      const granted = new Set(
        collaboratorSubgroupAccess(subgroup)
          .map((grant) => grant.item)
          .filter((item) => item === "discussion_channel" || item === "weekly_meeting"),
      );
      owedBy.set(subgroup, granted);
    }
    const papers = this.store.listPapers();
    const rows: Array<{
      member_id: string;
      member_name: string;
      slack_user_id: string;
      channels: string[];
    }> = [];
    for (const member of this.store.listLabMembers()) {
      if (adminBotIsAlumniMember(member)) {
        continue;
      }
      const slack = member.slack_user_id?.trim();
      if (!slack) {
        continue;
      }
      const granted = member.collaborator_subgroup
        ? (owedBy.get(member.collaborator_subgroup) ?? new Set<string>())
        : new Set<string>();
      const prefixes: AdminBotTopicChannelPrefix[] = [];
      if (granted.has("discussion_channel")) {
        prefixes.push("discussion");
      }
      // The weekly-meeting row also carries the Wednesday calendar invite. Only its Slack half is
      // acted on here; the calendar half is a separate connector path and is not wired yet.
      if (granted.has("weekly_meeting")) {
        prefixes.push("meeting");
      }
      if (prefixes.length === 0) {
        continue;
      }
      const matched = prefixes.flatMap((prefix) =>
        matchTopicChannels({ member, papers, channels, prefix }),
      );
      if (matched.length === 0) {
        continue;
      }
      rows.push({
        member_id: member.id,
        member_name: member.name,
        slack_user_id: slack,
        channels: [...new Set(matched)].toSorted((left, right) => left.localeCompare(right)),
      });
    }
    return rows.toSorted((left, right) => left.member_name.localeCompare(right.member_name));
  }

  /**
   * Invite each collaborator into the topic channels they match.
   *
   * Idempotent through Slack rather than through a ledger: already_in_channel is success, so a
   * member who is already there costs one API call and changes nothing. That is what makes it safe
   * to run daily against a matcher whose answer can change when somebody edits their interests.
   */
  async syncTopicChannels(
    actor: string,
    channels: readonly string[],
  ): Promise<
    AdminBotServiceResponse<{
      invited: Array<{ member_id: string; channel: string }>;
      skipped: AdminBotMemberNudgeSkip[];
    }>
  > {
    const known = channels
      .map((channel) => channel.trim().replace(/^#/u, "").toLowerCase())
      .filter((channel) => topicOfChannel(channel));
    const invited: Array<{ member_id: string; channel: string }> = [];
    const skipped: AdminBotMemberNudgeSkip[] = [];

    for (const row of this.topicChannelRoster(known)) {
      for (const channel of row.channels) {
        const proposed = this.createProposal({
          type: "slack.invite_to_channel",
          summary: `Add ${row.member_name} to #${channel} (topic match)`,
          target: {
            service: "slack",
            channel: "slack",
            target: channel,
            recipientMemberId: row.member_id,
          },
          proposed_payload: { channel, user_id: row.slack_user_id },
          undo_plan: "Leave the channel, or have an admin remove the member from it.",
        });
        if (!proposed.ok) {
          skipped.push({ member_id: row.member_id, reason: proposed.error.message });
          continue;
        }
        const executed = await this.execute(proposed.payload.id, { dry_run: false });
        if (!executed.ok) {
          skipped.push({ member_id: row.member_id, reason: executed.error.message });
          continue;
        }
        invited.push({ member_id: row.member_id, channel });
      }
    }

    this.recordAudit({
      type: "topic_channels.swept",
      actor,
      details: {
        channels_offered: known.length,
        invited: invited.length,
        skipped: skipped.length,
      },
    });
    return { ok: true, status: 200, payload: { invited, skipped } };
  }

  /**
   * Put the people in each #meeting-xxx channel on that meeting's Wednesday invite.
   *
   * A channel sweep rather than a topic match: whoever is actually in the room is who attends, which
   * is a fact the lab has already curated by adding them. The topic matcher decides who gets *into*
   * the channel; this follows the channel, so somebody added by hand is picked up too and somebody
   * who left the channel is not re-invited.
   *
   * The address is `calendar_email`, which is the field that exists for exactly this: a Google
   * invite has to reach the account the person keeps their calendar in, which is routinely not the
   * address the lab mails them at. Somebody without one is reported, not guessed at -- an invite to
   * the wrong Google account is silently not seen.
   *
   * Attendees are added, never removed. Leaving a recurring meeting is the attendee's own decision
   * and a sweep that undid it every night would be the lab overruling them once a day.
   */
  async syncThemedMeetingInvites(
    actor: string,
    params: {
      meetings: ReadonlyArray<{ event_id: string; summary: string }>;
      channels: ReadonlyArray<{ channel: string; slack_user_ids: readonly string[] }>;
      calendarId: string;
    },
  ): Promise<
    AdminBotServiceResponse<{
      invited: Array<{ event_id: string; channel: string; attendees: string[] }>;
      skipped: AdminBotMemberNudgeSkip[];
    }>
  > {
    const bySlack = new Map<string, AdminBotLabMember>();
    for (const member of this.store.listLabMembers()) {
      const slack = member.slack_user_id?.trim();
      if (slack) {
        bySlack.set(slack, member);
      }
    }
    const invited: Array<{ event_id: string; channel: string; attendees: string[] }> = [];
    const skipped: AdminBotMemberNudgeSkip[] = [];

    for (const row of params.channels) {
      const meetings = matchThemedMeetings(row.channel, params.meetings);
      if (meetings.length === 0) {
        continue;
      }
      if (meetings.length > 1) {
        // Two events answering to one channel is a calendar the lab should look at, not something
        // to resolve by picking the first.
        skipped.push({
          member_id: row.channel,
          reason: `matches ${meetings.length} themed meetings: ${meetings.map((m) => m.summary).join("; ")}`,
        });
        continue;
      }
      const attendees: string[] = [];
      for (const slackId of new Set(row.slack_user_ids)) {
        const member = bySlack.get(slackId.trim());
        if (!member) {
          // Somebody in the channel who is not on the roster -- a guest, or the bot itself. Not an
          // error, and not somebody the lab has an address for.
          continue;
        }
        if (adminBotIsAlumniMember(member)) {
          continue;
        }
        const email = member.calendar_email?.trim();
        if (!email) {
          skipped.push({ member_id: member.id, reason: "member has no calendar_email" });
          continue;
        }
        attendees.push(email);
      }
      if (attendees.length === 0) {
        continue;
      }
      const meeting = meetings[0] as { event_id: string; summary: string };
      const proposed = this.createProposal({
        type: "calendar.add_attendees",
        summary: `Add ${attendees.length} from #${row.channel} to ${meeting.summary}`,
        target: { service: "calendar", channel: "calendar", target: meeting.event_id },
        proposed_payload: {
          calendar_id: params.calendarId,
          event_id: meeting.event_id,
          attendees: [...new Set(attendees)].toSorted(),
        },
        undo_plan: "Remove the attendees with calendar.remove_attendees.",
      });
      if (!proposed.ok) {
        skipped.push({ member_id: row.channel, reason: proposed.error.message });
        continue;
      }
      invited.push({
        event_id: meeting.event_id,
        channel: row.channel,
        attendees: [...new Set(attendees)].toSorted(),
      });
    }

    this.recordAudit({
      type: "themed_meeting_invites.swept",
      actor,
      details: {
        meetings: params.meetings.length,
        proposed: invited.length,
        skipped: skipped.length,
      },
    });
    return { ok: true, status: 200, payload: { invited, skipped } };
  }

  async syncCityChannels(
    actor: string,
    options: { nowIso?: string } = {},
  ): Promise<
    AdminBotServiceResponse<{
      groups: Array<{ channel: string; place: string; members: number }>;
      invited: Array<{ member_id: string; channel: string }>;
      skipped: AdminBotMemberNudgeSkip[];
    }>
  > {
    const nowIso = options.nowIso ?? new Date().toISOString();
    const plan = cityChannelPlan(this.store.listLabMembers());
    const invited: Array<{ member_id: string; channel: string }> = [];
    const skipped: AdminBotMemberNudgeSkip[] = [...plan.skipped];

    for (const invite of plan.invites) {
      const member = this.store.getLabMember(invite.member_id);
      if (!member) {
        continue;
      }
      const proposed = this.createProposal({
        type: "slack.invite_to_channel",
        summary: `Add ${invite.member_name} to #${invite.channel} (${invite.place_label})`,
        target: {
          service: "slack",
          channel: "slack",
          target: invite.channel,
          recipientMemberId: invite.member_id,
        },
        proposed_payload: {
          channel: invite.channel,
          user_id: invite.slack_user_id,
        },
        undo_plan: "Leave the channel, or have an admin remove the member from it.",
      });
      // Stamped before the send, and left stamped either way. See the header. The channel is
      // recorded alongside the time so a later move to another city is still offered its own
      // channel, while this one is never offered twice.
      const offered = member.city_channels_invited ?? [];
      this.store.saveLabMember({
        ...member,
        city_channel_invited_at: nowIso,
        city_channels_invited: offered.includes(invite.channel)
          ? offered
          : [...offered, invite.channel],
        updated_at: nowIso,
      });
      if (!proposed.ok) {
        skipped.push({ member_id: invite.member_id, reason: proposed.error.message });
        continue;
      }
      const executed = await this.execute(proposed.payload.id, { dry_run: false });
      if (!executed.ok) {
        skipped.push({ member_id: invite.member_id, reason: executed.error.message });
        continue;
      }
      invited.push({ member_id: invite.member_id, channel: invite.channel });
      await this.sendMemberNudge(
        {
          channel: "slack",
          recipient_member_ids: [invite.member_id],
          message: buildCityChannelMessage(invite),
          kind: "nudge",
          title: `Added to #${invite.channel}`,
          tab: "adminbotMembers",
        },
        actor,
      );
    }

    this.recordAudit({
      type: "city_channels.synced",
      actor,
      details: {
        minimum_members: adminBotCityChannelMinimumMembers,
        groups: plan.groups.length,
        invited: invited.length,
        skipped: skipped.length,
      },
    });
    return {
      ok: true,
      status: 200,
      payload: {
        groups: plan.groups.map((group) => ({
          channel: group.channel,
          place: group.place.label,
          members: group.members.length,
        })),
        invited,
        skipped,
      },
    };
  }

  /**
   * Every member's most recent onboarding welcome, by member id.
   *
   * Read off `onboarding.guide_sent` rather than a queue table, the same way the alumni Slack
   * invitation reads it: the send already records who was written to and when, and a second store
   * to keep in step with it would only be a way for the two to disagree.
   *
   * Matched on the address the guide actually went to, across every field a member may carry one
   * on -- a welcome is routinely sent to the correspondence address while the roster is keyed by
   * the institutional one. A recipient the roster cannot name is skipped rather than guessed at.
   */
  private latestOnboardingWelcomeByMember(): Map<string, string> {
    const byAddress = new Map<string, string>();
    for (const member of this.store.listLabMembers()) {
      for (const address of [member.email, member.correspondence_email, member.calendar_email]) {
        const key = address?.trim().toLowerCase();
        if (key) {
          byAddress.set(key, member.id);
        }
      }
    }
    const latest = new Map<string, string>();
    for (const event of this.store.listAuditEvents()) {
      if (event.type !== "onboarding.guide_sent") {
        continue;
      }
      const details = event.details as { recipient?: unknown; sent?: unknown } | undefined;
      if (!details || details.sent !== true || typeof details.recipient !== "string") {
        continue;
      }
      const memberId = byAddress.get(details.recipient.trim().toLowerCase());
      if (!memberId) {
        continue;
      }
      // The most recent welcome wins: somebody re-onboarded after a standing change is chased about
      // that cycle, not about the one from their first year.
      const existing = latest.get(memberId);
      if (!existing || event.timestamp > existing) {
        latest.set(memberId, event.timestamp);
      }
    }
    return latest;
  }

  /**
   * When this member last signed in, from whichever record still has it.
   *
   * `last_login_at` is a single field on the roster row and a bulk write can erase it -- it has
   * been erased on this roster -- so an absent one is checked against the login-event table before
   * it is believed. The fallback only runs for members whose field is empty, which is exactly the
   * set about to be chased, so the cost lands where the answer matters.
   */
  private lastLoginOf(member: AdminBotLabMember): string | undefined {
    const stored = member.last_login_at?.trim();
    if (stored) {
      return stored;
    }
    return this.store.listLoginEvents(member.id, 1)[0]?.at;
  }

  /**
   * The disengagement sweep: people who never arrived, and the ladder for people just invited.
   *
   * One pass rather than two crons, because the two rules overlap on exactly the people they are
   * both about. A member welcomed last week has never signed in, so a standing "you have never
   * signed in" reminder and the onboarding ladder would both fire on them, three days apart,
   * saying the same thing in different words. The ladder owns anybody it is still running for and
   * the standing reminder stands aside -- which is a decision the two sweeps can only make
   * together, and is why `dormantChaseDue` takes a `laddered` flag rather than working it out.
   *
   * Who is chased at all comes from `adminBotDormantChaseMemberTypes`, which is one line to widen
   * when alumni, own-pace advisees and major coauthors are brought in.
   *
   * Server-computed like the other sweeps -- nothing about who is chased or what is said comes
   * from the caller -- so cron can run it under the service principal.
   */
  async chaseDisengagedMembers(
    actor: string,
    options: { nowIso?: string } = {},
  ): Promise<
    AdminBotServiceResponse<{
      reminded: Array<{ member_id: string; step: OnboardingFollowUpStep; days: number }>;
      escalated: Array<{ member_id: string; notifications: number }>;
      dormant: string[];
      skipped: AdminBotMemberNudgeSkip[];
    }>
  > {
    const now = options.nowIso ? new Date(options.nowIso) : new Date();
    const nowIso = now.toISOString();
    const welcomes = this.latestOnboardingWelcomeByMember();
    const ledger = this.nudgeLedgerIndex();
    const reminded: Array<{ member_id: string; step: OnboardingFollowUpStep; days: number }> = [];
    const escalated: Array<{ member_id: string; notifications: number }> = [];
    const dormant: string[] = [];
    const skipped: AdminBotMemberNudgeSkip[] = [];
    const stamps: Array<{ domain: AdminBotNudgeDomain; subjectId: string; memberId: string }> = [];

    for (const member of this.store.listLabMembers()) {
      if (!isChaseableMember(member)) {
        continue;
      }
      const lastLoginAt = this.lastLoginOf(member);
      const lastEditAt = lastSelfEditAt(member);
      const welcomedAt = welcomes.get(member.id);
      let laddered = false;

      if (welcomedAt) {
        const entry = ledger.get(`onboarding_followup|${member.id}|${member.id}`);
        const decision = planOnboardingFollowUp({
          welcomedAt,
          ...(lastLoginAt ? { lastLoginAt } : {}),
          ...(lastEditAt ? { lastSelfEditAt: lastEditAt } : {}),
          sentCount: entry?.nudge_count ?? 0,
          ...(entry?.last_nudged_at ? { lastNudgedAt: entry.last_nudged_at } : {}),
          now,
        });
        // "Still running" is due-now or not-yet, but not finished and not engaged: those two mean
        // the ladder has let go, and the standing reminder may take the member back.
        laddered = decision.due || decision.reason === "too_soon";
        if (decision.due && decision.step === "escalate") {
          // Narrowed inside `decision.due` rather than across it: the reminder branch below needs
          // the step to exclude "escalate", and a compound condition does not carry that.
          const raised = this.escalateOnboardingFollowUp(member.id, nowIso);
          escalated.push({ member_id: member.id, notifications: raised });
          stamps.push({
            domain: "onboarding_followup",
            subjectId: member.id,
            memberId: member.id,
          });
        } else if (decision.due && decision.step !== "escalate") {
          const days = daysBetween(welcomedAt, now);
          const sent = await this.sendMemberNudge(
            {
              channel: "slack",
              recipient_member_ids: [member.id],
              message: buildOnboardingFollowUpMessage({ step: decision.step, days }),
              kind: "nudge",
              title:
                decision.step === "first_reminder"
                  ? "Your AdminBot account is waiting for you"
                  : "Second reminder: your AdminBot account",
              tab: "myOnboarding",
              // Important, so the escalation pass can see these on the professor's desk. That is
              // the whole shape of this ladder: two asks, then a person.
              important: true,
            },
            actor,
          );
          if (!sent.ok) {
            skipped.push({ member_id: member.id, reason: sent.error.message });
            continue;
          }
          skipped.push(...sent.payload.skipped);
          // Stamped whether or not Slack took it, for the reason chaseOpenOnboarding gives: the
          // notification was filed either way, and a member with no linked Slack must not be
          // re-chased every night because the DM never landed.
          reminded.push({ member_id: member.id, step: decision.step, days });
          stamps.push({
            domain: "onboarding_followup",
            subjectId: member.id,
            memberId: member.id,
          });
          continue;
        }
      }

      const dormantEntry = ledger.get(`dormant_account|${member.id}|${member.id}`);
      if (
        dormantChaseDue({
          ...(lastLoginAt ? { lastLoginAt } : {}),
          ...(dormantEntry?.last_nudged_at ? { lastNudgedAt: dormantEntry.last_nudged_at } : {}),
          now,
          laddered,
        })
      ) {
        const sent = await this.sendMemberNudge(
          {
            channel: "slack",
            recipient_member_ids: [member.id],
            message: buildDormantAccountMessage(),
            kind: "nudge",
            title: "You have never signed in to AdminBot",
            tab: "myOnboarding",
          },
          actor,
        );
        if (!sent.ok) {
          skipped.push({ member_id: member.id, reason: sent.error.message });
          continue;
        }
        skipped.push(...sent.payload.skipped);
        dormant.push(member.id);
        stamps.push({ domain: "dormant_account", subjectId: member.id, memberId: member.id });
      }
    }

    this.stampNudgeLedger(stamps, nowIso);
    this.recordAudit({
      type: "members.disengagement_swept",
      actor,
      details: {
        reminded: reminded.length,
        escalated: escalated.length,
        dormant: dormant.length,
        skipped: skipped.length,
        member_types: [...adminBotDormantChaseMemberTypes],
      },
    });
    return { ok: true, status: 200, payload: { reminded, escalated, dormant, skipped } };
  }

  /**
   * Put this member's onboarding reminders on the professor's desk.
   *
   * Stamps `escalated_at` on the notifications the ladder already filed, which is the same channel
   * `escalateStaleNudges` uses and the one `listEscalatedNudges` reads -- so these arrive on the
   * page the professor already works through, grouped by member, with the reminder's own title as
   * the line item. A second queue would have been a second place to forget to look.
   *
   * Only unread, un-escalated ones: a member who has already answered is not raised, and nothing
   * is raised twice.
   */
  private escalateOnboardingFollowUp(memberId: string, nowIso: string): number {
    const due = this.store
      .listMemberNotifications(memberId)
      .filter(
        (notification) =>
          notification.important && !notification.read_at && !notification.escalated_at,
      );
    for (const notification of due) {
      this.store.saveMemberNotification({ ...notification, escalated_at: nowIso });
    }
    return due.length;
  }

  /**
   * Chases the members whose checklist is still open, on its own clock.
   *
   * The cycle is what makes this measurable. A checklist opens at registration or when somebody's
   * standing changes, and this asks about it ten days later and every two months after that --
   * from when *that* cycle opened, so a member promoted in their third year is chased about the
   * promotion rather than about an account created in their first.
   *
   * Deliberately not marked important, so it does not reach the head professor. Onboarding reading
   * is worth asking about repeatedly and is not worth a three-way DM: the escalating nudges are the
   * three the lab chose, and quietly adding a fourth would be the fastest way to make all of them
   * ignorable.
   *
   * Server-computed, like the other sweeps: nothing about who is chased or what is said comes from
   * the caller.
   */
  async chaseOpenOnboarding(
    actor: string,
    options: { nowIso?: string } = {},
  ): Promise<
    AdminBotServiceResponse<{
      nudged: Array<{ member_id: string; open_steps: number; days_open: number }>;
      skipped: AdminBotMemberNudgeSkip[];
    }>
  > {
    const now = options.nowIso ? new Date(options.nowIso) : new Date();
    const nowIso = now.toISOString();
    const nudged: Array<{ member_id: string; open_steps: number; days_open: number }> = [];
    const skipped: AdminBotMemberNudgeSkip[] = [];

    for (const member of this.store.listLabMembers()) {
      // The checklist is for people currently working in the lab. Chasing somebody who has left is
      // worse than not chasing at all.
      if (member.status === "alumni" || member.status === "external") {
        continue;
      }
      const onboarding = member.onboarding;
      const open = (onboarding?.steps ?? []).filter(
        (step) => step.required && step.status !== "complete",
      );
      if (!open.length) {
        continue;
      }
      // A cycle with no stamp predates this feature. Treated as opened now rather than at the epoch,
      // so the change does not chase the whole lab on the day it ships.
      const openedAt = onboarding?.opened_at ?? member.created_at ?? nowIso;
      const daysOpen = daysBetween(openedAt, now);
      if (daysOpen < adminBotOnboardingFirstChaseDays) {
        continue;
      }
      const lastNudged = onboarding?.last_nudged_at;
      if (lastNudged && daysBetween(lastNudged, now) < adminBotOnboardingRepeatChaseDays) {
        continue;
      }
      const sent = await this.sendMemberNudge(
        {
          channel: "slack",
          recipient_member_ids: [member.id],
          message: buildOnboardingChaseMessage({
            openLabels: open.map((step) => step.label),
            days: daysOpen,
            reason: onboarding?.reason ?? "registration",
          }),
          kind: "nudge",
          title: "Your setup checklist is still open",
          tab: "myOnboarding",
        },
        actor,
      );
      if (!sent.ok) {
        skipped.push({ member_id: member.id, reason: sent.error.message });
        continue;
      }
      skipped.push(...sent.payload.skipped);
      // Stamped whether or not Slack took it: the notification was filed either way, and a member
      // whose Slack is unlinked must not be re-chased every night because the DM never landed.
      this.store.saveLabMember({
        ...member,
        onboarding: { ...(onboarding as AdminBotMemberOnboarding), last_nudged_at: nowIso },
        updated_at: nowIso,
      });
      nudged.push({ member_id: member.id, open_steps: open.length, days_open: daysOpen });
    }

    this.recordAudit({
      type: "onboarding.chased",
      actor,
      details: {
        first_chase_days: adminBotOnboardingFirstChaseDays,
        repeat_days: adminBotOnboardingRepeatChaseDays,
        nudged: nudged.length,
        skipped: skipped.length,
      },
    });
    return { ok: true, status: 200, payload: { nudged, skipped } };
  }

  /**
   * Asks the head professor to chase what AdminBot could not.
   *
   * The escalation is a three-way Slack DM -- AdminBot, the head professor and the member -- rather
   * than a message about the member sent to the professor. The member is in the room because the
   * point is to get the thing done, not to report them: a private complaint is how somebody finds
   * out weeks later that they were being discussed, and the group DM is the version of this that
   * nobody has to be told about afterwards.
   *
   * Only important, unread nudges older than the window escalate, and each escalates once. The
   * stamp goes on whether or not Slack accepted the message: a second escalation is far worse than
   * a missed one -- the first is the lab appearing to nag through its professor.
   *
   * Server-computed, like the mandatory-fields sweep: the caller chooses nothing about who is
   * chased or what is said, so cron can run it under the service principal.
   */
  async escalateStaleNudges(
    actor: string,
    options: { nowIso?: string } = {},
  ): Promise<
    AdminBotServiceResponse<{
      escalated: Array<{ member_id: string; notification_id: string; title: string }>;
      skipped: AdminBotMemberNudgeSkip[];
    }>
  > {
    const settings = this.resolveSettings();
    const headProfessorId = settings.head_professor_member_id?.trim();
    if (!headProfessorId) {
      return serviceError(409, "no head professor is configured to escalate to");
    }
    const headProfessor = this.store.getLabMember(headProfessorId);
    // A roster row, but no longer a Slack account. This used to refuse the whole pass unless the
    // professor had a linked Slack, because the escalation opened a DM with them in it. It no
    // longer does -- their copy is the queue on their own page -- so requiring a Slack account
    // would now stop every member's escalation over a channel nothing sends to.
    if (!headProfessor) {
      return serviceError(409, "the configured head professor is not on the roster");
    }
    const now = options.nowIso ? new Date(options.nowIso) : new Date();
    const nowIso = now.toISOString();
    const cutoff = now.getTime() - adminBotNudgeEscalateAfterDays * 24 * 60 * 60 * 1000;
    const escalated: Array<{ member_id: string; notification_id: string; title: string }> = [];
    const skipped: AdminBotMemberNudgeSkip[] = [];

    for (const member of this.store.listLabMembers()) {
      // The head professor does not chase themselves, and alumni are no longer the lab's to chase.
      if (member.id === headProfessorId || member.status === "alumni") {
        continue;
      }
      const due = this.store
        .listMemberNotifications(member.id)
        .filter(
          (notification) =>
            notification.important &&
            !notification.read_at &&
            !notification.escalated_at &&
            Date.parse(notification.created_at) <= cutoff,
        )
        .toSorted((left, right) => left.created_at.localeCompare(right.created_at));
      if (!due.length) {
        continue;
      }
      // One DM per member, however many things are overdue. Three separate group DMs about three
      // reminders is the professor being nagged, which is the thing this must not become.
      const stampFirst = () => {
        for (const notification of due) {
          this.store.saveMemberNotification({ ...notification, escalated_at: nowIso });
        }
      };
      if (!member.slack_user_id) {
        stampFirst();
        skipped.push({ member_id: member.id, reason: "member has no slack_user_id" });
        continue;
      }
      const message = buildNudgeEscalationMessage({
        memberName: member.name,
        professorName: headProfessor.name,
        outstanding: due.map((notification) => notification.title),
        days: adminBotNudgeEscalateAfterDays,
      });
      // The member, and only the member. This used to open a three-way DM with the head professor
      // in it, on the reasoning that a private complaint is how somebody finds out weeks later they
      // were being discussed. That reasoning still holds -- and is still satisfied, because the
      // member is told here in as many words that it has gone to the professor.
      //
      // What changed is the professor's copy. AdminBot sends the PI nothing: their queue is the
      // escalation list on their own page (see listEscalatedNudges), which `stampFirst` above has
      // already written to. A DM as well would be the same item said twice to the one person who
      // cannot act on it by replying.
      const proposed = this.createProposal({
        type: "member_nudge.escalate",
        summary: `Tell ${member.name} their overdue nudges are now with ${headProfessor.name}: ${truncateForSummary(message)}`,
        target: {
          service: "slack",
          channel: "slack",
          target: member.slack_user_id,
          recipientMemberId: member.id,
        },
        proposed_payload: {
          channel: "slack",
          user_ids: [member.slack_user_id],
          message,
        },
        undo_plan: "Send a follow-up in the same DM saying it is handled.",
      });
      // Stamped before the send, and left stamped either way. See the header.
      stampFirst();
      if (!proposed.ok) {
        skipped.push({ member_id: member.id, reason: proposed.error.message });
        continue;
      }
      const executed = await this.execute(proposed.payload.id, { dry_run: false });
      if (!executed.ok) {
        skipped.push({ member_id: member.id, reason: executed.error.message });
        continue;
      }
      for (const notification of due) {
        escalated.push({
          member_id: member.id,
          notification_id: notification.id,
          title: notification.title,
        });
      }
    }

    this.recordAudit({
      type: "member_nudge.escalated",
      actor,
      details: {
        after_days: adminBotNudgeEscalateAfterDays,
        head_professor_member_id: headProfessorId,
        escalated: escalated.length,
        skipped: skipped.length,
      },
    });
    return { ok: true, status: 200, payload: { escalated, skipped } };
  }

  private async assessMemberProfilePhoto(
    member: AdminBotLabMember,
    checkedAt: string,
  ): Promise<AdminBotProfilePhotoAssessment> {
    if (!member.slack_user_id) {
      return {
        compliant: false,
        issues: ["missing_slack_user_id"],
        summary: "No Slack account is linked yet, so the profile photo cannot be reviewed.",
        checked_at: checkedAt,
        source: "heuristic",
      };
    }
    const reviewer = this.options.reviewSlackProfilePhoto;
    if (!reviewer) {
      return {
        compliant: false,
        issues: ["reviewer_unavailable"],
        summary:
          "Automated photo review is not configured yet. Please use a professional, front-facing headshot with a clean background.",
        checked_at: checkedAt,
        source: "heuristic",
      };
    }
    try {
      const result = await reviewer({ slackUserId: member.slack_user_id });
      return {
        compliant: result.compliant,
        issues: result.issues.map((issue) => issue.trim()).filter(Boolean),
        summary: result.summary.trim(),
        checked_at: checkedAt,
        ...(result.photoUrl ? { photo_url: result.photoUrl } : {}),
        source: result.source ?? "ai",
      };
    } catch (error) {
      return {
        compliant: false,
        issues: ["review_failed"],
        summary: `Automated photo review failed: ${error instanceof Error ? error.message : String(error)}`,
        checked_at: checkedAt,
        source: "heuristic",
      };
    }
  }

  async processSlackChannelNamingEvent(
    event: AdminBotSlackChannelNamingEvent,
    actor = "slack-monitor",
  ): Promise<
    AdminBotServiceResponse<{
      status: "compliant" | "pending" | "reminder_sent";
      channel_id: string;
      channel_name: string;
      suggested_name?: string;
    }>
  > {
    const channelId = event.channel_id.trim();
    const channelName = normalizeSlackChannelName(event.channel_name);
    if (!channelId) {
      return serviceError(400, "channel_id is required");
    }
    if (!channelName) {
      return serviceError(400, "channel_name is required");
    }
    const naming = evaluateSlackChannelName({
      channelName,
      purpose: normalizeOptionalString(event.purpose),
      topic: normalizeOptionalString(event.topic),
    });
    if (naming.valid) {
      this.store.deleteSlackChannelNamingRecord(channelId);
      return {
        ok: true,
        status: 200,
        payload: {
          status: "compliant",
          channel_id: channelId,
          channel_name: channelName,
        },
      };
    }
    const now = new Date().toISOString();
    const existing = this.store.getSlackChannelNamingRecord(channelId);
    const ownerUserId = normalizeOptionalString(event.owner_user_id) ?? existing?.owner_user_id;
    let reminderSentAt = existing?.reminder_sent_at;
    let reminderActionId = existing?.reminder_action_id;
    if (!reminderSentAt && ownerUserId) {
      const reminder = await this.sendSlackChannelNamingNotice({
        ownerUserId,
        channelId,
        channelName,
        suggestedName: naming.suggestedName,
      });
      if (reminder.ok) {
        reminderSentAt = now;
        reminderActionId = reminder.payload.id;
      }
    }
    this.store.saveSlackChannelNamingRecord({
      channel_id: channelId,
      latest_channel_name: channelName,
      ...(ownerUserId ? { owner_user_id: ownerUserId } : {}),
      expected_prefix: naming.expectedPrefix,
      suggested_name: naming.suggestedName,
      first_seen_at: existing?.first_seen_at ?? now,
      last_seen_at: now,
      ...(reminderSentAt ? { reminder_sent_at: reminderSentAt } : {}),
      ...(reminderActionId ? { reminder_action_id: reminderActionId } : {}),
    });
    this.recordAudit({
      type: "slack.channel_naming_checked",
      actor,
      details: {
        channel_id: channelId,
        channel_name: channelName,
        suggested_name: naming.suggestedName,
        reminded: Boolean(reminderSentAt),
      },
    });
    return {
      ok: true,
      status: 200,
      payload: {
        status: reminderSentAt ? "reminder_sent" : "pending",
        channel_id: channelId,
        channel_name: channelName,
        suggested_name: naming.suggestedName,
      },
    };
  }

  /**
   * One pass over the channels whose reminder window has run out, filing a rename for each.
   *
   * Proposes; it does not rename. This used to call `execute` on the proposal it had just written,
   * which made it the only sweep in the system that approved its own work -- and renaming somebody
   * else's channel is not a clerical correction, it is a visible statement about their channel that
   * lands with no warning beyond a DM sent two days earlier. It is now an ordinary T3 action: the
   * proposal appears on the Actions tab with the current name, the suggested one, and the owner,
   * and an admin decides.
   *
   * The consequence for the record is that it survives the sweep instead of being deleted on
   * rename. A channel drops out of the ledger when it actually becomes compliant -- the top of the
   * loop, driven by the rename event -- which is true whether the new name came from the owner or
   * from an approved proposal, so no post-approval bookkeeping is needed here. `rename_action_id`
   * is what keeps a re-run from filing a second rename for a channel already waiting.
   */
  async runSlackChannelNamingSweep(
    actor = "slack-monitor",
    nowIso = new Date().toISOString(),
  ): Promise<
    AdminBotServiceResponse<{
      scanned: number;
      reminders_pending: number;
      renames_proposed: number;
      renames_awaiting_approval: number;
      skipped: number;
    }>
  > {
    const records = this.store.listSlackChannelNamingRecords();
    const dueBefore = new Date(
      Date.parse(nowIso) - SLACK_CHANNEL_NAMING_RENAME_AFTER_MS,
    ).toISOString();
    let remindersPending = 0;
    let renamesProposed = 0;
    let awaitingApproval = 0;
    let skipped = 0;
    for (const record of records) {
      const naming = evaluateSlackChannelName({ channelName: record.latest_channel_name });
      if (naming.valid) {
        this.store.deleteSlackChannelNamingRecord(record.channel_id);
        continue;
      }
      if (!record.reminder_sent_at || record.reminder_sent_at > dueBefore) {
        remindersPending += 1;
        continue;
      }
      // Already asked. A proposal an admin has not answered yet is the normal state for a sweep
      // that can be pressed twice in a morning, so it is reported rather than re-filed. A rejected
      // one is not re-filed either: "no" is an answer, and a job that asked again every run would
      // be arguing with the person it is meant to be asking.
      if (record.rename_action_id) {
        const existing = this.store.getProposal(record.rename_action_id);
        if (existing && existing.status !== "executed") {
          awaitingApproval += 1;
          continue;
        }
      }
      const rename = this.createProposal({
        type: "slack.rename_channel",
        summary: `Rename Slack channel #${record.latest_channel_name} to #${record.suggested_name}`,
        target: {
          service: "slack",
          channel_id: record.channel_id,
        },
        proposed_payload: {
          channel_id: record.channel_id,
          new_name: record.suggested_name,
        },
        rationale: record.owner_user_id
          ? `Channel naming policy: still non-compliant more than 48 hours after <@${record.owner_user_id}> was reminded.`
          : "Channel naming policy: still non-compliant more than 48 hours after the reminder.",
        undo_plan:
          "Rename the channel again if a lab admin decides another compliant name is better.",
      });
      if (!rename.ok) {
        skipped += 1;
        continue;
      }
      this.store.saveSlackChannelNamingRecord({
        ...record,
        rename_action_id: rename.payload.id,
      });
      renamesProposed += 1;
    }
    this.recordAudit({
      type: "slack.channel_naming_swept",
      actor,
      details: {
        scanned: records.length,
        renames_proposed: renamesProposed,
        renames_awaiting_approval: awaitingApproval,
        reminders_pending: remindersPending,
      },
    });
    return {
      ok: true,
      status: 200,
      payload: {
        scanned: records.length,
        reminders_pending: remindersPending,
        renames_proposed: renamesProposed,
        renames_awaiting_approval: awaitingApproval,
        skipped,
      },
    };
  }

  /**
   * The one DM this policy sends: the heads-up, when a non-compliant channel is first seen.
   *
   * There used to be a second, sent right after the sweep renamed a channel to tell its owner it
   * had happened. The sweep no longer renames anything -- it files a proposal an admin approves --
   * so that message had no honest moment to be sent: at proposal time it would claim a rename that
   * has not happened, and there is no hook after approval to send it from. Rather than keep an
   * unreachable branch whose text asserts something false, it is gone. The owner's warning is this
   * one, sent two days earlier, which is what the window is for.
   */
  private async sendSlackChannelNamingNotice(params: {
    ownerUserId: string;
    channelId: string;
    channelName: string;
    suggestedName: string;
  }): Promise<AdminBotServiceResponse<AdminBotStoredProposal>> {
    const message = [
      `Hi <@${params.ownerUserId}>,`,
      `the channel #${params.channelName} does not follow the lab naming policy.`,
      `Please rename it to something like #${params.suggestedName} within 48 hours.`,
      "Allowed prefixes: proj-, meeting-, group-, lab-, students-, etc-.",
    ].join(" ");
    const proposal = this.createProposal({
      type: "slack.channel_naming_notify_owner",
      summary: `Remind Slack channel owner about naming policy for #${params.channelName}`,
      target: {
        service: "slack",
        owner_user_id: params.ownerUserId,
        channel_id: params.channelId,
      },
      proposed_payload: {
        owner_user_id: params.ownerUserId,
        message,
      },
      rationale: "Owner notification before policy enforcement.",
      undo_plan: "Send a follow-up clarification if the channel context needs correction.",
    });
    if (!proposal.ok) {
      return proposal;
    }
    const executed = await this.execute(proposal.payload.id, { dry_run: false });
    if (!executed.ok) {
      return executed;
    }
    return {
      ok: true,
      status: 200,
      payload: this.store.getProposal(proposal.payload.id) ?? proposal.payload,
    };
  }

  pruneAuditEventsBefore(cutoffIso: string): number {
    return this.store.pruneAuditEventsBefore(cutoffIso);
  }

  private recordAudit(event: Omit<AdminBotAuditEvent, "id" | "timestamp">): void {
    this.store.recordAudit({
      id: `aud_${randomUUID()}`,
      timestamp: new Date().toISOString(),
      ...event,
    });
    this.pruneRetainedAuditEvents();
  }

  private pruneRetainedAuditEvents(): void {
    const retentionDays = this.options.auditRetentionDays;
    if (typeof retentionDays !== "number" || retentionDays < 0) {
      return;
    }
    this.store.pruneAuditEventsBefore(retentionCutoffIso(retentionDays));
  }

  private resolveSettings(): AdminBotSettings {
    return (
      this.store.getSettings() ?? {
        ...DEFAULT_SETTINGS,
        updated_at: new Date(0).toISOString(),
      }
    );
  }
}

export function payloadHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function deadlinePayload(proposal: AdminBotStoredProposal): DeadlinePublicationPayload | undefined {
  return proposal.type === "deadline.publish" &&
    isDeadlinePublicationPayload(proposal.proposed_payload)
    ? proposal.proposed_payload
    : undefined;
}

function firstDeadlineValidationError(
  errors: Partial<Record<keyof DeadlineProposalInput, string>>,
): string {
  return Object.values(errors)[0] ?? "deadline proposal is invalid";
}

function deadlineBoardEntryId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const id = row.deadline_id ?? row.id;
  return typeof id === "string" ? id : undefined;
}

function deadlineInputFromBoardEntry(value: unknown): DeadlineProposalInput | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const deadline = typeof row.deadline_aoe === "string" ? row.deadline_aoe : "";
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/u.exec(deadline);
  if (!match || typeof row.name !== "string" || typeof row.entry_type !== "string") {
    return undefined;
  }
  return {
    name: row.name,
    parentConference: typeof row.venue_family === "string" ? row.venue_family : "",
    parentYear: "",
    entryType: row.entry_type as DeadlineProposalInput["entryType"],
    deadlineDate: match[1],
    deadlineTime: match[2],
    timezone: "Etc/GMT+12",
    homepageUrl:
      typeof row.homepage_url === "string" && row.homepage_url
        ? row.homepage_url
        : typeof row.source_url === "string"
          ? row.source_url
          : typeof row.link === "string"
            ? row.link
            : "",
    cfpUrl: typeof row.cfp_url === "string" ? row.cfp_url : "",
    openReviewUrl: typeof row.openreview_url === "string" ? row.openreview_url : "",
    note: "",
  };
}

function publishedDeadlineVenue(records_: PublishedDeadlineRecord[]): Record<string, unknown> {
  const records = records_.toSorted((left, right) => left.revision - right.revision);
  const latest = records.at(-1)!;
  const validated = validateDeadlineProposalInput(latest.deadline);
  if (!validated.ok) {
    throw new Error(`published deadline ${latest.deadline_id} is invalid`);
  }
  const instant = new Date(validated.instant).getTime();
  const aoe = new Date(instant - 12 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
  const entryType = latest.deadline.entryType;
  const family = latest.deadline.parentConference;
  const parentGroup =
    [family, latest.deadline.parentYear].filter(Boolean).join(" ") || latest.deadline.name;
  const group =
    entryType === "workshop" && family && !/\bworkshops?$/iu.test(parentGroup)
      ? `${parentGroup} Workshops`
      : parentGroup;
  const label =
    entryType === "arr_commitment"
      ? "ARR commitment"
      : entryType === "arr_direct_submission"
        ? "ARR submission"
        : entryType === "rebuttal"
          ? "rebuttal ends"
          : "submission";
  return {
    id: latest.deadline_id,
    deadline_id: latest.deadline_id,
    venue_id: latest.deadline_id,
    venue_aliases: [latest.deadline_id],
    name: latest.deadline.name,
    venue_type:
      entryType === "workshop" ? "workshop" : entryType === "rebuttal" ? "rebuttal" : "conference",
    venue_group: group,
    ...(family ? { venue_family: family } : {}),
    entry_type: entryType,
    archival_status: "unknown",
    venue_priority: "standard",
    archival: false,
    stale: false,
    deadline_label: label,
    deadline_aoe: aoe,
    link: latest.deadline.cfpUrl || latest.deadline.homepageUrl,
    homepage_url: latest.deadline.homepageUrl,
    ...(latest.deadline.cfpUrl ? { cfp_url: latest.deadline.cfpUrl } : {}),
    source_url: latest.deadline.cfpUrl || latest.deadline.homepageUrl,
    source_checked_at: latest.published_at,
    ...(latest.deadline.openReviewUrl ? { openreview_url: latest.deadline.openReviewUrl } : {}),
    revisions: records.map((record) => {
      const revision = validateDeadlineProposalInput(record.deadline);
      const revisionInstant = revision.ok ? new Date(revision.instant).getTime() : Number.NaN;
      return {
        observed_at: record.published_at,
        deadline_aoe: Number.isFinite(revisionInstant)
          ? new Date(revisionInstant - 12 * 60 * 60 * 1000)
              .toISOString()
              .replace("T", " ")
              .slice(0, 19)
          : aoe,
        deadline_label: label,
        link: record.deadline.cfpUrl || record.deadline.homepageUrl,
      };
    }),
  };
}

const SELF_PROFILE_EDITABLE_FIELDS = [
  "name",
  "preferred_name",
  "slack_user_id",
  // Slack-derived, not something a member types: the roster sync writes it through the service
  // principal, which lands on this same whitelist. Governance fields stay in the privileged list.
  "slack_channels",
  // Written by the Slack activity sweep through the service principal, never typed by a member.
  "slack_messages_7d",
  "slack_activity_checked_at",
  "role",
  "research_branch",
  "research_topics",
  "projects",
  "hours_per_week",
  "availability",
  "location",
  "current_city",
  "affiliation",
  "timezone",
  "personal_website",
  "openreview_id",
  "avatar_url",
  "cv_url",
  "intake_form_url",
  "linkedin_url",
  // LinkedIn publishes no vanity-URL-to-URN mapping, so this is a value somebody has to look up --
  // but the member can look it up as easily as an admin, and the field's own help text has always
  // told them to, pointing at the collector tool that reads it off their own account. The control
  // was disabled and self updates carrying a URN were dropped here, so that instruction could not
  // be followed. Both halves are fixed: the member may now paste one in.
  //
  // Still absent from the reminder's set (adminBotAdminOwnedProfileFields), which is a separate
  // question from who may write it: one member of 199 has a URN, and chasing the rest for it would
  // be fifty nudges about a field nobody has heard of.
  "linkedin_urn",
  "twitter_url",
  "github_url",
  "scholar_url",
  "calendar_email",
  "joined_month",
  "graduated_month",
  "whatsapp",
  "correspondence_email",
  // Confidential on read (see adminBotConfidentialMemberFields); self-editable like any other
  // field a member writes about themselves.
  "personal_circumstances",
  "lesswrong_url",
  "other_socials",
  "notes",
  "availability",
  "time_off",
  "milestones",
  "trips",
  "dismissed_deadlines",
  // The prose that goes with the three lists above. Admin-visible on read (see
  // adminBotScheduleMemberFields) and self-editable, like the rows it explains.
  "availability_notes",
  "availability_doc_url",
  // The link only. cv_snapshot is deliberately absent: it is what the scan compares against, so a
  // member who could write it could hide or invent their own career changes.
  "cv_url",
] as const;

const SELF_PROFILE_PRIVILEGED_FIELDS = [
  "privilege_level",
  // Decide who the batch sweeps address, so they are not facts a member states about themselves.
  "test_onboard_batch",
  "member_type",
  // The nudge allowlist. Refused loudly rather than dropped quietly: a member who could add
  // themselves would make the list something other than what the lab put on it.
  "receives_nudges",
  "collaborator_subgroup",
  "access_overrides",
  "status",
  "email",
] as const;

// What an author may maintain on their own paper: the record's own description, plus every artifact
// link (conference and topic live there too).
const OWN_PAPER_EDITABLE_FIELDS = [
  "title",
  // The project's short name and when it started. Both are the author's own answers about their
  // own project, and both are asked for at creation, so they have to be writable by the member
  // filing it -- a field the create form collects and the service drops is the worst of both.
  "alias",
  "started_on",
  "authors",
  "current_step",
  "artifacts",
  "notes",
  // Who read the draft. The author's own record of who they asked, so it is theirs to edit.
  "feedback_givers",
  // What each author does on the paper. Theirs to write for the same reason the author list is.
  "author_roles",
  // Who the author list actually names. Editable by an author for the same reason `authors` is --
  // and it is the field that decides which coauthors can see the paper at all, so a member adding
  // a colleague here is giving them access to a paper they already wrote.
  "author_links",
  // Where the paper is aimed and when it is due. An author's own call, and it moves -- a missed
  // deadline, a change of plan -- so it belongs with the fields they edit on their own card.
  "venue",
  "deadline",
] as const;

// Governance the paper flow drives: mentor assignment, the reviewer checklist, and reminder cadence
// (escalation windows and the head professor who gets escalated to). Ownership is server-stamped.
//
// The nudge-targeting and decision fields are here for the same reason: `first_author_member_id`
// decides who every nudge on this paper goes to, `venue_decision`/`attempt` record what the venue
// said, and `dormant_override` exempts a paper from the dormancy rule. Named explicitly rather
// than left to fall off the editable list, so a member who tries gets a refusal instead of a
// silent no-op.
const OWN_PAPER_PRIVILEGED_FIELDS = [
  "mentor_member_id",
  "checks",
  "reminder",
  "submitted_by_member_id",
  "first_author_member_id",
  "venue_decision",
  "attempt",
  "dormant_override",
] as const;

function paperMatchesNeedles(paper: AdminBotPaperRecord, needles: string[]): boolean {
  const haystack = [paper.title, paper.artifacts?.topic, ...paper.authors]
    .flatMap((value) => (typeof value === "string" ? [value] : []))
    .join("\n");
  return textMatchesNeedles(haystack, needles);
}

function truncateForSummary(message: string, maxLength = 80): string {
  return message.length > maxLength ? `${message.slice(0, maxLength - 1)}…` : message;
}

function resolvePolicy(proposal: AdminBotActionProposal): AdminBotActionPolicy {
  const defaults = DEFAULT_ACTION_POLICIES[proposal.type];
  const riskTier = proposal.risk_tier ?? defaults.risk_tier;
  const fallback = defaultPolicyForRiskTier(riskTier);
  return {
    ...fallback,
    ...defaults,
    risk_tier: riskTier,
    requires_approval:
      defaults.requires_approval || fallback.requires_approval || defaults.auto_allowed !== true,
  };
}

function defaultPolicyForRiskTier(riskTier: AdminBotRiskTier): AdminBotActionPolicy {
  if (riskTier === "T0" || riskTier === "T1") {
    return autoPolicy(riskTier);
  }
  if (riskTier === "T2" || riskTier === "T3") {
    return approvalPolicy(riskTier, ["admin"]);
  }
  return approvalPolicy(riskTier, ["admin"], 2);
}

function autoPolicy(riskTier: AdminBotRiskTier): AdminBotActionPolicy {
  return {
    risk_tier: riskTier,
    requires_approval: false,
    approver_roles: [],
    min_approvals: 0,
    auto_allowed: true,
  };
}

function approvalPolicy(
  riskTier: AdminBotRiskTier,
  approverRoles: AdminBotApproverRole[],
  minApprovals = 1,
): AdminBotActionPolicy {
  return {
    risk_tier: riskTier,
    requires_approval: true,
    approver_roles: approverRoles,
    min_approvals: minApprovals,
  };
}

function serviceError<T>(status: number, message: string): AdminBotServiceResponse<T> {
  return { ok: false, status, error: { message } };
}

// How long a member is left alone after a mandatory-fields reminder. The cron script may run as
// often as it likes -- daily is fine, and gives a member who fills their profile in on day one a
// prompt exit from the list -- but nobody is nudged about the same gap more than once per window.
const MANDATORY_FIELDS_REMINDER_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;

// The same idea one level down: a *slot* is left alone for three days after it was nudged about.
// Per-slot rather than per-paper, so filling in two of four artifacts genuinely quiets those two
// and the next pass chases only what is still open.
const PAPER_SLOT_NUDGE_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;

// A venue-cycle stage is asked about once a week, not every three days like a slot. The author
// cannot make the answer arrive any sooner -- the venue decides when reviews land -- so a tighter
// cadence buys nothing and spends the one thing that makes these mails work, which is that
// receiving one still means something.
const PAPERFLOW_STAGE_NUDGE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

// Fixed order, so a person owed slots in two roles on the same paper reads them in the same order
// every time.
function isAdminBotAttendanceState(
  value: string,
): value is (typeof adminBotAttendanceStates)[number] {
  return (adminBotAttendanceStates as readonly string[]).includes(value);
}

function isAdminBotReimbursementState(
  value: string,
): value is (typeof adminBotReimbursementStates)[number] {
  return (adminBotReimbursementStates as readonly string[]).includes(value);
}

// The one list, shared with the Control UI through the contracts module so the reminder can never
// chase a field the profile page calls optional -- or one it calls required but will not let the
// member type. See adminBotMemberAnswerableProfileFields for what each exclusion is for.
//
// Both sides used to drop exactly one field and drop a *different* one, so the two counts agreed at
// twelve while the two sets did not, and nothing in either page's arithmetic could show it.
/** The access-matrix row that puts a collaborator in a project's own channel. */
const PROJECT_CHANNEL_ACCESS_ITEM = "project_channel";

const MANDATORY_PROFILE_FIELDS = adminBotMemberAnswerableProfileFields;
/**
 * Whether the lab holds any address at all for this member.
 *
 * All three columns, because they are three different addresses rather than a preference order:
 * `email` is the login identity, `calendar_email` is the Google account invites go to, and
 * `correspondence_email` is where outreach is written. A bulk-imported row routinely carries only
 * the last of these, and treating it as unreachable would delete somebody the lab mails weekly.
 */
function memberHasAnyEmail(member: AdminBotLabMember): boolean {
  return [member.email, member.calendar_email, member.correspondence_email].some(
    (value) => typeof value === "string" && value.trim() !== "",
  );
}

function missingMandatoryProfileFields(member: AdminBotLabMember): string[] {
  return MANDATORY_PROFILE_FIELDS.filter((key) => {
    const value = member[key];
    if (Array.isArray(value)) {
      return value.filter(Boolean).length === 0;
    }
    return value === undefined || value === null || String(value).trim() === "";
  });
}

/**
 * How many entries a member has put on their Time Availability page.
 *
 * "Timeline" in the brainstorming doc is that page: the hours-per-week rows, the time off, the
 * dated milestones and the trips. Counted together rather than reported per list because the
 * question it answers is "has this person told us when they are working at all", and one row of
 * any kind is a different situation from none.
 */
function countTimelineEntries(member: AdminBotLabMember): AdminBotMemberTimelineCounts {
  const availability = member.availability?.length ?? 0;
  const timeOff = member.time_off?.length ?? 0;
  const milestones = member.milestones?.length ?? 0;
  const trips = member.trips?.length ?? 0;
  return {
    availability,
    time_off: timeOff,
    milestones,
    trips,
    total: availability + timeOff + milestones + trips,
  };
}

/**
 * Least finished first, which is the order this list is worked in.
 *
 * Missing profile fields dominate the sort and timeline entries break the tie: a member with a
 * blank profile is a bigger gap than one who filled everything in but has not planned their term,
 * and the name is the last tiebreak so the order is stable between reads.
 */
function byProfileProgress(
  left: AdminBotMemberProfileOverviewRow,
  right: AdminBotMemberProfileOverviewRow,
): number {
  if (left.missing_fields.length !== right.missing_fields.length) {
    return right.missing_fields.length - left.missing_fields.length;
  }
  if (left.timeline.total !== right.timeline.total) {
    return left.timeline.total - right.timeline.total;
  }
  return left.name.localeCompare(right.name);
}

/**
 * The ask, urgent, with the reason attached to it.
 *
 * Urgency here is a fact rather than a tone: the meeting is tomorrow morning, the planning happens
 * *in* that meeting, and a paper with no venue on it at 9:30 is a paper that gets planned around
 * rather than planned for. So the deadline leads, the consequence is concrete, and the ask is one
 * line somebody can act on from their phone. What it does not do is manufacture alarm -- no
 * all-caps, no "URGENT" prefix, no threat. A reminder that shouts every week stops being read by
 * the third week, and this one needs to work tomorrow.
 */
function buildPreRegistrationMessage(params: { venue: string; paperCount: number }): string {
  const papers = params.paperCount === 1 ? "your paper" : `your ${params.paperCount} active papers`;
  return [
    `*Needed before tomorrow's 9:30 group meeting* — none of ${papers} is registered for ` +
      `${params.venue} yet.`,
    "",
    `We plan the next six weeks in that meeting: who reviews what, who needs mentor time, and ` +
      `whose deadline lands where. All of it comes off the pre-registration list, so a paper that ` +
      `is not on it tomorrow morning is a paper the lab plans *around* instead of planning *for* ` +
      `— and that is how three people end up needing the same reviewer in the same week.`,
    "",
    `Please do it tonight: My Projects & Papers → *Pre-register a paper* → pick the venue and a ` +
      `rough likelihood for each one. Two minutes. A guess is a real answer — 50% tells us far ` +
      `more than a blank does.`,
  ].join("\n");
}

/**
 * For somebody who has registered something: the rest of their papers still need an answer.
 *
 * Same deadline, gentler opening. They have already done the thing being asked for once, and
 * opening on what they have not done reads as a complaint rather than a reminder.
 */
function buildRegistrationUpdateMessage(params: { venue: string; unregistered: number }): string {
  const papers =
    params.unregistered === 1
      ? "one other active paper"
      : `${params.unregistered} other active papers`;
  return [
    `*Before tomorrow's 9:30 group meeting* — thanks for registering for ${params.venue}. You ` +
      `have ${papers} with no venue on it yet.`,
    "",
    `We plan reviewer load and mentor time off the full list tomorrow morning, so the gaps are ` +
      `what bite: not everything is going to ${params.venue}, and knowing which ones are not is ` +
      `just as useful as knowing which ones are.`,
    "",
    "Please finish it tonight: My Projects & Papers → *Pre-register a paper*, venue and rough " +
      "likelihood for each of the rest. Two minutes.",
  ].join("\n");
}

/**
 * The reminder, in the shape of whatever this person is actually missing.
 *
 * Their own missing subset, not the lab-wide list. Naming every checked field made a member who was
 * short one item read a message about eleven others, which is how a reminder teaches people that it
 * is not about them -- and it hid the linkedin_urn bug for as long as it ran, because a complete
 * profile and a nearly complete one got the identical sentence.
 *
 * Still nobody's prose: the field names come from adminBotMandatoryProfileFieldLabels and the only
 * caller-supplied part is *which* of those fixed labels appear, so the text remains impossible for
 * a member or an agent to steer.
 *
 * One message rather than two when both halves are outstanding: they are two halves of the same
 * page, and a member who gets one nudge about their profile and another about their timeline reads
 * a system that does not know what it already sent.
 */
function buildProfileReminderMessage(needs: { missingFields: string[]; timeline: boolean }): string {
  const lines: string[] = [];
  if (needs.missingFields.length > 0) {
    const fields = needs.missingFields
      .map((key) => adminBotMandatoryProfileFieldLabels[key as AdminBotMandatoryProfileField] ?? key)
      .join(", ");
    const count =
      needs.missingFields.length === 1
        ? "one required field"
        : `${needs.missingFields.length} required fields`;
    lines.push(
      `Quick reminder: your AdminBot profile is missing ${count} — ${fields}.`,
      "Open your profile page in the Control UI and fill them in — it saves as you type.",
    );
  }
  if (needs.timeline) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(
      "Your timeline is empty. Add when you are working, when you are away, and the milestones " +
        "you are aiming at, on the Time Availability page.",
      "It is what the lab plans deadlines and meetings around — without it, nobody can tell " +
        "whether you are free next month.",
    );
  }
  lines.push("", "Already done? You'll stop getting this once it is filled in.");
  return lines.join("\n");
}

const PROFILE_PHOTO_RULES_TEXT = [
  "Profile photo guidelines:",
  "- Big enough headshot.",
  "- Face is clearly visible, preferably facing front.",
  "- Background is clean (blurred, single color, or easy to make single-color using a background remover).",
].join("\n");

function buildProfilePhotoGuidelineMessage(): string {
  return [
    "Your current Slack profile photo does not yet match our profile photo guidelines.",
    PROFILE_PHOTO_RULES_TEXT,
    "",
    "These rules are because we're developing webpages and strongly recommend a professional Slack profile photo so we can include you on the teams/collaborators pages. We directly link member photos from Slack on your profile and on our lab public website.",
    "",
    "How-To if you want to take a better photo yourself:",
    "- Use portrait mode and the back camera (higher quality), and have somebody take the photo for you.",
    "- Many phones/apps can blur the background or change it to a pure color. Some members took good photos in 10 seconds using portrait mode.",
    "- Neutral backgrounds are usually better; you can use https://www.remove.bg/ to crop yourself and place yourself into a neutral background.",
    "- Usually the shot is chest-up and includes shoulders.",
    "",
    "In your AdminBot profile page, you can choose AI-based polishing for your current photo, review generated options, and apply the version you like.",
  ].join("\n");
}

// Built from the checklist definition rather than hardcoded per step, so the nudge text and the
// dashboard warning card can never describe the task differently.
function buildOnboardingNudgeMessage(step: AdminBotMemberOnboardingStep | undefined): string {
  if (!step) {
    return "You have an outstanding lab onboarding step — see your AdminBot dashboard.";
  }
  const lines = [
    `Hey! 👋 If you haven't gotten to *${step.label}* yet, please take a minute to do it — it's part of your lab onboarding.`,
  ];
  if (step.detail) {
    lines.push(step.detail);
  }
  for (const bullet of step.bullets ?? []) {
    lines.push(`• ${bullet.text}`);
    for (const point of bullet.points ?? []) {
      lines.push(`    ◦ ${point}`);
    }
  }
  for (const link of step.links ?? []) {
    lines.push(`${link.label}: ${link.url}`);
  }
  // The reaction option only works because scripts/adminbot_onboarding_confirm.py polls the DM
  // for it; keep this wording and that script's CONFIRM_REACTIONS in sync.
  lines.push(
    "Already done? React to this message with ✅ and I'll record it. If not, do it now and react when you're done — thanks! 🙌",
  );
  lines.push(
    "(Reactions are picked up automatically every few hours, so the confirmation isn't instant — don't worry, it will be recorded. You can also mark it complete on your AdminBot dashboard.)",
  );
  return lines.join("\n");
}

function validateLabMember(
  member: AdminBotLabMemberInput,
  privilegeLevel: AdminBotPrivilegeLevel,
  existingEmail?: string,
): string | undefined {
  if (!member.id.trim()) {
    return "member id is required";
  }
  // Optional-chained even though the type says `name` is required: the HTTP layer casts a parsed
  // JSON body straight to this type, so an absent name reaches here as undefined and used to throw
  // a TypeError out of the route as a 500 rather than answering 400.
  if (!member.name?.trim()) {
    return "member name is required";
  }
  if (member.status && !adminBotMemberStatuses.includes(member.status)) {
    return "member status is invalid";
  }
  // Typed rather than coerced. An admin who sends "true" or 1 would otherwise store a value that
  // adminBotReceivesNudges reads as off, and the symptom would be a member who is on the list
  // according to the record and silent according to the sweeps.
  if (member.receives_nudges !== undefined && typeof member.receives_nudges !== "boolean") {
    return "member receives_nudges must be true or false";
  }
  const emailError = validateMemberEmail(member.email, existingEmail);
  if (emailError) {
    return emailError;
  }
  if (member.calendar_email !== undefined) {
    const calendarEmailError = validateEmailFormat(member.calendar_email, "calendar email");
    if (calendarEmailError) {
      return calendarEmailError;
    }
  }
  if (member.collaborator_subgroup !== undefined) {
    if (!adminBotExternalCollaboratorSubgroups.includes(member.collaborator_subgroup)) {
      return `member collaborator subgroup must be one of: ${adminBotExternalCollaboratorSubgroups.join(", ")}`;
    }
    // Checked against the *effective* level, so setting a subgroup on a stored external
    // collaborator works without resending privilege_level, and a same-request promotion is refused
    // rather than silently keeping a subgroup the new level has no matrix for.
    if (privilegeLevel !== "external_collaborator") {
      return "member collaborator subgroup requires privilege level external_collaborator";
    }
  }
  // Role is a closed vocabulary, not free text: the roster is filtered and reported on by role,
  // and "PhD student" / "PhD Student" / "PhD" as three distinct values made those counts lie.
  // Empty stays legal — a role nobody has recorded yet is different from a wrong one.
  if (member.role !== undefined && member.role !== "") {
    if (!adminBotMemberRoles.includes(member.role as (typeof adminBotMemberRoles)[number])) {
      return `member role must be one of: ${adminBotMemberRoles.join(", ")}`;
    }
  }
  if (
    member.hours_per_week !== undefined &&
    (!Number.isFinite(member.hours_per_week) ||
      member.hours_per_week < 0 ||
      member.hours_per_week > 168)
  ) {
    return "member hours per week must be between 0 and 168";
  }
  if (member.availability_doc_url !== undefined) {
    const docError = validateAvailabilityDocUrl(member.availability_doc_url);
    if (docError) {
      return docError;
    }
  }
  if (member.openreview_id !== undefined) {
    const openReviewError = validateOpenReviewId(member.openreview_id);
    if (openReviewError) {
      return openReviewError;
    }
  }
  // Slack channel names, not ids or links: the sync writes what `users.conversations` reports, and
  // a stray "#" or a full archive URL would break the lookups that join a member to a channel.
  if (member.slack_channels !== undefined) {
    if (!Array.isArray(member.slack_channels)) {
      return "member slack channels must be a list";
    }
    for (const channel of member.slack_channels) {
      if (typeof channel !== "string" || !SLACK_CHANNEL_NAME.test(channel)) {
        return `member slack channel is invalid: ${String(channel)}`;
      }
    }
  }
  for (const spec of SOCIAL_URL_FIELDS) {
    const value = member[spec.field];
    if (value === undefined) {
      continue;
    }
    const urlError = validateSocialUrl(value, spec);
    if (urlError) {
      return urlError;
    }
  }
  return validateAvailability(member);
}

// Every one of these is a *real* account-page shape check, not merely "is this a URL" -- a
// wrong-platform link (a GitHub URL saved as the Twitter field) or a bare domain with no handle
// fails the same way a garbage string would. Confirming the account actually *exists* is a
// liveness question, not a shape question, so it deliberately does not belong here: a live check
// means an outbound fetch on every profile save, and (per AVAILABILITY_DOC_HOSTS above) this
// service does not add fetch primitives driven by member-supplied input. The Control UI does that
// check itself, client-side, against each platform's own public API, where it costs nothing to
// get wrong and nothing to rate-limit.
type SocialUrlFieldSpec = {
  field:
    | "personal_website"
    | "avatar_url"
    | "cv_url"
    | "intake_form_url"
    | "linkedin_url"
    | "twitter_url"
    | "github_url"
    | "scholar_url";
  label: string;
  // Omitted for personal_website/cv_url: those genuinely point anywhere the member likes.
  hosts?: Set<string>;
  path?: RegExp;
  requireQueryParam?: string;
  // The field may also hold an inline `data:` image instead of a link out. Only the profile photo
  // does: the lab runs no object storage, so an uploaded picture is stored on the record itself
  // (see the Control UI's own upload control, which reads the file and sends a data URL). Without
  // this, every upload failed the https check below and the whole feature was inert.
  allowInlineImage?: true;
};

// Raster types only, and never image/svg+xml: an SVG is a document that can carry script, and this
// value is handed straight to an <img src> in the Control UI.
const INLINE_IMAGE_PATTERN =
  /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

// Matches MAX_AVATAR_BYTES in the Control UI's upload control. The client already refuses a larger
// file; this is the same limit enforced where it counts, against the decoded bytes rather than the
// ~33%-larger base64 text.
const MAX_INLINE_IMAGE_BYTES = 512 * 1024;

/** Validates an inline image payload, returning an error message when it is not storable. */
function validateInlineImage(value: string, spec: SocialUrlFieldSpec): string | undefined {
  const match = INLINE_IMAGE_PATTERN.exec(value);
  if (!match) {
    return `${spec.label} must be a PNG, JPEG, GIF, or WebP image`;
  }
  const base64 = match[1] ?? "";
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const decodedBytes = Math.floor((base64.length * 3) / 4) - padding;
  if (decodedBytes > MAX_INLINE_IMAGE_BYTES) {
    return `${spec.label} must be ${Math.floor(MAX_INLINE_IMAGE_BYTES / 1024)} KB or smaller`;
  }
  return undefined;
}

const SOCIAL_URL_FIELDS: SocialUrlFieldSpec[] = [
  { field: "personal_website", label: "personal website" },
  { field: "avatar_url", label: "profile photo", allowInlineImage: true },
  { field: "cv_url", label: "CV" },
  {
    // A member's own intake answers. Google Forms hands each respondent a link to their single
    // submitted response, so the host is fixed and the path is always a /forms/ route -- checking
    // that much stops a stray link being filed here, without pretending to know the response id.
    field: "intake_form_url",
    label: "intake form answers",
    hosts: new Set(["docs.google.com"]),
    path: /^\/forms\/.+/u,
  },
  {
    field: "github_url",
    label: "GitHub",
    hosts: new Set(["github.com", "www.github.com"]),
    path: /^\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/?$/u,
  },
  {
    field: "twitter_url",
    label: "Twitter/X",
    hosts: new Set(["twitter.com", "www.twitter.com", "x.com", "www.x.com"]),
    path: /^\/[A-Za-z0-9_]{1,15}\/?$/u,
  },
  {
    field: "linkedin_url",
    label: "LinkedIn",
    hosts: new Set(["linkedin.com", "www.linkedin.com"]),
    path: /^\/in\/[A-Za-z0-9\-_%]+\/?$/u,
  },
  {
    field: "scholar_url",
    label: "Google Scholar",
    hosts: new Set(["scholar.google.com"]),
    path: /^\/citations\/?$/u,
    requireQueryParam: "user",
  },
];

function validateSocialUrl(value: unknown, spec: SocialUrlFieldSpec): string | undefined {
  if (typeof value !== "string") {
    return `${spec.label} link must be a string`;
  }
  const trimmed = value.trim();
  // Empty clears the link.
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("data:")) {
    return spec.allowInlineImage
      ? validateInlineImage(trimmed, spec)
      : `${spec.label} link must use https`;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return `${spec.label} link must be a valid URL`;
  }
  if (parsed.protocol !== "https:") {
    return `${spec.label} link must use https`;
  }
  if (spec.hosts && !spec.hosts.has(parsed.hostname)) {
    return `${spec.label} link must point to ${spec.label}`;
  }
  if (spec.path && !spec.path.test(parsed.pathname)) {
    return `${spec.label} link must be a profile URL (e.g. a page with a username in the path)`;
  }
  if (spec.requireQueryParam && !parsed.searchParams.has(spec.requireQueryParam)) {
    return `${spec.label} link must include a ${spec.requireQueryParam} parameter`;
  }
  return undefined;
}

// OpenReview tilde ids look like "~First_Last1": a letter, then letters/digits/underscores/dots,
// ending in the disambiguating digit OpenReview appends. Rejecting the shape here is cheap and
// catches "pasted the profile URL instead of the id" before it reaches the reviewing-cycle
// automation that matches submissions against this field.
// Hyphens and non-ASCII letters are both ordinary in real ids -- "~Tung-Yu_Wu1",
// "~Emilia_Wiśnios1" -- and the old ASCII-only, hyphen-free pattern rejected them, which silently
// cost those members the field. Still anchored on the tilde and the trailing disambiguation digit,
// which are the parts OpenReview actually guarantees.
const SLACK_CHANNEL_NAME = /^[a-z0-9][a-z0-9._-]{0,79}$/u;
const OPENREVIEW_ID = /^~\p{L}[\p{L}\p{N}_.-]*[0-9]$/u;

function validateOpenReviewId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return "openreview id must be a string";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!OPENREVIEW_ID.test(trimmed)) {
    return 'openreview id must look like "~First_Last1" (see the "id" in your OpenReview profile URL)';
  }
  return undefined;
}

const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function validateEmailFormat(value: unknown, label: string): string | undefined {
  if (typeof value !== "string") {
    return `${label} must be a string`;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!EMAIL_FORMAT.test(trimmed)) {
    return `${label} must be a valid email address`;
  }
  return undefined;
}

// A cs.toronto.edu address is preferred, not required.
//
// This used to refuse anything else outright for anyone who was not an external collaborator, on
// the reasoning that the department directory is what every Slack/paper/reimbursement flow keys a
// member by. In practice that is not what the roster is: lab members arrive with a CMU or an ETH
// address and work here for months before a departmental account exists -- and refusing to store
// the only address the lab actually has for them left the record blank, which is strictly worse
// than storing the address that works.
//
// "Preferred" is still honoured where it means something: `vectorRosterEmail` picks the
// cs.toronto.edu address when a member carries one, falling back to whatever else is on file, and
// the onboarding mail asks people to get one. Nothing depends on the domain for correctness.
//
// Only a genuinely new or changed value is checked -- re-saving an unrelated field on an
// already-stored member must not start failing over a value nobody is touching.
function validateMemberEmail(
  value: string | undefined,
  existingEmail: string | undefined,
): string | undefined {
  if (value === undefined || value === existingEmail) {
    return undefined;
  }
  // Format only. The old domain rule short-circuited before any format check for external
  // collaborators, so their addresses were never validated at all; this closes that quietly.
  return validateEmailFormat(value, "member email");
}

// The availability importer fetches this URL server-side with the AdminBot's own Google
// credentials, so it is restricted to the hosts the Drive tooling can actually read. Without the
// allowlist a self-editable profile field would become a fetch primitive aimed at any host.
const AVAILABILITY_DOC_HOSTS = new Set(["docs.google.com", "drive.google.com"]);

function validateAvailabilityDocUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return "availability doc url must be a string";
  }
  const trimmed = value.trim();
  // Empty clears the link; the importer simply skips members without one.
  if (!trimmed) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "availability doc url must be a valid URL";
  }
  if (parsed.protocol !== "https:") {
    return "availability doc url must use https";
  }
  if (!AVAILABILITY_DOC_HOSTS.has(parsed.hostname)) {
    return "availability doc url must be a Google Docs or Drive link";
  }
  return undefined;
}

// Members are stored as one JSON blob, so an unbounded array here would bloat every
// read of the roster. The cap is deliberately far above any real schedule.
const MAX_AVAILABILITY_ROWS = 200;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

// A calendar date with no time part; parsed as UTC so a server timezone can never
// shift a row onto the neighbouring day.
function parseIsoDate(value: string): number {
  if (!ISO_DATE.test(value)) {
    return Number.NaN;
  }
  return Date.parse(`${value}T00:00:00Z`);
}

function validateDateRange(row: { start: string; end: string }, label: string): string | undefined {
  const start = parseIsoDate(row.start);
  const end = parseIsoDate(row.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return `${label} dates must be YYYY-MM-DD`;
  }
  if (start > end) {
    return `${label} start date must not be after its end date`;
  }
  return undefined;
}

// Supporting links on a schedule row or milestone. Deliberately stricter than "is a URL": these
// are rendered as anchors in the Control UI, so anything but https is refused outright rather than
// left for the renderer to decide about. Unlike availability_doc_url this is not restricted to
// Google — a syllabus or a project board can live anywhere.
function validateExternalLink(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return `${label} link must be a string`;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return `${label} link must be a valid URL`;
  }
  if (parsed.protocol !== "https:") {
    return `${label} link must use https`;
  }
  return undefined;
}

function validateLabel(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return `${label} must be a string`;
  }
  if (value.length > ADMINBOT_MAX_LABEL_LENGTH) {
    return `${label} cannot exceed ${ADMINBOT_MAX_LABEL_LENGTH} characters`;
  }
  return undefined;
}

/**
 * The optional wall-clock half of a dated deadline: "HH:MM" plus the zone it is read in.
 *
 * The pair is validated together because neither half is usable alone. A time with no zone is the
 * failure this field exists to prevent -- a member in Toronto typing "23:59" for a deadline set in
 * Anywhere-on-Earth is off by seventeen hours, and storing the number without the zone makes that
 * mistake unrecoverable rather than merely made. Storing a zone with no time is harmless but
 * meaningless, so it is refused too rather than kept as a value nothing ever reads.
 */
function validateDeadlineClock(
  time: unknown,
  timezone: unknown,
  label: string,
): string | undefined {
  if (time === undefined && timezone === undefined) {
    return undefined;
  }
  if (time !== undefined && typeof time !== "string") {
    return `${label} time must be a string`;
  }
  if (timezone !== undefined && typeof timezone !== "string") {
    return `${label} time zone must be a string`;
  }
  if (typeof time !== "string" || !ADMINBOT_DEADLINE_TIME_PATTERN.test(time)) {
    return `${label} time must be HH:MM`;
  }
  if (typeof timezone !== "string" || !timezone.trim()) {
    return `${label} time zone is required when a time is given`;
  }
  if (!isAdminBotTimezone(timezone)) {
    return `${label} time zone is not a known IANA zone`;
  }
  return undefined;
}

/**
 * Trips, validated like the other dated lists plus the two rules that are theirs alone.
 *
 * A city is required because a trip with no place is indistinguishable from time off, and the
 * timezone -- when given -- has to be a real IANA zone, since everything downstream feeds it
 * straight to Intl and a typo would otherwise surface as a silently missing local time.
 */
function validateTrips(member: AdminBotLabMemberInput): string | undefined {
  if (member.trips === undefined) {
    return undefined;
  }
  if (!Array.isArray(member.trips)) {
    return "member trips must be a list";
  }
  if (member.trips.length > MAX_AVAILABILITY_ROWS) {
    return `member trips cannot exceed ${MAX_AVAILABILITY_ROWS} rows`;
  }
  for (const row of member.trips) {
    if (!Number.isFinite(parseIsoDate(row?.start)) || !Number.isFinite(parseIsoDate(row?.end))) {
      return "trip start and end must be YYYY-MM-DD";
    }
    if (row.end < row.start) {
      return "trip end cannot be before its start";
    }
    if (typeof row.city !== "string" || !row.city.trim()) {
      return "trip city is required";
    }
    const cityError = validateLabel(row.city, "trip city");
    if (cityError) {
      return cityError;
    }
    if (row.timezone !== undefined && row.timezone !== "" && !isAdminBotTimezone(row.timezone)) {
      return "trip time zone is not a known IANA zone";
    }
    const linkError = validateExternalLink(row.link, "trip");
    if (linkError) {
      return linkError;
    }
  }
  return undefined;
}

/**
 * The list of snapshot deadlines a member has dismissed.
 *
 * Bounded like every other member-supplied list, and each entry length-checked like a label: these
 * are venue names copied off the bundled snapshot, and without a ceiling the field is an unbounded
 * write on a record every admin reads.
 */
function validateDismissedDeadlines(member: AdminBotLabMemberInput): string | undefined {
  if (member.dismissed_deadlines === undefined) {
    return undefined;
  }
  if (!Array.isArray(member.dismissed_deadlines)) {
    return "member dismissed deadlines must be a list";
  }
  if (member.dismissed_deadlines.length > MAX_AVAILABILITY_ROWS) {
    return `member dismissed deadlines cannot exceed ${MAX_AVAILABILITY_ROWS} rows`;
  }
  for (const entry of member.dismissed_deadlines) {
    if (typeof entry !== "string" || !entry.trim()) {
      return "dismissed deadline names must be non-empty strings";
    }
    const labelError = validateLabel(entry, "dismissed deadline");
    if (labelError) {
      return labelError;
    }
  }
  return undefined;
}

function validateMilestones(member: AdminBotLabMemberInput): string | undefined {
  if (member.milestones === undefined) {
    return undefined;
  }
  if (!Array.isArray(member.milestones)) {
    return "member milestones must be a list";
  }
  if (member.milestones.length > MAX_AVAILABILITY_ROWS) {
    return `member milestones cannot exceed ${MAX_AVAILABILITY_ROWS} rows`;
  }
  for (const row of member.milestones) {
    if (!Number.isFinite(parseIsoDate(row?.date))) {
      return "milestone date must be YYYY-MM-DD";
    }
    // A milestone with no label is an unexplained mark on someone's timeline.
    if (typeof row.label !== "string" || !row.label.trim()) {
      return "milestone label is required";
    }
    const labelError = validateLabel(row.label, "milestone label");
    if (labelError) {
      return labelError;
    }
    if (
      row.deadline_id !== undefined &&
      (typeof row.deadline_id !== "string" || !isDeadlineMilestoneId(row.deadline_id))
    ) {
      return "milestone deadline_id must identify a deadline-board entry";
    }
    const linkError = validateExternalLink(row.link, "milestone");
    if (linkError) {
      return linkError;
    }
    const clockError = validateDeadlineClock(row.time, row.timezone, "milestone");
    if (clockError) {
      return clockError;
    }
  }
  return undefined;
}

// The overall note is prose, so the only rules are that it is prose and that it stays a note. The
// ceiling matches the profile page's paragraph controls; without one, a free-text field on a record
// served to every admin is an unbounded write.
const MAX_AVAILABILITY_NOTES_LENGTH = 2000;

function validateAvailability(member: AdminBotLabMemberInput): string | undefined {
  if (member.availability_notes !== undefined) {
    if (typeof member.availability_notes !== "string") {
      return "member availability notes must be a string";
    }
    if (member.availability_notes.length > MAX_AVAILABILITY_NOTES_LENGTH) {
      return `member availability notes cannot exceed ${MAX_AVAILABILITY_NOTES_LENGTH} characters`;
    }
  }
  if (member.availability !== undefined) {
    if (!Array.isArray(member.availability)) {
      return "member availability must be a list";
    }
    if (member.availability.length > MAX_AVAILABILITY_ROWS) {
      return `member availability cannot exceed ${MAX_AVAILABILITY_ROWS} rows`;
    }
    for (const row of member.availability) {
      const rangeError = validateDateRange(row, "availability");
      if (rangeError) {
        return rangeError;
      }
      if (
        !Number.isFinite(row.hours_per_week) ||
        row.hours_per_week < 0 ||
        row.hours_per_week > 168
      ) {
        return "availability hours per week must be between 0 and 168";
      }
      const linkError = validateExternalLink(row.link, "availability");
      if (linkError) {
        return linkError;
      }
    }
  }
  if (member.time_off !== undefined) {
    if (!Array.isArray(member.time_off)) {
      return "member time off must be a list";
    }
    if (member.time_off.length > MAX_AVAILABILITY_ROWS) {
      return `member time off cannot exceed ${MAX_AVAILABILITY_ROWS} rows`;
    }
    for (const row of member.time_off) {
      const rangeError = validateDateRange(row, "time off");
      if (rangeError) {
        return rangeError;
      }
      if (!adminBotTimeOffKinds.includes(row.kind)) {
        return "time off kind is invalid";
      }
      if (row.availability !== "none" && row.availability !== "partial") {
        return "time off availability must be none or partial";
      }
      if (row.hours_per_week !== undefined) {
        if (
          !Number.isFinite(row.hours_per_week) ||
          row.hours_per_week < 0 ||
          row.hours_per_week > 168
        ) {
          return "time off hours per week must be between 0 and 168";
        }
        // Hours on a whole-day row would be two answers to the same question, and the chart
        // reads the whole-day flag first -- so the number would be stored and never shown.
        if (row.availability === "none") {
          return "time off hours per week applies only to partial availability";
        }
      }
      const labelError = validateLabel(row.label, "time off label");
      if (labelError) {
        return labelError;
      }
      const linkError = validateExternalLink(row.link, "time off");
      if (linkError) {
        return linkError;
      }
    }
  }
  return validateMilestones(member) ?? validateTrips(member) ?? validateDismissedDeadlines(member);
}

// availability_updated_at is server-owned: it moves only when the schedule content
// actually changes, so an unrelated profile save (name, website) does not reset the
// staleness badge and mask a member who has stopped updating their hours.
function availabilityStamp(
  existing: AdminBotLabMember | undefined,
  member: AdminBotLabMemberInput,
  now: string,
): { availability_updated_at?: string } {
  const previous = existing?.availability_updated_at;
  const touched =
    (member.availability !== undefined &&
      stableJson(member.availability) !== stableJson(existing?.availability)) ||
    (member.time_off !== undefined &&
      stableJson(member.time_off) !== stableJson(existing?.time_off));
  if (touched) {
    return { availability_updated_at: now };
  }
  return previous ? { availability_updated_at: previous } : {};
}

/**
 * Trims a venue list and drops the entries that cannot identify a venue.
 *
 * A blank id is silently dropped rather than rejected: the settings form submits its rows as a
 * block, so a half-typed row an admin has not finished is a normal intermediate state, not an
 * error worth refusing the whole save for.
 */
function normalizeVenueSources(sources: AdminBotVenueSource[]): AdminBotVenueSource[] {
  const seen = new Set<string>();
  return sources.flatMap((source) => {
    const id = source.id?.trim() ?? "";
    if (!id || seen.has(id)) {
      return [];
    }
    seen.add(id);
    return [{ id, label: source.label?.trim() || id }];
  });
}

function validateSettings(settings: AdminBotSettingsInput): string | undefined {
  if (
    settings.group_meeting_weekday !== undefined &&
    (!Number.isInteger(settings.group_meeting_weekday) ||
      settings.group_meeting_weekday < 0 ||
      settings.group_meeting_weekday > 6)
  ) {
    return "group meeting weekday must be 0 (Sunday) to 6 (Saturday)";
  }
  if (
    settings.group_meeting_time !== undefined &&
    settings.group_meeting_time.trim() !== "" &&
    !/^\d{1,2}:\d{2}$/u.test(settings.group_meeting_time.trim())
  ) {
    // Refused rather than defaulted: a time the parser cannot read would silently fall back to
    // the compiled-in one, which is a reminder going out at a time nobody chose.
    return "group meeting time must look like 09:30";
  }
  if (settings.group_meeting_timezone !== undefined && settings.group_meeting_timezone.trim()) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: settings.group_meeting_timezone.trim() });
    } catch {
      return "group meeting timezone must be an IANA name like America/Toronto";
    }
  }
  if (
    settings.paper_escalation_business_days !== undefined &&
    (!Number.isInteger(settings.paper_escalation_business_days) ||
      settings.paper_escalation_business_days < 1)
  ) {
    return "paper escalation business days must be a positive integer";
  }
  if (
    settings.meeting_minimum_minutes !== undefined &&
    (!Number.isInteger(settings.meeting_minimum_minutes) || settings.meeting_minimum_minutes < 0)
  ) {
    // Zero is meaningful — it means list everything — so this floor is 0, not 1.
    return "meeting minimum minutes must be a non-negative integer";
  }
  if (
    settings.cv_recency_window_months !== undefined &&
    (!Number.isInteger(settings.cv_recency_window_months) ||
      settings.cv_recency_window_months < 1 ||
      // A window past five years stops separating news from history at all, which is the only
      // job this setting has.
      settings.cv_recency_window_months > 60)
  ) {
    return "cv recency window months must be a whole number between 1 and 60";
  }
  const applicantLastReviewedAt = normalizeOptionalString(settings.applicant_last_reviewed_at);
  if (applicantLastReviewedAt && Number.isNaN(Date.parse(applicantLastReviewedAt))) {
    return "applicant last reviewed at must be an ISO timestamp";
  }
  return undefined;
}

/** Trimmed, blank-free, order preserved. Author order decides who the stage nudges go to. */
function normalizeNameList(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function validatePaper(paper: AdminBotPaperRecordInput): string | undefined {
  if (!paper.id.trim()) {
    return "paper id is required";
  }
  if (!paper.title.trim()) {
    return "paper title is required";
  }
  // Either list satisfies it: the card's picker sends `author_links` (names plus who they are) and
  // never touches `authors`, which upsertPaper regenerates from the links a moment later. Checking
  // only `authors` would refuse every save the picker makes.
  const namedAuthors =
    normalizeNameList(paper.authors).length +
    (paper.author_links ?? []).filter((link) => link.name?.trim()).length;
  if (namedAuthors === 0) {
    return "paper authors are required";
  }
  if (paper.author_links !== undefined && !Array.isArray(paper.author_links)) {
    return "author links must be a list";
  }
  // Refused rather than rewritten. The alias becomes the project's Slack channel name, so an
  // author who typed something that cannot be one has to be told now -- not discover afterwards
  // what the lab called their channel. Blank is fine: the alias is optional on an existing paper,
  // and only the creation form insists on one.
  if (paper.alias !== undefined && String(paper.alias).trim()) {
    if (!adminBotNormalizePaperAlias(paper.alias)) {
      return `paper alias must be letters, digits and hyphens, ${adminBotPaperAliasMaxLength} characters or fewer`;
    }
  }
  if (paper.started_on !== undefined && String(paper.started_on).trim()) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(paper.started_on).trim())) {
      return "project start date must look like 2026-09-01";
    }
  }
  if (paper.feedback_givers && !Array.isArray(paper.feedback_givers)) {
    return "feedback givers must be a list of names";
  }
  if (paper.author_roles !== undefined && typeof paper.author_roles !== "string") {
    return "author roles must be a paragraph of text";
  }
  return undefined;
}

function mergeAccessGrants(
  defaults: AdminBotAccessGrant[],
  overrides: AdminBotAccessGrant[] | undefined,
): AdminBotAccessGrant[] {
  const byService = new Map(defaults.map((grant) => [grant.service, grant]));
  for (const override of overrides ?? []) {
    byService.set(override.service, override);
  }
  return [...byService.values()].toSorted((left, right) =>
    left.service.localeCompare(right.service),
  );
}

type PaperTimelinePlanItem = {
  step: AdminBotPaperStep;
  label: string;
  dependency_group: AdminBotPaperTimeline["items"][number]["dependency_group"];
  duration_business_days: number;
  color: string;
  /**
   * Steps that must finish first. The paper flow is not a single line: slides branch off the
   * submission and run alongside the arXiv/announcement chain, so this is a graph rather than the
   * plan's array order. Scheduling walks these edges; the array order only defines step identity.
   */
  depends_on: readonly AdminBotPaperStep[];
};

const PAPER_TIMELINE_PLAN = [
  {
    step: "brainstorming_docs",
    label: "Brainstorming docs",
    dependency_group: "ideation",
    duration_business_days: 2,
    color: "#64748b",
    depends_on: [],
  },
  {
    step: "overleaf_writing",
    label: "Overleaf writing",
    dependency_group: "writing",
    duration_business_days: 5,
    color: "#2563eb",
    depends_on: ["brainstorming_docs"],
  },
  {
    step: "submission",
    label: "Submission",
    dependency_group: "submission",
    duration_business_days: 1,
    color: "#7c3aed",
    depends_on: ["overleaf_writing"],
  },
  {
    step: "google_drive_pdf",
    label: "Drive PDF",
    dependency_group: "release",
    duration_business_days: 1,
    color: "#0891b2",
    depends_on: ["submission"],
  },
  {
    step: "arxiv_polish",
    label: "arXiv polish",
    dependency_group: "release",
    duration_business_days: 2,
    color: "#0f766e",
    depends_on: ["google_drive_pdf"],
  },
  {
    step: "social_posts",
    label: "Announcements",
    dependency_group: "outreach",
    duration_business_days: 1,
    color: "#db2777",
    depends_on: ["arxiv_polish"],
  },
  {
    step: "slide_making",
    label: "Slides",
    dependency_group: "materials",
    duration_business_days: 2,
    color: "#d97706",
    depends_on: ["submission"],
  },
  {
    step: "poster_making",
    label: "Poster",
    dependency_group: "materials",
    duration_business_days: 2,
    color: "#16a34a",
    depends_on: ["slide_making"],
  },
] as const satisfies readonly PaperTimelinePlanItem[];

function withPaperTimeline(paper: AdminBotPaperRecord): AdminBotPaperRecord {
  return {
    ...paper,
    timeline: buildPaperTimeline(paper),
  };
}

function buildPaperTimeline(
  paper: Pick<AdminBotPaperRecord, "current_step" | "reminder">,
): AdminBotPaperTimeline {
  const currentStepIndex = Math.max(
    0,
    PAPER_TIMELINE_PLAN.findIndex((item) => item.step === paper.current_step),
  );
  // Work in the plan, used for progress. This is the sum of every step's estimate and is not the
  // same as the schedule length below: parallel branches take calendar time off the schedule
  // without taking work off the paper.
  const totalWorkBusinessDays = PAPER_TIMELINE_PLAN.reduce(
    (total, item) => total + item.duration_business_days,
    0,
  );
  const complete = paper.reminder?.status === "complete";
  const blocked = paper.reminder?.status === "blocked";

  // Earliest start per step = latest finish among its dependencies (longest path). The plan is
  // ordered so every step appears after its dependencies, so one forward pass is enough.
  const finishByStep = new Map<AdminBotPaperStep, number>();
  const items = PAPER_TIMELINE_PLAN.map((item, index) => {
    const start = item.depends_on.reduce(
      (latest, dependency) => Math.max(latest, finishByStep.get(dependency) ?? 0),
      0,
    );
    const end = start + item.duration_business_days;
    finishByStep.set(item.step, end);
    return {
      step: item.step,
      label: item.label,
      dependency_group: item.dependency_group,
      depends_on: [...item.depends_on],
      status: timelineStatus(index, currentStepIndex, complete, blocked),
      offset_start_business_day: start,
      offset_end_business_day: end,
      duration_business_days: item.duration_business_days,
      color: item.color,
    };
  });
  // Schedule length is the critical path, which is what a Gantt axis spans.
  const scheduleBusinessDays = Math.max(1, ...items.map((item) => item.offset_end_business_day));
  const completedWorkBusinessDays = complete
    ? totalWorkBusinessDays
    : PAPER_TIMELINE_PLAN.slice(0, currentStepIndex).reduce(
        (total, item) => total + item.duration_business_days,
        0,
      );
  return {
    progress_percent: Math.round((completedWorkBusinessDays / totalWorkBusinessDays) * 100),
    current_step_index: currentStepIndex,
    total_estimated_business_days: scheduleBusinessDays,
    items,
  };
}

function timelineStatus(
  index: number,
  currentStepIndex: number,
  complete: boolean,
  blocked: boolean,
): AdminBotPaperTimeline["items"][number]["status"] {
  if (complete || index < currentStepIndex) {
    return "complete";
  }
  if (index === currentStepIndex) {
    return blocked ? "blocked" : "current";
  }
  return "upcoming";
}
function duePaperNudges(paper: AdminBotPaperRecord, nowIso: string): AdminBotPaperNudge[] {
  const reminder = paper.reminder;
  if (reminder?.status !== "waiting_on_authors") {
    return [];
  }
  if (reminder.last_author_dm_at && replyAfterLastDm(reminder)) {
    return [];
  }
  const escalationBusinessDays = reminder.escalation_after_business_days ?? 3;
  const elapsedBusinessDays = reminder.last_author_dm_at
    ? countBusinessDays(reminder.last_author_dm_at, nowIso)
    : 0;
  if (
    reminder.last_author_dm_at &&
    elapsedBusinessDays >= escalationBusinessDays &&
    reminder.head_professor_member_id
  ) {
    return [
      {
        type: "head_professor_escalation",
        paper_id: paper.id,
        title: paper.title,
        step: paper.current_step,
        recipients: [reminder.head_professor_member_id],
        business_days_since_author_dm: elapsedBusinessDays,
        message:
          `Authors have not replied for ${elapsedBusinessDays} business days. ` +
          `Ask the head professor to remind them about ${paper.current_step}.`,
        ...(paper.timeline ? { timeline: paper.timeline } : {}),
      },
    ];
  }
  if (reminder.next_nudge_at && reminder.next_nudge_at > nowIso) {
    return [];
  }
  return [
    {
      type: "author_nudge",
      paper_id: paper.id,
      title: paper.title,
      step: paper.current_step,
      recipients: paper.authors,
      message: `Remind authors to complete ${paper.current_step} for "${paper.title}".`,
      ...(paper.timeline ? { timeline: paper.timeline } : {}),
    },
  ];
}

function replyAfterLastDm(reminder: { last_author_dm_at?: string; last_author_reply_at?: string }) {
  return Boolean(
    reminder.last_author_dm_at &&
    reminder.last_author_reply_at &&
    reminder.last_author_reply_at > reminder.last_author_dm_at,
  );
}

function normalizeSlackChannelName(value: string): string {
  return value
    .trim()
    .replace(/^#/u, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/(^-|-$)/gu, "");
}

function evaluateSlackChannelName(params: {
  channelName: string;
  purpose?: string;
  topic?: string;
}): { valid: boolean; expectedPrefix: SlackChannelNamingPrefix; suggestedName: string } {
  const normalized = normalizeSlackChannelName(params.channelName);
  const valid = SLACK_CHANNEL_NAME_RE.test(normalized);
  const expectedPrefix = inferSlackChannelPrefix({
    channelName: normalized,
    purpose: params.purpose,
    topic: params.topic,
  });
  const remainder = SLACK_CHANNEL_NAME_ALLOWED_PREFIXES.some((prefix) =>
    normalized.startsWith(`${prefix}-`),
  )
    ? normalized.replace(/^[a-z]+-/u, "")
    : normalized;
  const base = remainder || "untitled";
  const suggestedName = `${expectedPrefix}-${base}`
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-");
  return {
    valid,
    expectedPrefix,
    suggestedName: SLACK_CHANNEL_NAME_RE.test(suggestedName)
      ? suggestedName
      : `${expectedPrefix}-channel`,
  };
}

function inferSlackChannelPrefix(params: {
  channelName: string;
  purpose?: string;
  topic?: string;
}): SlackChannelNamingPrefix {
  const basis = [params.channelName, params.purpose, params.topic]
    .map((part) => part?.toLowerCase() ?? "")
    .join(" ");
  if (/\b(student|students|phd|master|msc|undergrad)\b/u.test(basis)) {
    return "students";
  }
  if (/\b(meeting|sync|standup|seminar|reading)\b/u.test(basis)) {
    return "meeting";
  }
  if (/\b(group|toronto|location|cohort|team)\b/u.test(basis)) {
    return "group";
  }
  if (/\b(lab|logistics|question|opportunit|lunch)\b/u.test(basis)) {
    return "lab";
  }
  if (/\b(food|music|sport|social|fun|casual)\b/u.test(basis)) {
    return "etc";
  }
  return "proj";
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function countBusinessDays(startIso: string, endIso: string): number {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    return 0;
  }
  let days = 0;
  const oneDayMs = 24 * 60 * 60 * 1000;
  const startDay = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  for (let dayMs = startDay + oneDayMs; dayMs <= endDay; dayMs += oneDayMs) {
    const cursor = new Date(dayMs);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) {
      days += 1;
    }
  }
  return days;
}

function hasApproval(
  approvals: AdminBotApprovalRequest[],
  request: AdminBotApprovalRequest,
): boolean {
  return approvals.some(
    (approval) =>
      approval.payload_hash === request.payload_hash &&
      approverIdentity(approval) === approverIdentity(request),
  );
}

// The approver's member id is the identity; the role is only the permission that let them in.
// Falling back to the role keeps pre-identity audit rows countable as one approver.
function approverIdentity(approval: AdminBotApprovalRequest): string {
  return approval.approver_id?.trim() || `role:${approval.approver_role}`;
}

function distinctApprovers(approvals: AdminBotApprovalRequest[]): number {
  return new Set(approvals.map(approverIdentity)).size;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortForStableJson(value));
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForStableJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, sortForStableJson(entryValue)]),
  );
}

function retentionCutoffIso(retentionDays: number): string {
  return new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
}

/** A member the audit window has nothing for. Shared so every such row is the same object shape. */
const EMPTY_ACTIVITY: AdminBotMemberActivityCounts = {
  logins: 0,
  profile_edits: 0,
  paper_updates: 0,
};

/**
 * Somebody the lab would still chase about their own record.
 *
 * Two fields, because the lab writes "has left" in two places and they do not agree. `status` is
 * AdminBot's own flag, set by an admin on the member page. `member_type` is the spreadsheet's
 * Member Type column, imported verbatim, and it is the one the lab actually maintains -- on the
 * current roster 22 people are alumni there while only 2 carry `status: "alumni"`, and not one
 * person has both. Reading `status` alone left all 22 in every sweep and in the adoption columns,
 * which is a reminder to somebody who left months ago.
 *
 * Either saying alumni is enough. The failure this guards against is chasing a person who has
 * gone, and neither field is authoritative enough to override the other.
 */
function isActiveRosterMember(member: AdminBotLabMember): boolean {
  if (member.status === "alumni" || member.status === "external") {
    return false;
  }
  return !adminBotIsAlumniType(member.member_type);
}

/** See bulkMemberWriteSeconds. Distinct members written in one second before it reads as a sync. */
const BULK_MEMBER_WRITE_THRESHOLD = 5;
