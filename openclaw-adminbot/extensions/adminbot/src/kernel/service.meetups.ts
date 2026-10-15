// The Events tab and the intros that come with it: who is going where, who is nearby, and the
// three-person Slack group DM that turns "two lab members in the same city" into a coffee.
//
// The rules (docs/operations/conference-intros.md says them for humans):
//   - Zero setup: both kinds are on for every active member with Slack linked. The controls are the
//     footer link in every intro, the Events tab and the profile toggle; an admin's do_not_contact
//     wins over all of them, and such a member is never asked, named or listed.
//   - Each intro is the best research match plus one seeded wildcard (withWildcard). Matching is
//     by research interest; place only decides that an intro is worth making this week. Nothing here follows anybody: a place is the city the last sign-in
//     resolved to, or what the member wrote on their profile, compared as a metro.
//   - Event intros (default on): people Going to the same event, plus people whose sign-in puts them
//     in the event's city while it runs *and* who opted in to city intros. One per member per event,
//     and never the same pair twice (any intro, event or city).
//   - City intros (default on): 2+ members whose sign-in in the last 7 days is the same metro, at
//     least one of them away from home (isAtHome). One per member per place per 14 days, and never
//     the same pair twice.
//   - Say hi is the member's own tap: the group DM goes at once (the sender picked the moment, so
//     no quiet-hours wait), once per sender per event and once per pair for Nearby now.
//   - Every intro waits for 10:00-20:00 in each recipient's own zone; the hourly sweep retries.
//   - Snoozed or opted-out members are never named, as subject or partner.
//   - Another member's inferred city is never shown or sent. The Events tab shows the viewer their
//     own place, and other people only as "also around <metro>" -- both sides opted in.
//
// Every send is the existing `slack.conference_intro` action, through propose -> auto policy ->
// execute, so it shows up in the action log like any other Slack effect.
import { adminBotIsAlumniMember, type AdminBotLabMember } from "../contracts/actions.js";
import { resolveAdminBotControlUiUrl } from "../contracts/control-ui.js";
import type {
  AdminBotEventCard,
  AdminBotEventPerson,
  AdminBotEventsOverview,
} from "../contracts/events.js";
import {
  isoDay,
  travelConferenceSites,
  type TravelConferenceSite,
} from "../workflows/members/lab-travel.js";
import {
  CITY_MEETUP_WINDOW_DAYS,
  cityIntroKey,
  introPairs,
  isAtHome,
  isIntroSendTime,
  meetupIntrosAllowed,
  meetupPreferences,
  type MeetupPlace,
  memberZone,
  nearEachOther,
  onCityCooldown,
  pairKey,
  placeKey,
  placeLabel,
  signInPlace,
  viewerLocation,
} from "../workflows/members/meetups.js";
import { memberThemeIds, RESEARCH_THEMES } from "../workflows/members/research-themes.js";
import { canonicalConferenceTrips } from "../workflows/papers/conference-attendance.js";
import {
  buildCityIntroMessage,
  buildConferenceIntroMessage,
  buildSayHiMessage,
  CONFERENCE_INTRO_PARTNERS,
  conferenceMapUrl,
  type IntroCandidate,
  type IntroMessage,
  type IntroPartner,
  rankIntroPartners,
  withWildcard,
} from "../workflows/papers/conference-intros.js";
import type { AdminBotService, AdminBotServiceStore } from "./service.js";
import { isTravelEntitled } from "./service.lab-travel.js";

type Host = Pick<
  AdminBotService,
  "createProposal" | "execute" | "removePending" | "listConferenceRosters"
>;

export type IntroRunResult = {
  introduced: number;
  skipped: number;
  /** Waiting for daytime in somebody's zone; the hourly sweep picks these up. */
  deferred: number;
  failed: number;
};

const fail = (status: number, message: string) => ({
  ok: false as const,
  status,
  error: { message },
});
const ok = <T>(payload: T) => ({ ok: true as const, status: 200, payload });

/** How long a past event stays on the tab's Past list. */
const PAST_DAYS = 365;
const DAY_MS = 86_400_000;

function addDays(day: string, days: number): string {
  return isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));
}

function siteWhere(site: TravelConferenceSite): string | undefined {
  return site.location?.trim() || [site.city, site.country].filter(Boolean).join(", ") || undefined;
}

function sitePlace(site: TravelConferenceSite): MeetupPlace | undefined {
  return site.city
    ? { city: site.city, ...(site.country ? { country: site.country } : {}) }
    : undefined;
}

