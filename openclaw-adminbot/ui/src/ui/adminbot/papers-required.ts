/** Pages whose visible content or filters use the lab-wide paper list. */
export function needsLabPapers(tab: string): boolean {
  return (
    tab === "dashboard" ||
    tab === "profile" ||
    tab === "myWork" ||
    tab === "adminbotMembers" ||
    tab === "adminbotPapers" ||
    tab === "adminbotAnnouncements" ||
    tab === "adminbotCalendar" ||
    tab === "adminbotProfessor" ||
    tab === "adminbotGrantReport"
  );
}

/**
 * Which paper read a page needs: "own" is `GET /papers?scope=mine`, "lab" the full list.
 *
 * The Profile only ever draws its viewer's papers (badges, project chips), and so does a plain
 * member's Dashboard; an admin's Dashboard summarizes the whole pipeline. Every other page that
 * needs papers needs all of them.
 */
export type PaperScope = "own" | "lab";

export function paperScopeForTab(tab: unknown, privilegeLevel: unknown): PaperScope {
  if (tab === "profile" || (tab === "dashboard" && privilegeLevel !== "admin")) {
    return "own";
  }
  return "lab";
}

type PaperLoadStamps = { papersLoadedAt?: number | null; ownPapersLoadedAt?: number | null };

/**
 * Whether the loaded papers are enough for a page of this scope. The full list is a superset of
 * the viewer's own papers, so it satisfies either; an own-scope read never satisfies a lab page,
 * which is why it has its own stamp rather than setting papersLoadedAt.
 */
export function papersReadyFor(data: PaperLoadStamps | undefined, scope: PaperScope): boolean {
  if (data?.papersLoadedAt) {
    return true;
  }
  return scope === "own" && Boolean(data?.ownPapersLoadedAt);
}

/** The papers a page needs and does not have yet, for the host's active tab and viewer. */
export function papersMissingFor(host: {
  tab?: unknown;
  memberPrivilegeLevel?: unknown;
  adminBotData?: PaperLoadStamps;
}): boolean {
  return !papersReadyFor(host.adminBotData, paperScopeForTab(host.tab, host.memberPrivilegeLevel));
}
