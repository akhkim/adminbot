// Who AdminBot introduces to whom at a conference, and what the introduction says.
//
// The roster answers "who is going to EMNLP" but nobody acts on it: two people from the lab can
// spend four days in the same convention centre and meet at the airport. The intro is one Slack
// group DM of three -- the person who just confirmed Going and the two co-attendees whose research
// is closest to theirs -- carrying the things they would otherwise each look up: when, where, and
// the event page.
//
// Three and not the whole roster, because that is what the conference channel is for; a group DM
// of everyone is a second channel without a name. The two partners are one best research match
// and one wildcard drawn at random, because the lab-mates you already share a theme with are the
// ones you would have found anyway; the wildcard is the serendipity.
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
  /** The member's current project titles, for a conversation starter. */
  projects?: readonly string[];
};

/** A partner picked for the subject, and why. */
export type IntroPartner = IntroCandidate & {
  /** Themes shared with the subject; empty when the pick came from the seeded sample. */
  shared_themes: ResearchThemeId[];
  /** Drawn at random from the rest rather than for shared research; the message says so. */
  wildcard?: boolean;
};

export const CONFERENCE_INTRO_PARTNERS = 2;

/**
 * FNV-1a over a string, as an unsigned 32-bit integer.
 *
 * Only a tiebreak, so the property that matters is stability across processes and Node versions,
 * not distribution quality.
 */
export function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The subject's partners: the best research match, then one wildcard.
 *
 * The match is the head of rankIntroPartners (most shared themes, seeded tiebreak). The wildcard is
 * drawn from everyone else with a differently salted hash, so it is random across people and
 * events but the same on every retry of one intro -- the payload hash is bound to approval, and a
 * pick that changed between proposal and replay would read as tampering. Pass a list that already
 * skips spent pairs and the wildcard never repeats a pair either.
 *
 * Returns fewer than two when there are not enough candidates.
 */
export function pickIntroPartners(
  subject: IntroCandidate,
  candidates: readonly IntroCandidate[],
  seed: string,
): IntroPartner[] {
  return withWildcard(subject, rankIntroPartners(subject, candidates, seed), seed);
}

/** The head of `ranked` plus one seeded wildcard from the rest. `ranked` is already filtered. */
export function withWildcard(
  subject: Pick<IntroCandidate, "member_id">,
  ranked: readonly IntroPartner[],
  seed: string,
): IntroPartner[] {
  const [best, ...rest] = ranked;
  if (!best) {
    return [];
  }
  const draw = (partner: IntroPartner) =>
    stableHash(`${seed}:wildcard:${subject.member_id}:${partner.member_id}`);
  const wildcard = rest.toSorted(
    (a, b) => draw(a) - draw(b) || a.member_id.localeCompare(b.member_id),
  )[0];
  return wildcard ? [best, { ...wildcard, wildcard: true }] : [best];
}

