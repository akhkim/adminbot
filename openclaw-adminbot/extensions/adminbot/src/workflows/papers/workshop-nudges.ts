// Paper-to-workshop recommendations and exact, server-generated nudge messages.
//
// Matching stays pure: the native AdminBot adapter below normalizes current records in memory,
// while the API owns the administrator gate and delivery. A recommendation can therefore never
// become a Slack message merely because matching succeeded.

import type { Embedder } from "../../connectors/embeddings.js";
import {
  isAdminBotFullMember,
  type AdminBotLabMember,
  type AdminBotPaperRecord,
} from "../../contracts/actions.js";
import type { AdminBotConferenceAttendeeRecord } from "../../contracts/paper-cycle.js";
import {
  ABSOLUTE_FLOOR,
  RELATIVE_MARGIN,
  cosineSimilarity,
  interestsEmbeddingText,
  interestTerms,
  overlappingKeywords,
} from "./venue-relevance.js";

export type CrossSubmissionStatus = "allowed" | "prohibited" | "unclear";
export type WorkshopArchivalStatus = "archival" | "non_archival" | "mixed" | "unknown";

export type WorkshopRoute = {
  deadline_id: string;
  label: string;
  submission_type: string;
  deadline_aoe: string;
  source_url: string;
};

export type WorkshopProfile = {
  workshop_id: string;
  name: string;
  parent_conference_key: string;
  parent_conference: string;
  conference_location: string;
  topics: string[];
  topic_evidence: string;
  routes: WorkshopRoute[];
  archival_status: WorkshopArchivalStatus;
  cross_submission_status: CrossSubmissionStatus;
  cross_submission_evidence: string;
  cross_submission_source_url: string;
  profile_extracted_at: string;
};

export type WorkshopNudgePaper = {
  paper_id: string;
  title: string;
  year?: number;
  current_submission_state?: string;
  topic_summary?: string;
  lab_author_names: string[];
  recipient_member_id?: string;
  recipient_display_name?: string;
  publication_sources: string[];
};

export type WorkshopAttendance = {
  member_id: string;
  parent_conference_key: string;
  attendance_likelihood?: number;
  source: string;
  last_confirmed_at: string;
};

export type WorkshopRecommendationPaper = Pick<WorkshopNudgePaper, "paper_id" | "title"> &
  Partial<
    Pick<
      WorkshopNudgePaper,
      "year" | "current_submission_state" | "recipient_member_id" | "recipient_display_name"
    >
  > & {
    publication_sources: string[];
  };

export type WorkshopRecommendation = {
  pair_id: string;
  paper: WorkshopRecommendationPaper;
  workshop: WorkshopProfile;
  semantic_score: number;
  topic_relevance: number;
  topic_evidence: string[];
  attendance?: WorkshopAttendance;
  rank_explanation: string;
  final_rank?: number;
  draftable: boolean;
  draft_fragment?: string;
};

export type WorkshopRecipientRecommendations = {
  recipient_member_id: string;
  recipient_display_name?: string;
  recommendations: WorkshopRecommendation[];
  draft: WorkshopNudgeDraft | null;
};

export type WorkshopNudgeDraft = {
  recipient_member_id: string;
  recipient_display_name?: string;
  pair_ids: string[];
  text: string;
  recommendations: WorkshopRecommendation[];
};

export type WorkshopNudgeResult = {
  generated_at: string;
  paper_count: number;
  workshop_count: number;
  recipients: WorkshopRecipientRecommendations[];
  unresolved_recipients: Array<{
    paper: WorkshopRecommendationPaper;
    recommendations: WorkshopRecommendation[];
  }>;
  excluded_by_submission_rules: WorkshopRecommendation[];
};

export type WorkshopNudgeCoverage = {
  members_without_usable_papers: Array<{ member_id: string; name: string }>;
  papers_with_unresolved_authors: Array<{
    paper_id: string;
    title: string;
    author_names: string[];
  }>;
  papers_without_active_recipients: Array<{ paper_id: string; title: string }>;
};

export type WorkshopNudgeNativeInputs = {
  papers: WorkshopNudgePaper[];
  attendance: WorkshopAttendance[];
  coverage: WorkshopNudgeCoverage;
};