function happening(site: TravelConferenceSite, today: string): boolean {
  return Boolean(site.starts && site.starts <= today && today <= (site.ends ?? site.starts));
}

/** Slack linked, still in the lab, and not on the admin's do-not-contact list. */
function reachable(member: AdminBotLabMember | undefined): member is AdminBotLabMember & {
  slack_user_id: string;
} {
  return Boolean(
    member?.slack_user_id && !member.do_not_contact && !adminBotIsAlumniMember(member),
  );
}

/** Where the footer's "Pause or turn off" link lands. The built-in default needs no config. */
function eventsUrl(): string {
  return `${resolveAdminBotControlUiUrl()}/events`;
}

function person(member: AdminBotLabMember): AdminBotEventPerson {
  return {
    member_id: member.id,
    name: member.preferred_name?.trim() || member.name,
    ...(member.avatar_url ? { avatar_url: member.avatar_url } : {}),
  };
}

function candidate(member: AdminBotLabMember & { slack_user_id: string }): IntroCandidate {
  return {
    member_id: member.id,
    name: member.preferred_name?.trim() || member.name,
    slack_user_id: member.slack_user_id,
    themes: memberThemeIds(member),
    ...(member.projects?.length ? { projects: member.projects } : {}),
  };
}

/**
 * Up to two partners for `subject`: the best research match and one seeded wildcard, both from
 * people AdminBot has not introduced to the subject yet. The intro is about the subject, so the
 * two partners may already know each other (at an event, the newcomer meets two people from an
 * earlier trio). Empty when nobody new is left.
 */
function freshPartners(
  subject: IntroCandidate,
  candidates: readonly IntroCandidate[],
  pairs: ReadonlySet<string>,
  seed: string,
): IntroPartner[] {
  const fresh = rankIntroPartners(subject, candidates, seed).filter(
    (option) => !pairs.has(pairKey(subject.member_id, option.member_id)),
  );
  return withWildcard(subject, fresh, seed).slice(0, CONFERENCE_INTRO_PARTNERS);
}

function addPairs(pairs: Set<string>, group: readonly IntroCandidate[]): void {
  for (const a of group) {
    for (const b of group) {
      if (a.member_id !== b.member_id) {
        pairs.add(pairKey(a.member_id, b.member_id));
      }
    }
  }
}

export class MeetupService {
  constructor(
    private store: AdminBotServiceStore,
    private host: Host,
    private dataset: () => readonly unknown[],
    private now: () => Date = () => new Date(),
  ) {}

  private today(): string {
    return isoDay(this.now());
  }

  /** Every dataset site, past ones included (the dataset's own "upcoming" cut is today). */
  private allSites(): TravelConferenceSite[] {
    return travelConferenceSites(this.dataset(), "0000-01-01");
  }

  private themeLabels() {
    return new Map(RESEARCH_THEMES.map((theme) => [theme.id, theme.label]));
  }

  /** Member ids Going to a conference: paper roster "yes" plus Travel tab RSVPs. */
  private goingIds(groupKey: string, sites: readonly TravelConferenceSite[]): Set<string> {
    const ids = new Set<string>();
    const rosters = this.host.listConferenceRosters();
    const roster = rosters.ok
      ? rosters.payload.conferences.find((entry) => entry.key === groupKey)
      : undefined;
    for (const row of roster?.people ?? []) {
      if (row.attending === "yes" && row.member_id) {
        ids.add(row.member_id);
      }
    }
    const keys = new Set([groupKey, ...sites.map((site) => site.key)]);
    for (const trip of canonicalConferenceTrips(this.store.listConferenceTrips())) {
      if (trip.intent === "going" && keys.has(trip.conference_key)) {
        ids.add(trip.member_id);
      }
    }
    return ids;
  }

  /** The conference's own sites, in the shape the RSVP and the message use. */
  groupKeyFor(conferenceKey: string): string {
    return this.allSites().find((site) => site.key === conferenceKey)?.group_key ?? conferenceKey;
  }

  // --- event intros -----------------------------------------------------------------------------

