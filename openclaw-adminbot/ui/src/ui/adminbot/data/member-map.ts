// Where the lab is, for the map card on the Dashboard and on Collaborate.
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

import type { UiSettings } from "../../storage.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";
import { readApiJson } from "./api-json.ts";

/** Where a member's pin came from, as the service reports it. */
export type MemberMapSource = "slack" | "roster" | "login";

/**
 * How finely the pin locates the member: a city somebody wrote down or signed in from, the city a
 * time zone is named for (which also covers its neighbours), or only a country.
 */
export type MemberMapPrecision = "city" | "timezone" | "country";

export type MemberMapMember = {
  member_id: string;
  name: string;
  avatar_url?: string;
  last_login_at?: string;
  source?: MemberMapSource;
  precision?: MemberMapPrecision;
};

/** One city the gazetteer knows, with however much of its membership the caller may see. */
export type MemberMapPlace = {
  key: string;
  label: string;
  country: string;
  lat: number;
  lon: number;
  /**
   * Placed only to a country, from a sign-in's IP geolocation, not to a city anyone wrote down.
   * The service marks these with a `country:` key; the dot sits on the country's centroid, which
   * is not where the person is, so the card draws it differently rather than implying a city.
   */
  approximate?: boolean;
  /** Present in both shapes. In `full` it equals `members.length`. */
  count: number;
  /** `full` only: who is there. Absent for a non-admin, which is not an error. */
  members?: MemberMapMember[];
};

export type MemberMap = {
  mode: "full" | "summary";
  places: MemberMapPlace[];
  /**
   * The credit the service's IP geolocation provider requires wherever its data is shown (DB-IP
   * Lite is CC BY 4.0). The service names it because only the service knows which provider runs.
   */
  attribution?: { text: string; url: string };
  /** Members whose written location the gazetteer could not place. A count only — see below. */
  unplaced: number;
  counts: { placed: number; unplaced: number; unknown: number };
  /** When this copy arrived (ms since epoch), for "Updated N min ago". Set by loadMemberMap. */
  loadedAt?: number;
};

export type MemberMapHost = {
  settings: UiSettings;
  /** Undefined until a tab that shows this optional card first requests it. */
  adminBotMemberMap: MemberMap | null | undefined;
  adminBotMemberMapLoading: boolean;
  adminBotMemberMapRequestId?: number;
  /** When the last read finished, either way, so a failing service is asked again on the timer. */
  adminBotMemberMapCheckedAt?: number;
};

/**
 * How often an open map asks again. Sign-in cities change as people sign in, and the card says
 * "Updated N min ago", so a tab left open all afternoon should not quietly show the morning.
 */
export const MEMBER_MAP_REFRESH_MS = 5 * 60 * 1000;

export function invalidateMemberMap(host: {
  adminBotMemberMap?: MemberMap | null;
  adminBotMemberMapLoading?: boolean;
  adminBotMemberMapRequestId?: number;
}): void {
  host.adminBotMemberMapRequestId = (host.adminBotMemberMapRequestId ?? 0) + 1;
  host.adminBotMemberMap = undefined;
  host.adminBotMemberMapLoading = false;
}

// The tabs that render the card. Collaborate shows it too, so a member who opens Collaborate
// first -- or only -- still gets the map, instead of a card that only fills in after a detour
// through the Dashboard.
const MEMBER_MAP_TABS: ReadonlySet<string> = new Set(["dashboard", "labSharing"]);

export function isMemberMapTab(tab: string): boolean {
  return MEMBER_MAP_TABS.has(tab);
}

/** What decides a refresh beyond the first load; without it only the first load is ever due. */
export type MemberMapRefreshContext = {
  /** The tab on the previous render: arriving on a map tab from anywhere else reads it again. */
  previousTab?: string;
  /** When the last read finished (MemberMapHost.adminBotMemberMapCheckedAt). */
  checkedAt?: number;
  now: number;
  /** document.visibilityState === "visible": a background tab does not poll. */
  visible: boolean;
};

export function needsMemberMap(
  tab: string,
  hasMemberSession: boolean,
  map: MemberMap | null | undefined,
  loading: boolean,
  refresh?: MemberMapRefreshContext,
): boolean {
  if (!MEMBER_MAP_TABS.has(tab) || !hasMemberSession || loading) {
    return false;
  }
  if (map === undefined) {
    return true;
  }
  if (!refresh) {
    return false;
  }
  if (refresh.previousTab !== undefined && refresh.previousTab !== tab) {
    return true;
  }
  return (
    refresh.visible &&
    refresh.checkedAt !== undefined &&
    refresh.now - refresh.checkedAt >= MEMBER_MAP_REFRESH_MS
  );
}

// One ticker for the whole app, so the "Updated N min ago" line moves and a due refresh is noticed
// without anyone touching the page. It only asks for a render; needsMemberMap decides whether that
// render reads the map again.
let ticker: ReturnType<typeof setInterval> | undefined;
let tickerTarget: { tab: () => string; update: () => void } | undefined;

export function ensureMemberMapTicker(tab: () => string, update: () => void): void {
  tickerTarget = { tab, update };
  if (ticker !== undefined || typeof setInterval !== "function") {
    return;
  }
  const tick = () => {
    const target = tickerTarget;
    const visible = typeof document === "undefined" || document.visibilityState === "visible";
    if (target && visible && MEMBER_MAP_TABS.has(target.tab())) {
      target.update();
    }
  };
  ticker = setInterval(tick, 60_000);
  // Coming back to a tab that sat in the background past its refresh catches up at once.
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", tick);
  }
}

