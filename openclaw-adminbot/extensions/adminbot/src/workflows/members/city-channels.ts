// Which Slack channel each city has, who is missing from it, and which guidebook section they need.
//
// Pure: this decides, and the service does. Everything here is arithmetic over the roster, which is
// what makes "would AdminBot add this person to this channel" answerable without a Slack workspace.
//
// The city comes from `resolvePlace`, the same resolver the member map uses, so "Zürich", "Zurich",
// "currently Zurich" and the IANA zone "Europe/Zurich" all land on one channel. A second
// normalizer here would eventually disagree with the map, and the failure would be a member who
// appears in Zürich on the map and is invited to nothing.
import { resolvePlace, type AdminBotMapPlace } from "./member-map.js";

/**
 * How many people a city needs before it gets a channel.
 *
 * More than three, so four. Below that a city channel is two people who already talk, and creating
 * one is how a workspace ends up with a directory of dead rooms -- which is worse than no channel,
 * because it makes the live ones harder to find.
 */
export const adminBotCityChannelMinimumMembers = 4;

/**
 * Guidebook sections that are about being somewhere in particular.
 *
 * Keyed by the same place key the gazetteer uses. A city with no entry simply gets no link: the
 * channel is still worth joining, and a link to a section that does not exist is worse than none.
 */
export const adminBotCityGuidebookSections: Record<string, string> = {
  toronto: "Working from Toronto",
  zurich: "Working from Zürich",
  tuebingen: "Working from Tübingen",
};

export type CityChannelMember = {
  id: string;
  name: string;
  status?: string;
  slack_user_id?: string;
  current_city?: string;
  location?: string;
  timezone?: string;
  /** When AdminBot last added them to their city channel. Set means never again -- see below. */
  city_channel_invited_at?: string;
};

export type CityChannelGroup = {
  place: AdminBotMapPlace;
  /** `#group-toronto`, `#group-zurich`. The name only; the connector resolves it to an id. */
  channel: string;
  /** Everyone the roster places here, whether or not they can be invited. */
  members: CityChannelMember[];
  /** The guidebook section about living and working there, when there is one. */
  guidebookSection?: string;
};

export type CityChannelInvite = {
  member_id: string;
  member_name: string;
  slack_user_id: string;
  channel: string;
  place_label: string;
  guidebookSection?: string;
};

export type CityChannelPlan = {
  groups: CityChannelGroup[];
  invites: CityChannelInvite[];
  skipped: Array<{ member_id: string; reason: string }>;
};

/** The channel a place gets. Slack channel names are lowercase, so the gazetteer key is the name. */
export function cityChannelName(place: AdminBotMapPlace): string {
  return `group-${place.key}`;
}

/**
 * Where the roster thinks somebody is.
 *
 * `current_city` first because it is the field the member fills in about themselves, then the
 * roster's `location`, then the timezone -- which is inferred and the weakest of the three, but is
 * the only one that updates itself when somebody moves.
 */
function placeOf(member: CityChannelMember): AdminBotMapPlace | undefined {
  return (
    resolvePlace(member.current_city) ??
    resolvePlace(member.location) ??
    resolvePlace(member.timezone)
  );
}

/**
 * What the sweep would do, given the roster.
 *
 * Invited once, and only once. `city_channel_invited_at` is the whole opt-out: a member who is
 * added and leaves must stay left, and without a stamp the next sweep would put them back every
 * few days -- an argument with a person that a cron job always wins. Reading channel membership
 * instead would be the same bug wearing better clothes: "not in the channel" is exactly what
 * leaving looks like.
 */
export function cityChannelPlan(members: readonly CityChannelMember[]): CityChannelPlan {
  const byPlace = new Map<string, CityChannelGroup>();
  for (const member of members) {
    // Alumni and external collaborators are not who a city channel is for, and counting them
    // toward the threshold would open a channel for a city the lab has left.
    if (member.status === "alumni" || member.status === "external") {
      continue;
    }
    const place = placeOf(member);
    if (!place) {
      continue;
    }
    const group = byPlace.get(place.key) ?? {
      place,
      channel: cityChannelName(place),
      members: [],
      ...(adminBotCityGuidebookSections[place.key]
        ? { guidebookSection: adminBotCityGuidebookSections[place.key] }
        : {}),
    };
    group.members.push(member);
    byPlace.set(place.key, group);
  }

  const groups = [...byPlace.values()]
    .filter((group) => group.members.length >= adminBotCityChannelMinimumMembers)
    .toSorted((left, right) => left.place.key.localeCompare(right.place.key));

  const invites: CityChannelInvite[] = [];
  const skipped: CityChannelPlan["skipped"] = [];
  for (const group of groups) {
    for (const member of group.members.toSorted((left, right) => left.id.localeCompare(right.id))) {
      if (member.city_channel_invited_at) {
        continue;
      }
      if (!member.slack_user_id) {
        skipped.push({ member_id: member.id, reason: "member has no slack_user_id" });
        continue;
      }
      invites.push({
        member_id: member.id,
        member_name: member.name,
        slack_user_id: member.slack_user_id,
        channel: group.channel,
        place_label: group.place.label,
        ...(group.guidebookSection ? { guidebookSection: group.guidebookSection } : {}),
      });
    }
  }
  return { groups, invites, skipped };
}

/**
 * What the member is told after they are added.
 *
 * Says where they were added, why, and how to leave -- in that order, and the leaving part is not
 * buried. They did not ask for this, so the message that announces it is also the one that has to
 * make undoing it obvious; anything less is a workspace somebody feels managed by.
 */
export function buildCityChannelMessage(invite: CityChannelInvite): string {
  return [
    `I have added you to #${invite.channel} — it is where the ${invite.place_label} group coordinates.`,
    ...(invite.guidebookSection
      ? ["", `The guidebook's "${invite.guidebookSection}" section is worth a read.`]
      : []),
    "",
    "If you would rather not be there, just leave the channel — I will not add you back.",
  ].join("\n");
}
