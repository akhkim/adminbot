import {
  validateDeadlineProposalInput,
  type PublishedDeadlineRecord,
} from "../../contracts/deadline-proposals.js";

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
    const update = publishedDeadlineVenue(records);
    const original = merged.get(String(update.id)) as Record<string, unknown> | undefined;
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
  return [...merged.values()];
}

function publishedDeadlineVenue(records_: PublishedDeadlineRecord[]): Record<string, unknown> {
  const records = records_.toSorted(
    (left, right) =>
      left.published_at.localeCompare(right.published_at) || left.revision - right.revision,
  );
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
    milestone:
      entryType === "arr_commitment"
        ? "commitment"
        : entryType === "rebuttal"
          ? "rebuttal"
          : "direct_submission",
    schedule: [],
    deadline_label: label,
    deadline_aoe: aoe,
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
