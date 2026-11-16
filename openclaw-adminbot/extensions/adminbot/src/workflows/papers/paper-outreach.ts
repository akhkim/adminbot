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
  type AdminBotLabMember,
  type AdminBotPaperPresentationType,
  type AdminBotPaperRecord,
} from "../../contracts/actions.js";
import { isSamePerson } from "../../contracts/person-names.js";
import { acceptedVenueOf, venueKey } from "./publication-list.js";

/** The guidebook's three moments: on acceptance, at camera-ready, right before the conference. */
export type OutreachStage = "acceptance" | "camera_ready" | "pre_conference";

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
  | "social";

export type OutreachOutlet = {
  key: string;
  institute: string;
  label: string;
  stage: OutreachStage;
  /** `form` outlets are submitted by a person through a web form; they are never mailed. */
  channel: "email" | "form";
  audience: OutreachAudience;
  /** Restricts the outlet to papers on one topic. */
  topic?: "multi_agent";
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

type RosterMember = Pick<AdminBotLabMember, "id" | "name" | "member_type">;

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
};

// The title and the topic somebody typed are the only topical evidence a paper record carries, so
// this is a suggestion an admin reads rather than a classification: it decides which papers a
// draft *offers* a multi-agent newsletter, and the draft says so.
const MULTI_AGENT_TITLE =
  /multi[-\s]?agent|cooperat|collusi|negotiat|social dilemma|game[-\s]theor/iu;

export function describeOutreachPaper(
  paper: AdminBotPaperRecord,
  context: { roster: readonly RosterMember[]; piMemberId?: string; seniorAuthors: string[] },
): OutreachPaper | undefined {
  const venue = acceptedVenueOf(paper);
  if (!venue) {
    return undefined;
  }
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
  const url = paper.artifacts?.arxiv_url?.trim() || paper.artifacts?.google_drive_pdf_url?.trim();
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

type RenderContext = { venue: string; piName?: string; papers: OutreachPaper[] };

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
    default:
      return format satisfies never;
  }
}

export type OutreachDraft = {
  key: string;
  institute: string;
  label: string;
  stage: OutreachStage;
  channel: "email" | "form";
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

/** Every outlet's draft for the papers accepted at one venue. */
export function composeOutreach(params: {
  papers: readonly AdminBotPaperRecord[];
  roster: readonly RosterMember[];
  piMemberId?: string;
  /** The venue as the records spell it; matched with `venueKey`. */
  venue: string;
  config: OutreachConfig;
}): OutreachPlan {
  const wanted = venueKey(params.venue);
  const pi = params.roster.find((member) => member.id === params.piMemberId);
  const accepted = params.papers
    .map((paper) =>
      describeOutreachPaper(paper, {
        roster: params.roster,
        ...(pi ? { piMemberId: pi.id } : {}),
        seniorAuthors: params.config.senior_authors,
      }),
    )
    .filter((paper): paper is OutreachPaper => Boolean(paper && venueKey(paper.venue) === wanted))
    // Stable within a rank, so papers keep the order the records list them in.
    .toSorted((left, right) => prominence(left) - prominence(right));

  const drafts = OUTREACH_OUTLETS.map((outlet): OutreachDraft => {
    const configured = params.config.outlets[outlet.key];
    const audience = configured?.audience ?? outlet.audience;
    const papers = accepted.filter(
      (paper) => inAudience(paper, audience) && (!outlet.topic || paper.multi_agent),
    );
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
    const missingLinks = papers.filter((paper) => !paper.url).length;
    if (missingLinks > 0) {
      notes.push(
        `${missingLinks} ${plural(missingLinks, "paper has", "papers have")} no arXiv or Drive link recorded.`,
      );
    }
    const body =
      papers.length > 0
        ? renderBody(outlet.format, {
            venue: params.venue,
            ...(pi ? { piName: pi.name } : {}),
            papers,
          })
        : "";
    const needsEdit = body.includes(OUTREACH_SUMMARY_PLACEHOLDER);
    if (needsEdit) {
      notes.push(
        "Add each paper's one-sentence summary above. Until then this can be copied, not sent.",
      );
    }
    const to = configured?.to ?? [];
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
      subject: `Jinesis Lab: ${papers.length} ${plural(papers.length, "paper", "papers")} accepted at ${params.venue}`,
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