  /**
   * One pass of the event intro (see AdminBotService.introduceConferenceAttendees for the
   * serialization around it). Each Going member who has not been in an intro for this event yet
   * gets one with the two co-attendees closest to their research.
   */
  async introduceEventNow(groupKey: string) {
    const today = this.today();
    const now = this.now();
    const rosters = this.host.listConferenceRosters();
    if (!rosters.ok) {
      return rosters;
    }
    const roster = rosters.payload.conferences.find((entry) => entry.key === groupKey);
    const upcoming = travelConferenceSites(this.dataset(), today).filter(
      (site) => site.group_key === groupKey,
    );
    const label = roster?.label ?? upcoming[0]?.conference_label;
    if (!label) {
      return fail(404, "conference not found");
    }

    // Going (roster or RSVP), then anyone the sign-in puts in the city while it runs -- but only
    // those who said yes to city intros, because naming them tells the other two where they are.
    const members = new Map(this.store.listLabMembers().map((member) => [member.id, member]));
    const going = this.goingIds(groupKey, upcoming);
    const inTown = new Set<string>();
    const live = upcoming.filter((site) => happening(site, today));
    for (const member of members.values()) {
      if (going.has(member.id) || !isTravelEntitled(member)) {
        continue;
      }
      if (!meetupIntrosAllowed(member, "city", today)) {
        continue;
      }
      const here = signInPlace(member, now);
      const at =
        here && live.find((site) => sitePlace(site) && nearEachOther(here, sitePlace(site)!));
      if (at) {
        inTown.add(member.id);
      }
    }
    const candidates: IntroCandidate[] = [];
    const zones = new Map<string, string | undefined>();
    for (const id of [...going, ...inTown].toSorted()) {
      const member = members.get(id);
      if (!reachable(member) || !meetupIntrosAllowed(member, "event", today)) {
        continue;
      }
      candidates.push(candidate(member));
      zones.set(id, memberZone(member, now));
    }
    const result: IntroRunResult = { introduced: 0, skipped: 0, deferred: 0, failed: 0 };
    if (candidates.length < CONFERENCE_INTRO_PARTNERS + 1) {
      return ok({ ...result, skipped: candidates.length });
    }
    const keyPrefix = `conference-intro:${groupKey}:`;
    const everything = this.store.listProposalsByType("slack.conference_intro");
    // Pair history spans every event and city: two people AdminBot has introduced are never
    // introduced again, wherever they next meet.
    const pairs = introPairs(everything);
    const history = everything.filter((proposal) =>
      proposal.idempotency_key?.startsWith(keyPrefix),
    );
    const covered = new Set<string>();
    for (const proposal of history) {
      if (proposal.status !== "executed") {
        continue;
      }
      const ids = (proposal.proposed_payload as { member_ids?: unknown } | undefined)?.member_ids;
      for (const id of Array.isArray(ids) ? ids : []) {
        if (typeof id === "string") {
          covered.add(id);
        }
      }
    }
    const themeLabels = this.themeLabels();
    const town = live.map(sitePlace).find(Boolean);
    for (const subject of candidates) {
      const idempotencyKey = `${keyPrefix}${subject.member_id}`;
      const latest = history.findLast((p) => p.idempotency_key === idempotencyKey);
      if (covered.has(subject.member_id) || latest?.status === "rejected") {
        result.skipped++;
        continue;
      }
      const partners = freshPartners(subject, candidates, pairs, groupKey);
      if (partners.length === 0) {
        result.skipped++;
        continue;
      }
      const trio = [subject, ...partners];
      if (
        !isIntroSendTime(
          trio.map((p) => zones.get(p.member_id)),
          now,
        )
      ) {
        result.deferred++;
        continue;
      }
      const message = buildConferenceIntroMessage({
        conference_label: label,
        subject,
        partners,
        sites: upcoming,
        theme_labels: themeLabels,
        today,
        ...(town && trio.some((p) => inTown.has(p.member_id)) ? { in_town: placeLabel(town) } : {}),
        seed: idempotencyKey,
        events_url: eventsUrl(),
      });
      const sent = await this.send({
        latest,
        idempotencyKey,
        trio,
        message,
        summary: `Introduce ${subject.name} to ${partners.map((p) => p.name).join(" and ")} for ${label}`,
        rationale: `All three are going to (or in town for) ${label} and have event intros on.`,
      });
      if (sent) {
        result.introduced++;
        for (const p of trio) {
          covered.add(p.member_id);
        }
        addPairs(pairs, trio);
      } else {
        result.failed++;
      }
    }
    return ok(result);
  }

  // --- city intros ------------------------------------------------------------------------------

