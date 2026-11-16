// Research outreach: what the lab tells each institute when papers are accepted.
//
// The Mailing List digest answers "send one list to one address". Outreach is the step after it in
// the lab's guidebook: an acceptance goes to several institutes, each of which wants a different
// subset of the papers (only the head professor's, only a named senior author's, anything by a
// full member, only multi-agent work) written a different way (a numbered record for a lab manager,
// a one-line congratulation for a department newsletter, a grouped list for a LinkedIn post).
//
// Pure, like publication-list.ts: papers, a roster and a configuration go in, drafts come out.
// Three things are deliberately not in this file:
//
// - Addresses. Who receives an outlet's email is deployment configuration (ADMINBOT_OUTREACH_CONFIG),
//   so no contact is committed to the repository and an outlet with no recipients cannot be sent.
// - Sentences nobody recorded. An outlet that wants a one-sentence summary gets a visible
//   placeholder and is marked `needs_edit`, which makes it copy-only. A generated sentence about a
//   paper's findings, mailed to a newsletter under the lab's name, is not this module's to invent.
// - Sending. The route decides who may send and audits it; see api/routes/paper-admin.ts.
import {
  adminBotIsCoauthorMajorType,
  adminBotIsFullMemberType,
  adminBotPaperSteps,
  type AdminBotLabMember,
  type AdminBotPaperPresentationType,
  type AdminBotPaperRecord,
} from "../../contracts/actions.js";
import { isSamePerson } from "../../contracts/person-names.js";
import { acceptedVenueOf, venueKey } from "./publication-list.js";

/**
 * The guidebook's moments, in the order they come: once the submission deadline has passed, on
 * acceptance, at camera-ready, right before the conference.
 */
export type OutreachStage = "submission" | "acceptance" | "camera_ready" | "pre_conference";

/**
 * How a draft leaves the lab. `email` can be sent from AdminBot; `form` is pasted into somebody's
 * web form; `doc` is the start of something a person writes (an article, a blog post) and is never
 * mailed, whatever is configured.
 */
export type OutreachChannel = "email" | "form" | "doc";

/**
 * Which papers an outlet is told about, by who is on them.
 *
 * `pi` is the head professor from settings; `senior` is a named co-author from configuration
 * (somebody whose institute tracks their papers separately); `lab` is any full or major-coauthor
 * member, the head professor included.
 */
export type OutreachAudience = "pi" | "senior" | "pi_or_senior" | "lab";

export type OutreachFormat =
  | "record"
  | "congratulation"
  | "spotlight"
  | "roundup"
  | "achievement"
  | "brief"
  | "grouped"
  | "pitch"
  | "social"
  | "submission"
  | "announcement"
  | "link_nudge"
  | "article"
  | "blog";

export type OutreachOutlet = {
  key: string;
  institute: string;
  label: string;
  stage: OutreachStage;
  channel: OutreachChannel;
  audience: OutreachAudience;
  /** Restricts the outlet to papers on one topic. */
  topic?: "multi_agent";
  /**
   * Which of the venue's papers the outlet draws from. Unset is the accepted ones. `submitted` is
   * everything sent to the venue, whatever was decided since; `no_arxiv` is the accepted papers
   * whose record still has no arXiv link.
   */
  source?: "submitted" | "no_arxiv";
  /** Only the first few papers, most prominent first. */
  limit?: number;
  /**
   * `authors` mails the lab members on the papers themselves, at the addresses the roster holds,
   * instead of a configured list.
   */
  recipients?: "authors";
  cadence: string;
  format: OutreachFormat;
};

/**
 * The outlets the guidebook lists, with the format each one's own newsletter uses.
 *
 * The audiences are defaults read off the guidebook's routing table and can be overridden per
 * outlet in configuration, because "which of our papers does this institute care about" is the
 * lab's call and changes when an affiliation does.
 */
