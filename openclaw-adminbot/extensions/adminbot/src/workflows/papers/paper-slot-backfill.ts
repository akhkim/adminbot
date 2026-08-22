// Turning the artifacts already on 114 papers into slot rows.
//
// Without this, evidence tracking starts empty and the first sweep asks eighty first authors for a
// brainstorm doc on papers that have been on arXiv for a year. That is not a cosmetic problem: it
// is the one event that teaches a lab to ignore AdminBot, and it happens once, on the day the
// feature ships.
//
// Three passes, in increasing order of confidence about what they claim:
//
//   1. Copy each stored artifact link into the slot it obviously is. A URL that exists is proof
//      the thing exists -- the same reasoning `next-step.ts` already used to place a paper on the
//      graph, applied to the table instead.
//   2. Grandfather the ancestors of anything provided. A paper with an arXiv link demonstrably got
//      through the brainstorm, the draft and the PDF, whatever the lab did or did not write down
//      at the time. These are marked `waived`, not `provided`: we are excusing the paper from
//      evidence nobody was collecting then, and a waiver is the record that says so.
//   3. Close out papers that were already finished. Passes 1 and 2 recover what a paper *did*, but
//      they also open every branch downstream of it -- restoring an arXiv link makes the social
//      branch actionable, so a paper published two years ago starts asking its author to draft an
//      X post. On a dry run against the real database that was 80 papers. A paper that reached
//      arXiv and has sat untouched since is finished as far as the lab is concerned, and the
//      remaining artifacts are ones nobody ever intended to collect for it.
//
//   4. Lift `artifacts.conference` into the paper's `venue` column, so the deadline half of a
//      nudge has something to read.
//
// It is idempotent and it never overwrites: a slot somebody has already answered is left exactly
// as they answered it.
import type { AdminBotPaperRecord } from "../../contracts/actions.js";
import {
  adminBotPaperSlotRegistry,
  type AdminBotPaperSlot,
  type AdminBotPaperSlotRecord,
} from "../../contracts/paper-slots.js";

/**
 * Which stored artifact key proves which slot.
 *
 * Only unambiguous mappings. `google_drive_pdf_url` maps to `drive_pdf_arxiv` because there is
 * only one Drive PDF per paper now -- the ambiguity that made this mapping unsafe in the previous
 * revision was the submitted-version slot, and that slot is gone.
 *
 * `twitter_draft_url` is deliberately absent. The X draft gate reads the drafts table, and a bare
 * URL is not a draft body -- there is nothing to ask a coauthor to consent to, so backfilling it
 * would claim a consent step happened that never did.
 */
const ARTIFACT_SLOTS: Array<[string, AdminBotPaperSlot]> = [
  ["brainstorming_doc_url", "project_folder"],
  ["overleaf_view_url", "overleaf_view"],
  ["overleaf_edit_url", "overleaf_edit"],
  ["submission_url", "submission"],
  ["google_drive_pdf_url", "drive_pdf_arxiv"],
  ["arxiv_url", "arxiv"],
  ["google_slides_url", "slides"],
  ["poster_url", "poster"],
];

/** The reviewer checklist is the only signal for PaperMentor review, which has no artifact. */
const CHECK_SLOTS: Array<[string, AdminBotPaperSlot]> = [
  ["paper_mentor_checked", "papermentor_review"],
];

export const BACKFILL_WAIVER_REASON =
  "grandfathered: this paper was already in flight when evidence tracking started";

export const BACKFILL_SETTLED_REASON =
  "grandfathered: this paper was already published and quiet when evidence tracking started";

/**
 * How long a published paper has to have been quiet before the backfill calls it finished.
 *
 * Ninety days is deliberately generous: a paper that went up last month is still inside its
 * social and talk window and its author should be asked for those. One that has not moved in a
 * quarter is not mid-flight, whatever the checklist would otherwise claim.
 */
export const BACKFILL_SETTLED_QUIET_DAYS = 90;

/** All of them, so pass 3 can close whatever passes 1 and 2 left open. */
const ALL_SLOTS = Object.keys(adminBotPaperSlotRegistry) as AdminBotPaperSlot[];

/** Every slot upstream of `slot`, transitively. */
function ancestorsOf(slot: AdminBotPaperSlot): AdminBotPaperSlot[] {
  const seen = new Set<AdminBotPaperSlot>();
  const queue = [...adminBotPaperSlotRegistry[slot].upstream];
  while (queue.length > 0) {
    const current = queue.shift() as AdminBotPaperSlot;
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    queue.push(...adminBotPaperSlotRegistry[current].upstream);
  }
  return [...seen];
}

export type PaperBackfillPlan = {
  /** Rows to write. Never includes a slot that already had one. */
  slots: AdminBotPaperSlotRecord[];
  /** Set when `artifacts.conference` can fill an empty `venue`. */
  venue?: string;
  /** True when pass 3 decided this paper was already finished. */
  settled: boolean;
};

