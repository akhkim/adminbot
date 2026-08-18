// Reported blockers: what is stuck, who said so, and what has already been dealt with.
//
// Resolving is not deleting, for the same reason reading a notification is not deleting it. "We
// hit this last spring and here is what it was" is most of the value a blocker log has after the
// fact, and an admin who resolves the wrong row needs it back rather than a retyped guess. So each
// entry carries `resolved_at` instead of being removed, which makes Recover a one-field edit.
//
// Stored on the paper in `artifacts` as one JSON-encoded key, the same technique the nudge log
// uses. The service merges artifacts on write, so this never disturbs venue, confidence or nudges,
// and none of it needs a schema change.

// Types only, so this stays a leaf at runtime: controllers/admin.ts imports values from here, and
// a type-only edge back is erased rather than becoming a cycle.
import type {
  AdminBotPaperRecord,
  AdminBotPaperSaveInput,
  AdminBotPaperStep,
} from "./controllers/admin.ts";

/**
 * How much resolved history one paper keeps. Open blockers are never counted against it.
 *
 * The bound exists so a record cannot grow without limit, but a blunt cap on the whole log would
 * let a long history push a live blocker out of the list -- losing the one entry that still needs
 * someone to act. So the trim only ever drops the oldest *resolved* rows.
 *
 * This is per paper, not per lab: an admin looking at 300 open blockers across the pipeline sees
 * all 300, because each paper carries its own log.
 */
const MAX_RESOLVED = 30;

export const BLOCKER_TITLE_MAX = 70;

export type BlockerEntry = {
  /** Which PaperFlow step is stuck. A fixed list, so admins can sort into stable buckets. */
  stage: string;
  title: string;
  note: string;
  /** Who reported it. Named, because "who do I go ask about this" is the next question. */
  by: string;
  at: string;
  resolved_at?: string;
  resolved_by?: string;
};

export type BlockerRow = BlockerEntry & {
  paperId: string;
  paperTitle: string;
};

function parseLog(raw: string | undefined): BlockerEntry[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry): entry is BlockerEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as BlockerEntry).title === "string",
    );
  } catch {
    // A corrupt log is not worth losing the page over; treat it as no history.
    return [];
  }
}

/**
 * The log for one paper, newest first.
 *
 * Falls back to the single-blocker keys this feature originally wrote, so blockers filed before
 * the log existed still appear instead of silently disappearing.
 */
export function blockerLog(paper: AdminBotPaperRecord): BlockerEntry[] {
  const log = parseLog(paper.artifacts?.blocker_log);
  if (log.length > 0) {
    return log;
  }
  const title = paper.artifacts?.blocker_title?.trim();
  return title
    ? [
        {
          stage: paper.artifacts?.blocker_stage ?? "",
          title,
          note: paper.artifacts?.blocker_note ?? "",
          by: paper.artifacts?.blocker_by ?? "",
          at: paper.artifacts?.blocker_at ?? "",
        },
      ]
    : [];
}

/** Every still-open blocker on a paper, newest first. A paper can be stuck on several things. */
export function openEntries(paper: AdminBotPaperRecord): BlockerEntry[] {
  return blockerLog(paper).filter((entry) => !entry.resolved_at);
}

/** The newest open blocker, for the places that only have room to show one. */
export function openBlocker(paper: AdminBotPaperRecord): BlockerEntry | undefined {
  return openEntries(paper)[0];
}

function withPaper(paper: AdminBotPaperRecord, entries: BlockerEntry[]): BlockerRow[] {
  return entries.map((entry) => ({ ...entry, paperId: paper.id, paperTitle: paper.title }));
}

export function openBlockers(papers: readonly AdminBotPaperRecord[]): BlockerRow[] {
  return papers.flatMap((paper) =>
    withPaper(
      paper,
      blockerLog(paper).filter((entry) => !entry.resolved_at),
    ),
  );
}

