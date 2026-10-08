import type {
  AdminBotConferenceAttendeeRecord,
  AdminBotPaperReimbursementRecord,
  AdminBotSocialDraftRecord,
} from "../contracts/paper-cycle.js";
import type { AdminBotPaperSlotRecord } from "../contracts/paper-slots.js";
import type { AdminBotPaperflowEvidenceRecord } from "../contracts/paperflow-stages.js";
import type { AdminBotPaperMentorRun } from "../contracts/papermentor.js";

/** The per-paper reads an all-paper sweep makes, keyed the way the store keys them. */
export type PaperRowReader = {
  listPaperSlots(paperId?: string): AdminBotPaperSlotRecord[];
  listSocialDrafts(paperId?: string, draftId?: string): AdminBotSocialDraftRecord[];
  listConferenceAttendees(paperId?: string): AdminBotConferenceAttendeeRecord[];
  listPaperReimbursements(paperId?: string): AdminBotPaperReimbursementRecord[];
  listPaperMentorRuns(paperId?: string): AdminBotPaperMentorRun[];
  listPaperflowEvidence(paperId?: string): AdminBotPaperflowEvidenceRecord[];
};

/**
 * One read per table for a whole sweep, answered per paper from memory.
 *
 * A sweep over every paper asked the store for each paper's slots, drafts, attendees and so on in
 * turn -- thousands of statements for one page load. The unfiltered read is ordered the same way
 * within a paper as the per-paper one (paper id first, then the per-paper order), so grouping it
 * gives every paper the rows, and the order, its own read would have. Only for synchronous,
 * read-only sweeps: a write during the sweep would not be seen.
 */
export class PaperTableSnapshot implements PaperRowReader {
  private readonly tables = new Map<string, Map<string, unknown[]>>();

  constructor(private readonly store: PaperRowReader) {}

  private rows<T extends { paper_id: string }>(
    table: string,
    paperId: string | undefined,
    readAll: () => T[],
  ): T[] {
    // The store treats an empty id as "every paper", so this does too.
    if (!paperId) {
      return readAll();
    }
    let byPaper = this.tables.get(table) as Map<string, T[]> | undefined;
    if (!byPaper) {
      byPaper = new Map();
      for (const row of readAll()) {
        const rows = byPaper.get(row.paper_id);
        if (rows) {
          rows.push(row);
        } else {
          byPaper.set(row.paper_id, [row]);
        }
      }
      this.tables.set(table, byPaper as Map<string, unknown[]>);
    }
    // A fresh array each time, as the store hands out: callers are free to sort or splice it.
    return [...(byPaper.get(paperId) ?? [])];
  }

  listPaperSlots(paperId?: string): AdminBotPaperSlotRecord[] {
    return this.rows("slots", paperId, () => this.store.listPaperSlots());
  }

  listSocialDrafts(paperId?: string, draftId?: string): AdminBotSocialDraftRecord[] {
    if (draftId !== undefined) {
      return this.store.listSocialDrafts(paperId, draftId);
    }
    return this.rows("drafts", paperId, () => this.store.listSocialDrafts());
  }

  listConferenceAttendees(paperId?: string): AdminBotConferenceAttendeeRecord[] {
    return this.rows("attendees", paperId, () => this.store.listConferenceAttendees());
  }

  listPaperReimbursements(paperId?: string): AdminBotPaperReimbursementRecord[] {
    return this.rows("reimbursements", paperId, () => this.store.listPaperReimbursements());
  }

  listPaperMentorRuns(paperId?: string): AdminBotPaperMentorRun[] {
    return this.rows("papermentor", paperId, () => this.store.listPaperMentorRuns());
  }

  listPaperflowEvidence(paperId?: string): AdminBotPaperflowEvidenceRecord[] {
    return this.rows("evidence", paperId, () => this.store.listPaperflowEvidence());
  }
}
