// The lists that hang off a project: its weekly log, the social drafts and their sign-offs, who is
// going to the conference, the reader's own trip, and who has been reimbursed.
//
// Only drawn once the project's cycle has been read: an empty log and an unloaded one look the
// same, and only one of them means nobody has written anything.
import { nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { draftLinkedInPost, draftXPost } from "../api/papers.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";
import { renderPaperCycle } from "../views/paper-cycle.ts";
import { renderPaperWeeklyUpdates } from "../views/paper-weekly-updates.ts";
import type { PaperWorkspaceProps } from "./workspace.ts";

/** What each author did on this paper, week by week. */
export function renderWeeklyUpdates(paper: AdminBotPaperRecord, props: PaperWorkspaceProps) {
  const cycle = props.slots[paper.id];
  if (!cycle) {
    return nothing;
  }
  const names: Record<string, string> = {};
  for (const update of cycle.weeklyUpdates) {
    names[update.member_id] = props.memberName(update.member_id);
  }
  return renderPaperWeeklyUpdates({
    paperId: paper.id,
    updates: cycle.weeklyUpdates,
    ...(props.memberId ? { memberId: props.memberId } : {}),
    memberNames: names,
    busy: props.slotsBusyId === paper.id,
    // No session, no box: the service takes the author from the session.
    ...(props.onSaveWeeklyUpdate && props.memberId
      ? { onSave: (body: string) => props.onSaveWeeklyUpdate?.(paper.id, body) }
      : {}),
  });
}

/**
 * The conference as an announcement names it, e.g. "EMNLP 2026 (Oral)", from what the card already
 * records. Prefills the draft settings so nobody retypes it; empty until the venue is known.
 */
export function announcementVenue(paper: AdminBotPaperRecord): string {
  const venue = paper.accepted_venue?.trim();
  if (!venue) {
    return "";
  }
  const year = typeof paper.accepted_year === "number" ? ` ${paper.accepted_year}` : "";
  const type = paper.presentation_type?.trim();
  const format = type ? ` (${type.charAt(0).toUpperCase()}${type.slice(1)})` : "";
  return `${venue}${year}${format}`;
}

/** What to say when the console cannot reach AdminBot at all, rather than a bare "could not". */
const UNREACHABLE =
  "Could not reach AdminBot. Check your connection and the AdminBot URL in settings, then press Generate again.";

/**
 * Drafts and their sign-offs, the conference roll call, the reader's trip, and reimbursements.
 *
 * Both generate paths run against the member's own session and the console's configured AdminBot
 * URL: called without the settings, resolveAdminBotBaseUrl falls back to this page's hostname and
 * a guessed port, which is not where AdminBot lives unless the console is served from it.
 */
export function renderCycle(
  state: AppViewState,
  paper: AdminBotPaperRecord,
  props: PaperWorkspaceProps,
) {
  const cycle = props.slots[paper.id];
  if (!cycle) {
    return nothing;
  }
  return renderPaperCycle({
    paperId: paper.id,
    drafts: cycle.drafts,
    consents: cycle.consents,
    attendees: cycle.attendees,
    reimbursements: cycle.reimbursements,
    conferenceOpen:
      paper.venue_decision === "accept" && cycle.missingAcceptanceDetails.length === 0,
    missingAcceptanceDetails: cycle.missingAcceptanceDetails,
    // Only when the service named a conference for this paper and the surface wired the way to
    // the Travel tab: without the key there is no trip to read back.
    ...(cycle.conferenceKey && props.onOpenTravel
      ? { myTrip: cycle.myTrip ?? null, onOpenTravel: props.onOpenTravel }
      : {}),
    cycleClosed: cycle.cycleClosed,
    memberId: props.memberId,
    memberName: props.memberName,
    // The X thread credits authors by their member records, so it needs the byline and the roster.
    paperAuthors: paper.authors ?? [],
    creditMembers: state.adminBotData?.members ?? [],
    defaultVenue: announcementVenue(paper),
    onSaveDraft: (platform, body, xThread) => props.onSaveDraft(paper.id, platform, body, xThread),
    onCirculateDraft: (draftId: string) => props.onCirculateDraft(paper.id, draftId),
    // The service reads the Drive copy the page already chases, unless a PDF was dropped on the
    // panel. The result lands as a stored draft, so the usual sign-off row takes over from there.
    onGenerateLinkedInDraft: async (
      venue: string,
      note: string,
      pdfBase64?: string,
      abstract?: string,
    ) => {
      const stored = loadStoredMemberSession();
      if (!stored) {
        globalThis.alert?.("Sign in first — drafting runs against your own session.");
        return;
      }
      try {
        const result = await draftLinkedInPost(
          {
            paperId: paper.id,
            ...(pdfBase64 ? { pdfBase64 } : {}),
            ...(abstract ? { abstract } : {}),
            ...(paper.artifacts?.arxiv_url ? { url: paper.artifacts.arxiv_url } : {}),
            ...(venue ? { venue } : {}),
            ...(note ? { note } : {}),
          },
          stored.sessionToken ?? "",
          resolveAdminBotBaseUrl(state.settings),
        );
        if (!result.ok) {
          globalThis.alert?.(
            result.kind === "unreachable"
              ? UNREACHABLE
              : (result.message ?? "Could not generate the draft."),
          );
          return;
        }
        props.onSaveDraft(paper.id, "linkedin", result.value.text);
      } catch (error) {
        globalThis.alert?.((error as Error).message);
      }
    },
    // A thread, not a post: each stage (arXiv, acceptance, poster, talk) announces something
    // different, and the posts are stored with the stage so the sign-off is about what will go out.
    onGenerateXDraft: async (_venue, _note, pdfBase64, announcement, credits, abstract) => {
      const stored = loadStoredMemberSession();
      if (!stored) {
        globalThis.alert?.("Sign in first.");
        return;
      }
      try {
        const result = await draftXPost(
          {
            paperId: paper.id,
            ...(announcement ? { announcement } : {}),
            ...(credits ? { credits } : {}),
            ...(pdfBase64 ? { pdfBase64 } : {}),
            ...(abstract ? { abstract } : {}),
            ...(paper.artifacts?.arxiv_url ? { url: paper.artifacts.arxiv_url } : {}),
          },
          stored.sessionToken ?? "",
          resolveAdminBotBaseUrl(state.settings),
        );
        if (!result.ok) {
          globalThis.alert?.(
            result.kind === "unreachable"
              ? UNREACHABLE
              : (result.message ?? "Could not generate the X thread."),
          );
          return;
        }
        props.onSaveDraft(paper.id, "x", result.value.posts.map((post) => post.text).join("\n\n"), {
          stage: announcement?.stage ?? "arxiv",
          posts: result.value.posts,
        });
        if (result.value.issues.length) {
          globalThis.alert?.(result.value.issues.join("\n"));
        }
      } catch (error) {
        globalThis.alert?.((error as Error).message);
      }
    },
    onConsent: (draftId: string, decision: string, comment?: string) =>
      props.onConsent(paper.id, draftId, decision, comment),
    onSetAttendee: (name: string, memberId: string | undefined, attending: string) =>
      props.onSetAttendee(paper.id, name, memberId, attending),
    onSetReimbursement: (memberId: string, status: string) =>
      props.onSetReimbursement(paper.id, memberId, status),
  });
}
