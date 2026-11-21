// Pilot enrollment enables the CLI. The current website role and each handler's
// ownership, approval and workflow checks still determine access to the target.
import contract from "../../../cli/openapi.generated.json" with { type: "json" };

// A member's CLI token reads and edits their own records. It does not message other people or
// spend model or paid-API time: a leaked token, or an agent stuck in a loop, could otherwise send
// invites, Slack hellos and social posts, or run up model calls, as fast as it can make requests.
// Those routes stay on the website, behind a click (say-hi, invites, social drafts, reimbursement
// filing, the guidebook and lab-sharing assistants, photo polish, venue search, PaperMentor runs).
const memberPaths: Record<string, string> = {
  "/auth/session": "GET",
  "/auth/logout": "POST",
  "/my/projects": "GET",
  "/my/projects/{projects_id}/weekly-updates": "GET",
  "/papers": "GET",
  "/papers/{papers_id}": "GET PUT DELETE",
  "/papers/{papers_id}/poster-print": "GET PUT",
  "/poster-printing": "GET",
  "/poster-printing/{poster_printing_id}/printed": "POST",
  "/papers/{papers_id}/progress": "PATCH",
  "/papers/{papers_id}/slots": "GET",
  "/papers/{papers_id}/slots/{slots_id}": "PUT",
  "/papers/{papers_id}/weekly-updates": "GET POST",
  "/papers/{papers_id}/internal-peer-review": "GET PUT",
  "/papers/{papers_id}/recent-edits": "GET",
  "/papers/{papers_id}/attendees": "PUT",
  "/papers/{papers_id}/reimbursements/{reimbursements_id}": "PUT",
  "/papers/social-drafts/{social_drafts_id}/consent": "POST",
  "/papers/slot-overview": "GET",
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
  "/badges": "GET",
  "/badges/nominations": "GET POST",
  "/badges/suggestions": "GET POST",
  "/lab-sharing": "GET",
  "/lab-sharing/discover": "GET",
  "/lab-sharing/mine": "GET",
  "/lab-sharing/members": "GET",
  "/lab-sharing/projects/{projects_id}": "GET",
  "/lab-sharing/invites": "GET",
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
  "/deadlines": "GET",
  "/deadline-proposals": "GET POST",
  "/opportunities": "GET POST",
  "/opportunities/{opportunities_id}": "PUT DELETE",
  "/venue-picker": "GET",
  "/venue-papers/categories": "GET",
  "/venue-papers/sources": "GET",
  "/papermentor/reviews": "GET",
  "/papermentor/reviews/{reviews_id}/files/{files_id}": "GET",
  "/cv/talk-leaderboard": "GET",
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

// Admin routes an admin's CLI token cannot reach, because each can hand someone access or a
// sign-in another way: a merge copies the duplicate's reset address, CLI role and password onto
// the survivor; renaming an id sidesteps the "already enrolled" check; sheet rows and onboarding
// derive privilege from Member Type; PUT /settings can name the PI. They stay in the browser.
const adminBrowserOnly = new Set([
  "POST /lab/members/merge",
  "POST /lab/members/{members_id}/id",
  "POST /membership/sheet/rows",
  "PUT /membership/sheet/rows",
  "PATCH /membership/sheet/rows",
  "DELETE /membership/sheet/rows",
  "POST /membership/sheet/onboard",
  "PUT /settings",
  "PATCH /settings",
]);

function admits(op: Operation, admin: boolean): boolean {
  if (op.member) return true;
  if (
    !admin ||
    op.path.startsWith("/internal/") ||
    op.path === "/lab/members/{members_id}/email" ||
    adminBrowserOnly.has(`${op.method} ${op.path}`)
  )
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
