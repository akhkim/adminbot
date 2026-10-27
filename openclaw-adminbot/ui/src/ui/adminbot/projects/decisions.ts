// Venue-decision banners: a decided paper still asking its author for something -- the track and
// format, whether they are going, the coauthor email, a new venue after a rejection.
//
// Addressed to one person. They are drawn on the viewer's own pages only; on somebody else's paper
// a decision prompt would invite an admin to answer a question that was asked of the author.
import { html, nothing } from "lit";
import { isSamePerson } from "../../../../../extensions/adminbot/src/contracts/person-names.js";
import { buildCoauthorEmail, firstFullMemberAuthor } from "../coauthor-email.ts";
import type { AdminBotLabMember, AdminBotPaperRecord } from "../controllers/admin.ts";
import {
  decisionEmailSentStamp,
  decisionOf,
  isDecisionAnswered,
  isDecisionEmailSent,
  renderDecisionBanner,
} from "../decision-popup.ts";
import { presentationFormat, publicationTrack } from "../paper-classification.ts";
import { openPreRegistrationDialog } from "../pre-registration.ts";
import type { PaperWorkspaceProps } from "./workspace.ts";

/**
 * Session state, not app state: dismissing is a "not right now", and the stored flag is what makes
 * an answer permanent. Module-level so a re-render mid-answer does not lose what was pressed.
 */
const collapsedDecisions = new Set<string>();
/** Decision banners drawn open before the rest fold away. */
const DECISION_PREVIEW = 3;
/** Papers whose answer was written in this session, so the button can say so before a reload. */
const savedDecisions = new Set<string>();
/**
 * Papers edited since their answer was written: `isDecisionAnswered` stays true once an answer
 * has ever been saved, so without this a changed track would still read "Saved".
 */
const dirtyDecisions = new Set<string>();
/** Closed by hand this session. The close also writes the seen stamp, which is the durable half. */
const dismissedDecisions = new Set<string>();
/** The coauthor-email task: whether the box is open, and the body as edited. */
const emailTasks = new Map<string, { open: boolean; body: string }>();
const decisionDrafts = new Map<
  string,
  { track?: string; presentation: string; attending: "yes" | "no" | ""; nextVenue: string }
>();

export function resetDecisionBannerState(): void {
  collapsedDecisions.clear();
  savedDecisions.clear();
  dirtyDecisions.clear();
  dismissedDecisions.clear();
  emailTasks.clear();
  decisionDrafts.clear();
}

/** The venue as the banner names it, so the mail and the heading never disagree. */
function venueOf(paper: AdminBotPaperRecord): string {
  return paper.accepted_venue?.trim() || paper.artifacts?.conference?.trim() || "the venue";
}

export function renderDecisionBanners(
  papers: AdminBotPaperRecord[],
  props: PaperWorkspaceProps,
  members: AdminBotLabMember[],
) {
  const memberId = props.memberId;
  if (!memberId) {
    return nothing;
  }
  // A banner stops asking when it is closed by hand this session, or was answered in an earlier
  // one. One answered in *this* session keeps its banner: the click that recorded the answer needs
  // something to confirm against, and a card that vanishes under the button reads as a lost answer.
  const waiting = papers.filter((paper) => {
    if (decisionOf(paper) === null || dismissedDecisions.has(paper.id)) {
      return false;
    }
    return (
      !isDecisionAnswered(paper) || savedDecisions.has(paper.id) || dirtyDecisions.has(paper.id)
    );
  });
  if (waiting.length === 0) {
    return nothing;
  }
  const banner = (paper: AdminBotPaperRecord) => {
    const decision = decisionOf(paper);
    if (!decision) {
      return nothing;
    }
    const saved =
      !dirtyDecisions.has(paper.id) && (savedDecisions.has(paper.id) || isDecisionAnswered(paper));
    const draft = decisionDrafts.get(paper.id) ?? {
      track: publicationTrack(paper),
      presentation: presentationFormat(paper),
      attending: "" as const,
      nextVenue: "",
    };
    return renderDecisionBanner({
      paper,
      decision,
      draft,
      saved,
      dirty: dirtyDecisions.has(paper.id),
      members,
      // One person per paper is asked, and author order decides who. Matched on id where the
      // session carries one and on name otherwise, so a duplicate roster row is still told.
      isEmailOwner: (() => {
        const owner = firstFullMemberAuthor(paper, members);
        if (!owner) {
          return false;
        }
        return owner.id === memberId || isSamePerson(owner.name, props.memberName(memberId));
      })(),
      email: emailTasks.get(paper.id) ?? null,
      emailSent: isDecisionEmailSent(paper),
      onToggleEmail: () => {
        const current = emailTasks.get(paper.id);
        emailTasks.set(paper.id, {
          open: !current?.open,
          body:
            current?.body ??
            buildCoauthorEmail(paper, decision, venueOf(paper), props.memberName(memberId)).body,
        });
        props.onRerender?.();
      },
      onEmailBody: (body) => {
        emailTasks.set(paper.id, { open: true, body });
        props.onRerender?.();
      },
      onResetEmail: () => {
        emailTasks.set(paper.id, {
          open: true,
          body: buildCoauthorEmail(paper, decision, venueOf(paper), props.memberName(memberId))
            .body,
        });
        props.onRerender?.();
      },
      onSetEmailSent: (sent) =>
        props.onSavePaper({
          id: paper.id,
          title: paper.title,
          authors: paper.authors ?? [],
          currentStep: paper.current_step,
          decisionEmailSent: sent ? decisionEmailSentStamp(paper) : "",
        }),
      onReset: () => {
        decisionDrafts.set(paper.id, { track: "", presentation: "", attending: "", nextVenue: "" });
        savedDecisions.delete(paper.id);
        dirtyDecisions.add(paper.id);
        props.onRerender?.();
      },
      onDraft: (patch) => {
        decisionDrafts.set(paper.id, { ...draft, ...patch });
        // Any change re-arms the button: "Saved" must never describe something older than the
        // thing on screen.
        savedDecisions.delete(paper.id);
        dirtyDecisions.add(paper.id);
        props.onRerender?.();
      },
      onSavePaper: (input) => {
        savedDecisions.add(paper.id);
        dirtyDecisions.delete(paper.id);
        props.onSavePaper(input);
      },
      onSetAttendance: (attending) =>
        props.onSetAttendee(paper.id, props.memberName(memberId), memberId, attending),
      onPreRegister: () =>
        openPreRegistrationDialog({
          papers,
          onSavePaper: props.onSavePaper,
          onDone: () => props.onRerender?.(),
        }),
      onDismiss: () => {
        dismissedDecisions.add(paper.id);
        props.onRerender?.();
      },
      collapsed: collapsedDecisions.has(paper.id),
      onToggleCollapsed: () => {
        // Collapsed, not gone: a banner that vanishes on "not now" takes the news with it.
        if (collapsedDecisions.has(paper.id)) {
          collapsedDecisions.delete(paper.id);
        } else {
          collapsedDecisions.add(paper.id);
        }
        props.onRerender?.();
      },
    });
  };
  // Each banner is a whole form; past a few the page is all forms. The rest wait one click down,
  // in the order they were asked.
  if (waiting.length <= DECISION_PREVIEW) {
    return html`${waiting.map(banner)}`;
  }
  return html`${waiting.slice(0, DECISION_PREVIEW).map(banner)}
    <details class="adminbot-fold" data-testid="my-work-more-decisions">
      <summary>${waiting.length - DECISION_PREVIEW} more decisions to record</summary>
      ${waiting.slice(DECISION_PREVIEW).map(banner)}
    </details>`;
}