  /** Opted-in, reachable members whose sign-in in the last week is near `anchor`. */
  private nearbyOptedIn(anchor: MeetupPlace, today: string) {
    const now = this.now();
    return this.store.listLabMembers().filter((member) => {
      if (!reachable(member) || !isTravelEntitled(member)) {
        return false;
      }
      if (!meetupIntrosAllowed(member, "city", today)) {
        return false;
      }
      const here = signInPlace(member, now, CITY_MEETUP_WINDOW_DAYS);
      return Boolean(here && nearEachOther(here, anchor));
    });
  }

  async introduceCityNow(anchor: MeetupPlace) {
    const today = this.today();
    const now = this.now();
    const place = placeKey(anchor);
    const label = placeLabel(anchor);
    const people = this.nearbyOptedIn(anchor, today).toSorted((a, b) => a.id.localeCompare(b.id));
    const result: IntroRunResult = { introduced: 0, skipped: 0, deferred: 0, failed: 0 };
    if (people.length < 2) {
      return ok({ ...result, skipped: people.length });
    }
    const history = this.store.listProposalsByType("slack.conference_intro");
    const pairs = introPairs(history);
    const busy = new Set(
      people
        .filter((member) => onCityCooldown(history, place, member.id, today))
        .map((member) => member.id),
    );
    const candidates = people.map((member) =>
      candidate(member as AdminBotLabMember & { slack_user_id: string }),
    );
    const zones = new Map(people.map((member) => [member.id, memberZone(member, now)]));
    const home = new Set(
      people.filter((member) => isAtHome(member, anchor)).map((member) => member.id),
    );
    const themeLabels = this.themeLabels();
    for (const subject of candidates) {
      const idempotencyKey = cityIntroKey(place, subject.member_id, today);
      const latest = history.findLast((p) => p.idempotency_key === idempotencyKey);
      if (busy.has(subject.member_id) || latest?.status === "rejected") {
        result.skipped++;
        continue;
      }
      // Two locals are not news; one of the group has to be visiting.
      const partners = freshPartners(
        subject,
        candidates.filter(
          (other) =>
            !busy.has(other.member_id) &&
            !(home.has(subject.member_id) && home.has(other.member_id)),
        ),
        pairs,
        place,
      );
      if (partners.length === 0) {
        result.skipped++;
        continue;
      }
      const group = [subject, ...partners];
      if (
        !isIntroSendTime(
          group.map((p) => zones.get(p.member_id)),
          now,
        )
      ) {
        result.deferred++;
        continue;
      }
      const sent = await this.send({
        latest,
        idempotencyKey,
        trio: group,
        message: buildCityIntroMessage({
          place_label: label,
          subject,
          partners,
          theme_labels: themeLabels,
          seed: idempotencyKey,
          events_url: eventsUrl(),
        }),
        summary: `Introduce ${subject.name} to ${partners.map((p) => p.name).join(" and ")} around ${label}`,
        rationale: `All have city intros on and signed in around ${label} this week.`,
      });
      if (sent) {
        result.introduced++;
        for (const p of group) {
          busy.add(p.member_id);
        }
        addPairs(pairs, group);
      } else {
        result.failed++;
      }
    }
    return ok(result);
  }

  /** Propose (or reuse the still-current proposal) and execute one intro. True when delivered. */
  private async send(params: {
    latest: ReturnType<AdminBotServiceStore["listProposalsByType"]>[number] | undefined;
    idempotencyKey: string;
    trio: readonly IntroCandidate[];
    message: IntroMessage;
    summary: string;
    rationale: string;
  }): Promise<boolean> {
    const [subject] = params.trio;
    const payload = {
      user_ids: params.trio.map((p) => p.slack_user_id),
      member_ids: params.trio.map((p) => p.member_id),
      message: params.message.text,
      blocks: params.message.blocks,
    };
    let proposalId = params.latest?.id;
    if (
      params.latest &&
      JSON.stringify(params.latest.proposed_payload) !== JSON.stringify(payload)
    ) {
      // Stale: a partner withdrew, the days-to-go moved on. Replace it rather than send old text.
      this.host.removePending(params.latest.id, { note: "Intro recipients or text changed." });
      proposalId = undefined;
    }
    if (!proposalId) {
      const proposal = this.host.createProposal({
        type: "slack.conference_intro",
        summary: params.summary,
        target: {
          service: "slack",
          channel: "slack",
          target: payload.user_ids.join(","),
          recipientMemberId: subject!.member_id,
        },
        proposed_payload: payload,
        rationale: params.rationale,
        undo_plan:
          "A Slack message cannot be unsent by AdminBot; any participant can leave the DM.",
        idempotency_key: params.idempotencyKey,
      });
      if (!proposal.ok) {
        return false;
      }
      proposalId = proposal.payload.id;
    }
    try {
      const executed = await this.host.execute(proposalId, {
        dry_run: false,
        idempotency_key: params.idempotencyKey,
      });
      return executed.ok && executed.payload.status === "executed";
    } catch {
      return false;
    }
  }