export const OUTREACH_OUTLETS: readonly OutreachOutlet[] = [
  {
    key: "mpi_submissions",
    institute: "MPI-IS",
    label: "Submissions record",
    stage: "submission",
    channel: "email",
    audience: "senior",
    source: "submitted",
    cadence: "once the submission deadline has passed",
    format: "submission",
  },
  {
    key: "mpi_record",
    institute: "MPI-IS",
    label: "Department record",
    stage: "acceptance",
    channel: "email",
    audience: "senior",
    cadence: "on acceptance",
    format: "record",
  },
  {
    key: "mpi_minerva",
    institute: "MPI-IS",
    label: "Minerva Minute",
    stage: "acceptance",
    channel: "email",
    audience: "pi_or_senior",
    cadence: "quarterly",
    format: "brief",
  },
  {
    key: "vector",
    institute: "Vector Institute",
    label: "Faculty newsletter, Spotlight",
    stage: "acceptance",
    channel: "email",
    audience: "pi",
    cadence: "biweekly",
    format: "spotlight",
  },
  {
    key: "dcs",
    institute: "U of T Computer Science",
    label: "CS Connect",
    stage: "acceptance",
    channel: "email",
    audience: "pi",
    cadence: "monthly",
    format: "congratulation",
  },
  {
    key: "sri",
    institute: "Schwartz Reisman Institute",
    label: "Research Round-Up",
    stage: "acceptance",
    channel: "email",
    audience: "pi",
    cadence: "monthly",
    format: "roundup",
  },
  {
    key: "ellis",
    institute: "ELLIS",
    label: "ELLIS Edge",
    stage: "acceptance",
    channel: "email",
    audience: "pi_or_senior",
    cadence: "monthly",
    format: "achievement",
  },
  {
    key: "cls",
    institute: "Center for Learning Systems",
    label: "LinkedIn post",
    stage: "acceptance",
    channel: "form",
    audience: "pi_or_senior",
    cadence: "per conference",
    format: "grouped",
  },
  {
    key: "caif",
    institute: "Cooperative AI Foundation",
    label: "Newsletter",
    stage: "acceptance",
    channel: "email",
    audience: "lab",
    topic: "multi_agent",
    cadence: "monthly",
    format: "brief",
  },
  {
    key: "external_list",
    institute: "Jinesis Lab",
    label: "External mailing list",
    stage: "acceptance",
    channel: "email",
    audience: "lab",
    cadence: "per conference",
    format: "announcement",
  },
  {
    key: "author_links",
    institute: "Paper authors",
    label: "Add the arXiv link",
    stage: "camera_ready",
    channel: "email",
    audience: "lab",
    source: "no_arxiv",
    recipients: "authors",
    cadence: "after camera-ready",
    format: "link_nudge",
  },
  {
    key: "featured_article",
    institute: "Featured article",
    label: "Outline for the top papers",
    stage: "camera_ready",
    channel: "doc",
    audience: "lab",
    limit: 2,
    cadence: "at camera-ready, top one or two papers",
    format: "article",
  },
  {
    key: "lab_blog",
    institute: "Lab website",
    label: "Blog post per paper",
    stage: "camera_ready",
    channel: "doc",
    audience: "lab",
    cadence: "at camera-ready",
    format: "blog",
  },
  {
    key: "cifar_insights",
    institute: "CIFAR",
    label: "Insights blog pitch",
    stage: "camera_ready",
    channel: "form",
    audience: "lab",
    cadence: "at camera-ready, top one or two papers",
    format: "pitch",
  },
  {
    key: "social_managers",
    institute: "Institute social media",
    label: "Conference posts",
    stage: "pre_conference",
    channel: "email",
    audience: "lab",
    cadence: "the week before the conference",
    format: "social",
  },
];

const AUDIENCES: readonly OutreachAudience[] = ["pi", "senior", "pi_or_senior", "lab"];

export type OutreachOutletConfig = {
  to: string[];
  cc: string[];
  form_url?: string;
  audience?: OutreachAudience;
};

export type OutreachConfig = {
  /** Co-authors whose institutes track their papers, as the papers print the names. */
  senior_authors: string[];
  outlets: Record<string, OutreachOutletConfig>;
  /** Why the configuration could not be used. Set means nothing is sendable. */
  error?: string;
};

export const EMPTY_OUTREACH_CONFIG: OutreachConfig = { senior_authors: [], outlets: {} };

const ADDRESS_SHAPE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/u;