/** Resolved blockers across all papers, most recently resolved first. */
export function resolvedBlockers(papers: readonly AdminBotPaperRecord[]): BlockerRow[] {
  return papers
    .flatMap((paper) =>
      withPaper(
        paper,
        blockerLog(paper).filter((entry) => entry.resolved_at),
      ),
    )
    .sort((left, right) => Date.parse(right.resolved_at ?? "") - Date.parse(left.resolved_at ?? ""));
}

/** Days since a blocker was filed. The oldest one is usually the real problem. */
export function blockerAgeDays(at: string): number | undefined {
  const filed = Date.parse(at);
  if (!Number.isFinite(filed)) {
    return undefined;
  }
  return Math.floor((Date.now() - filed) / (1000 * 60 * 60 * 24));
}

/**
 * Every save below rewrites the whole log, because the service's write path is a full upsert
 * rather than a patch -- title, authors and step have to ride along or the record is blanked.
 */
function trim(log: BlockerEntry[]): BlockerEntry[] {
  const open = log.filter((entry) => !entry.resolved_at);
  const resolved = log.filter((entry) => entry.resolved_at).slice(0, MAX_RESOLVED);
  // Rebuilt in the original order so the caller's sort is not silently rearranged.
  const keep = new Set([...open, ...resolved]);
  return log.filter((entry) => keep.has(entry));
}

function saveLog(paper: AdminBotPaperRecord, log: BlockerEntry[]): AdminBotPaperSaveInput {
  return {
    id: paper.id,
    title: paper.title,
    authors: paper.authors ?? [],
    currentStep: paper.current_step as AdminBotPaperStep,
    blockerLog: JSON.stringify(trim(log)),
  };
}

/**
 * Filing adds a blocker; it does not replace the ones already there.
 *
 * A paper genuinely can be stuck on several things at once -- waiting on a rerun and blocked on a
 * missing licence are two problems, and collapsing them into one row loses whichever the reporter
 * mentioned second.
 */
export function fileBlockerInput(
  paper: AdminBotPaperRecord,
  fields: { stage: string; title: string; note: string; by: string },
  now = new Date(),
): AdminBotPaperSaveInput {
  const entry: BlockerEntry = {
    stage: fields.stage,
    title: fields.title.slice(0, BLOCKER_TITLE_MAX),
    note: fields.note,
    by: fields.by,
    at: now.toISOString(),
  };
  return saveLog(paper, [entry, ...blockerLog(paper)]);
}

/**
 * Edit one blocker in place, keyed by its filing time.
 *
 * `at` is the identity here rather than an index, because the log is re-sorted and re-filtered all
 * over the UI and a position would silently start pointing at a different row.
 */
export function editBlockerInput(
  paper: AdminBotPaperRecord,
  at: string,
  fields: { stage: string; title: string; note: string },
): AdminBotPaperSaveInput {
  const log = blockerLog(paper).map((entry) =>
    entry.at === at
      ? {
          ...entry,
          stage: fields.stage,
          title: fields.title.slice(0, BLOCKER_TITLE_MAX),
          note: fields.note,
        }
      : entry,
  );
  return saveLog(paper, log);
}

export function resolveBlockerInput(
  paper: AdminBotPaperRecord,
  at: string,
  by: string,
  now = new Date(),
): AdminBotPaperSaveInput {
  const log = blockerLog(paper).map((entry) =>
    entry.at === at ? { ...entry, resolved_at: now.toISOString(), resolved_by: by } : entry,
  );
  return saveLog(paper, log);
}

/**
 * Undo. Strips the resolution marks so the entry is open again, in its original position -- a
 * misclick should leave no trace, not add a "reopened" row nobody asked for.
 */
export function recoverBlockerInput(
  paper: AdminBotPaperRecord,
  at: string,
): AdminBotPaperSaveInput {
  const log = blockerLog(paper).map((entry) => {
    if (entry.at !== at) {
      return entry;
    }
    const { resolved_at: _resolvedAt, resolved_by: _resolvedBy, ...open } = entry;
    return open;
  });
  return saveLog(paper, log);
}
