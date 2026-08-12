// Where the lab is, for the dashboard card.
//
// `GET /member-map` answers in two shapes and the service decides which (see the route in
// api/server.ts): an admin gets `full`, with who is in each city; everyone else — signed-in member
// or anonymous — gets `summary`, a headcount per city and no names. Publishing 150 people's
// locations is a decision the lab makes deliberately, not a side effect of someone opening a
// dashboard, so this module never tries to widen that: it renders whichever shape it is handed and
// treats the absence of names as normal rather than as missing data.
//
// The served page at /lab_stats/member_map draws the same data on real Leaflet tiles. This is not
// that page in a frame: an iframe would be cross-origin against the Vercel-hosted Control UI, would
// carry no session (so it could only ever show the summary, even to an admin), and would look like
// an embedded document rather than a card. The dashboard renders the JSON itself.

import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";
import type { UiSettings } from "../../storage.ts";

/** One city the gazetteer knows, with however much of its membership the caller may see. */
export type MemberMapPlace = {
  key: string;
  label: string;
  country: string;
  lat: number;
  lon: number;
  /** Present in both shapes. In `full` it equals `members.length`. */
  count: number;
  /** `full` only: who is there. Absent for a non-admin, which is not an error. */
  members?: Array<{ member_id: string; name: string }>;
};

export type MemberMap = {
  mode: "full" | "summary";
  places: MemberMapPlace[];
  /** Members whose written location the gazetteer could not place. A count only — see below. */
  unplaced: number;
  counts: { placed: number; unplaced: number; unknown: number };
};

export type MemberMapHost = {
  settings: UiSettings;
  adminBotMemberMap: MemberMap | null;
  adminBotMemberMapLoading: boolean;
};

type RawPlace = {
  key?: unknown;
  label?: unknown;
  country?: unknown;
  lat?: unknown;
  lon?: unknown;
  count?: unknown;
  members?: unknown;
};

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

/**
 * Normalises one place, or null when it cannot be plotted.
 *
 * A place without usable coordinates is dropped rather than drawn at (0, 0), which is in the Gulf
 * of Guinea and would read as a real lab presence there.
 */
function toPlace(raw: RawPlace): MemberMapPlace | null {
  const lat = asNumber(raw.lat);
  const lon = asNumber(raw.lon);
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return null;
  }
  const members = Array.isArray(raw.members)
    ? raw.members.flatMap((entry) => {
        const record = entry as { member_id?: unknown; name?: unknown };
        return typeof record?.name === "string"
          ? [{ member_id: String(record.member_id ?? ""), name: record.name }]
          : [];
      })
    : undefined;
  const count = asNumber(raw.count);
  return {
    key: String(raw.key ?? raw.label ?? `${lat},${lon}`),
    label: String(raw.label ?? ""),
    country: String(raw.country ?? ""),
    lat,
    lon,
    // The summary shape carries `count`; the full shape carries `members`. Either is enough.
    count: Number.isNaN(count) ? (members?.length ?? 0) : count,
    ...(members ? { members } : {}),
  };
}

export function parseMemberMap(body: unknown): MemberMap | null {
  const raw = body as
    | { mode?: unknown; places?: unknown; unplaced?: unknown; counts?: unknown }
    | null;
  if (!raw || !Array.isArray(raw.places)) {
    return null;
  }
  const counts = (raw.counts ?? {}) as { placed?: unknown; unplaced?: unknown; unknown?: unknown };
  const places = raw.places
    .map((place) => toPlace(place as RawPlace))
    .filter((place): place is MemberMapPlace => place !== null)
    .toSorted((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  return {
    mode: raw.mode === "full" ? "full" : "summary",
    places,
    // Only ever a number here. The full response lists unplaced members by name, but the card has
    // no use for that — it is a prompt to extend the gazetteer, not a roster.
    unplaced: Array.isArray(raw.unplaced) ? raw.unplaced.length : 0,
    counts: {
      placed: asNumber(counts.placed) || 0,
      unplaced: asNumber(counts.unplaced) || 0,
      unknown: asNumber(counts.unknown) || 0,
    },
  };
}

/**
 * Loads the map onto the host.
 *
 * Failure is silent by design: this is one card on a dashboard whose other cards are what a member
 * came for, and a red error where a map should be would cost more attention than the card is worth.
 * The card renders nothing when there is nothing to draw.
 */
export async function loadMemberMap(host: MemberMapHost): Promise<void> {
  host.adminBotMemberMapLoading = true;
  try {
    const stored = loadStoredMemberSession();
    const response = await fetch(`${resolveAdminBotBaseUrl(host.settings)}/member-map`, {
      // Capitalised to match every other authed call in the Control UI (see session.ts).
      // Header names are case-insensitive on the wire, but a lone lowercase one reads as a
      // different code path to anyone grepping, and to a test asserting over all calls.
      headers: stored ? { Authorization: `Bearer ${stored.sessionToken}` } : {},
    });
    if (!response.ok) {
      return;
    }
    host.adminBotMemberMap = parseMemberMap(await response.json());
  } catch {
    // Unreachable service, offline, blocked request: leave the card empty.
  } finally {
    host.adminBotMemberMapLoading = false;
  }
}
