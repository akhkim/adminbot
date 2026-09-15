// The Tab Usage tab's side of the wire: read the window, and hand over the rows behind it.
//
// Two calls rather than one, because they answer to different readers. The report is what the page
// draws and is small whatever the window; the rows are for an analysis that happens somewhere else
// entirely (R, a notebook, a paper), so they are fetched only when somebody asks to export and are
// never held in view state.
import { t } from "../../../i18n/index.ts";
import type { UiSettings } from "../../storage.ts";
import {
  fetchTabVisitReport,
  fetchTabVisitRows,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
  type TabVisitReport,
  type TabVisitRow,
} from "../auth/session.ts";

/** The windows the page offers. Days, because that is how the question is asked. */
export const TAB_USAGE_WINDOWS = [7, 30, 90] as const;

export type AdminBotTabUsageHost = {
  settings: UiSettings;
  adminBotTabUsage: TabVisitReport | null;
  adminBotTabUsageDays: number;
  adminBotTabUsageLoading: boolean;
  adminBotTabUsageError: string | null;
  adminBotTabUsageExporting: boolean;
};

function failureText(result: { kind: string; message?: string }, baseUrl: string): string {
  if (result.kind === "unreachable") {
    return t("tabUsage.error.unreachable", { url: baseUrl });
  }
  if (result.kind === "forbidden") {
    return t("tabUsage.error.forbidden");
  }
  return result.message ?? t("tabUsage.error.failed");
}

function session(host: AdminBotTabUsageHost): { token: string; baseUrl: string } | null {
  const stored = loadStoredMemberSession();
  return stored
    ? { token: stored.sessionToken, baseUrl: resolveAdminBotBaseUrl(host.settings) }
    : null;
}

export async function loadAdminBotTabUsage(host: AdminBotTabUsageHost): Promise<void> {
  const wire = session(host);
  if (!wire) {
    host.adminBotTabUsageError = t("tabUsage.error.signIn");
    return;
  }
  host.adminBotTabUsageLoading = true;
  host.adminBotTabUsageError = null;
  try {
    const result = await fetchTabVisitReport(wire.token, wire.baseUrl, host.adminBotTabUsageDays);
    if (!result.ok) {
      // The old window is left on screen rather than blanked: an unreachable service should not
      // also erase the numbers somebody was reading.
      host.adminBotTabUsageError = failureText(result, wire.baseUrl);
      return;
    }
    host.adminBotTabUsage = result.value;
  } finally {
    host.adminBotTabUsageLoading = false;
  }
}

/**
 * The log as a CSV file, built in the browser.
 *
 * Client-side rather than a CSV route, because the service already hands over the rows and a second
 * representation of them on the server is a second thing to keep honest. One row per visit, the
 * service's own field names in the header, so a column in the paper's analysis and a column here
 * mean the same thing without a translation table.
 */
export async function exportAdminBotTabUsage(host: AdminBotTabUsageHost): Promise<void> {
  const wire = session(host);
  if (!wire) {
    host.adminBotTabUsageError = t("tabUsage.error.signIn");
    return;
  }
  host.adminBotTabUsageExporting = true;
  host.adminBotTabUsageError = null;
  try {
    const result = await fetchTabVisitRows(wire.token, wire.baseUrl, host.adminBotTabUsageDays);
    if (!result.ok) {
      host.adminBotTabUsageError = failureText(result, wire.baseUrl);
      return;
    }
    downloadCsv(
      `adminbot-tab-visits-${host.adminBotTabUsageDays}d.csv`,
      tabVisitsCsv(result.value),
    );
  } finally {
    host.adminBotTabUsageExporting = false;
  }
}

/**
 * Rows as CSV text.
 *
 * Exported for its own test: quoting is the part that quietly corrupts an export, and a tab id or
 * member id containing a comma would otherwise shift every column after it by one.
 */
export function tabVisitsCsv(rows: readonly TabVisitRow[]): string {
  const header = ["id", "member_id", "tab", "at", "impersonated"];
  const lines = rows.map((row) =>
    [row.id, row.member_id, row.tab, row.at, row.impersonated ? "1" : "0"].map(csvCell).join(","),
  );
  return [header.join(","), ...lines].join("\n");
}

function csvCell(value: string): string {
  // Quote when the value could otherwise break the row, and double any quote inside it -- the RFC
  // 4180 rule, which every reader of a CSV already expects.
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function downloadCsv(filename: string, text: string): void {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
