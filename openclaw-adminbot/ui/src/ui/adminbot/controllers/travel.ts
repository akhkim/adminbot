// The travel tab's side of the wire.
//
// One record at a time -- the viewer's own -- rather than a roster of them. The page is a
// professor reading their own year, and holding one history is what keeps it that way: there is no
// state here that could accumulate other people's movements.
import { t } from "../../../i18n/index.ts";
import type { UiSettings } from "../../storage.ts";
import {
  fetchMemberTravelHistory,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
  type TravelHistoryRow,
} from "../auth/session.ts";

/** Which slice of the log to ask for. Named windows rather than a date picker: see below. */
export type TravelRange = "12m" | "24m" | "all";

export type TravelState = {
  history: TravelHistoryRow | null;
  range: TravelRange;
  loading: boolean;
  error: string | null;
};

export type AdminBotTravelHost = {
  settings: UiSettings;
  /** The signed-in member. This page only ever asks for their own record. */
  memberId: string | null;
  adminBotTravel: TravelState;
};

export const EMPTY_TRAVEL: TravelState = {
  history: null,
  // A year, because that is the unit the two things this page is for are measured in: a
  // reimbursement window and the next year's planning. "All" is a click away for anyone who wants
  // the whole record.
  range: "12m",
  loading: false,
  error: null,
};

/**
 * The ISO instant a range starts at, or undefined for the whole log.
 *
 * Computed from a clock passed in rather than read from `Date.now()` inline so a test can pin it;
 * the boundary lands on a month, not on the hour the page happened to be opened, which keeps two
 * loads a minute apart from returning subtly different stays.
 */
export function rangeStart(range: TravelRange, now = new Date()): string | undefined {
  if (range === "all") {
    return undefined;
  }
  const months = range === "12m" ? 12 : 24;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1));
  return start.toISOString();
}

function failureText(result: { kind: string; message?: string }, baseUrl: string): string {
  if (result.kind === "unreachable") {
    return t("adminbotTravel.error.unreachable", { url: baseUrl });
  }
  if (result.kind === "forbidden") {
    return t("adminbotTravel.error.forbidden");
  }
  // The Control UI ships on merge and the service deploys separately, so this page can outrun the
  // route that answers it. "Not deployed yet" and "you have never travelled" look identical on
  // screen otherwise.
  if (result.kind === "not-found") {
    return t("adminbotTravel.error.notDeployed");
  }
  return result.message ?? t("adminbotTravel.error.failed");
}

export async function loadAdminBotTravel(
  host: AdminBotTravelHost,
  options: { range?: TravelRange } = {},
): Promise<void> {
  const stored = loadStoredMemberSession();
  const range = options.range ?? host.adminBotTravel.range;
  const patch = (state: Partial<TravelState>) => {
    host.adminBotTravel = { ...host.adminBotTravel, range, ...state };
  };
  if (!stored || !host.memberId) {
    patch({ history: null, loading: false, error: t("adminbotTravel.error.signIn") });
    return;
  }
  const baseUrl = resolveAdminBotBaseUrl(host.settings);
  // The old history stays on screen while a wider range loads. Blanking it would flash the page
  // empty on every range change, which reads as "no travel found" for as long as the request takes.
  patch({ loading: true, error: null });
  const from = rangeStart(range);
  const result = await fetchMemberTravelHistory(
    host.memberId,
    stored.sessionToken,
    baseUrl,
    from ? { fromIso: from } : undefined,
  );
  patch(
    result.ok
      ? { history: result.value, loading: false, error: null }
      : { history: null, loading: false, error: failureText(result, baseUrl) },
  );
}