  // --- triggers ---------------------------------------------------------------------------------

  /**
   * What a fresh sign-in location can start: the event intro for any event running in that city
   * today, and the city intro when the member has it on. The callers serialize and swallow errors.
   */
  locatedWork(memberId: string): { events: string[]; city?: MeetupPlace } {
    const member = this.store.getLabMember(memberId);
    const today = this.today();
    const here = member && isTravelEntitled(member) ? signInPlace(member, this.now()) : undefined;
    if (!member || !here) {
      return { events: [] };
    }
    const events = meetupIntrosAllowed(member, "event", today)
      ? [
          ...new Set(
            travelConferenceSites(this.dataset(), today)
              .filter((site) => happening(site, today))
              .filter((site) => sitePlace(site) && nearEachOther(here, sitePlace(site)!))
              .map((site) => site.group_key),
          ),
        ]
      : [];
    return {
      events,
      ...(meetupIntrosAllowed(member, "city", today) ? { city: here } : {}),
    };
  }

  /** The hourly sweep's worklist: events with people Going, and places with 2+ opted in. */
  sweepWork(): { events: string[]; cities: MeetupPlace[] } {
    const today = this.today();
    const sites = travelConferenceSites(this.dataset(), today);
    const groups = new Set(sites.map((site) => site.group_key));
    const rosters = this.host.listConferenceRosters();
    for (const roster of rosters.ok ? rosters.payload.conferences : []) {
      if (roster.going_count > 0) {
        groups.add(roster.key);
      }
    }
    const events = [...groups].filter((key) => {
      const own = sites.filter((site) => site.group_key === key);
      return (
        this.goingIds(key, own).size >= CONFERENCE_INTRO_PARTNERS + 1 ||
        own.some((site) => happening(site, today))
      );
    });
    const cities = new Map<string, MeetupPlace>();
    const now = this.now();
    for (const member of this.store.listLabMembers()) {
      if (!reachable(member) || !meetupIntrosAllowed(member, "city", today)) {
        continue;
      }
      const here = signInPlace(member, now, CITY_MEETUP_WINDOW_DAYS);
      if (here && !cities.has(placeKey(here))) {
        cities.set(placeKey(here), here);
      }
    }
    return {
      events,
      cities: [...cities.values()].filter((place) => {
        const near = this.nearbyOptedIn(place, today);
        return near.length >= 2 && near.some((member) => !isAtHome(member, place));
      }),
    };
  }

  // --- say hi -----------------------------------------------------------------------------------

  /**
   * Who a Say hi on this event reaches: up to two Going lab-mates who take event intros, the best
   * research match and a wildcard, preferring people the viewer has not been introduced to yet.
   */
  private sayHiPartners(
    me: AdminBotLabMember & { slack_user_id: string },
    groupKey: string,
    pairs: ReadonlySet<string>,
  ): IntroPartner[] {
    const today = this.today();
    const sites = this.allSites().filter((site) => site.group_key === groupKey);
    const others: IntroCandidate[] = [];
    for (const id of [...this.goingIds(groupKey, sites)].toSorted()) {
      const member = this.store.getLabMember(id);
      if (id !== me.id && reachable(member) && meetupIntrosAllowed(member, "event", today)) {
        others.push(candidate(member));
      }
    }
    const subject = candidate(me);
    const ranked = rankIntroPartners(subject, others, groupKey);
    const met = (p: IntroPartner) => pairs.has(pairKey(me.id, p.member_id));
    const ordered = [...ranked.filter((p) => !met(p)), ...ranked.filter(met)];
    return withWildcard(subject, ordered, `say-hi:${groupKey}`).slice(
      0,
      CONFERENCE_INTRO_PARTNERS,
    );
  }

