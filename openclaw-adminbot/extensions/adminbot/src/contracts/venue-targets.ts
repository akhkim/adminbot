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

import { DEADLINE_VENUES } from "../workflows/deadlines/generated/dataset.js";

/** One bet: a venue, and how likely the authors think they will actually submit to it. */
export type AdminBotVenueTarget = {
  venue_id: string;
  label: string;
  confidence: number;
};

const ARTIFACT_KEY = "venue_targets";

type PaperLike = { artifacts?: Record<string, unknown> | undefined };

const CONFERENCE_KEY = "conference";

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
 * Two id spaces are already in the wild: the pre-registration dialog writes deadline-board ids
 * ("iclr2027_paper") and the add-project form writes venue-catalog ids ("ICLR"). Resolve both
 * through the generated explicit aliases; substring matching can silently confuse distinct venues.
 */
export function paperTargetsVenue(paper: PaperLike, venue: string): boolean {
  const needle = canonicalVenueId(venue);
  if (!needle) {
    return false;
  }
  const explicit = readPaperVenueTargets(paper).flatMap((target) => [
    target.venue_id,
    target.label,
  ]);
  return [...explicit, ...conferenceVenueCandidates(paper)].some((candidate) =>
    venueMatches(canonicalVenueId(candidate), needle),
  );
}

/**
 * Where the paper says it is going, from the field the author actually filled in.
 *
 * `artifacts.venue_targets` is written by the pre-registration dialog. `artifacts.conference` is
 * written by the venue picker on My Projects & Papers -- the control an author reaches for when
 * they add a paper and say where it is aimed. They were never joined up, so designating a
 * conference did not pre-register the paper: on the current roster 127 papers name a conference
 * and only 12 of them carry a venue target, which left 115 papers invisible to a sweep whose whole
 * job is asking who has not pre-registered yet.
 *
 * Read here rather than fixed at the write site because the write site is not the only one, and
 * because 115 papers already carry the value. A reader that understands both fields needs no
 * backfill and cannot be bypassed by whichever control writes next.
 *
 * The strings are free text and look it: "ICLR 2027", "Findings of EMNLP", "EMNLP 2026 (main)",
 * "ARR Acceptance, Committed to EMNLP Findings". Each is reduced to the venue names inside it --
 * years, track parentheses and the connective words around them carry no venue of their own.
 */
function conferenceVenueCandidates(paper: PaperLike): string[] {
  const raw = paper.artifacts?.[CONFERENCE_KEY];
  if (typeof raw !== "string" || !raw.trim()) {
    return [];
  }
  // The whole string first: "EMNLP-main" and "AACL-demo" are venue ids in their own right, and a
  // paper whose conference is exactly one of those should match it exactly rather than by family.
  const candidates = [raw.trim()];
  for (const part of raw.split(/[,;()]/u)) {
    const cleaned = part
      .replace(/\b(19|20)\d{2}\b/gu, " ")
      .replace(
        /\b(findings|of|acceptance|committed|commitment|to|be|the|and|cycle|track)\b/giu,
        " ",
      )
      .trim();
    if (cleaned) {
      candidates.push(cleaned);
      // A cleaned fragment can still be two names ("EMNLP IJCNLP", "ARR EMNLP"); each word that
      // looks like a venue acronym is a candidate on its own.
      for (const word of cleaned.split(/[\s/]+/u)) {
        if (word.length >= 2) {
          candidates.push(word);
        }
      }
    }
  }
  return candidates;
}

/**
 * Does this candidate satisfy the venue being asked about?
 *
 * Exact id first. Failing that, a bare family name matches any of its tracks: somebody asking
 * "who is aiming at ICLR" means the conference, and an ICLR workshop paper is aimed at ICLR. The
 * reverse is deliberately not true -- asking about `EMNLP-main` must not be answered by a paper
 * aimed at `EMNLP-demo`, which is a different deadline and a different decision.
 */
function venueMatches(candidate: string, needle: string): boolean {
  if (!candidate) {
    return false;
  }
  if (candidate === needle) {
    return true;
  }
  return needle === venueFamily(needle) && venueFamily(candidate) === needle;
}

/**
 * The conference behind a venue id, without its track or year.
 *
 * The id spaces in the wild disagree about separators -- `EMNLP-main`, `emnlp2026_commitment`,
 * `EMNLP/2026/Workshop/NLP4PI`, `arr_2026_may` -- so this takes the leading run of letters, which
 * is the one part all of them spell the same way.
 */
function venueFamily(value: string): string {
  return /^[a-z]+/u.exec(value)?.[0] ?? "";
}

function canonicalVenueId(value: string): string {
  const candidate = value.trim().toLowerCase();
  if (!candidate) {
    return "";
  }
  for (const deadline of DEADLINE_VENUES) {
    if (deadline.venue_aliases.some((alias) => alias.toLowerCase() === candidate)) {
      return deadline.venue_id.toLowerCase();
    }
  }
  return candidate;
}
