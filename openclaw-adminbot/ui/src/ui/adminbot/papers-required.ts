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