function addressList(value: unknown, where: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${where} must be a list of addresses`);
  }
  return value.map((entry) => {
    const address = typeof entry === "string" ? entry.trim() : "";
    if (!ADDRESS_SHAPE.test(address)) {
      throw new Error(`${where} holds something that is not an email address`);
    }
    return address;
  });
}

/**
 * Reads ADMINBOT_OUTREACH_CONFIG:
 *
 *   {"senior_authors": ["Grace Hopper"],
 *    "outlets": {"vector": {"to": ["news@example.org"], "cc": ["editor@example.org"]},
 *                "cls": {"form_url": "https://example.org/form"}}}
 *
 * All or nothing. One bad address makes the whole configuration unusable rather than quietly
 * dropping that recipient, because "the newsletter editor was never on the email" is a failure
 * nobody would notice until the paper was missing from the newsletter.
 */
export function parseOutreachConfig(raw: string | undefined): OutreachConfig {
  const text = (raw ?? "").trim();
  if (!text) {
    return EMPTY_OUTREACH_CONFIG;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("the configuration must be a JSON object");
    }
    const record = parsed as Record<string, unknown>;
    const seniors = record.senior_authors ?? [];
    if (!Array.isArray(seniors) || seniors.some((name) => typeof name !== "string")) {
      throw new Error("senior_authors must be a list of names");
    }
    const outlets: Record<string, OutreachOutletConfig> = {};
    const known = new Set(OUTREACH_OUTLETS.map((outlet) => outlet.key));
    for (const [key, value] of Object.entries((record.outlets ?? {}) as Record<string, unknown>)) {
      if (!known.has(key)) {
        throw new Error(`"${key}" is not an outreach outlet`);
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`outlets.${key} must be an object`);
      }
      const entry = value as Record<string, unknown>;
      const formUrl = typeof entry.form_url === "string" ? entry.form_url.trim() : "";
      if (formUrl && !formUrl.startsWith("https://")) {
        throw new Error(`outlets.${key}.form_url must be an https link`);
      }
      const audience = entry.audience;
      if (audience !== undefined && !AUDIENCES.includes(audience as OutreachAudience)) {
        throw new Error(`outlets.${key}.audience must be one of ${AUDIENCES.join(", ")}`);
      }
      outlets[key] = {
        to: addressList(entry.to, `outlets.${key}.to`),
        cc: addressList(entry.cc, `outlets.${key}.cc`),
        ...(formUrl ? { form_url: formUrl } : {}),
        ...(audience ? { audience: audience as OutreachAudience } : {}),
      };
    }
    return {
      senior_authors: (seniors as string[]).map((name) => name.trim()).filter(Boolean),
      outlets,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ...EMPTY_OUTREACH_CONFIG, error: `outreach configuration is not usable: ${reason}` };
  }
}

type RosterMember = Pick<AdminBotLabMember, "id" | "name" | "member_type"> &
  Partial<Pick<AdminBotLabMember, "email" | "correspondence_email">>;

/** Where a paper sent to a venue stands there. */
export type OutreachSubmissionStatus = "under_review" | "accepted" | "rejected" | "withdrawn";

/** One accepted paper, with the questions the outlets ask of it already answered. */
export type OutreachPaper = {
  id: string;
  title: string;
  authors: string[];
  venue: string;
  url?: string;
  /** One sentence a person wrote for the newsletters that ask for one. */
  summary?: string;
  presentation?: AdminBotPaperPresentationType;
  has_pi: boolean;
  /** The head professor is the first printed author. */
  pi_leads: boolean;
  /** The configured senior authors on this paper, as configured. */
  seniors: string[];
  has_lab_member: boolean;
  multi_agent: boolean;
  /** The record has an arXiv link, not just the Drive PDF. */
  has_arxiv: boolean;
  /** The Drive PDF, when that is all the record has. */
  drive_url?: string;
  /** Roster addresses of the lab members on the paper, the head professor left out. */
  author_emails: string[];
  /** Set when the paper is described as a submission rather than as an acceptance. */
  status?: OutreachSubmissionStatus;
};

// The title and the topic somebody typed are the only topical evidence a paper record carries, so
// this is a suggestion an admin reads rather than a classification: it decides which papers a
// draft *offers* a multi-agent newsletter, and the draft says so.
const MULTI_AGENT_TITLE =
  /multi[-\s]?agent|cooperat|collusi|negotiat|social dilemma|game[-\s]theor/iu;

type DescribeContext = {
  roster: readonly RosterMember[];
  piMemberId?: string;
  seniorAuthors: string[];
};

export function describeOutreachPaper(
  paper: AdminBotPaperRecord,
  context: DescribeContext,
): OutreachPaper | undefined {
  const venue = acceptedVenueOf(paper);
  return venue ? describePaperAt(paper, venue, context) : undefined;
}

const SUBMITTED_FROM = adminBotPaperSteps.indexOf("submission");

/**
 * Where a paper stands at the venue it was sent to, or undefined when nothing says it was sent.
 *
 * "Sent" needs evidence: a decision somebody recorded, an OpenReview submission, or a record that
 * has moved past the submission step. A paper that merely names a venue it is aiming at is not a
 * submission, and telling an institute's record-keeper that it was would be a false record.
 */
export function submissionStatusOf(
  paper: AdminBotPaperRecord,
): OutreachSubmissionStatus | undefined {
  if (acceptedVenueOf(paper)) {
    return "accepted";
  }
  const synced = paper.openreview_sync?.status;
  if (synced === "withdrawn") {
    return "withdrawn";
  }
  if (paper.venue_decision === "reject" || synced === "rejected" || synced === "desk_rejected") {
    return "rejected";
  }
  const pastSubmission = adminBotPaperSteps.indexOf(paper.current_step) > SUBMITTED_FROM;
  return paper.venue_decision === "pending" || synced || pastSubmission
    ? "under_review"
    : undefined;
}

function describePaperAt(
  paper: AdminBotPaperRecord,
  venue: string,
  context: DescribeContext,
): OutreachPaper {
  const authors = paper.authors ?? [];
  const links = paper.author_links ?? [];
  const byId = new Map(context.roster.map((member) => [member.id, member]));
  const pi = context.piMemberId ? byId.get(context.piMemberId) : undefined;
  const isPi = (index: number): boolean => {
    if (!pi) {
      return false;
    }
    // A recorded link is a fact; the printed name is the fallback for rows that predate links.
    return links[index]?.member_id === pi.id || isSamePerson(authors[index] ?? "", pi.name);
  };
  const piIndex = authors.findIndex((_, index) => isPi(index));
  const memberIds = new Set(
    [...links.map((link) => link.member_id), paper.first_author_member_id].filter(
      (id): id is string => Boolean(id),
    ),
  );
  const hasLabMember =
    piIndex >= 0 ||
    [...memberIds].some((id) => {
      const type = byId.get(id)?.member_type;
      return adminBotIsFullMemberType(type) || adminBotIsCoauthorMajorType(type);
    });
  // arXiv once it is up; until then the Drive PDF, which every submitted paper is meant to have,
  // so an acceptance can go out before camera-ready.
  const arxiv = paper.artifacts?.arxiv_url?.trim();
  const drive = paper.artifacts?.google_drive_pdf_url?.trim();
  const url = arxiv || drive;
  const authorEmails = new Set<string>();
  for (const id of memberIds) {
    const member = id === pi?.id ? undefined : byId.get(id);
    // The address the lab writes to, else the one the member signs in with.
    const address = (member?.correspondence_email || member?.email || "").trim();
    if (ADDRESS_SHAPE.test(address)) {
      authorEmails.add(address);
    }
  }
  const summary = normalizeOutreachSummary(paper.artifacts?.outreach_summary ?? "");
  return {
    id: paper.id,
    title: paper.title,
    authors,
    venue,
    ...(url ? { url } : {}),
    ...(summary ? { summary } : {}),
    ...(paper.presentation_type ? { presentation: paper.presentation_type } : {}),
    has_pi: piIndex >= 0,
    pi_leads: piIndex === 0,
    seniors: context.seniorAuthors.filter((name) =>
      authors.some((author) => isSamePerson(author, name)),
    ),
    has_lab_member: hasLabMember,
    multi_agent: MULTI_AGENT_TITLE.test(`${paper.title} ${paper.artifacts?.topic ?? ""}`),
    has_arxiv: Boolean(arxiv),
    ...(!arxiv && drive ? { drive_url: drive } : {}),
    author_emails: [...authorEmails],
  };
}

function inAudience(paper: OutreachPaper, audience: OutreachAudience): boolean {
  switch (audience) {
    case "pi":
      return paper.has_pi;
    case "senior":
      return paper.seniors.length > 0;
    case "pi_or_senior":
      return paper.has_pi || paper.seniors.length > 0;
    case "lab":
      return paper.has_lab_member;
    default:
      return audience satisfies never;
  }
}

/** Most prominent first, so the paper an outlet is most likely to feature leads its list. */
const PROMINENCE: readonly AdminBotPaperPresentationType[] = [
  "award",
  "oral",
  "spotlight",
  "main",
  "findings",
  "poster",
];

function prominence(paper: OutreachPaper): number {
  const rank = paper.presentation ? PROMINENCE.indexOf(paper.presentation) : -1;
  return rank < 0 ? PROMINENCE.length : rank;
}

const PRESENTATION_LABEL: Record<AdminBotPaperPresentationType, string> = {
  award: "Award",
  oral: "Oral",
  spotlight: "Spotlight",
  main: "Main conference",
  findings: "Findings",
  poster: "Poster",
};

/** The placeholder a person replaces. Its presence is what makes a draft copy-only. */
export const OUTREACH_SUMMARY_PLACEHOLDER = "[one-sentence summary]";
export const OUTREACH_SUMMARY_MAX = 400;

/** One line, however it was pasted: a summary sits inside a sentence of somebody's newsletter. */
export function normalizeOutreachSummary(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function summaryOf(paper: OutreachPaper): string {
  return paper.summary ?? OUTREACH_SUMMARY_PLACEHOLDER;
}

/** How the institute's own conference posts mark each kind of presentation. */
const PRESENTATION_EMOJI: Record<AdminBotPaperPresentationType, string> = {
  award: "🏆",
  oral: "🎤",
  spotlight: "🌟",
  main: "📄",
  findings: "📄",
  poster: "📌",
};
const SIGN_OFF = "— AdminBot, on behalf of the Jinesis Lab";

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function authorLine(paper: OutreachPaper): string {
  return paper.authors.join(", ") || "authors not recorded";
}

function withLink(paper: OutreachPaper): string {
  return paper.url ?? "link not recorded";
}

type RenderContext = {
  venue: string;
  piName?: string;
  papers: OutreachPaper[];
  /** The venue's camera-ready date and whether it has gone by, when the deadline data has one. */
  cameraReady?: { date: string; passed: boolean };
};

const STATUS_LABEL: Record<OutreachSubmissionStatus, string> = {
  under_review: "under review",
  accepted: "accepted",
  rejected: "rejected",
  withdrawn: "withdrawn",
};

/** A bracketed prompt in a `doc` draft: the part a person writes. */
const write = (prompt: string): string => `[${prompt}]`;

function presentationTag(paper: OutreachPaper): string {
  return paper.presentation ? ` [${PRESENTATION_LABEL[paper.presentation]}]` : "";
}

function renderBody(format: OutreachFormat, context: RenderContext): string {
  const { venue, papers } = context;
  const count = papers.length;
  const who = context.piName ?? "the Jinesis Lab";
  switch (format) {
    case "record": {
      const seniors = [...new Set(papers.flatMap((paper) => paper.seniors))];
      const involving = seniors.length > 0 ? ` involving ${seniors.join(" and ")}` : "";
      return [
        "Dear all,",
        "",
        `I wanted to share the following ${venue} paper ${plural(count, "acceptance", "acceptances")}${involving}:`,
        "",
        ...papers.map(
          (paper, index) =>
            `${index + 1}. ${paper.title} — ${authorLine(paper)} — ${withLink(paper)}`,
        ),
        "",
        "Please let me know if you need any additional information for the record.",
        "",
        SIGN_OFF,
      ].join("\n");
    }
    case "congratulation":
      return [
        "Hello,",
        "",
        "For the Congratulations section of the next newsletter:",
        "",
        `🎉 ${who} had ${count} ${plural(count, "paper", "papers")} accepted at ${venue}:`,
        ...papers.map((paper) => `• ${paper.title} (${withLink(paper)})`),
        "",
        SIGN_OFF,
      ].join("\n");
    case "spotlight":
      return [
        "Hello,",
        "",
        "For the Spotlight section of the faculty newsletter:",
        "",
        `${who}: ${count} ${plural(count, "paper", "papers")} accepted at ${venue}.`,
        ...papers.map(
          (paper) =>
            `• ${paper.title}${paper.presentation ? ` (${PRESENTATION_LABEL[paper.presentation]})` : ""} — ${withLink(paper)}`,
        ),
        "",
        SIGN_OFF,
      ].join("\n");
    case "roundup":
      return [
        "Hello,",
        "",
        'For "New publications from our community" in the Research Round-Up:',
        "",
        ...papers.map(
          (paper) =>
            `*${paper.title}* (*${venue}*), ${who} (${paper.pi_leads ? "lead author" : "co-author"}) — ${summaryOf(paper)} ${withLink(paper)}`,
        ),
        "",
        SIGN_OFF,
      ].join("\n");
    case "achievement": {
      const featured = papers.filter((paper) => prominence(paper) <= 2);
      return [
        "Hello,",
        "",
        `${count} ${plural(count, "paper", "papers")} from the Jinesis Lab ${plural(count, "was", "were")} accepted at ${venue}${
          featured.length > 0
            ? `, including ${featured.length} selected as award, oral or spotlight`
            : ""
        }.`,
        "",
        ...papers.map(
          (paper) =>
            `• ${paper.title}${paper.presentation ? ` [${PRESENTATION_LABEL[paper.presentation]}]` : ""}\n  ${authorLine(paper)}\n  ${withLink(paper)}`,
        ),
        "",
        SIGN_OFF,
      ].join("\n");
    }
    case "brief":
      return [
        "Hello,",
        "",
        `${plural(count, "A publication", "Publications")} for the next issue, accepted at ${venue}:`,
        "",
        ...papers.map(
          (paper) => `• ${paper.title} (${venue})\n  ${authorLine(paper)}\n  ${withLink(paper)}`,
        ),
        "",
        SIGN_OFF,
      ].join("\n");
    case "grouped": {
      // The form asks for a post; the institute's own posts group by how a paper is presented, and
      // the per-paper block below is what lets the person writing the post say something about each.
      const groups = new Map<string, OutreachPaper[]>();
      for (const paper of papers) {
        const label = paper.presentation
          ? `${PRESENTATION_EMOJI[paper.presentation]} ${PRESENTATION_LABEL[paper.presentation]}`
          : "📄 Accepted";
        groups.set(label, [...(groups.get(label) ?? []), paper]);
      }
      return [
        `Jinesis Lab at ${venue}`,
        "",
        ...[...groups].flatMap(([label, group]) => [
          `${label}:`,
          ...group.map((paper) => `• ${paper.title}`),
          "",
        ]),
        "Per paper:",
        "",
        ...papers.flatMap((paper) => [
          paper.title,
          `Authors: ${authorLine(paper)}`,
          `Presentation: ${paper.presentation ? PRESENTATION_LABEL[paper.presentation] : "not recorded"}`,
          `Link: ${withLink(paper)}`,
          `Summary: ${summaryOf(paper)}`,
          "",
        ]),
      ]
        .join("\n")
        .trimEnd();
    }
    case "pitch":
      return [
        `Featured-article candidates from ${venue}, most prominent first. Pitch one or two.`,
        "",
        ...papers.flatMap((paper) => [
          `${paper.title}${paper.presentation ? ` [${PRESENTATION_LABEL[paper.presentation]}]` : ""}`,
          `Authors: ${authorLine(paper)}`,
          `Link: ${withLink(paper)}`,
          `Why it matters to a non-technical reader: ${summaryOf(paper)}`,
          "",
        ]),
      ]
        .join("\n")
        .trimEnd();
    case "social":
      return [
        "Hello,",
        "",
        `The Jinesis Lab is presenting ${count} ${plural(count, "paper", "papers")} at ${venue}. Details for your conference posts:`,
        "",
        ...papers.map(
          (paper) =>
            `• ${paper.title}${paper.presentation ? ` (${PRESENTATION_LABEL[paper.presentation]})` : ""}\n  ${authorLine(paper)}\n  ${withLink(paper)}`,
        ),
        "",
        SIGN_OFF,
      ].join("\n");
    case "submission": {
      const seniors = [...new Set(papers.flatMap((paper) => paper.seniors))];
      const involving = seniors.length > 0 ? ` involving ${seniors.join(" and ")}` : "";
      return [
        "Dear all,",
        "",
        `For the record, here ${plural(count, "is the paper", `are the ${count} papers`)}${involving} submitted to ${venue}:`,
        "",
        ...papers.map(
          (paper, index) =>
            `${index + 1}. ${paper.title} — ${authorLine(paper)} — ${STATUS_LABEL[paper.status ?? "under_review"]}`,
        ),
        "",
        // Only a promise while something is still undecided; a record of settled papers ends there.
        ...(papers.some((paper) => (paper.status ?? "under_review") === "under_review")
          ? ["The decisions will follow once they are out.", ""]
          : []),
        SIGN_OFF,
      ].join("\n");
    }
    case "announcement":
      return [
        "Hello everyone,",
        "",
        `The Jinesis Lab has ${count} ${plural(count, "paper", "papers")} accepted at ${venue}:`,
        "",
        ...papers.map((paper) =>
          [
            `• ${paper.title}${presentationTag(paper)}`,
            `  ${authorLine(paper)}`,
            // A summary helps here but the list reads without one, so its absence is not a gap.
            ...(paper.summary ? [`  ${paper.summary}`] : []),
            `  ${withLink(paper)}`,
          ].join("\n"),
        ),
        "",
        SIGN_OFF,
      ].join("\n");
    case "link_nudge": {
      const due = context.cameraReady;
      return [
        "Hi all,",
        "",
        `${
          due
            ? `The ${venue} camera-ready ${due.passed ? "was" : "is"} due on ${due.date}. `
            : `Congratulations again on ${venue}. `
        }${plural(count, "The paper below has", "The papers below have")} no arXiv link in AdminBot yet.`,
        "",
        "Once the camera-ready version is on arXiv, please add the link on the paper's page in AdminBot. The institute newsletters, the lab's acceptance sheet and the conference posts all take the link from there, so until it is in, they go out with a Drive link or none.",
        "",
        ...papers.map(
          (paper) =>
            `• ${paper.title}\n  Now: ${paper.drive_url ? `Drive PDF only (${paper.drive_url})` : "no link recorded"}`,
        ),
        "",
        SIGN_OFF,
      ].join("\n");
    }
    case "article":
      return [
        `Featured-article outlines for ${venue}, most prominent first. The bracketed parts are for a person to write; everything else is from the paper's record.`,
        "",
        ...papers.flatMap((paper) => [
          `# ${paper.title}`,
          `${authorLine(paper)} · ${venue}${presentationTag(paper)}`,
          `Paper: ${withLink(paper)}`,
          "",
          `In one sentence: ${paper.summary ?? write("one-sentence summary")}`,
          "",
          write("Opening: the question this paper asks, for a reader outside the field"),
          write("What the authors did"),
          write("What they found, with one concrete result"),
          write("Why it matters, and what comes next"),
          write("A quote from one of the authors"),
          "",
        ]),
      ]
        .join("\n")
        .trimEnd();
    case "blog":
      return papers
        .flatMap((paper) => [
          "---",
          `title: ${JSON.stringify(paper.title)}`,
          `authors: ${JSON.stringify(paper.authors)}`,
          `venue: ${JSON.stringify(`${venue}${paper.presentation ? ` (${PRESENTATION_LABEL[paper.presentation]})` : ""}`)}`,
          `paper: ${JSON.stringify(paper.url ?? "")}`,
          "---",
          "",
          paper.summary ?? write("one-sentence summary"),
          "",
          write("Two or three paragraphs: the problem, the approach, the main result"),
          write("A figure from the paper, with a caption"),
          "",
          `Read the paper: ${withLink(paper)}`,
          "",
        ])
        .join("\n")
        .trimEnd();
    default:
      return format satisfies never;
  }
}