/** Every candidate in pickIntroPartners' order, for a caller that has to skip some (pair history). */
export function rankIntroPartners(
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

// --- the message ----------------------------------------------------------------------------------
//
// Short and warm: a header, who and why, one idea, one opener, and a quiet footer saying why you got
// it and how to pause. Block Kit for Slack, with the same words as plain text for the notification
// preview and any client that cannot draw blocks.

/** A Slack Block Kit block, as chat.postMessage takes it. */
export type SlackBlock = Record<string, unknown>;

/** What an intro posts. `text` is the notification and fallback; `blocks` is what people see. */
export type IntroMessage = { text: string; blocks: SlackBlock[] };

/** One concrete thing to do, which is what turns "you should meet" into a meeting. */
export const EVENT_SUGGESTION = "Grab a coffee between sessions, or walk the posters together.";
export const CITY_SUGGESTION = "Lunch or a coffee somewhere central this week?";
export const CITY_COFFEE_SUGGESTION = "Grab a coffee. No agenda needed.";

/**
 * Openers, rotated by a seeded hash of the intro's own key so the same intro always carries the
 * same question (the payload is hashed for replay) and different intros do not all ask the same.
 */
const EVENT_OPENERS = [
  "Which talk on the program would you skip for a good coffee?",
  "What's the one poster you'd drag the others to see?",
  "Gentle hot take: what's the most overrated idea at this conference?",
  "What paper would you happily reread on the flight home?",
] as const;
const CITY_OPENERS = [
  "What's the best thing you've eaten around here so far?",
  "Best coffee within walking distance: who knows a spot?",
] as const;
const ANYWHERE_OPENERS = [
  "If compute were free for a month, what would you train?",
  "What's one result you believed for far too long?",
  "What's the most underrated tool in your workflow?",
  "What side project could you pitch in one sentence?",
] as const;

export function pickOpener(kind: "event" | "city", seed: string): string {
  const pool = [...(kind === "event" ? EVENT_OPENERS : CITY_OPENERS), ...ANYWHERE_OPENERS];
  return pool[stableHash(`${seed}:opener`) % pool.length]!;
}

/** Slack mrkdwn escaping, plus the formatting characters a name could use to restyle the text. */
function md(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/[*_~`]/gu, "");
}

/** `<url|label>` for an http(s) URL Slack can parse, else just the label. */
function mdLink(url: string | undefined, label: string): string {
  return url && /^https?:\/\/[^\s<>|]+$/u.test(url) ? `<${url}|${md(label)}>` : md(label);
}

function nameList(names: readonly string[]): string {
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Two strings for each line: plain for the fallback, mrkdwn for the block. */
type Line = { plain: string; md: string };

const bold = (name: string) => `*${md(name)}*`;

function partnerLine(
  partner: IntroPartner,
  themeLabels: ReadonlyMap<string, string>,
  there: string,
): Line {
  const themes = nameList(partner.shared_themes.map((id) => themeLabels.get(id) ?? id));
  if (partner.wildcard) {
    const tail = themes
      ? `picked at random, and it turns out you both like ${themes} too.`
      : "picked at random, because the best lab chats are often off-topic.";
    return {
      plain: `${partner.name} is this round's wildcard: ${tail}`,
      md: `${bold(partner.name)} is this round's wildcard: ${md(tail)}`,
    };
  }
  const rest = themes ? `also works on ${themes}.` : `is ${there} too.`;
  return { plain: `${partner.name} ${rest}`, md: `${bold(partner.name)} ${md(rest)}` };
}

function compose(params: {
  header: string;
  hello: Line;
  partners: readonly IntroPartner[];
  theme_labels: ReadonlyMap<string, string>;
  there: string;
  details?: Line[];
  suggestion: string;
  opener: string;
  reason: string;
  events_url: string;
}): IntroMessage {
  const who = [
    params.hello,
    ...params.partners.map((p) => partnerLine(p, params.theme_labels, params.there)),
  ];
  const footer: Line = {
    plain: `You're getting this because ${params.reason}. Pause or turn off in AdminBot > Events: ${params.events_url}`,
    md: `You're getting this because ${md(params.reason)} · ${mdLink(params.events_url, "Pause or turn off in AdminBot › Events")}`,
  };
  const text = [
    params.header,
    ...who.map((line) => line.plain),
    ...(params.details?.length ? ["", ...params.details.map((line) => line.plain)] : []),
    "",
    `Idea: ${params.suggestion}`,
    `Opener: ${params.opener}`,
    footer.plain,
  ].join("\n");
  const section = (body: string): SlackBlock => ({
    type: "section",
    text: { type: "mrkdwn", text: body },
  });
  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: params.header.slice(0, 150), emoji: true },
    },
    section(who.map((line) => line.md).join("\n")),
    ...(params.details?.length ? [section(params.details.map((line) => line.md).join("\n"))] : []),
    section(`*Idea:* ${md(params.suggestion)}\n*Opener:* _${md(params.opener)}_`),
    { type: "context", elements: [{ type: "mrkdwn", text: footer.md }] },
  ];
  return { text, blocks };
}

function eventDetails(sites: readonly TravelConferenceSite[], today: string): Line[] {
  if (sites.length === 0) {
    const note = "No dates or location on file yet; check the event page.";
    return [{ plain: note, md: `_${md(note)}_` }];
  }
  const lines: Line[] = [];
  for (const site of sites) {
    if (sites.length > 1) {
      lines.push({ plain: `${site.label}:`, md: `*${md(site.label)}*` });
    }
    const when = siteWhen(site);
    const until = daysUntil(today, site.starts);
    if (when) {
      const soon =
        until !== undefined && until > 0 ? ` (in ${until} day${until === 1 ? "" : "s"})` : "";
      lines.push({ plain: `When: ${when}${soon}`, md: `*When* ${md(when + soon)}` });
    }
    const where = siteWhere(site);
    if (where) {
      const map = conferenceMapUrl(where);
      lines.push({ plain: `Where: ${where} - ${map}`, md: `*Where* ${mdLink(map, where)}` });
    }
    if (site.homepage_url) {
      lines.push({
        plain: `Event page: ${site.homepage_url}`,
        md: mdLink(site.homepage_url, "Event page"),
      });
    }
  }
  return lines;
}

const together = (count: number) => (count === 2 ? "both" : "all");

