// Every project in the lab, one row each, for the admins' Lab Projects page.
//
// My Projects answers "what is on my plate"; this answers "what is the lab working on", so it is
// keyed by project rather than by person and lists every paper, not only the viewer's. It is built
// from the same records My Projects reads (papers, their evidence slots, weekly updates, help
// requests) and adds no storage of its own.
//
// What it leaves out matters as much as what it carries, because a list is read at a glance and
// copied around: no credential (the Overleaf share link, the arXiv paper password), no email of
// anybody off the roster, and no prose -- notes and weekly-update bodies stay on the project page,
// where the reader has asked for that one paper.
import {
  adminBotProjectChannelName,
  type AdminBotLabMember,
  type AdminBotPaperRecord,
} from "../../contracts/actions.js";
import type { LabHelpRequest } from "../../contracts/lab-sharing.js";
import type { AdminBotSocialDraftRecord } from "../../contracts/paper-cycle.js";
import type { AdminBotPaperSlot, AdminBotPaperSlotRecord } from "../../contracts/paper-slots.js";
import type { AdminBotPaperWeeklyUpdate } from "../../contracts/paper-weekly-updates.js";
import { summarizeProject, type AdminBotMyProjectSummary } from "./my-projects.js";
import { paperIdsByOwner, rosterNameCounts } from "./paper-ownership.js";
import { isPaperClosed, isPaperDormant } from "./paper-slots.js";

/** Where a project stands overall. Rejected and completed both count as closed. */
export type AdminBotLabProjectStatus = "active" | "dormant" | "completed" | "rejected";

/** What the primary paper link points at, so the page can label it honestly. */
export type AdminBotLabProjectPaperLinkKind =
  | "arxiv"
  | "pdf"
  | "submission"
  | "overleaf_view"
  | "github"
  | "project_doc";

export type AdminBotLabProjectLink = { url: string } | null;

export type AdminBotLabProject = AdminBotMyProjectSummary & {
  status: AdminBotLabProjectStatus;
  topic?: string;
  /** Open help-request tags: what the project says it needs, which is also what it is about. */
  tags: string[];
  /** Lab members on the paper, resolved the same way My Projects decides ownership. */
  members: Array<{ member_id: string; name: string }>;
  /** The author line as printed, minus anything that is an email address. */
  authors: string[];
  /** Latest of the record, its evidence slots and its weekly updates. */
  last_update_at: string;
  /** The newest weekly update's who and when. The text itself is on the project page. */
  last_weekly_update?: { week_start: string; member_id: string; name?: string; updated_at: string };
  links: {
    /** Paper, else repository, else the project's weekly-update / brainstorm doc. */
    primary: (AdminBotLabProjectLink & { kind: AdminBotLabProjectPaperLinkKind }) | null;
    github: AdminBotLabProjectLink;
    /** The channel the alias names (`proj-<alias>`); null when the project has no alias. */
    slack_channel: string | null;
    slides: AdminBotLabProjectLink;
    poster: AdminBotLabProjectLink;
  };
};

export type AdminBotLabProjectSources = {
  papers: readonly AdminBotPaperRecord[];
  roster: readonly AdminBotLabMember[];
  slots: (paperId: string) => AdminBotPaperSlotRecord[];
  drafts: (paperId: string) => AdminBotSocialDraftRecord[];
  weeklyUpdates: readonly AdminBotPaperWeeklyUpdate[];
  helpRequests: readonly LabHelpRequest[];
  now: Date;
};

function labProjectStatus(paper: AdminBotPaperRecord, now: Date): AdminBotLabProjectStatus {
  if (paper.venue_decision === "reject") {
    return "rejected";
  }
  if (isPaperClosed(paper)) {
    return "completed";
  }
  return isPaperDormant(paper, now) ? "dormant" : "active";
}

/** A link a person filed and nobody has marked wrong. Only https, so a stray value is not a href. */
function safeUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^https:\/\//iu.test(trimmed) ? trimmed : undefined;
}

function slotUrl(slots: readonly AdminBotPaperSlotRecord[], slot: AdminBotPaperSlot) {
  const row = slots.find((entry) => entry.slot === slot);
  return row && row.status !== "invalid" ? safeUrl(row.url) : undefined;
}

