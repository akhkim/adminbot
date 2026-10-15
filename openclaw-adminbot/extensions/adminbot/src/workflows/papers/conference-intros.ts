// Who AdminBot introduces to whom at a conference, and what the introduction says.
//
// The roster answers "who is going to EMNLP" but nobody acts on it: two people from the lab can
// spend four days in the same convention centre and meet at the airport. The intro is one Slack
// group DM of three -- the person who just confirmed Going and the two co-attendees whose research
// is closest to theirs -- carrying the things they would otherwise each look up: when, where, and
// the event page.
//
// Three and not the whole roster, because that is what the conference channel is for; a group DM
// of everyone is a second channel without a name. Two partners rather than one, because a pair
// whose single match is on a different schedule is no introduction at all.
//
// Everything here is pure and deterministic. The partners and the text land in a proposal's
// payload, and the payload hash is bound to approval and replay: a "random" pick that changed
// between the proposal and its retry would read as a tampered payload, so the fallback sample is
// a seeded hash, not Math.random.
import type { TravelConferenceSite } from "../members/lab-travel.js";
import type { ResearchThemeId } from "../members/research-themes.js";

/** One Going lab member the intro can name. */
export type IntroCandidate = {
  member_id: string;
  name: string;
  slack_user_id: string;
  themes: readonly ResearchThemeId[];
};

/** A partner picked for the subject, and why. */
export type IntroPartner = IntroCandidate & {
  /** Themes shared with the subject; empty when the pick came from the seeded sample. */
  shared_themes: ResearchThemeId[];
};

export const CONFERENCE_INTRO_PARTNERS = 2;

/**
 * FNV-1a over a string, as an unsigned 32-bit integer.
 *
 * Only a tiebreak, so the property that matters is stability across processes and Node versions,
 * not distribution quality.
 */
function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The subject's two partners: most shared research themes first, then a seeded random sample.
 *
 * Ranking by overlap count, with the seeded hash breaking ties, gives both halves of the rule in
 * one sort: when two or more co-attendees share themes they win on overlap, and when nobody does
 * every score is zero and the order is the sample. The seed is the conference and the subject, so
 * the same person at the same conference is always offered the same people, and two different
 * people with no overlap are not all handed the same pair.
 *
 * Returns fewer than two when there are not enough candidates; the caller decides whether that is
 * worth a message (it is not -- a pair is a DM, not an introduction).
 */
export function pickIntroPartners(
  subject: IntroCandidate,
  candidates: readonly IntroCandidate[],
  seed: string,
): IntroPartner[] {
  const mine = new Set(subject.themes);
  return candidates
    .filter((candidate) => candidate.member_id !== subject.member_id)
    .map((candidate) => ({
      ...candidate,
      shared_themes: candidate.themes.filter((theme) => mine.has(theme)),
      tiebreak: stableHash(`${seed}:${subject.member_id}:${candidate.member_id}`),
    }))
    .sort(
      (a, b) =>
        b.shared_themes.length - a.shared_themes.length ||
        a.tiebreak - b.tiebreak ||
        a.member_id.localeCompare(b.member_id),
    )
    .slice(0, CONFERENCE_INTRO_PARTNERS)
    .map(({ tiebreak: _tiebreak, ...partner }) => partner);
}

/** A map search for a free-text location. No API key, and it opens the app on a phone. */
export function conferenceMapUrl(location: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
}

function formatDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      });
}

function siteWhen(site: TravelConferenceSite): string | undefined {
  if (!site.starts) return undefined;
  return site.ends && site.ends !== site.starts
    ? `${formatDay(site.starts)} - ${formatDay(site.ends)}`
    : formatDay(site.starts);
}

function siteWhere(site: TravelConferenceSite): string | undefined {
  return site.location?.trim() || [site.city, site.country].filter(Boolean).join(", ") || undefined;
}

/** Whole days from `today` to the conference's first day, or undefined without a start date. */
function daysUntil(today: string, starts: string | undefined): number | undefined {
  if (!starts) return undefined;
  const ms = Date.parse(`${starts}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : undefined;
}

/**
 * The intro text. Plain text: the executor posts with mrkdwn off so a name cannot inject markup.
 *
 * `sites` are the dataset's rows for this conference (more than one for a multi-site meeting such
 * as NeurIPS). None is a real case -- a venue the collector does not cover -- and the message says
 * so rather than inventing a date or a city.
 */
export function buildConferenceIntroMessage(params: {
  conference_label: string;
  subject: IntroCandidate;
  partners: readonly IntroPartner[];
  sites: readonly TravelConferenceSite[];
  theme_labels: ReadonlyMap<string, string>;
  today: string;
}): string {
  const { subject, partners, sites } = params;
  const names = partners.map((partner) => partner.name);
  const lines = [
    `Hi ${subject.name}, ${names.join(" and ")} -- you are all going to ${params.conference_label}, so AdminBot is introducing you.`,
  ];
  for (const partner of partners) {
    const shared = partner.shared_themes.map((id) => params.theme_labels.get(id) ?? id);
    lines.push(
      shared.length > 0
        ? `- ${subject.name} and ${partner.name} both work on ${shared.join(", ")}.`
        : `- ${partner.name} is also going (picked at random from the lab's attendees).`,
    );
  }
  lines.push("");
  if (sites.length === 0) {
    lines.push(
      "AdminBot has no dates or location on file for this conference yet; check the event page.",
    );
  }
  for (const site of sites) {
    if (sites.length > 1) lines.push(`${site.label}:`);
    const when = siteWhen(site);
    const until = daysUntil(params.today, site.starts);
    if (when) {
      lines.push(
        `When: ${when}${until !== undefined && until > 0 ? ` (in ${until} day${until === 1 ? "" : "s"})` : ""}`,
      );
    }
    const where = siteWhere(site);
    if (where) lines.push(`Where: ${where} - ${conferenceMapUrl(where)}`);
    if (site.homepage_url) lines.push(`Event page: ${site.homepage_url}`);
  }
  lines.push("", "Worth planning a coffee or a poster walk together.");
  return lines.join("\n");
}
