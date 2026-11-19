// Pilot enrollment enables the CLI. The current website role and each handler's
// ownership, approval and workflow checks still determine access to the target.
import contract from "../../../cli/openapi.generated.json" with { type: "json" };

const memberPaths: Record<string, string> = {
  "/auth/session": "GET",
  "/auth/logout": "POST",
  "/my/projects": "GET",
  "/my/projects/{projects_id}/weekly-updates": "GET",
  "/papers": "GET",
  "/papers/{papers_id}": "GET PUT DELETE",
  "/papers/{papers_id}/progress": "PATCH",
  "/papers/{papers_id}/slots": "GET",
  "/papers/{papers_id}/slots/{slots_id}": "PUT",
  "/papers/{papers_id}/weekly-updates": "GET POST",
  "/papers/{papers_id}/internal-peer-review": "GET PUT",
  "/papers/{papers_id}/recent-edits": "GET",
  "/papers/{papers_id}/attendees": "PUT",
  "/papers/{papers_id}/reimbursements/{reimbursements_id}": "PUT",
  "/papers/{papers_id}/social-drafts": "POST",
  "/papers/social-drafts/{social_drafts_id}/circulate": "POST",
  "/papers/social-drafts/{social_drafts_id}/consent": "POST",
  "/papers/slot-overview": "GET",
  "/papers/linkedin-draft": "POST",
  "/papers/x-draft": "POST",
  "/papers/relevant": "GET",
  "/lab/members/self": "GET",
  "/lab/members/roster": "GET",
  "/lab/members/{members_id}": "PUT",
  "/lab/members/{members_id}/detail": "GET",
  "/lab/members/{members_id}/locations": "GET",
  "/lab/members/{members_id}/recent-edits": "GET",
  "/lab/members/{members_id}/travel": "GET",
  "/lab/members/requests": "GET POST",
  "/lab/members/collaborator-schedules": "GET",
  "/onboarding/interviewers": "GET",
  "/onboarding/interview-invitation": "POST",
  "/lab/members/requests/{requests_id}": "DELETE",
  "/drive/check-edit-access": "POST",
  "/onboarding/ack": "POST",
  "/member-drafts/{member_drafts_id}": "GET PUT",
  "/notifications": "GET",
  "/notifications/read": "POST",
  "/profile/device-location": "POST",
  "/profile/location-permission": "POST",
  "/profile/location-prompt": "GET POST",
  "/profile-photo/apply": "POST",
  "/profile-photo/polish": "POST",
  "/badges": "GET",
  "/badges/nominations": "GET POST",
  "/badges/suggestions": "GET POST",
  "/lab-sharing": "GET",
  "/lab-sharing/ask": "POST",
  "/lab-sharing/discover": "GET",
  "/lab-sharing/mine": "GET",
  "/lab-sharing/members": "GET",
  "/lab-sharing/projects/{projects_id}": "GET",
  "/lab-sharing/invites": "GET POST",
  "/lab-sharing/requests/{requests_id}": "PUT",
  "/lab-sharing/requests/{requests_id}/close": "POST",
  "/lab-sharing/requests/{requests_id}/interest": "PUT",
  "/lab-sharing/requests/{requests_id}/interest/withdraw": "POST",
  "/lab-sharing/status": "GET",
  "/meetings": "GET",
  "/meetings/series": "GET",
  "/meetings/{meetings_id}": "GET",
  "/events": "GET",
  "/events/preferences": "PUT",
  "/events/say-hi": "POST",
  "/travel": "GET",
  "/travel/location": "POST",
  "/travel/sharing": "GET PUT",
  "/travel/whos-in": "GET",
  "/travel/conferences/{conferences_id}/rsvp": "PUT DELETE",
  "/conferences/{conferences_id}/trip": "PUT DELETE",
  "/logistics/requests": "GET POST",
  "/logistics/requests/{requests_id}": "GET PUT",
  "/logistics/requests/{requests_id}/withdraw": "POST",
  "/logistics/requests/{requests_id}/confirm-submitted": "POST",
  "/logistics/requests/{requests_id}/confirm-submitted/undo": "POST",
  "/logistics/eligibility/me": "GET",
  "/logistics/signature-form": "POST",
  "/reimbursements/converse": "POST",
  "/reimbursements/generate": "POST",
  "/reimbursements/submit": "POST",
  "/deadlines": "GET",
  "/deadline-proposals": "GET POST",
  "/opportunities": "GET POST",
  "/opportunities/{opportunities_id}": "PUT DELETE",
  "/venue-picker": "GET",
  "/venue-papers/categories": "GET",
  "/venue-papers/search": "POST",
  "/venue-papers/sources": "GET",
  "/papermentor/reviews": "GET POST",
  "/papermentor/reviews/{reviews_id}/files/{files_id}": "GET",
  "/cv/talk-leaderboard": "GET",
  "/guidebook/ask": "POST",
  "/feedback": "POST",
  "/openapi.json": "GET",
};

// Resolve the most specific *path* before considering the method. A catalog
// entry for /papers/pi-review must never inherit the permissions of /papers/{id}.
const routes = Object.entries(contract.paths)
  .map(([path, methods]) => {
    const parts = path.split("/");
    const operations = Object.entries(methods).map(([verb, entry]) => ({
      id: entry.operationId,
      method: verb.toUpperCase(),
      path,
      member: memberPaths[path]?.split(" ").includes(verb.toUpperCase()) ?? false,
    }));
    return { parts, specificity: parts.filter((p) => !p.startsWith("{")).length, operations };
  })
  .sort((a, b) => b.specificity - a.specificity);

type Operation = (typeof routes)[number]["operations"][number];

function admits(op: Operation, admin: boolean): boolean {
  if (op.member) return true;
  if (!admin || op.path.startsWith("/internal/") || op.path === "/lab/members/{members_id}/email")
    return false;
  // Credential management and device pairing require interactive authentication.
  return !op.path.startsWith("/auth/") || op.path.startsWith("/auth/registrations");
}

export function pilotOperations(admin: boolean): string[] {
  return routes.flatMap((route) =>
    route.operations.filter((op) => admits(op, admin)).map((op) => op.id),
  );
}

export function pilotOperation(path: string, method: string | undefined, admin: boolean) {
  const parts = path.split("/");
  const route = routes.find(
    (r) =>
      r.parts.length === parts.length &&
      r.parts.every(
        (segment, i) => segment === parts[i] || (segment.startsWith("{") && Boolean(parts[i])),
      ),
  );
  return route?.operations.find((op) => op.method === method && admits(op, admin));
}