  /** Lab-mates the viewer sees under Nearby now: both have city intros on, one is visiting. */
  private nearbyFor(me: AdminBotLabMember, here: MeetupPlace, today: string) {
    const meHome = isAtHome(me, here);
    return this.nearbyOptedIn(here, today).filter(
      (member) => member.id !== me.id && !(meHome && isAtHome(member, here)),
    );
  }

  private sentKeys(): Map<string, string> {
    const status = new Map<string, string>();
    for (const proposal of this.store.listProposalsByType("slack.conference_intro")) {
      if (proposal.idempotency_key?.startsWith("say-hi:")) {
        status.set(proposal.idempotency_key, proposal.status);
      }
    }
    return status;
  }

  /**
   * The Say hi button: a group DM from the viewer to lab-mates at an event (`event_key`) or one
   * Nearby now face (`member_id`), right now. One per viewer per event and one per pair for
   * Nearby now; a second tap answers "already said hi" instead of sending again. It counts in the
   * pair history like any intro, so the automatic intros will not re-introduce the same people.
   */
  async sayHiNow(memberId: string, input: unknown) {
    const viewer = this.viewer(memberId);
    if (!viewer.ok) {
      return viewer;
    }
    const me = viewer.member;
    const body = (input ?? {}) as { event_key?: unknown; member_id?: unknown };
    const eventKey = typeof body.event_key === "string" ? body.event_key : "";
    const otherId = typeof body.member_id === "string" ? body.member_id : "";
    if (!eventKey && !otherId) {
      return fail(400, "Say hi needs an event_key or a member_id.");
    }
    if (!reachable(me)) {
      return fail(409, "Link your Slack account in your profile to say hi.");
    }
    const today = this.today();
    const history = this.store.listProposalsByType("slack.conference_intro");
    const pairs = introPairs(history);
    const themeLabels = this.themeLabels();
    let partners: IntroPartner[];
    let idempotencyKey: string;
    let message: IntroMessage;
    let summary: string;
    if (eventKey) {
      const site = this.allSites().find(
        (entry) => entry.key === eventKey || entry.group_key === eventKey,
      );
      if (!site || (site.ends ?? site.starts ?? "9999") < today) {
        return fail(404, "That event is not on the Events tab.");
      }
      const groupKey = site.group_key;
      partners = this.sayHiPartners(me, groupKey, pairs);
      idempotencyKey = `say-hi:event:${groupKey}:${me.id}`;
      const sites = travelConferenceSites(this.dataset(), today).filter(
        (entry) => entry.group_key === groupKey,
      );
      message = buildSayHiMessage({
        sender: candidate(me),
        partners,
        theme_labels: themeLabels,
        event: {
          conference_label: site.conference_label,
          sites,
          today,
          sender_going: this.goingIds(groupKey, sites).has(me.id),
        },
        seed: idempotencyKey,
        events_url: eventsUrl(),
      });
      summary = `${candidate(me).name} said hi to lab-mates going to ${site.conference_label}`;
    } else {
      const here = viewerLocation(me, this.now())?.place;
      const other =
        here && meetupIntrosAllowed(me, "city", today)
          ? this.nearbyFor(me, here, today).find((member) => member.id === otherId)
          : undefined;
      if (!here || !reachable(other)) {
        return fail(404, "That lab-mate is not nearby right now.");
      }
      partners = rankIntroPartners(candidate(me), [candidate(other)], "say-hi");
      idempotencyKey = `say-hi:city:${pairKey(me.id, other.id)}`;
      message = buildSayHiMessage({
        sender: candidate(me),
        partners,
        theme_labels: themeLabels,
        place_label: placeLabel(here),
        seed: idempotencyKey,
        events_url: eventsUrl(),
      });
      summary = `${candidate(me).name} said hi to ${partners[0]!.name} around ${placeLabel(here)}`;
    }
    const latest = history.findLast((p) => p.idempotency_key === idempotencyKey);
    if (latest?.status === "executed") {
      const ids = (latest.proposed_payload as { member_ids?: string[] }).member_ids ?? [];
      return ok({
        status: "already_said_hi" as const,
        with: ids
          .filter((id) => id !== me.id)
          .map((id) => this.store.getLabMember(id))
          .filter((member): member is AdminBotLabMember => Boolean(member))
          .map(person),
      });
    }
    if (latest?.status === "rejected") {
      return fail(409, "An admin held this message back.");
    }
    if (partners.length === 0) {
      return fail(409, "Nobody going can be messaged right now.");
    }
    const sent = await this.send({
      latest,
      idempotencyKey,
      trio: [candidate(me), ...partners],
      message,
      summary,
      rationale: `${candidate(me).name} tapped Say hi in the Events tab.`,
    });
    if (!sent) {
      return fail(502, "Slack did not take the message. Try again in a minute.");
    }
    return ok({
      status: "sent" as const,
      with: partners.map((p) => person(this.store.getLabMember(p.member_id)!)),
    });
  }