function subjectOf(outlet: OutreachOutlet, venue: string, count: number): string {
  const papers = `${count} ${plural(count, "paper", "papers")}`;
  switch (outlet.format) {
    case "submission":
      return `Jinesis Lab: ${papers} submitted to ${venue}`;
    case "link_nudge":
      return `${venue}: please add the arXiv link for ${plural(count, "your paper", "your papers")}`;
    case "article":
      return `Featured article: ${venue}`;
    case "blog":
      return `Lab blog: ${venue}`;
    default:
      return `Jinesis Lab: ${papers} accepted at ${venue}`;
  }
}

export type OutreachDraft = {
  key: string;
  institute: string;
  label: string;
  stage: OutreachStage;
  channel: OutreachChannel;
  audience: OutreachAudience;
  cadence: string;
  paper_ids: string[];
  subject: string;
  body: string;
  /** The body still holds a placeholder a person must write, so it can only be copied. */
  needs_edit: boolean;
  /** What a reader should know before using the draft. */
  notes: string[];
  to: string[];
  cc: string[];
  form_url?: string;
  /** An email outlet with recipients, papers, and nothing left to write. */
  sendable: boolean;
};

export type OutreachPlan = {
  venue: string;
  papers: OutreachPaper[];
  drafts: OutreachDraft[];
  config_error?: string;
};

