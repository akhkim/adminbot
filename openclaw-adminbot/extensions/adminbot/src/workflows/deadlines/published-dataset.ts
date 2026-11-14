import {
  validateDeadlineProposalInput,
  type PublishedDeadlineRecord,
} from "../../contracts/deadline-proposals.js";
import { applyStageProposal } from "../../contracts/deadline-proposals.stage.js";

// These published additions now have an official collector source using the same board ID.
const collectorManagedDeadlines = new Set([
  "community_f43e7729-6593-4aed-90fd-fca5ff390806", // ICML 2027
  "community_91ccb05a-8e08-4684-bcbe-aa5b3a53c0fa", // ACL 2027 ARR submission
  "community_9e9c9619-a1ac-41f9-b67e-05dfd81accf5", // CLeaR 2027
  "community_207f3047-46da-4ce9-9805-ccccd048cb56", // COLING 2027 ARR commitment
]);

// Match the collector's known archival main programs. A custom venue or workshop needs evidence.
const archivalConferenceFamilies = new Set([
  "aacl",
  "acl",
  "aistats",
  "clear",
  "colm",
  "coling",
  "eacl",
  "emnlp",
  "iclr",
  "icml",
  "naacl",
  "neurips",
]);

/** Merge the public projection while keeping approved corrections authoritative. */
export function mergePublishedDeadlines(
  generated: readonly unknown[],
  published: PublishedDeadlineRecord[],
): unknown[] {
  const byDeadline = new Map<string, PublishedDeadlineRecord[]>();
  for (const record of published) {
    const records = byDeadline.get(record.deadline_id) ?? [];
    records.push(record);
    byDeadline.set(record.deadline_id, records);
  }
  const merged = new Map(
    generated.map((row) => [(row as Record<string, unknown>).id as string, row]),
  );
  for (const records of byDeadline.values()) {
    const primary = records.filter((record) => !record.deadline.stage?.venueId);
    if (!primary.length) {
      continue;
    }
    const update = publishedDeadlineVenue(primary);
    const original = merged.get(String(update.id)) as Record<string, unknown> | undefined;
    const latest = primary.toSorted(comparePublication).at(-1)!;
    const previous = latest.previous_deadline_aoe;
    const isReviewedChange =
      latest.revision > 1 ||
      (previous && previous.slice(0, 16) !== String(update.deadline_aoe).slice(0, 16));
    if (original && collectorManagedDeadlines.has(latest.deadline_id) && !isReviewedChange) {
      continue;
    }
    merged.set(
      String(update.id),
      original
        ? {
            ...original,
            ...update,
            name: original.name,
            venue_type: original.venue_type,
            venue_group: original.venue_group,
            venue_family: original.venue_family,
            entry_type: original.entry_type,
            track: original.track,
            submission_type: original.submission_type,
            archival_status: original.archival_status,
            archival: original.archival,
            venue_priority: original.venue_priority,
            venue_id: original.venue_id,
            venue_aliases: original.venue_aliases,
            milestone: original.milestone,
            schedule: original.schedule,
            deadline_label: original.deadline_label,
            source_checked_at: original.source_checked_at,
            deadline_source_kind: "manual",
            deadline_source_status: "administrator_approved",
            revisions: [
              ...(Array.isArray(original.revisions) ? original.revisions : []),
              ...(update.revisions as unknown[]),
            ],
          }
        : update,
    );
  }
  for (const record of published.toSorted(comparePublication)) {
    if (!record.deadline.stage?.venueId) {
      continue;
    }
    const target = merged.get(record.deadline_id) as Record<string, unknown> | undefined;
    const validated = validateDeadlineProposalInput(record.deadline);
    // The collector publishes ICML's abstract as a separate, linked deadline.
    // Retire the initial manual stage addition once that row is available.
    if (
      target?.abstract_deadline_id === "icml2027_abstract" &&
      merged.has("icml2027_abstract") &&
      record.deadline.stage.milestone === "abstract" &&
      record.deadline.stage.operation === "add"
    ) {
      if (record.revision > 1 && validated.ok) {
        const abstract = merged.get("icml2027_abstract") as Record<string, unknown>;
        const update = publishedDeadlineVenue([record]);
        merged.set("icml2027_abstract", {
          ...abstract,
          deadline_aoe: update.deadline_aoe,
          deadline_at: update.deadline_at,
          deadline_date: update.deadline_date,
          deadline_timezone: update.deadline_timezone,
          deadline_time_precision: update.deadline_time_precision,
          deadline_source_kind: "manual",
          deadline_source_status: "administrator_approved",
        });
      }
      continue;
    }
    if (target && validated.ok) {
      merged.set(
        record.deadline_id,
        applyStageProposal(target, validated.value, validated.instant),
      );
    }
  }
  return [...merged.values()];
}