  // --- the tab ----------------------------------------------------------------------------------

  private viewer(memberId: string) {
    const member = this.store.getLabMember(memberId);
    if (!member) {
      return fail(403, "A member session is required.");
    }
    if (!isTravelEntitled(member)) {
      return fail(403, "Events are available to full lab members.");
    }
    return { ok: true as const, member };
  }

  overview(memberId: string) {
    const viewer = this.viewer(memberId);
    if (!viewer.ok) {
      return viewer;
    }
    const me = viewer.member;
    const now = this.now();
    const today = this.today();
    const prefs = meetupPreferences(me);
    const where = viewerLocation(me, now);
    const members = new Map(this.store.listLabMembers().map((member) => [member.id, member]));
    const trips = canonicalConferenceTrips(this.store.listConferenceTrips());
    const rosters = this.host.listConferenceRosters();
    const rosterByKey = new Map(
      (rosters.ok ? rosters.payload.conferences : []).map((roster) => [roster.key, roster]),
    );
    const oldest = addDays(today, -PAST_DAYS);
    const sites = this.allSites().filter((site) => {
      const last = site.ends ?? site.starts;
      return last ? last >= oldest : site.year >= Number(today.slice(0, 4));
    });
    const cards: AdminBotEventCard[] = [];
    const seenGroups = new Set<string>();
    const sayHiSent = this.sentKeys();
    const pairs = introPairs(this.store.listProposalsByType("slack.conference_intro"));
    const canSayHi = new Map<string, boolean>();
    const sayHiTo = (groupKey: string) => {
      if (!canSayHi.has(groupKey)) {
        canSayHi.set(
          groupKey,
          reachable(me) && this.sayHiPartners(me, groupKey, pairs).length > 0,
        );
      }
      return canSayHi.get(groupKey)!;
    };
    for (const site of sites) {
      seenGroups.add(site.group_key);
      const roster = rosterByKey.get(site.group_key);
      const rosterGoing = (roster?.people ?? []).filter((row) => row.attending === "yes");
      const goingIds = new Set<string>([
        ...rosterGoing.flatMap((row) => (row.member_id ? [row.member_id] : [])),
        ...trips
          .filter(
            (trip) =>
              trip.intent === "going" &&
              (trip.conference_key === site.key || trip.conference_key === site.group_key),
          )
          .map((trip) => trip.member_id),
      ]);
      const status: AdminBotEventCard["status"] =
        (site.ends ?? site.starts ?? "9999") < today
          ? "past"
          : happening(site, today)
            ? "happening"
            : "upcoming";
      const place = sitePlace(site);
      const near = Boolean(where?.place && place && nearEachOther(where.place, place));
      const mine = trips.find(
        (trip) =>
          trip.member_id === me.id &&
          (trip.conference_key === site.key || trip.conference_key === site.group_key),
      );
      const going = [...goingIds]
        .map((id) => members.get(id))
        .filter(
          (member): member is AdminBotLabMember =>
            Boolean(member) && !adminBotIsAlumniMember(member!),
        )
        .map(person)
        .toSorted((a, b) => a.name.localeCompare(b.name));
      const iAmGoing = goingIds.has(me.id);
      const location = siteWhere(site);
      const days =
        status === "upcoming" && site.starts
          ? Math.round(
              (Date.parse(`${site.starts}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS,
            )
          : undefined;
      cards.push({
        key: site.key,
        group_key: site.group_key,
        label: site.label,
        ...(site.starts ? { starts: site.starts } : {}),
        ...(site.ends ? { ends: site.ends } : {}),
        ...(location ? { location, map_url: conferenceMapUrl(location) } : {}),
        ...(site.homepage_url ? { homepage_url: site.homepage_url } : {}),
        status,
        ...(days !== undefined ? { days_until: days } : {}),
        going,
        on_paper: rosterGoing.length > 0,
        ...(mine ? { my_rsvp: mine } : {}),
        i_am_going: iAmGoing,
        can_rsvp: status !== "past",
        near_you: near,
        ...(status !== "past"
          ? {
              can_say_hi: sayHiTo(site.group_key),
              said_hi: sayHiSent.get(`say-hi:event:${site.group_key}:${me.id}`) === "executed",
            }
          : {}),
        ...(status === "happening" && near && !iAmGoing && where
          ? {
              in_town_prompt: `Looks like you're in ${where.label} during ${site.conference_label}. Are you attending?`,
            }
          : {}),
      });
    }
    // Accepted-paper conferences the dataset does not cover (no dates, no city): still the lab's
    // events, shown with what the rosters know.
    for (const roster of rosterByKey.values()) {
      if (seenGroups.has(roster.key) || roster.year < Number(today.slice(0, 4))) {
        continue;
      }
      const going = roster.people
        .filter((row) => row.attending === "yes" && row.member_id)
        .flatMap((row) => {
          const member = members.get(row.member_id!);
          return member ? [person(member)] : [];
        });
      cards.push({
        key: roster.key,
        group_key: roster.key,
        label: roster.label,
        status: "upcoming",
        going,
        on_paper: going.length > 0,
        i_am_going: going.some((p) => p.member_id === me.id),
        can_rsvp: false,
        near_you: false,
      });
    }
    const order = (a: AdminBotEventCard, b: AdminBotEventCard) =>
      Number(b.status === "happening") - Number(a.status === "happening") ||
      Number(b.near_you) - Number(a.near_you) ||
      (a.starts ?? "9999").localeCompare(b.starts ?? "9999") ||
      a.label.localeCompare(b.label);
    const overview: AdminBotEventsOverview = {
      today,
      ...(where ? { viewer_location: { label: where.label, source: where.source } } : {}),
      preferences: prefs,
      events: cards.filter((card) => card.status !== "past").toSorted(order),
      past: cards
        .filter((card) => card.status === "past")
        .toSorted((a, b) => (b.ends ?? "").localeCompare(a.ends ?? "")),
      ...this.alsoNearby(me, where?.place, today),
    };
    return ok(overview);
  }

  /**
   * "Also around <metro>" (the Events header and Collaborate's Nearby now strip): only for a viewer
   * with city intros on, only naming members who have them on too, at least one of the two away
   * from home, and only as the viewer's metro -- never anybody's own city.
   */
  private alsoNearby(
    me: AdminBotLabMember,
    here: MeetupPlace | undefined,
    today: string,
  ): Pick<AdminBotEventsOverview, "also_nearby"> {
    if (me.do_not_contact) {
      return {};
    }
    if (!meetupIntrosAllowed(me, "city", today)) {
      return { also_nearby: { locked: true } };
    }
    if (!here) {
      return {};
    }
    const sent = this.sentKeys();
    const people = this.nearbyFor(me, here, today)
      .map((member) => {
        const face = person(member);
        if (sent.get(`say-hi:city:${pairKey(me.id, member.id)}`) === "executed") {
          face.said_hi = true;
        }
        return face;
      })
      .toSorted((a, b) => a.name.localeCompare(b.name));
    return {
      also_nearby: {
        locked: false,
        place_label: placeLabel(here),
        people,
        can_say_hi: reachable(me),
      },
    };
  }

  setPreferences(memberId: string, input: unknown) {
    const viewer = this.viewer(memberId);
    if (!viewer.ok) {
      return viewer;
    }
    const body = (input ?? {}) as Record<string, unknown>;
    const current = meetupPreferences(viewer.member);
    const next = { ...current };
    for (const key of ["events", "city"] as const) {
      if (body[key] === undefined) {
        continue;
      }
      if (typeof body[key] !== "boolean") {
        return fail(400, `${key} must be true or false.`);
      }
      next[key] = body[key];
    }
    if (body.snoozed_until !== undefined) {
      const until = body.snoozed_until;
      if (until === null || until === "") {
        delete next.snoozed_until;
      } else if (
        typeof until === "string" &&
        /^\d{4}-\d{2}-\d{2}$/u.test(until) &&
        until <= addDays(this.today(), 366)
      ) {
        next.snoozed_until = until;
      } else {
        return fail(400, "snoozed_until must be a YYYY-MM-DD day within a year, or null.");
      }
    }
    this.store.saveLabMember({
      ...viewer.member,
      meetup_intros: next,
      updated_at: this.now().toISOString(),
    });
    return ok({ preferences: next });
  }
}
