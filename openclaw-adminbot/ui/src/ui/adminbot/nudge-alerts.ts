// In-app nudge alerts: the bell in the top bar.
//
// Why this is allowed to send where `copyNudge` is not. Delivering a nudge to Slack or email is an
// external effect and belongs in propose -> approve -> execute -> audit. Writing a flag onto a
// paper that the same app reads back is not: nothing leaves the system, and the member sees it
// only because they were already looking at their own record. So the admin button can do this
// directly, while still copying the message for the admin to paste wherever they actually talk.
//
// Reading is not deleting. A notification list that empties itself the moment you glance at it
// destroys the one thing a member needs afterwards -- "what was I asked, and when". So every nudge
// is appended to a log that stays, and `nudge_seen_at` is only a watermark: entries after it are
// unread and drive the badge, entries before it stay in the list, greyed. This is the OpenReview
// model, and it is the reason that inbox is usable at 52 messages.
//
// Stored on the paper in `artifacts`, the same free-form map that carries venue, confidence and
// blockers, with the log JSON-encoded into one key. The service merges artifacts on write, so
// touching a nudge key never disturbs the rest, and none of this needs a schema change.

// Types only, so this stays a leaf at runtime: controllers/admin.ts imports values from here,
// and a type-only edge back is erased rather than becoming a cycle.
import type {
  AdminBotPaperRecord,
  AdminBotPaperSaveInput,
  AdminBotPaperStep,
} from "./controllers/admin.ts";

/**
 * How many already-read notifications one paper keeps. Unread ones are never trimmed.
 *
 * A blunt cap on the whole log would let a busy paper drop a notification the member has not seen
 * yet, which is the one case where losing it actually costs something.
 */
const MAX_READ = 20;

/**
 * What happened. Absent on entries written before there was more than one kind, which is why the
 * reader defaults to "nudge" rather than treating a missing kind as unknown.
 */
export type NudgeKind = "nudge" | "blocker_solved" | "blocker_reopened" | "blocker_reply";

export type NudgeEntry = {
  kind?: NudgeKind;
  /**
   * What the notification is about: the PaperFlow task for a nudge, the blocker title for the
   * blocker kinds. One field rather than one per kind, because the panel only ever shows it in
   * the same position -- the sentence around it is what changes.
   */
  node: string;
  /** Free text the admin wrote. Only the reply kind has one; the rest are generated sentences. */
  body?: string;
  by: string;
  at: string;
};

export type NudgeAlert = NudgeEntry & {
  paperId: string;
  paperTitle: string;
  read: boolean;
};

function parseLog(raw: string | undefined): NudgeEntry[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry): entry is NudgeEntry =>
        typeof entry === "object" && entry !== null && typeof (entry as NudgeEntry).at === "string",
    );
  } catch {
    // A corrupt log is not worth losing the page over; treat it as no history.
    return [];
  }
}

/**
 * The log for one paper, newest first.
 *
 * Falls back to the single-nudge keys this feature originally wrote, so records created before the
 * log existed still show their one notification instead of silently disappearing.
 */
export function nudgeLog(paper: AdminBotPaperRecord): NudgeEntry[] {
  const log = parseLog(paper.artifacts?.nudge_log);
  if (log.length > 0) {
    return log;
  }
  const at = paper.artifacts?.nudge_at?.trim();
  return at
    ? [{ at, node: paper.artifacts?.nudge_node ?? "", by: paper.artifacts?.nudge_by ?? "An admin" }]
    : [];
}