/**
 * The event intro.
 *
 * `sites` are the dataset's rows for this conference (more than one for a multi-site meeting such
 * as NeurIPS). None is a real case -- a venue the collector does not cover -- and the message says
 * so rather than inventing a date or a city.
 *
 * `in_town` names the place when somebody in the group is there without having said Going (the
 * sign-in placed them in the city during the event): "all going to" would then be untrue.
 */
export function buildConferenceIntroMessage(params: {
  conference_label: string;
  subject: IntroCandidate;
  partners: readonly IntroPartner[];
  sites: readonly TravelConferenceSite[];
  theme_labels: ReadonlyMap<string, string>;
  today: string;
  in_town?: string;
  /** The intro's idempotency key: picks the opener. */
  seed: string;
  events_url: string;
}): IntroMessage {
  const { subject, partners } = params;
  const all = together(partners.length + 1);
  const why = params.in_town
    ? `you're ${all} around ${params.conference_label} in ${params.in_town} this week`
    : `you're ${all} going to ${params.conference_label}`;
  const names = partners.map((p) => p.name);
  return compose({
    header: `☕ ${why.charAt(0).toUpperCase()}${why.slice(1)}`,
    hello: {
      plain: `${subject.name}, meet ${nameList(names)}.`,
      md: `${bold(subject.name)}, meet ${nameList(names.map(bold))}.`,
    },
    partners,
    theme_labels: params.theme_labels,
    there: params.in_town ? "there" : "going",
    details: eventDetails(params.sites, params.today),
    suggestion: EVENT_SUGGESTION,
    opener: pickOpener("event", params.seed),
    reason: why,
    events_url: params.events_url,
  });
}

/**
 * The city intro: the metro is the reason, and there is no event block.
 *
 * `place_label` is the metro ("San Francisco Bay Area"), never the city a sign-in resolved to.
 * When nobody shares research the intro is pure serendipity and says so: "you're both in Boston
 * this week; grab a coffee".
 */
export function buildCityIntroMessage(params: {
  place_label: string;
  subject: IntroCandidate;
  partners: readonly IntroPartner[];
  theme_labels: ReadonlyMap<string, string>;
  seed: string;
  events_url: string;
}): IntroMessage {
  const { subject, partners } = params;
  const all = together(partners.length + 1);
  const shared = partners.some((p) => p.shared_themes.length > 0);
  const names = partners.map((p) => p.name);
  return compose({
    header: `☕ You're ${all} in ${params.place_label} this week`,
    hello: {
      plain: `${subject.name}, meet ${nameList(names)}.`,
      md: `${bold(subject.name)}, meet ${nameList(names.map(bold))}.`,
    },
    partners,
    theme_labels: params.theme_labels,
    there: "in town",
    suggestion: shared ? CITY_SUGGESTION : CITY_COFFEE_SUGGESTION,
    opener: pickOpener("city", params.seed),
    reason: `you're ${all} around ${params.place_label} this week`,
    events_url: params.events_url,
  });
}

/**
 * Say hi: the member tapped the button, so the message is from them, not from AdminBot's matching.
 * `event` for an event card, `place_label` for a Nearby now face.
 */
export function buildSayHiMessage(params: {
  sender: IntroCandidate;
  partners: readonly IntroPartner[];
  theme_labels: ReadonlyMap<string, string>;
  event?: {
    conference_label: string;
    sites: readonly TravelConferenceSite[];
    today: string;
    sender_going: boolean;
  };
  place_label?: string;
  seed: string;
  events_url: string;
}): IntroMessage {
  const { sender, partners, event } = params;
  const others = partners.length === 1 ? "you're" : "you're all";
  const spotted = event
    ? `saw ${others} going to ${event.conference_label}${event.sender_going ? " too" : ""}`
    : `saw ${others} around ${params.place_label ?? "town"} this week`;
  return compose({
    header: `👋 ${sender.name} says hi`,
    hello: {
      plain: `${sender.name} ${spotted} and started this chat.`,
      md: `${bold(sender.name)} ${md(spotted)} and started this chat.`,
    },
    partners: partners.map(({ wildcard: _wildcard, ...p }) => p),
    theme_labels: params.theme_labels,
    there: event ? "going" : "in town",
    ...(event ? { details: eventDetails(event.sites, event.today) } : {}),
    suggestion: event ? EVENT_SUGGESTION : CITY_COFFEE_SUGGESTION,
    opener: pickOpener(event ? "event" : "city", params.seed),
    reason: `${sender.name} tapped Say hi in AdminBot`,
    events_url: params.events_url,
  });
}
