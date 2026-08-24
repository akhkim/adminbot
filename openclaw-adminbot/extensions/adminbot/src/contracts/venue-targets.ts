// Which venues a paper is aimed at, read by the service.
//
// The Control UI has stored this since pre-registration shipped: `artifacts.venue_targets`, a JSON
// array of {venue_id, label, confidence}, written by the pre-registration dialog. The service has
// never looked at it. That was fine while the only consumer was the page that wrote it, and it is
// not fine the moment anything has to ask "who has not pre-registered for ICLR yet" -- a question
// only the server can answer, because only the server sees every member's papers.
//
// So this is the reading half, deliberately mirroring ui/src/ui/adminbot/venue-targets.ts. Same
// key, same shape, same tolerance for a half-written value. The duplication is the price of the
// field living in a free-form artifacts blob rather than in a column; when `paper_venue_targets`
// becomes a table, both sides read the table and this file goes away.

/** One bet: a venue, and how likely the authors think they will actually submit to it. */
export type AdminBotVenueTarget = {
  venue_id: string;
  label: string;
  confidence: number;
};

const ARTIFACT_KEY = "venue_targets";

type PaperLike = { artifacts?: Record<string, unknown> | undefined };

/**
 * Read the targets off a paper.
 *
 * Tolerant on purpose, exactly as the UI's reader is: this is free-form JSON in a shared map, and
 * a hand-edited or half-written value must degrade to "no targets" rather than throw inside a
 * sweep that is walking every paper in the lab.
 */
export function readPaperVenueTargets(paper: PaperLike): AdminBotVenueTarget[] {
  const raw = paper.artifacts?.[ARTIFACT_KEY];
  if (typeof raw !== "string" || !raw.trim()) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const row = entry as Record<string, unknown>;
    const venueId = typeof row.venue_id === "string" ? row.venue_id.trim() : "";
    const label = typeof row.label === "string" ? row.label.trim() : "";
    const confidence = Number(row.confidence);
    if (!venueId && !label) {
      return [];
    }
    return [
      {
        venue_id: venueId,
        label: label || venueId,
        confidence: Number.isFinite(confidence) ? confidence : 0,
      },
    ];
  });
}

/**
 * Is this paper aimed at the named venue?
 *
 * Matched on the id *or* the label, case-insensitively, and by prefix on the label. Two id spaces
 * are already in the wild: the pre-registration dialog writes deadline-board ids ("iclr2027_paper")
 * and the add-project form writes venue-catalog ids ("ICLR"). A sweep that only understood one of
 * them would report half the lab as having no target and nudge people who already answered --
 * which is worse than the gap it is trying to close.
 */
export function paperTargetsVenue(paper: PaperLike, venue: string): boolean {
  const needle = venue.trim().toLowerCase();
  if (!needle) {
    return false;
  }
  return readPaperVenueTargets(paper).some((target) => {
    const id = target.venue_id.toLowerCase();
    const label = target.label.toLowerCase();
    return id.includes(needle) || label.includes(needle);
  });
}