/** Addresses out of a settings field a person typed: commas, semicolons or spaces between them. */
function addressesIn(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,;]+/u)
    .map((entry) => entry.trim())
    .filter((entry) => ADDRESS_SHAPE.test(entry));
}

/** Every outlet's draft for one venue: its submissions first, then what was accepted there. */
export function composeOutreach(params: {
  papers: readonly AdminBotPaperRecord[];
  roster: readonly RosterMember[];
  piMemberId?: string;
  /** The venue as the records spell it; matched with `venueKey`. */
  venue: string;
  config: OutreachConfig;
  /**
   * Settings' "where the submissions snapshot goes". Used for the submissions record when the
   * outlet has no recipients of its own in the configuration.
   */
  submissionReportEmail?: string;
  /** The venue's camera-ready deadline as an ISO instant, when the deadline data has one. */
  cameraReadyIso?: string;
  now?: Date;
}): OutreachPlan {
  const wanted = venueKey(params.venue);
  const pi = params.roster.find((member) => member.id === params.piMemberId);
  const context: DescribeContext = {
    roster: params.roster,
    ...(pi ? { piMemberId: pi.id } : {}),
    seniorAuthors: params.config.senior_authors,
  };
  const accepted = params.papers
    .map((paper) => describeOutreachPaper(paper, context))
    .filter((paper): paper is OutreachPaper => Boolean(paper && venueKey(paper.venue) === wanted))
    // Stable within a rank, so papers keep the order the records list them in.
    .toSorted((left, right) => prominence(left) - prominence(right));

  // Everything sent to the venue, in record order. A paper accepted somewhere else after a
  // rejection here still names this venue only if `venue` does, so it is matched on that.
  const submitted: OutreachPaper[] = [];
  let unsubmitted = 0;
  for (const paper of params.papers) {
    const venue = acceptedVenueOf(paper) ?? paper.venue?.trim();
    if (!venue || venueKey(venue) !== wanted) {
      continue;
    }
    const status = submissionStatusOf(paper);
    if (status) {
      submitted.push({ ...describePaperAt(paper, venue, context), status });
    } else {
      unsubmitted += 1;
    }
  }

  const now = params.now ?? new Date();
  const due = params.cameraReadyIso ? new Date(params.cameraReadyIso) : undefined;
  const cameraReady =
    due && !Number.isNaN(due.getTime())
      ? { date: due.toISOString().slice(0, 10), passed: due.getTime() <= now.getTime() }
      : undefined;

  const drafts = OUTREACH_OUTLETS.map((outlet): OutreachDraft => {
    const configured = params.config.outlets[outlet.key];
    const audience = configured?.audience ?? outlet.audience;
    const pool =
      outlet.source === "submitted"
        ? submitted
        : outlet.source === "no_arxiv"
          ? accepted.filter((paper) => !paper.has_arxiv)
          : accepted;
    const papers = pool
      .filter((paper) => inAudience(paper, audience) && (!outlet.topic || paper.multi_agent))
      .slice(0, outlet.limit);
    const notes: string[] = [];
    if (!pi && audience !== "senior") {
      notes.push("No head professor is set in Settings, so their papers cannot be recognised.");
    }
    if (audience !== "pi" && audience !== "lab" && params.config.senior_authors.length === 0) {
      notes.push("No senior authors are configured, so none of their papers are recognised.");
    }
    if (outlet.topic === "multi_agent") {
      notes.push("Papers are suggested from their titles. Check each one is multi-agent work.");
    }
    if (outlet.source === "submitted" && unsubmitted > 0) {
      notes.push(
        `${unsubmitted} ${plural(unsubmitted, "paper names", "papers name")} this venue but ${plural(unsubmitted, "is", "are")} not marked as submitted, and ${plural(unsubmitted, "is", "are")} left out.`,
      );
    }
    // A link is what an acceptance notice is for. A submission has none to give, the nudge exists
    // because it is missing, and a document a person finishes can have it added while they write.
    const wantsLinks = !outlet.source && outlet.channel !== "doc";
    const missingLinks = wantsLinks ? papers.filter((paper) => !paper.url).length : 0;
    if (missingLinks > 0) {
      notes.push(
        `${missingLinks} ${plural(missingLinks, "paper has", "papers have")} no arXiv or Drive link recorded.`,
      );
    }
    if (outlet.format === "link_nudge") {
      notes.push(
        cameraReady
          ? `Camera-ready ${cameraReady.passed ? "was" : "is"} due ${cameraReady.date}${cameraReady.passed ? "" : ". Authors may not have an arXiv version yet"}.`
          : "No camera-ready date is known for this venue, so check it has passed before sending.",
      );
      const unreachable = papers.filter((paper) => paper.author_emails.length === 0).length;
      if (unreachable > 0) {
        notes.push(
          `${unreachable} ${plural(unreachable, "paper has", "papers have")} no lab member with an email on the roster, so nobody is written to about ${plural(unreachable, "it", "them")}.`,
        );
      }
    }
    const body =
      papers.length > 0
        ? renderBody(outlet.format, {
            venue: params.venue,
            ...(pi ? { piName: pi.name } : {}),
            papers,
            ...(cameraReady ? { cameraReady } : {}),
          })
        : "";
    const missingSummary = body.includes(OUTREACH_SUMMARY_PLACEHOLDER);
    if (missingSummary) {
      notes.push(
        "Add each paper's one-sentence summary above. Until then this can be copied, not sent.",
      );
    }
    if (outlet.channel === "doc") {
      notes.push(
        "A starting point for a person to write from. AdminBot fills in what the records hold and nothing else, and never sends it.",
      );
    }
    const needsEdit = missingSummary || (outlet.channel === "doc" && papers.length > 0);
    const configuredTo = configured?.to ?? [];
    const to =
      outlet.recipients === "authors"
        ? [...new Set(papers.flatMap((paper) => paper.author_emails))]
        : configuredTo.length > 0 || outlet.source !== "submitted"
          ? configuredTo
          : addressesIn(params.submissionReportEmail);
    const cc = configured?.cc ?? [];
    return {
      key: outlet.key,
      institute: outlet.institute,
      label: outlet.label,
      stage: outlet.stage,
      channel: outlet.channel,
      audience,
      cadence: outlet.cadence,
      paper_ids: papers.map((paper) => paper.id),
      subject: subjectOf(outlet, params.venue, papers.length),
      body,
      needs_edit: needsEdit,
      notes,
      to,
      cc,
      ...(configured?.form_url ? { form_url: configured.form_url } : {}),
      sendable:
        outlet.channel === "email" &&
        !params.config.error &&
        to.length > 0 &&
        papers.length > 0 &&
        !needsEdit &&
        missingLinks === 0,
    };
  });
  return {
    venue: params.venue,
    papers: accepted,
    drafts,
    ...(params.config.error ? { config_error: params.config.error } : {}),
  };
}

