import { randomUUID } from "node:crypto";
import type { AdminBotLabMember, AdminBotPaperRecord } from "../contracts/actions.js";
import { validateHelpRequest } from "../contracts/lab-sharing.js";
import type { AdminBotServiceStore } from "./service.js";

type OwnsPaper = (member: AdminBotLabMember, paper: AdminBotPaperRecord) => boolean;
const failure = (status: number, message: string) => ({
  ok: false as const,
  status,
  error: { message },
});

// Only the local lab ledger is changed here. No notification or vendor connector is invoked.
export class LabSharingService {
  constructor(
    private store: AdminBotServiceStore,
    private ownsPaper: OwnsPaper,
  ) {}
  list(memberId: string) {
    const member = this.store.getLabMember(memberId);
    if (!member) {return failure(403, "A member session is required.");}
    const papers = this.store.listPapers();
    const canManage = (paper: AdminBotPaperRecord) =>
      member.privilege_level === "admin" || this.ownsPaper(member, paper);
    return {
      ok: true as const,
      status: 200,
      payload: {
        projects: papers.filter(canManage).map((paper) => ({ id: paper.id, title: paper.title })),
        requests: this.store
          .listHelpRequests()
          .flatMap((request) => {
            const paper = papers.find((p) => p.id === request.paper_id);
            if (!paper || (request.status !== "open" && !canManage(paper))) {return [];}
            return [
              {
                ...request,
                title: paper.title,
                owner_name: this.store.getLabMember(request.owner_id)?.name ?? "Lab member",
                can_manage: canManage(paper),
              },
            ];
          })
          .toSorted((a, b) => b.updated_at.localeCompare(a.updated_at)),
      },
    };
  }
  save(memberId: string, paperId: string, input: unknown, close = false) {
    const member = this.store.getLabMember(memberId);
    const paper = this.store.getPaper(paperId);
    if (!member) {return failure(403, "A member session is required.");}
    if (!paper) {return failure(404, "Project not found.");}
    if (member.privilege_level !== "admin" && !this.ownsPaper(member, paper))
      {return failure(403, "Only a project author or administrator can manage its help request.");}
    const existing = this.store.listHelpRequests().find((row) => row.paper_id === paperId);
    if (close && !existing) {return failure(404, "Help request not found.");}
    const draft = close ? existing! : validateHelpRequest(input);
    if (typeof draft === "string") {return failure(400, draft);}
    const now = new Date().toISOString();
    this.store.saveHelpRequest({
      ...draft,
      paper_id: paperId,
      owner_id: existing?.owner_id ?? memberId,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      status: close ? "closed" : "open",
    });
    this.store.recordAudit({
      id: `aud_${randomUUID()}`,
      timestamp: now,
      type: close ? "lab_help.closed" : "lab_help.saved",
      actor: memberId,
      details: { paper_id: paperId },
    });
    return this.list(memberId);
  }
}
