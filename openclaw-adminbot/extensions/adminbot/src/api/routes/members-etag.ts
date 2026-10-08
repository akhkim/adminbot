// Version ETags for the member views: GET /lab/members (every view) and GET /lab/members/self.
//
// A member view reads the roster, badge definitions and awards, the published deadlines and the
// deadline dataset file (milestones are reconciled against both), and is then redacted for the
// viewer. The store's labMemberViewVersion covers the stored inputs; the dataset is versioned by
// the same stat token readDeadlineDataset caches on, which is the reader server.ts wires into the
// service. A store without the version (the in-memory test store) keeps the byte hash.
import type { AdminBotListPage, AdminBotServiceStore } from "../../kernel/service.js";
import { deadlineDatasetVersion } from "../../workflows/deadlines/runtime-dataset.js";
import type { AdminBotPrincipal } from "./context.js";
import { principalRole, versionEtag } from "./version-etag.js";

type MemberViewVersionedStore = AdminBotServiceStore & { labMemberViewVersion?(): string };

export function memberViewEtag(
  store: AdminBotServiceStore,
  principal: AdminBotPrincipal,
  route: "lab-members" | "lab-members.self",
  query: { view?: string | null; page?: AdminBotListPage } = {},
): string | undefined {
  const version = (store as MemberViewVersionedStore).labMemberViewVersion?.();
  if (version === undefined) {
    return undefined;
  }
  return versionEtag(route, [
    version,
    deadlineDatasetVersion(),
    principalRole(principal),
    // Redaction keeps a member's own private fields and the summary view carries `self`, so the
    // body differs per member. Admins are keyed too: it costs nothing and needs no argument.
    principal.kind === "member" ? principal.member.id : null,
    query.view ?? null,
    query.page?.limit,
    query.page?.offset,
    query.page?.q,
  ]);
}