// The acceptance sheet --------------------------------------------------------------------------

/** The header the lab's acceptance tab carries, in its column order. */
export const ACCEPTANCE_SHEET_HEADER = [
  "year",
  "paper title",
  "conference",
  "authors",
  "paper_link",
] as const;

export type AcceptanceRow = {
  paper_id: string;
  year: string;
  title: string;
  conference: string;
  authors: string;
  paper_link: string;
};

const YEAR_IN_VENUE = /\b(20\d{2})\b/u;

/**
 * One row per accepted paper, newest year first.
 *
 * The year is the recorded acceptance year, else the one the venue label carries, else blank:
 * the record's creation date says when somebody typed the paper in, not when it was accepted.
 */
export function acceptanceRows(papers: readonly AdminBotPaperRecord[]): AcceptanceRow[] {
  const rows: AcceptanceRow[] = [];
  for (const paper of papers) {
    const venue = acceptedVenueOf(paper);
    if (!venue) {
      continue;
    }
    const year = paper.accepted_year ? String(paper.accepted_year) : YEAR_IN_VENUE.exec(venue)?.[1];
    rows.push({
      paper_id: paper.id,
      year: year ?? "",
      title: paper.title.trim(),
      // The year has its own column, so the conference reads "NeurIPS", not "NeurIPS 2026".
      conference: venue.replace(YEAR_IN_VENUE, "").replace(/\s+/gu, " ").trim(),
      authors: (paper.authors ?? []).join(", "),
      paper_link:
        paper.artifacts?.arxiv_url?.trim() || paper.artifacts?.google_drive_pdf_url?.trim() || "",
    });
  }
  return rows.toSorted(
    (left, right) =>
      right.year.localeCompare(left.year) ||
      left.conference.localeCompare(right.conference) ||
      left.title.localeCompare(right.title),
  );
}

