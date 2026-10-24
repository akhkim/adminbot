// How well the member map covers the lab, for admins: how many active members each kind of signal
// places, and who is placed only by something weak (or nothing), with when they were last here.
//
// Built from buildMemberMap's own output rather than a second reading of the member records, so
// the panel can never disagree with the map about why someone is where they are.
import type { AdminBotLabMember, AdminBotLocationPermission } from "../../contracts/actions.js";
import {
  type AdminBotCityCentroidResolver,
  type AdminBotMemberMap,
  isHiddenFromMemberMap,
  memberMapFromRoster,
  memberMapVisibility,
} from "./member-map.js";

/**
 * What placed an active member, strongest first. Exactly one per member:
 *
 * - `device`: the city their own browser reported (≤ ADMINBOT_DEVICE_LOCATION_FRESH_DAYS);
 * - `ip`: a fresh IP reading (≤ ADMINBOT_MAP_LOGIN_FRESH_DAYS) that agrees with their clock;
 * - `checkin`: their answer to "Where are you based right now?" (≤ ADMINBOT_LOCATION_CHECKIN_DAYS);
 * - `stored_city`: a city written somewhere (profile, Slack profile field), with no fresher signal;
 * - `timezone`: only a time zone's city (device, Slack or profile zone);
 * - `country`: only a country;
 * - `unplaced`: nothing usable, or text the gazetteer could not place;
 * - `hidden`: the member chose to be left off the map (or the roster hides them).
 */
export type AdminBotMapCoverageBucket =
  | "device"
  | "ip"
  | "checkin"
  | "stored_city"
  | "timezone"
  | "country"
  | "unplaced"
  | "hidden";

export type AdminBotMapCoverageEntry = {
  member_id: string;
  name: string;
  placed_by: Exclude<AdminBotMapCoverageBucket, "device" | "ip" | "checkin" | "hidden">;
  /** Where the map put them, when it put them anywhere. */
  place_label?: string;
  /** Their fresh IP reading was set aside as a likely VPN. */
  suspected_vpn?: true;
  /** Last day they used AdminBot themselves; absent when there is no record of it. */
  last_seen_at?: string;
};

/** A member whose browser said no to the location prompt, for the admins' "who said no" list. */
export type AdminBotLocationRefusal = {
  member_id: string;
  name: string;
  state: Exclude<AdminBotLocationPermission, "granted">;
  /** When the browser last changed its answer. */
  at?: string;
  last_seen_at?: string;
};

export type AdminBotMapCoverage = {
  generated_at: string;
  active: number;
  counts: Record<AdminBotMapCoverageBucket, number> & {
    /**
     * Members whose fresh IP reading was set aside as a likely VPN. Counted on top of the buckets
     * above, not instead of them: such a member is still placed by whatever came next.
     */
    suspected_vpn: number;
    /**
     * Members placed only approximately: by an IP city (the network's exit), a time zone's city or
     * a country. Counted on top of the buckets above (it is `ip + timezone + country`), so the
     * panel can say how much of the map is a guess.
     */
    approximate_only: number;
  };
  /**
   * Everyone placed by a stored city, a zone, a country or nothing, i.e. without a fresh device
   * city, IP reading or recent check-in: the people no automatic source currently places. Read by
   * admins only; nothing messages them. Never-seen first, then oldest seen.
   */
  stale: AdminBotMapCoverageEntry[];
  /**
   * What the browsers of active, automatically placed members said to the location prompt.
   * `not_asked` is everyone with no answer on record: not here since the prompt shipped, or a
   * browser that never reported.
   */
  permission: Record<AdminBotLocationPermission | "not_asked", number>;
  /** Who blocked it or closed it without answering, most recent answer first. */
  refused: AdminBotLocationRefusal[];
};

const DEPARTED = new Set(["alumni"]);

/** The newest of the stamps that say a member used AdminBot themselves. */
export function lastSeenInAdminBot(member: AdminBotLabMember): string | undefined {
  let newest: string | undefined;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const stamp of [member.last_seen_at, member.last_ip_observed_at, member.last_login_at]) {
    const ms = stamp ? Date.parse(stamp) : Number.NaN;
    if (!Number.isNaN(ms) && ms > newestMs) {
      newest = stamp;
      newestMs = ms;
    }
  }
  return newest;
}