function seenAt(paper: AdminBotPaperRecord): number {
  const raw = paper.artifacts?.nudge_seen_at?.trim();
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Every notification across the member's papers, newest first, each tagged read or unread. */
export function nudgeAlerts(papers: readonly AdminBotPaperRecord[]): NudgeAlert[] {
  return papers
    .flatMap((paper) => {
      const watermark = seenAt(paper);
      return nudgeLog(paper).map((entry) => ({
        ...entry,
        paperId: paper.id,
        paperTitle: paper.title,
        read: Date.parse(entry.at) <= watermark,
      }));
    })
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
}

export function unreadCount(papers: readonly AdminBotPaperRecord[]): number {
  return nudgeAlerts(papers).filter((alert) => !alert.read).length;
}

/**
 * The sentence for one notification, split so the panel can bold the names without the copy
 * living in the view. Past tense throughout: by the time a member reads this, it has happened.
 */
export function alertText(alert: NudgeEntry): { action: string; subject: string } {
  switch (alert.kind) {
    case "blocker_solved":
      return { action: "reviewed and closed your blocker", subject: alert.node };
    case "blocker_reopened":
      return { action: "reopened your blocker", subject: alert.node };
    case "blocker_reply":
      return { action: "replied about your blocker", subject: alert.node };
    default:
      return { action: "asked you to update", subject: alert.node };
  }
}

/** "2h ago" beats a timestamp here -- the question is how stale the ask is, not when it was. */
export function agoLabel(at: string, now = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(at)) / 60000);
  if (!Number.isFinite(minutes) || minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The save input an admin's nudge writes: the new entry prepended to the existing log.
 *
 * Title, authors and step ride along because the service's privileged write path is a full upsert,
 * not a patch -- omitting them blanks the record.
 */
export function nudgeSaveInput(
  paper: AdminBotPaperRecord,
  node: string,
  by: string,
  now = new Date(),
  kind: NudgeKind = "nudge",
  body?: string,
): AdminBotPaperSaveInput {
  const entry: NudgeEntry = { at: now.toISOString(), node, by, kind, ...(body ? { body } : {}) };
  const watermark = seenAt(paper);
  const full = [entry, ...nudgeLog(paper)];
  const read = full.filter((item) => Date.parse(item.at) <= watermark).slice(0, MAX_READ);
  const keep = new Set([...full.filter((item) => Date.parse(item.at) > watermark), ...read]);
  const log = full.filter((item) => keep.has(item));
  return {
    id: paper.id,
    title: paper.title,
    authors: paper.authors ?? [],
    currentStep: paper.current_step as AdminBotPaperStep,
    nudgeLog: JSON.stringify(log),
  };
}

/**
 * Marking read moves the watermark to now; nothing is removed.
 *
 * A watermark rather than a per-entry flag because "read" here only ever means "read everything up
 * to this point" -- the panel shows the whole list at once, so there is no way to read entry 3
 * without also seeing entries 1 and 2.
 */
export function seenSaveInput(
  paper: AdminBotPaperRecord,
  now = new Date(),
): AdminBotPaperSaveInput {
  return {
    id: paper.id,
    title: paper.title,
    authors: paper.authors ?? [],
    currentStep: paper.current_step as AdminBotPaperStep,
    nudgeSeenAt: now.toISOString(),
  };
}

/** Papers carrying at least one unread entry -- the ones a mark-all-read has to touch. */
export function papersWithUnread(
  papers: readonly AdminBotPaperRecord[],
): readonly AdminBotPaperRecord[] {
  return papers.filter((paper) => {
    const watermark = seenAt(paper);
    return nudgeLog(paper).some((entry) => Date.parse(entry.at) > watermark);
  });
}

/**
 * Just the log field, for callers that are already writing something else to the same paper.
 *
 * Solving a blocker is one user action, so it has to be one write: two sequential saves would each
 * trigger a reload, and the second would be computed against a record the first had already moved.
 * Spreading this into the blocker input keeps both changes in a single upsert.
 */
export function notifyFields(
  paper: AdminBotPaperRecord,
  kind: NudgeKind,
  subject: string,
  by: string,
  now = new Date(),
  body?: string,
): Pick<AdminBotPaperSaveInput, "nudgeLog"> {
  return { nudgeLog: nudgeSaveInput(paper, subject, by, now, kind, body).nudgeLog };
}