function comparePublication(left: PublishedDeadlineRecord, right: PublishedDeadlineRecord): number {
  return left.published_at.localeCompare(right.published_at) || left.revision - right.revision;
}

function publishedDeadlineVenue(records_: PublishedDeadlineRecord[]): Record<string, unknown> {
  const records = records_.toSorted(comparePublication);
  const latest = records.at(-1)!;
  const validated = validateDeadlineProposalInput(latest.deadline);
  if (!validated.ok) {
    throw new Error(`published deadline ${latest.deadline_id} is invalid`);
  }
  const instant = new Date(validated.instant).getTime();
  const aoe = new Date(instant - 12 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
  const entryType = latest.deadline.entryType;
  const family = latest.deadline.parentConference;
  const archival =
    (entryType === "main_conference" ||
      entryType === "arr_commitment" ||
      entryType === "arr_direct_submission") &&
    archivalConferenceFamilies.has(family.toLowerCase());
  const parentGroup =
    [family, latest.deadline.parentYear].filter(Boolean).join(" ") || latest.deadline.name;
  const group =
    entryType === "workshop" && family && !/\bworkshops?$/iu.test(parentGroup)
      ? `${parentGroup} Workshops`
      : parentGroup;
  const label =
    latest.deadline.stage?.label ??
    (entryType === "arr_commitment"
      ? "ARR commitment"
      : entryType === "arr_direct_submission"
        ? "ARR submission"
        : entryType === "rebuttal"
          ? "rebuttal ends"
          : "submission");
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
    archival_status: archival ? "archival" : "unknown",
    venue_priority: "standard",
    archival,
    stale: false,
    milestone:
      latest.deadline.stage?.milestone ??
      (entryType === "arr_commitment"
        ? "commitment"
        : entryType === "rebuttal"
          ? "rebuttal"
          : "direct_submission"),
    schedule: [],
    deadline_label: label,
    deadline_aoe: aoe,
    deadline_at: latest.deadline.deadlineTime ? new Date(instant).toISOString() : "",
    deadline_date: latest.deadline.deadlineDate,
    deadline_timezone: latest.deadline.timezone,
    deadline_time_precision: latest.deadline.deadlineTime ? "exact" : "date_only",
    link: latest.deadline.cfpUrl || latest.deadline.homepageUrl,
    homepage_url: latest.deadline.homepageUrl,
    ...(latest.deadline.cfpUrl ? { cfp_url: latest.deadline.cfpUrl } : {}),
    source_url: latest.deadline.cfpUrl || latest.deadline.homepageUrl,
    source_checked_at: "",
    reviewed_at: latest.published_at,
    ...(latest.deadline.openReviewUrl ? { openreview_url: latest.deadline.openReviewUrl } : {}),
    revisions: records.flatMap((record) => {
      const revision = validateDeadlineProposalInput(record.deadline);
      const revisionInstant = revision.ok ? new Date(revision.instant).getTime() : Number.NaN;
      const current = {
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
      return record.previous_deadline_aoe
        ? [{ ...current, deadline_aoe: record.previous_deadline_aoe }, current]
        : [current];
    }),
  };
}