function latest(values: Array<string | undefined>): string | undefined {
  let best: string | undefined;
  for (const value of values) {
    if (
      value &&
      Number.isFinite(Date.parse(value)) &&
      (!best || Date.parse(value) > Date.parse(best))
    ) {
      best = value;
    }
  }
  return best;
}

export function buildLabProjects(sources: AdminBotLabProjectSources): AdminBotLabProject[] {
  const { papers, roster, now } = sources;
  const names = new Map(roster.map((member) => [member.id, member.name]));
  const ownersByPaper = new Map<string, string[]>();
  for (const [memberId, paperIds] of paperIdsByOwner(roster, papers, rosterNameCounts(roster))) {
    for (const paperId of paperIds) {
      ownersByPaper.set(paperId, [...(ownersByPaper.get(paperId) ?? []), memberId]);
    }
  }
  const updatesByPaper = new Map<string, AdminBotPaperWeeklyUpdate[]>();
  for (const update of sources.weeklyUpdates) {
    updatesByPaper.set(update.paper_id, [...(updatesByPaper.get(update.paper_id) ?? []), update]);
  }

  return papers
    .map((paper): AdminBotLabProject => {
      const slots = sources.slots(paper.id);
      const artifacts = paper.artifacts ?? {};
      const updates = (updatesByPaper.get(paper.id) ?? []).toSorted(
        (left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at),
      );
      const newest = updates[0];

      const paperLink: [AdminBotLabProjectPaperLinkKind, string | undefined][] = [
        ["arxiv", slotUrl(slots, "arxiv") ?? safeUrl(artifacts.arxiv_url)],
        ["pdf", slotUrl(slots, "drive_pdf_arxiv") ?? safeUrl(artifacts.google_drive_pdf_url)],
        ["submission", slotUrl(slots, "submission") ?? safeUrl(artifacts.submission_url)],
        ["overleaf_view", slotUrl(slots, "overleaf_view") ?? safeUrl(artifacts.overleaf_view_url)],
        ["github", safeUrl(artifacts.github_url)],
        [
          "project_doc",
          slotUrl(slots, "project_folder") ?? safeUrl(artifacts.brainstorming_doc_url),
        ],
      ];
      const primary = paperLink.find(([, url]) => url);
      const github = safeUrl(artifacts.github_url);
      const slides = slotUrl(slots, "slides") ?? safeUrl(artifacts.google_slides_url);
      const poster = slotUrl(slots, "poster") ?? safeUrl(artifacts.poster_url);
      const topic = artifacts.topic?.trim();
      const tags = [
        ...new Set(
          sources.helpRequests
            .filter((request) => request.paper_id === paper.id && request.status === "open")
            .flatMap((request) => request.tags.map((tag) => tag.trim()).filter(Boolean)),
        ),
      ];

      return Object.assign(summarizeProject(paper, slots, sources.drafts(paper.id)), {
        status: labProjectStatus(paper, now),
        ...(topic ? { topic } : {}),
        tags,
        members: (ownersByPaper.get(paper.id) ?? [])
          .map((memberId) => ({ member_id: memberId, name: names.get(memberId) ?? memberId }))
          .toSorted((left, right) => left.name.localeCompare(right.name)),
        authors: paper.authors.filter((author) => author.trim() && !author.includes("@")),
        last_update_at:
          latest([
            paper.updated_at,
            ...slots.map((slot) => slot.provided_at),
            ...updates.map((update) => update.updated_at),
          ]) ?? paper.updated_at,
        ...(newest
          ? {
              last_weekly_update: {
                week_start: newest.week_start,
                member_id: newest.member_id,
                ...(names.has(newest.member_id) ? { name: names.get(newest.member_id) } : {}),
                updated_at: newest.updated_at,
              },
            }
          : {}),
        links: {
          primary: primary?.[1] ? { kind: primary[0], url: primary[1] } : null,
          github: github ? { url: github } : null,
          slack_channel: paper.alias ? adminBotProjectChannelName(paper.alias) : null,
          slides: slides ? { url: slides } : null,
          poster: poster ? { url: poster } : null,
        },
      });
    })
    .toSorted((left, right) => Date.parse(right.last_update_at) - Date.parse(left.last_update_at));
}