export function buildMapCoverage(
  members: readonly AdminBotLabMember[],
  options: {
    now?: Date;
    /** A map already built with `loginCity: true` from the same roster, to save building it twice. */
    map?: AdminBotMemberMap;
    resolveCity?: AdminBotCityCentroidResolver;
  } = {},
): AdminBotMapCoverage {
  const now = options.now ?? new Date();
  const active = members.filter((member) => !DEPARTED.has(member.status ?? ""));
  const map =
    options.map ??
    memberMapFromRoster(active, {
      loginCity: true,
      now,
      ...(options.resolveCity ? { resolveCity: options.resolveCity } : {}),
    });

  const counts: AdminBotMapCoverage["counts"] = {
    device: 0,
    ip: 0,
    checkin: 0,
    stored_city: 0,
    timezone: 0,
    country: 0,
    unplaced: 0,
    hidden: 0,
    suspected_vpn: 0,
    approximate_only: 0,
  };
  const byId = new Map(active.map((member) => [member.id, member]));
  const stale: AdminBotMapCoverageEntry[] = [];
  const entry = (
    member: AdminBotLabMember | undefined,
    fields: Omit<AdminBotMapCoverageEntry, "member_id" | "name" | "last_seen_at"> & {
      member_id: string;
      name: string;
    },
  ): AdminBotMapCoverageEntry => {
    const lastSeen = member ? lastSeenInAdminBot(member) : undefined;
    return { ...fields, ...(lastSeen ? { last_seen_at: lastSeen } : {}) };
  };

  for (const place of map.places) {
    for (const placed of place.members) {
      if (placed.ip_ignored === "suspected_vpn") {
        counts.suspected_vpn += 1;
      }
      // A login source at country precision is the IP country standing in after the city went
      // stale (or never came), so it counts as a country, not a fresh IP.
      // A device source at timezone precision is the browser's zone, not its position.
      const bucket: AdminBotMapCoverageBucket =
        placed.source === "device" && placed.precision === "city"
          ? "device"
          : placed.source === "login" && placed.precision === "city"
            ? "ip"
            : placed.source === "checkin"
              ? "checkin"
              : placed.precision === "timezone"
                ? "timezone"
                : placed.precision === "country"
                  ? "country"
                  : "stored_city";
      counts[bucket] += 1;
      if (bucket === "ip" || bucket === "timezone" || bucket === "country") {
        counts.approximate_only += 1;
      }
      if (bucket === "device" || bucket === "ip" || bucket === "checkin") {
        continue;
      }
      stale.push(
        entry(byId.get(placed.member_id), {
          member_id: placed.member_id,
          name: placed.name,
          placed_by: bucket,
          place_label: place.label,
          ...(placed.ip_ignored ? { suspected_vpn: true as const } : {}),
        }),
      );
    }
  }
  for (const unplaced of map.unplaced) {
    counts.unplaced += 1;
    stale.push(
      entry(byId.get(unplaced.member_id), {
        member_id: unplaced.member_id,
        name: unplaced.name,
        placed_by: "unplaced",
      }),
    );
  }
  const permission: AdminBotMapCoverage["permission"] = {
    granted: 0,
    denied: 0,
    dismissed: 0,
    not_asked: 0,
  };
  const refused: AdminBotLocationRefusal[] = [];
  for (const member of active) {
    if (isHiddenFromMemberMap(member) || memberMapVisibility(member) === "hidden") {
      counts.hidden += 1;
      continue;
    }
    // Only automatic placement is ever asked; "stated" members are left out of the tally.
    if (memberMapVisibility(member) !== "auto") {
      continue;
    }
    const state = member.location_permission;
    permission[state ?? "not_asked"] += 1;
    if (state === "denied" || state === "dismissed") {
      const lastSeen = lastSeenInAdminBot(member);
      refused.push({
        member_id: member.id,
        name: member.name,
        state,
        ...(member.location_permission_at ? { at: member.location_permission_at } : {}),
        ...(lastSeen ? { last_seen_at: lastSeen } : {}),
      });
    }
  }

  return {
    generated_at: now.toISOString(),
    active: active.length,
    counts,
    stale: stale.toSorted((left, right) => {
      const l = left.last_seen_at ? Date.parse(left.last_seen_at) : Number.NEGATIVE_INFINITY;
      const r = right.last_seen_at ? Date.parse(right.last_seen_at) : Number.NEGATIVE_INFINITY;
      return l - r || left.name.localeCompare(right.name);
    }),
    permission,
    refused: refused.toSorted(
      (left, right) =>
        (right.at ? Date.parse(right.at) : 0) - (left.at ? Date.parse(left.at) : 0) ||
        left.name.localeCompare(right.name),
    ),
  };
}
