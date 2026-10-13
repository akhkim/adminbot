// What every drawing of a paper reads and writes: the project page, the flat view, the sheet, and
// the PI's review dialog.
//
// Built once, in surfaces/projects.ts, so the four cannot grow different save paths. Every write
// here is an existing controller call; the service decides what each viewer may change, and these
// props only decide which affordances are drawn.
import type { XThreadDraft } from "../../../../../extensions/adminbot/src/workflows/papers/x-draft.js";
import type { PaperSlotOverviewRow } from "../api/paper-admin.ts";
import type { PaperCycle } from "../api/papers.ts";
import type {
  AdminBotPaperRecord,
  AdminBotPaperSaveInput,
  SlackChannelCheck,
} from "../controllers/admin.ts";

export type PaperWorkspaceProps = {
  onSavePaper: (paper: AdminBotPaperSaveInput) => void;
  /** Resolves to whether the blocker was stored, so a failed report keeps its draft. */
  onSaveBlocker?: (paper: AdminBotPaperSaveInput) => Promise<boolean>;
  /** Asks the host to re-render. The flat view and the sheet edit in place. */
  onRerender?: () => void;
  /**
   * Whether the reader administers the lab. It decides only which drawing the card list opens on
   * (see opensOnSheet in full-views.ts); what anybody may edit is the service's decision.
   */
  viewerIsAdmin?: boolean;
  /** What each paper still owes, computed by the service, so a count here matches what a nudge chases. */
  overview: PaperSlotOverviewRow[];
  /** The whole cycle by paper id, read when a project page (or the flat view) asks for it. */
  slots: Record<string, PaperCycle>;
  slotsBusyId: string | null;
  slotsError: string | null;
  slotsNotice: string | null;
  /** Fetches one paper's evidence. Optional: a surface without it offers no evidence to fill in. */
  onLoadSlots?: (paperId: string) => void;
  onSaveSlot: (
    paperId: string,
    slot: string,
    input: { url?: string; value_text?: string; value_note?: string; done?: boolean },
  ) => void;
  /**
   * Opens the Travel tab, where the reader RSVPs for the conference a paper was accepted to. The
   * card only reads the reader's answer back; the form lives on Travel.
   */
  onOpenTravel?: () => void;
  /** The signed-in member, so their own consent rows get buttons and nobody else's do. */
  memberId: string | null;
  memberName: (memberId: string) => string;
  onSaveDraft: (paperId: string, platform: string, body: string, xThread?: XThreadDraft) => void;
  onCirculateDraft: (paperId: string, draftId: string) => void;
  onConsent: (paperId: string, draftId: string, decision: string, comment?: string) => void;
  onSetAttendee: (
    paperId: string,
    name: string,
    memberId: string | undefined,
    attending: string,
  ) => void;
  onSetReimbursement: (paperId: string, memberId: string, status: string) => void;
  /** Writes the signed-in member's own line for this week. Absent leaves the log read-only. */
  onSaveWeeklyUpdate?: (paperId: string, body: string) => void;
  /** Fetches one object's edit history, called when its panel is opened. */
  onLoadRecentEdits?: (subject: "member" | "paper", id: string) => void;
  /**
   * Removes the paper outright. Absent hides the control: the service allows an admin any paper and
   * a member only one they authored, and a button that always 403s teaches people to distrust it.
   */
  onDeletePaper?: (paper: AdminBotPaperRecord) => void;
  /**
   * What the add-project form knows about the workspace's Slack channels. Absent hides the
   * "already has a channel" box: an unanswered check reads as a passed one.
   */
  channelCheck?: SlackChannelCheck;
  onChannelCheckToggle?: (enabled: boolean) => void;
};

export type BlockerDraft = {
  paperId: string;
  /** The blocker being edited, keyed by filing time. Absent when filing a new one. */
  at?: string;
  text: string;
  title?: string;
  note?: string;
  stage?: string;
  saving?: boolean;
  error?: string;
};

export type ProjectDetailsDraft = {
  title: string;
  alias: string;
  startedOn: string;
  error: string | null;
};

/** A venue row on the add-project form: a paper can be aimed at several, each with its own odds. */
export type ProjectVenueDraft = { venueId: string; year: number; confidence: number };