export type DeadlineWorkshopRecord = {
  id: string;
  deadline_id?: string;
  venue_id?: string;
  name: string;
  entry_type?: string;
  venue_type?: string;
  venue_group: string;
  venue_family?: string;
  deadline_label: string;
  deadline_aoe: string;
  submission_type?: string;
  source_url?: string;
  cfp_url?: string;
  homepage_url?: string;
  topic_profile?: readonly string[];
  topic_evidence?: string;
  archival_status?: string;
  cross_submission_status?: string;
  cross_submission_evidence?: string;
  cross_submission_source_url?: string;
  profile_extracted_at?: string;
  parent_conference_key?: string;
  conference_location?: string;
};

/** Normalizes the native paper store without exposing its rows to the browser. */
export function workshopNudgeInputsFromAdminBot(params: {
  papers: readonly AdminBotPaperRecord[];
  members: readonly AdminBotLabMember[];
  attendees: readonly AdminBotConferenceAttendeeRecord[];
  workshops: readonly WorkshopProfile[];
}): WorkshopNudgeNativeInputs {
  const activeMembers = params.members.filter(
    (member) =>
      isAdminBotFullMember(member) && member.status !== "alumni" && member.status !== "external",
  );
  const membersById = new Map(activeMembers.map((member) => [member.id, member]));
  const paperIdsByMember = new Map<string, Set<string>>();
  const normalized: WorkshopNudgePaper[] = [];
  const unresolvedAuthors: WorkshopNudgeCoverage["papers_with_unresolved_authors"] = [];
  const papersWithoutRecipients: WorkshopNudgeCoverage["papers_without_active_recipients"] = [];

  for (const paper of [...params.papers].toSorted((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const unresolvedNames = (paper.author_links ?? [])
      .filter((author) => !author.member_id && !author.email)
      .map((author) => author.name.trim())
      .filter(Boolean);
    if (unresolvedNames.length) {
      unresolvedAuthors.push({
        paper_id: paper.id,
        title: paper.title,
        author_names: unique(unresolvedNames),
      });
    }

    const recipientIds = unique([
      ...(paper.author_links ?? []).flatMap((author) =>
        author.member_id ? [author.member_id] : [],
      ),
      ...(paper.first_author_member_id ? [paper.first_author_member_id] : []),
      ...(paper.submitted_by_member_id ? [paper.submitted_by_member_id] : []),
    ]).filter((memberId) => membersById.has(memberId));
    if (!recipientIds.length) {
      normalized.push(workshopPaperFromAdminBot(paper));
      papersWithoutRecipients.push({ paper_id: paper.id, title: paper.title });
      continue;
    }
    for (const memberId of recipientIds) {
      const member = membersById.get(memberId) as AdminBotLabMember;
      normalized.push(workshopPaperFromAdminBot(paper, member));
      const ids = paperIdsByMember.get(memberId) ?? new Set<string>();
      ids.add(paper.id);
      paperIdsByMember.set(memberId, ids);
    }
  }

  return {
    papers: normalized,
    attendance: attendanceFromAdminBot(params.attendees, params.papers, params.workshops),
    coverage: {
      members_without_usable_papers: activeMembers
        .filter((member) => !paperIdsByMember.has(member.id))
        .map((member) => ({ member_id: member.id, name: member.name }))
        .toSorted((left, right) => left.name.localeCompare(right.name)),
      papers_with_unresolved_authors: unresolvedAuthors,
      papers_without_active_recipients: papersWithoutRecipients,
    },
  };
}

export function workshopProfilesFromDeadlines(
  records: readonly DeadlineWorkshopRecord[],
  now = new Date(),
): WorkshopProfile[] {
  const grouped = new Map<string, DeadlineWorkshopRecord[]>();
  for (const record of records) {
    if (
      (record.entry_type !== "workshop" && record.venue_type !== "workshop") ||
      aoeInstant(record.deadline_aoe) <= now.getTime()
    ) {
      continue;
    }
    const id = record.venue_id?.trim() || record.id;
    grouped.set(id, [...(grouped.get(id) ?? []), record]);
  }
  return [...grouped.entries()]
    .map(([workshopId, entries]) => {
      const ordered = entries.toSorted(
        (left, right) =>
          left.deadline_aoe.localeCompare(right.deadline_aoe) || left.id.localeCompare(right.id),
      );
      const first = ordered[0] as DeadlineWorkshopRecord;
      const topics = unique(
        ordered
          .flatMap((entry) => [...(entry.topic_profile ?? [])])
          .map(cleanTopicEvidence)
          .filter(Boolean),
      );
      return {
        workshop_id: workshopId,
        name: cleanWorkshopName(first.name),
        parent_conference_key:
          first.parent_conference_key?.trim() || parentKey(first.venue_family, first.venue_group),
        parent_conference: first.venue_group.replace(/\s+Workshops$/iu, ""),
        conference_location: first.conference_location?.trim() || "Location not recorded",
        topics: topics.length ? topics : [cleanWorkshopName(first.name)],
        topic_evidence: first.topic_evidence?.trim() || "Workshop title from its official listing.",
        routes: ordered.map((entry) => ({
          deadline_id: entry.deadline_id?.trim() || entry.id,
          label: entry.deadline_label,
          submission_type:
            entry.submission_type?.trim() ||
            (/commitment/iu.test(entry.deadline_label) ? "commitment" : "direct"),
          deadline_aoe: entry.deadline_aoe,
          source_url:
            entry.cfp_url?.trim() || entry.source_url?.trim() || entry.homepage_url?.trim() || "",
        })),
        archival_status: workshopArchivalStatus(first.archival_status),
        cross_submission_status: crossSubmissionStatus(first.cross_submission_status),
        cross_submission_evidence:
          first.cross_submission_evidence?.trim() ||
          "The collected call for papers does not state a cross-submission rule.",
        cross_submission_source_url:
          first.cross_submission_source_url?.trim() ||
          first.cfp_url?.trim() ||
          first.source_url?.trim() ||
          "",
        profile_extracted_at: first.profile_extracted_at?.trim() || "Not recorded",
      } satisfies WorkshopProfile;
    })
    .toSorted(
      (left, right) =>
        left.routes[0]!.deadline_aoe.localeCompare(right.routes[0]!.deadline_aoe) ||
        left.name.localeCompare(right.name),
    );
}

export async function matchWorkshopNudges(params: {
  papers: readonly WorkshopNudgePaper[];
  workshops: readonly WorkshopProfile[];
  attendance?: readonly WorkshopAttendance[];
  embed: Embedder;
  now?: Date;
}): Promise<WorkshopNudgeResult> {
  const papers = [...params.papers].toSorted((left, right) =>
    left.paper_id.localeCompare(right.paper_id),
  );
  const workshops = [...params.workshops];
  const texts = [...papers.map(paperEmbeddingText), ...workshops.map(workshopEmbeddingText)];
  const vectors = texts.length ? await params.embed(texts) : [];
  if (vectors.length !== texts.length) {
    throw new Error(`embedded ${vectors.length} records for ${texts.length} paper/workshop texts`);
  }
  const paperVectors = vectors.slice(0, papers.length);
  const workshopVectors = vectors.slice(papers.length);
  const attendance = new Map(
    (params.attendance ?? []).map((entry) => [
      attendanceKey(entry.member_id, entry.parent_conference_key),
      entry,
    ]),
  );
  const supported: WorkshopRecommendation[] = [];
  for (const [paperIndex, paper] of papers.entries()) {
    const scored = workshops
      .map((workshop, workshopIndex) => ({
        workshop,
        score: cosineSimilarity(
          paperVectors[paperIndex] ?? [],
          workshopVectors[workshopIndex] ?? [],
        ),
      }))
      .toSorted(
        (left, right) =>
          right.score - left.score ||
          left.workshop.workshop_id.localeCompare(right.workshop.workshop_id),
      );
    const best = scored[0]?.score ?? 0;
    if (best < ABSOLUTE_FLOOR) {
      continue;
    }
    const median = scored[Math.floor(scored.length / 2)]?.score ?? 0;
    const spread = best - median;
    const cutoff = median + RELATIVE_MARGIN * spread;
    const terms = interestTerms(`${paper.title}, ${paper.topic_summary ?? ""}`);
    for (const entry of scored.filter((candidate) => candidate.score >= cutoff)) {
      const relevance = spread > 0 ? clamp((entry.score - median) / spread) : 1;
      const travel = paper.recipient_member_id
        ? attendance.get(
            attendanceKey(paper.recipient_member_id, entry.workshop.parent_conference_key),
          )
        : undefined;
      const evidence = recommendationTopicEvidence(entry.workshop.topics, terms);
      const pairId = `${paper.paper_id}::${entry.workshop.workshop_id}`;
      const recommendation: WorkshopRecommendation = {
        pair_id: pairId,
        paper: recommendationPaper(paper),
        workshop: entry.workshop,
        semantic_score: entry.score,
        topic_relevance: relevance,
        topic_evidence: evidence,
        ...(travel ? { attendance: travel } : {}),
        rank_explanation: rankExplanation(relevance, travel, entry.workshop.parent_conference),
        draftable: entry.workshop.cross_submission_status === "allowed",
      };
      if (recommendation.draftable) {
        recommendation.draft_fragment = draftFragment(recommendation);
      }
      supported.push(recommendation);
    }
  }

  const excluded = supported
    .filter((entry) => entry.workshop.cross_submission_status === "prohibited")
    .toSorted(recommendationOrder);
  const eligible = supported.filter(
    (entry) => entry.workshop.cross_submission_status !== "prohibited",
  );
  const resolved = new Map<string, WorkshopRecommendation[]>();
  const unresolved = new Map<string, WorkshopRecommendation[]>();
  for (const recommendation of eligible) {
    const memberId = recommendation.paper.recipient_member_id;
    const target = memberId ? resolved : unresolved;
    const key = memberId || recommendation.paper.paper_id;
    target.set(key, [...(target.get(key) ?? []), recommendation]);
  }

  const recipients = [...resolved.entries()]
    .map(([memberId, recommendations]) => {
      const ranked = rankUpToThreeWorkshops(recommendations);
      const displayName = ranked.find((entry) => entry.paper.recipient_display_name)?.paper
        .recipient_display_name;
      const draftable = ranked.filter((entry) => entry.draftable);
      return {
        recipient_member_id: memberId,
        ...(displayName ? { recipient_display_name: displayName } : {}),
        recommendations: ranked,
        draft: draftable.length ? buildWorkshopNudgeDraft(memberId, displayName, draftable) : null,
      } satisfies WorkshopRecipientRecommendations;
    })
    .toSorted((left, right) => left.recipient_member_id.localeCompare(right.recipient_member_id));

  return {
    generated_at: (params.now ?? new Date()).toISOString(),
    paper_count: papers.length,
    workshop_count: workshops.length,
    recipients,
    unresolved_recipients: [...unresolved.entries()]
      .map(([paperId, recommendations]) => ({
        paper: recommendationPaper(
          papers.find((paper) => paper.paper_id === paperId) as WorkshopNudgePaper,
        ),
        recommendations: rankUpToThreeWorkshops(recommendations),
      }))
      .toSorted((left, right) => left.paper.paper_id.localeCompare(right.paper.paper_id)),
    excluded_by_submission_rules: excluded,
  };
}

export function buildWorkshopNudgeDraft(
  memberId: string,
  displayName: string | undefined,
  recommendations: readonly WorkshopRecommendation[],
): WorkshopNudgeDraft {
  const allowed = recommendations.filter((entry) => entry.draftable && entry.draft_fragment);
  if (!allowed.length) {
    throw new Error("a workshop nudge draft needs at least one allowed recommendation");
  }
  const greeting = displayName?.trim() ? `Hi ${displayName.trim()} —` : "Hi —";
  const byWorkshop = new Map<string, WorkshopRecommendation[]>();
  for (const recommendation of allowed) {
    const workshopId = recommendation.workshop.workshop_id;
    byWorkshop.set(workshopId, [...(byWorkshop.get(workshopId) ?? []), recommendation]);
  }
  return {
    recipient_member_id: memberId,
    ...(displayName?.trim() ? { recipient_display_name: displayName.trim() } : {}),
    pair_ids: allowed.map((entry) => entry.pair_id),
    recommendations: allowed,
    text: [
      `${greeting} these workshops may fit your papers:`,
      "",
      ...[...byWorkshop.values()].flatMap((entries) => [draftWorkshopFragment(entries), ""]),
      "Please check the calls and submission rules before deciding whether to submit.",
    ]
      .join("\n")
      .trim(),
  };
}

function rankUpToThreeWorkshops(
  recommendations: readonly WorkshopRecommendation[],
): WorkshopRecommendation[] {
  const ranked = recommendations.toSorted(recommendationOrder);
  const workshopRanks = new Map<string, number>();
  for (const recommendation of ranked) {
    const workshopId = recommendation.workshop.workshop_id;
    if (!workshopRanks.has(workshopId) && workshopRanks.size < 3) {
      workshopRanks.set(workshopId, workshopRanks.size + 1);
    }
  }
  return ranked
    .filter((recommendation) => workshopRanks.has(recommendation.workshop.workshop_id))
    .map((recommendation) => ({
      ...recommendation,
      final_rank: workshopRanks.get(recommendation.workshop.workshop_id),
    }));
}

function workshopPaperFromAdminBot(
  paper: AdminBotPaperRecord,
  recipient?: AdminBotLabMember,
): WorkshopNudgePaper {
  const notesSource = noteValue(paper.notes, "Source");
  const year =
    paper.accepted_year ??
    numericYear(noteValue(paper.notes, "Year")) ??
    numericYear(paper.accepted_venue) ??
    numericYear(paper.venue);
  const submissionState = [
    paper.venue_decision ?? noteValue(paper.notes, "Status"),
    paper.accepted_venue ?? paper.venue ?? noteValue(paper.notes, "Venue"),
  ]
    .filter(Boolean)
    .join(": ");
  return {
    paper_id: paper.id,
    title: paper.title,
    ...(year ? { year } : {}),
    current_submission_state: submissionState || paper.current_step.replaceAll("_", " "),
    ...(noteValue(paper.notes, "Topic") ? { topic_summary: noteValue(paper.notes, "Topic") } : {}),
    lab_author_names: unique(
      (paper.author_links ?? [])
        .filter((author) => Boolean(author.member_id))
        .map((author) => author.name),
    ),
    ...(recipient
      ? { recipient_member_id: recipient.id, recipient_display_name: recipient.name }
      : {}),
    publication_sources: unique(["AdminBot paper store", ...(notesSource ? [notesSource] : [])]),
  };
}

function attendanceFromAdminBot(
  attendees: readonly AdminBotConferenceAttendeeRecord[],
  papers: readonly AdminBotPaperRecord[],
  workshops: readonly WorkshopProfile[],
): WorkshopAttendance[] {
  const papersById = new Map(papers.map((paper) => [paper.id, paper]));
  const byMemberAndConference = new Map<string, WorkshopAttendance>();
  for (const attendee of attendees) {
    if (!attendee.member_id) {
      continue;
    }
    const paper = papersById.get(attendee.paper_id);
    const parentConferenceKey = paper ? parentConferenceKeyForPaper(paper, workshops) : undefined;
    if (!paper || !parentConferenceKey) {
      continue;
    }
    const entry: WorkshopAttendance = {
      member_id: attendee.member_id,
      parent_conference_key: parentConferenceKey,
      ...(attendee.attending === "yes"
        ? { attendance_likelihood: 100 }
        : attendee.attending === "no"
          ? { attendance_likelihood: 0 }
          : {}),
      source: `AdminBot attendance record for “${paper.title}”`,
      last_confirmed_at: attendee.confirmed_at ?? paper.updated_at,
    };
    const key = attendanceKey(entry.member_id, entry.parent_conference_key);
    const previous = byMemberAndConference.get(key);
    if (!previous || preferredAttendance(entry, previous)) {
      byMemberAndConference.set(key, entry);
    }
  }
  return [...byMemberAndConference.values()].toSorted(
    (left, right) =>
      left.member_id.localeCompare(right.member_id) ||
      left.parent_conference_key.localeCompare(right.parent_conference_key),
  );
}

function preferredAttendance(candidate: WorkshopAttendance, current: WorkshopAttendance): boolean {
  const candidateExplicit = candidate.attendance_likelihood !== undefined;
  const currentExplicit = current.attendance_likelihood !== undefined;
  return (
    (candidateExplicit && !currentExplicit) ||
    (candidateExplicit === currentExplicit &&
      candidate.last_confirmed_at.localeCompare(current.last_confirmed_at) > 0)
  );
}

function parentConferenceKeyForPaper(
  paper: AdminBotPaperRecord,
  workshops: readonly WorkshopProfile[],
): string | undefined {
  const venue = paper.accepted_venue ?? paper.venue ?? noteValue(paper.notes, "Venue");
  if (!venue) {
    return undefined;
  }
  const year =
    paper.accepted_year ?? numericYear(venue) ?? numericYear(noteValue(paper.notes, "Year"));
  const venueKey = normalizedConferenceName(venue);
  const candidates = unique(workshops.map((workshop) => workshop.parent_conference_key))
    .map((key) => workshops.find((workshop) => workshop.parent_conference_key === key)!)
    .filter((workshop) => !year || workshop.parent_conference_key.endsWith(`-${year}`))
    .filter((workshop) => {
      const family = workshop.parent_conference_key.replace(/-20\d{2}$/u, "");
      const label = normalizedConferenceName(workshop.parent_conference);
      return venueKey === family || venueKey === label || label.includes(venueKey);
    });
  return candidates.length === 1 ? candidates[0]?.parent_conference_key : undefined;
}

function normalizedConferenceName(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/\b20\d{2}\b/gu, "")
    .replace(/\b(?:conference|workshops?|annual meeting)\b/gu, "")
    .replace(/[^a-z0-9]+/gu, "")
    .trim();
}

function noteValue(notes: string | undefined, label: string): string | undefined {
  const prefix = `${label.toLocaleLowerCase()}:`;
  return notes
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.toLocaleLowerCase().startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}

function numericYear(value: string | undefined): number | undefined {
  const matched = value ? /\b(20\d{2})\b/u.exec(value)?.[1] : undefined;
  return matched ? Number(matched) : undefined;
}

function recommendationOrder(left: WorkshopRecommendation, right: WorkshopRecommendation): number {
  // Attendance only decides between matches shown at the same semantic percentage. It therefore
  // cannot create or rescue a topic match, and an unknown likelihood receives no invented credit.
  const leftPercent = Math.round(left.topic_relevance * 100);
  const rightPercent = Math.round(right.topic_relevance * 100);
  return (
    rightPercent - leftPercent ||
    attendanceBenefit(right.attendance) - attendanceBenefit(left.attendance) ||
    right.semantic_score - left.semantic_score ||
    left.workshop.routes[0]!.deadline_aoe.localeCompare(right.workshop.routes[0]!.deadline_aoe) ||
    left.paper.paper_id.localeCompare(right.paper.paper_id) ||
    left.workshop.workshop_id.localeCompare(right.workshop.workshop_id)
  );
}

function rankExplanation(
  relevance: number,
  attendance: WorkshopAttendance | undefined,
  parent: string,
): string {
  const topic = `${Math.round(relevance * 100)}% relative semantic match among the workshop profiles`;
  if (attendance?.attendance_likelihood !== undefined) {
    return `${topic}. Recorded attendance likelihood for ${parent}: ${attendance.attendance_likelihood}%. Attendance only orders equally strong topic matches.`;
  }
  return `${topic}. Attendance for ${parent} is unknown and did not affect the order.`;
}

function draftFragment(recommendation: WorkshopRecommendation): string {
  const route = recommendation.workshop.routes[0] as WorkshopRoute;
  return `• “${recommendation.paper.title}” → ${recommendation.workshop.name}\n  ${sentenceLabel(route.label)}: ${formatAoeDateTime(route.deadline_aoe)} · ${recommendation.topic_evidence.join(", ")}`;
}

function draftWorkshopFragment(recommendations: readonly WorkshopRecommendation[]): string {
  const first = recommendations[0] as WorkshopRecommendation;
  const route = first.workshop.routes[0] as WorkshopRoute;
  const papers = recommendations.map((entry) => `“${entry.paper.title}”`).join("; ");
  const evidence = unique(recommendations.flatMap((entry) => entry.topic_evidence)).slice(0, 3);
  return `• ${first.workshop.name}\n  ${recommendations.length === 1 ? "Paper" : "Papers"}: ${papers}\n  ${sentenceLabel(route.label)}: ${formatAoeDateTime(route.deadline_aoe)} · ${evidence.join(", ")}`;
}

function paperEmbeddingText(paper: WorkshopNudgePaper): string {
  const summary = paper.topic_summary?.trim();
  return interestsEmbeddingText(`${paper.title}${summary ? `. ${summary}` : ""}`);
}

function recommendationPaper(paper: WorkshopNudgePaper): WorkshopRecommendationPaper {
  return {
    paper_id: paper.paper_id,
    title: paper.title,
    ...(paper.year === undefined ? {} : { year: paper.year }),
    ...(paper.current_submission_state
      ? { current_submission_state: paper.current_submission_state }
      : {}),
    ...(paper.recipient_member_id ? { recipient_member_id: paper.recipient_member_id } : {}),
    ...(paper.recipient_display_name
      ? { recipient_display_name: paper.recipient_display_name }
      : {}),
    publication_sources: [...paper.publication_sources],
  };
}

function recommendationTopicEvidence(
  topics: readonly string[],
  terms: readonly string[],
): string[] {
  const matches = overlappingKeywords(topics, terms);
  return (matches.length ? matches : topics)
    .map(cleanTopicEvidence)
    .filter(Boolean)
    .toSorted((left, right) => left.length - right.length || left.localeCompare(right))
    .slice(0, 3)
    .map((value) => (value.length <= 140 ? value : `${value.slice(0, 139).trimEnd()}…`));
}

function workshopEmbeddingText(workshop: WorkshopProfile): string {
  return `title: ${workshop.name} | text: Topics: ${workshop.topics.join("; ")}. ${workshop.topic_evidence}`;
}

function attendanceKey(memberId: string, parentKeyValue: string): string {
  return `${memberId}\u0000${parentKeyValue}`;
}

function attendanceBenefit(attendance: WorkshopAttendance | undefined): number {
  return attendance?.attendance_likelihood ?? 0;
}

function crossSubmissionStatus(value: string | undefined): CrossSubmissionStatus {
  return value === "allowed" || value === "prohibited" ? value : "unclear";
}

function workshopArchivalStatus(value: string | undefined): WorkshopArchivalStatus {
  return value === "archival" || value === "non_archival" || value === "mixed" ? value : "unknown";
}

function cleanWorkshopName(value: string): string {
  return value
    .replace(/\s+(?:\(|@)\s*(?:ACL|EMNLP|NAACL|EACL|NeurIPS|ICML|ICLR|COLM)\s+20\d{2}\)?\s*$/iu, "")
    .trim();
}

function cleanTopicEvidence(value: string): string {
  let topic = value
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^[,;:.\s]+|[,;:.\s]+$/gu, "");
  if ((topic.match(/\(/gu)?.length ?? 0) !== (topic.match(/\)/gu)?.length ?? 0)) {
    topic = topic.replace(/[()]/gu, "").replace(/\s+/gu, " ").trim();
  }
  return topic;
}

function sentenceLabel(value: string): string {
  const label = value.replaceAll("_", " ").trim();
  return label ? `${label[0]?.toLocaleUpperCase()}${label.slice(1)}` : value;
}

function formatAoeDateTime(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/u.exec(value);
  if (!match) {
    return `${value} AoE`;
  }
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[Number(match[2]) - 1]} ${Number(match[3])}, ${match[1]} · ${match[4]}:${match[5]} AoE`;
}

function parentKey(family: string | undefined, group: string): string {
  const year = /\b(20\d{2})\b/u.exec(group)?.[1] ?? "unknown";
  return `${(family?.trim() || group.replace(/\s+20\d{2}.*$/u, "").trim()).toLowerCase()}-${year}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function aoeInstant(value: string): number {
  return Date.parse(value.replace(" ", "T") + "-12:00");
}
