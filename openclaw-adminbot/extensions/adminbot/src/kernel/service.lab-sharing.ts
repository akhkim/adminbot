import { randomUUID } from "node:crypto";
import type { AdminBotLabMember, AdminBotPaperRecord } from "../contracts/actions.js";
import {
  decodeDiscoveryCursor,
  encodeDiscoveryCursor,
} from "../contracts/lab-sharing-discovery-cursor.js";
import { parseLabSharingDiscoveryQuery } from "../contracts/lab-sharing-discovery.js";
import { validateHelpInterest } from "../contracts/lab-sharing-interest.js";
import { validateHelpRequest } from "../contracts/lab-sharing.js";
import type { AdminBotServiceStore } from "./service.js";
import { searchLabSharingMembers } from "./service.lab-sharing-members.js";
import { LabSharingStatusService } from "./service.lab-sharing-status.js";

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
  directorStatus() {
    return new LabSharingStatusService(this.store);
  }
  searchMembers(memberId: string, query: string) {
    return searchLabSharingMembers(this.store, this.ownsPaper, memberId, query);
  }
  projectDetail(memberId: string, paperId: string) {
    const member = this.store.getLabMember(memberId);
    if (!member) return failure(403, "A member session is required.");
    const paper = this.store.getPaper(paperId);
    const request = this.store.getHelpRequest(paperId);
    const canManage = Boolean(
      paper && (member.privilege_level === "admin" || this.ownsPaper(member, paper)),
    );
    if (!paper || !request || (request.status !== "open" && !canManage))
      return failure(404, "Project help request not found.");
    return {
      ok: true as const,
      status: 200,
      payload: {
        request: {
          ...request,
          title: paper.title,
          owner_name: this.store.getLabMember(request.owner_id)?.name ?? "Lab member",
          can_manage: canManage,
        },
      },
    };
  }
  discover(memberId: string, params: URLSearchParams) {
    const member = this.store.getLabMember(memberId);
    if (!member) return failure(403, "A member session is required.");
    const query = parseLabSharingDiscoveryQuery(params);
    if (typeof query === "string") return failure(400, query);
    if (params.getAll("cursor").length > 1) return failure(400, "Provide cursor only once.");
    const token = params.get("cursor");
    const after = token === null ? undefined : decodeDiscoveryCursor(query, token);
    if (typeof after === "string") return failure(400, after);
    const rows = this.store.discoverHelpRequests(query, after);
    const requests = rows.slice(0, query.limit).map((request) => {
      const paper = this.store.getPaper(request.paper_id);
      return {
        ...request,
        can_manage: Boolean(
          paper && (member.privilege_level === "admin" || this.ownsPaper(member, paper)),
        ),
      };
    });
    const last = requests.at(-1);
    const nextCursor =
      rows.length > query.limit && last
        ? encodeDiscoveryCursor(query, {
            title: last.title,
            hours: last.hours_per_week,
            paperId: last.paper_id,
          })
        : null;
    return { ok: true as const, status: 200, payload: { requests, next_cursor: nextCursor } };
  }
  /**
   * The Collaborate tab's view of what the viewer may act on.
   *
   * Two questions, kept separate, because one answer cannot serve both:
   *
   *   canManage -- may I act on this row? Ownership, or an administrator overseeing the lab. It
   *                decides what is *visible and actionable* here, and it is deliberately wide:
   *                an admin reads everything.
   *   owns      -- did I author this paper? It decides nothing about access and everything about
   *                *order*. An admin who reads the whole lab still opens this tab to their own
   *                work, and scrolling the lab to find it is the thing to avoid.
   *
   * So every list below is filtered by the first and sorted by the second, own work first, each
   * group keeping the ordering it would otherwise have had. Discover is left alone on purpose:
   * its order is the caller's (title or hours) and its pagination cursor is built from those
   * columns, so re-sorting it would silently break paging through the lab.
   */
  list(memberId: string, managedOnly = false) {
    const member = this.store.getLabMember(memberId);
    if (!member) {
      return failure(403, "A member session is required.");
    }
    const papers = this.store.listPapers();
    const owns = (paper: AdminBotPaperRecord) => this.ownsPaper(member, paper);
    const canManage = (paper: AdminBotPaperRecord) =>
      member.privilege_level === "admin" || owns(paper);
    // Resolved once: ownership walks a paper's authors, and the lists below ask about the same
    // papers repeatedly.
    const ownedPaperIds = new Set(papers.filter(owns).map((paper) => paper.id));
    // Sorts own work to the front while leaving everything else in the order it arrived. Array
    // sort is stable, so "mine first" is all this says -- it does not reshuffle either group.
    const mineFirst = <T>(rows: T[], paperIdOf: (row: T) => string) =>
      rows.toSorted(
        (left, right) =>
          Number(ownedPaperIds.has(paperIdOf(right))) - Number(ownedPaperIds.has(paperIdOf(left))),
      );
    return {
      ok: true as const,
      status: 200,
      payload: {
        interests: mineFirst(
          this.store.listHelpInterests(),
          (interest) => interest.paper_id,
        ).flatMap((interest) => {
          const paper = papers.find((entry) => entry.id === interest.paper_id);
          if (
            !paper ||
            (interest.member_id !== memberId && !(canManage(paper) && interest.status === "active"))
          ) {
            return [];
          }
          return [
            {
              ...interest,
              title: paper.title,
              is_own: interest.member_id === memberId,
              member_name: this.store.getLabMember(interest.member_id)?.name ?? "Lab member",
            },
          ];
        }),
        projects: mineFirst(papers.filter(canManage), (paper) => paper.id).map((paper) => ({
          id: paper.id,
          title: paper.title,
        })),
        requests: (managedOnly
          ? mineFirst(papers.filter(canManage), (paper) => paper.id).flatMap((paper) => {
              const request = this.store.getHelpRequest(paper.id);
              return request ? [request] : [];
            })
          : this.store.listHelpRequests()
        )
          .flatMap((request) => {
            const paper = papers.find((p) => p.id === request.paper_id);
            if (!paper || (request.status !== "open" && !canManage(paper))) {
              return [];
            }
            return [
              {
                ...request,
                title: paper.title,
                owner_name: this.store.getLabMember(request.owner_id)?.name ?? "Lab member",
                can_manage: canManage(paper),
              },
            ];
          })
          .toSorted(
            (a, b) =>
              Number(ownedPaperIds.has(b.paper_id)) - Number(ownedPaperIds.has(a.paper_id)) ||
              b.updated_at.localeCompare(a.updated_at),
          ),
      },
    };
  }
  interest(memberId: string, paperId: string, input: unknown, withdraw = false, minimal = false) {
    const member = this.store.getLabMember(memberId);
    const paper = this.store.getPaper(paperId);
    if (!member) {
      return failure(403, "A member session is required.");
    }
    if (!paper) {
      return failure(404, "Project not found.");
    }
    const request = this.store.listHelpRequests().find((row) => row.paper_id === paperId);
    if (!request) {
      return failure(404, "Help request not found.");
    }
    const existing = this.store
      .listHelpInterests()
      .find((row) => row.paper_id === paperId && row.member_id === memberId);
    if (withdraw && !existing) {
      return failure(404, "Your offer was not found.");
    }
    if (!withdraw && request.status !== "open") {
      return failure(409, "This help request is closed.");
    }
    if (!withdraw && (member.privilege_level === "admin" || this.ownsPaper(member, paper))) {
      return failure(403, "Project managers review offers rather than submitting their own.");
    }
    const draft = withdraw ? existing! : validateHelpInterest(input);
    if (typeof draft === "string") {
      return failure(400, draft);
    }
    const now = new Date().toISOString();
    this.store.saveHelpInterest({
      hours_per_week: draft.hours_per_week,
      note: draft.note,
      paper_id: paperId,
      member_id: memberId,
      status: withdraw ? "withdrawn" : "active",
      created_at: existing?.created_at ?? now,
      updated_at: now,
    });
    this.store.recordAudit({
      id: `aud_${randomUUID()}`,
      timestamp: now,
      type: withdraw ? "lab_interest.withdrawn" : "lab_interest.saved",
      actor: memberId,
      details: { paper_id: paperId },
    });
    return minimal
      ? { ok: true as const, status: 200, payload: { saved: true } }
      : this.list(memberId);
  }
  save(memberId: string, paperId: string, input: unknown, close = false, minimal = false) {
    const member = this.store.getLabMember(memberId);
    const paper = this.store.getPaper(paperId);
    if (!member) {
      return failure(403, "A member session is required.");
    }
    if (!paper) {
      return failure(404, "Project not found.");
    }
    if (member.privilege_level !== "admin" && !this.ownsPaper(member, paper)) {
      return failure(403, "Only a project author or administrator can manage its help request.");
    }
    const existing = this.store.listHelpRequests().find((row) => row.paper_id === paperId);
    if (close && !existing) {
      return failure(404, "Help request not found.");
    }
    const draft = close ? existing! : validateHelpRequest(input);
    if (typeof draft === "string") {
      return failure(400, draft);
    }
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
    return minimal
      ? { ok: true as const, status: 200, payload: { saved: true } }
      : this.list(memberId);
  }
}