// A literal "null" is what a blank spreadsheet cell or a JSON null pushed through String() turns
// into. The service already drops these rows; this keeps the card from ever printing one if an
// older service answers.
function isRenderableName(name: unknown): name is string {
  if (typeof name !== "string") {
    return false;
  }
  const trimmed = name.trim().toLowerCase();
  return trimmed !== "" && trimmed !== "null" && trimmed !== "undefined";
}

type RawPlace = {
  key?: unknown;
  label?: unknown;
  country?: unknown;
  lat?: unknown;
  lon?: unknown;
  count?: unknown;
  members?: unknown;
};

// Anything else -- an older service, a typo -- is dropped, and the card says nothing about how the
// pin was placed rather than saying something wrong.
const SOURCES: ReadonlySet<MemberMapSource> = new Set(["slack", "roster", "login"]);
const PRECISIONS: ReadonlySet<MemberMapPrecision> = new Set(["city", "timezone", "country"]);

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
        const record = entry as {
          member_id?: unknown;
          name?: unknown;
          avatar_url?: unknown;
          last_login_at?: unknown;
          source?: unknown;
          precision?: unknown;
        };
        if (!isRenderableName(record?.name)) {
          return [];
        }
        const avatarUrl = typeof record.avatar_url === "string" ? record.avatar_url.trim() : "";
        const lastLoginAt =
          typeof record.last_login_at === "string" ? record.last_login_at.trim() : "";
        const source = SOURCES.has(record.source as MemberMapSource)
          ? (record.source as MemberMapSource)
          : undefined;
        const precision = PRECISIONS.has(record.precision as MemberMapPrecision)
          ? (record.precision as MemberMapPrecision)
          : undefined;
        const member: MemberMapMember = {
          member_id: String(record.member_id ?? ""),
          name: record.name,
          ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
          ...(lastLoginAt ? { last_login_at: lastLoginAt } : {}),
          ...(source ? { source } : {}),
          ...(precision ? { precision } : {}),
        };
        return [member];
      })
    : undefined;
  const count = asNumber(raw.count);
  const key = String(raw.key ?? raw.label ?? `${lat},${lon}`);
  return {
    key,
    label: String(raw.label ?? ""),
    country: String(raw.country ?? ""),
    lat,
    lon,
    approximate: key.startsWith("country:"),
    // The summary shape carries `count`; the full shape carries `members`. Either is enough.
    count: Number.isNaN(count) ? (members?.length ?? 0) : count,
    ...(members ? { members } : {}),
  };
}

// Only an https link: the text lands in an <a href>, and anything else (a javascript: URL from a
// misconfigured or compromised service) is dropped along with its text.
function toAttribution(raw: unknown): MemberMap["attribution"] {
  const record = raw as { text?: unknown; url?: unknown } | null | undefined;
  const text = typeof record?.text === "string" ? record.text.trim() : "";
  const url = typeof record?.url === "string" ? record.url.trim() : "";
  return text && url.startsWith("https://") ? { text, url } : undefined;
}

export function parseMemberMap(body: unknown): MemberMap | null {
  const raw = body as {
    mode?: unknown;
    places?: unknown;
    unplaced?: unknown;
    unplaced_count?: unknown;
    counts?: unknown;
    attribution?: unknown;
  } | null;
  if (!raw || !Array.isArray(raw.places)) {
    return null;
  }
  const counts = (raw.counts ?? {}) as { placed?: unknown; unplaced?: unknown; unknown?: unknown };
  const places = raw.places
    .map((place) => toPlace(place as RawPlace))
    .filter((place): place is MemberMapPlace => place !== null)
    .toSorted((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  const attribution = toAttribution(raw.attribution);
  return {
    mode: raw.mode === "full" ? "full" : "summary",
    places,
    ...(attribution ? { attribution } : {}),
    // Only ever a number here: the card is a prompt to extend the gazetteer, not a roster. The full
    // response sends `unplaced_count`; an older server sent the list itself.
    unplaced: Array.isArray(raw.unplaced) ? raw.unplaced.length : asNumber(raw.unplaced_count) || 0,
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
  const token = loadStoredMemberSession()?.sessionToken ?? null;
  const requestId = (host.adminBotMemberMapRequestId ?? 0) + 1;
  host.adminBotMemberMapRequestId = requestId;
  const isCurrent = () =>
    (loadStoredMemberSession()?.sessionToken ?? null) === token &&
    host.adminBotMemberMapRequestId === requestId;
  host.adminBotMemberMapLoading = true;
  try {
    const response = await fetch(`${resolveAdminBotBaseUrl(host.settings)}/member-map`, {
      // Capitalised to match every other authed call in the Control UI (see session.ts).
      // Header names are case-insensitive on the wire, but a lone lowercase one reads as a
      // different code path to anyone grepping, and to a test asserting over all calls.
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok || !isCurrent()) {
      return;
    }
    const parsed = parseMemberMap(await readApiJson(response));
    if (isCurrent()) {
      host.adminBotMemberMap = parsed ? { ...parsed, loadedAt: Date.now() } : parsed;
    }
  } catch {
    // Unreachable service, offline, blocked request: leave the card as it was (empty on a first
    // load, the last good copy -- with its own "Updated" time -- on a refresh).
  } finally {
    if (isCurrent()) {
      host.adminBotMemberMapCheckedAt = Date.now();
      // A failed optional card stays empty; it is asked again on the next tab visit or refresh
      // tick, never on every render.
      if (host.adminBotMemberMap === undefined) {
        host.adminBotMemberMap = null;
      }
      host.adminBotMemberMapLoading = false;
    }
  }
}