export function acceptanceRowCells(row: AcceptanceRow): string[] {
  return [row.year, row.title, row.conference, row.authors, row.paper_link];
}

function cellKey(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

/**
 * The rows the sheet does not have yet.
 *
 * A paper is the same row when its title, year and conference match, whatever a person has since
 * done to the authors or link cells: the tab is edited by hand, and re-adding a paper because
 * somebody fixed a name in it would undo their fix with a duplicate.
 *
 * Throws when the tab's first row is not the expected header. Appending five columns under some
 * other header would file years under whatever that tab's first column means.
 */
export function missingAcceptanceRows(
  rows: readonly AcceptanceRow[],
  sheet: readonly (readonly string[])[],
): AcceptanceRow[] {
  const header = (sheet[0] ?? []).map(cellKey);
  if (ACCEPTANCE_SHEET_HEADER.some((name, index) => header[index] !== name)) {
    throw new Error(
      `the acceptance tab's first row must be: ${ACCEPTANCE_SHEET_HEADER.join(", ")}`,
    );
  }
  const present = new Set(
    sheet.slice(1).map((cells) => [cells[1], cells[0], cells[2]].map(cellKey).join("\u0000")),
  );
  return rows.filter(
    (row) => !present.has([row.title, row.year, row.conference].map(cellKey).join("\u0000")),
  );
}