/**
 * When a paper actually went public, read off its arXiv identifier.
 *
 * `created_at` and `updated_at` cannot answer this. Every paper in the database was written by the
 * same import run, so both timestamps say when AdminBot first heard about the paper, not when the
 * work happened -- on the real roster all 114 carry the same month. The arXiv id does carry it:
 * `2505.19212` is May 2025, and that is the one date in the record that means what it says.
 *
 * Returns `undefined` for anything that does not parse, and the caller treats that as "no idea",
 * which leaves the paper open rather than closing it on a guess.
 */
export function arxivPublicationDate(url: string): Date | undefined {
  const match = /arxiv\.org\/abs\/(\d{2})(\d{2})\./iu.exec(url);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  if (!match || !Number.isFinite(year) || month < 1 || month > 12) {
    return undefined;
  }
  // arXiv's YYMM scheme started in 2007 and every id since is 20YY.
  return new Date(Date.UTC(2000 + year, month - 1, 1));
}

/**
 * Has this paper been published and left alone long enough to call it done?
 *
 * An arXiv link is the evidence of publication -- it is the strongest single signal in the record
 * and the point past which the lab stops driving the paper.
 */
function isSettledHistory(
  paper: AdminBotPaperRecord,
  arxivUrl: string | undefined,
  now: Date,
  quietDays: number,
): boolean {
  if (!arxivUrl) {
    return false;
  }
  const published = arxivPublicationDate(arxivUrl);
  if (published) {
    return now.getTime() - published.getTime() > quietDays * 24 * 60 * 60 * 1000;
  }
  // No parseable id. Fall back to the record's own clock, which is usually the import date and so
  // will usually say "recent" -- erring towards leaving the paper open, which is the safe way to
  // be wrong here.
  const touched = Date.parse(paper.updated_at ?? paper.created_at ?? "");
  return Number.isFinite(touched) && now.getTime() - touched > quietDays * 24 * 60 * 60 * 1000;
}

/**
 * What this one paper's existing record implies, given whatever slot rows it already has.
 *
 * Returns only the rows that need writing, so running it twice writes nothing the second time.
 */
export function planPaperBackfill(params: {
  paper: AdminBotPaperRecord;
  existing: AdminBotPaperSlotRecord[];
  now: Date;
  /** Override the quiet window. Zero closes out every published paper, however recent. */
  quietDays?: number;
}): PaperBackfillPlan {
  const { paper } = params;
  const nowIso = params.now.toISOString();
  const already = new Set(params.existing.map((row) => row.slot));
  const artifacts = (paper.artifacts ?? {}) as Record<string, string | undefined>;
  const planned = new Map<AdminBotPaperSlot, AdminBotPaperSlotRecord>();

  const provided: AdminBotPaperSlot[] = [];
  for (const [key, slot] of ARTIFACT_SLOTS) {
    const value = artifacts[key];
    if (already.has(slot) || typeof value !== "string" || !value.trim()) {
      continue;
    }
    planned.set(slot, {
      paper_id: paper.id,
      slot,
      // Deliberately not validated here. These links predate the shape rules, and marking a
      // three-year-old Overleaf URL `invalid` would put a red field on a finished paper and chase
      // its author to fix a link nobody needs any more. They are accepted as historical fact; a
      // later edit goes through the normal validation path.
      status: "provided",
      url: value.trim(),
      provided_at: paper.created_at ?? nowIso,
      ...(paper.first_author_member_id
        ? { provided_by_member_id: paper.first_author_member_id }
        : {}),
    });
    provided.push(slot);
  }

  const checks = (paper.checks ?? {}) as Record<string, boolean | undefined>;
  for (const [key, slot] of CHECK_SLOTS) {
    if (already.has(slot) || planned.has(slot) || checks[key] !== true) {
      continue;
    }
    planned.set(slot, {
      paper_id: paper.id,
      slot,
      status: "provided",
      provided_at: paper.created_at ?? nowIso,
    });
    provided.push(slot);
  }

  // Pass 2: everything those imply.
  for (const slot of provided) {
    for (const ancestor of ancestorsOf(slot)) {
      if (already.has(ancestor) || planned.has(ancestor)) {
        continue;
      }
      planned.set(ancestor, {
        paper_id: paper.id,
        slot: ancestor,
        status: "waived",
        waived_reason: BACKFILL_WAIVER_REASON,
        provided_at: paper.created_at ?? nowIso,
      });
    }
  }

  // Pass 3: a paper that reached arXiv and then went quiet is finished. Waive whatever is still
  // open on it rather than opening its social and talk branches years after the fact.
  const settled = isSettledHistory(
    paper,
    artifacts.arxiv_url?.trim(),
    params.now,
    params.quietDays ?? BACKFILL_SETTLED_QUIET_DAYS,
  );
  if (settled) {
    for (const slot of ALL_SLOTS) {
      if (already.has(slot) || planned.has(slot) || !adminBotPaperSlotRegistry[slot].required) {
        continue;
      }
      planned.set(slot, {
        paper_id: paper.id,
        slot,
        status: "waived",
        waived_reason: BACKFILL_SETTLED_REASON,
        provided_at: paper.updated_at ?? nowIso,
      });
    }
  }

  const conference = artifacts.conference?.trim();
  return {
    slots: [...planned.values()],
    settled,
    ...(conference && !paper.venue?.trim() ? { venue: conference } : {}),
  };
}
