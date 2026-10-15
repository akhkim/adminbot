import type { DeadlineProposalInput } from "../../contracts/deadline-proposals.js";

/** The id a published deadline-board row is known by: `deadline_id`, or `id` on older rows. */
export function deadlineBoardEntryId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const id = row.deadline_id ?? row.id;
  return typeof id === "string" ? id : undefined;
}

/** A published board row back as the proposal input that would recreate it, if it parses. */
export function deadlineInputFromBoardEntry(value: unknown): DeadlineProposalInput | undefined {
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
