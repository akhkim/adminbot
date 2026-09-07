import type { AdminBotLabMember, AdminBotPaperRecord } from "../contracts/actions.js";
import type { AdminBotServiceStore } from "./service.js";

type SearchStore = Pick<
  AdminBotServiceStore,
  "getLabMember" | "listLabMembers" | "listPapers" | "listHelpRequests"
>;

export function searchLabSharingMembers(
  store: SearchStore,
  ownsPaper: (member: AdminBotLabMember, paper: AdminBotPaperRecord) => boolean,
  memberId: string,
  input: string,
) {
  if (!store.getLabMember(memberId)) {
    return { ok: false as const, status: 403, error: { message: "A member session is required." } };
  }
  const query = input.trim().toLowerCase();
  if (query.length > 100) {
    return {
      ok: false as const,
      status: 400,
      error: { message: "Search with at most 100 characters." },
    };
  }
  if (query.length < 2) {
    return { ok: true as const, status: 200, payload: { members: [], truncated: false } };
  }
  const openIds = new Set(
    store
      .listHelpRequests()
      .filter((request) => request.status === "open")
      .map((request) => request.paper_id),
  );
  const papers = store.listPapers().filter((paper) => openIds.has(paper.id));
  const matches = store
    .listLabMembers()
    .flatMap((member) => {
      const topics = member.research_topics ?? [];
      const branch = member.research_branch ?? "";
      const projects = papers
        .filter((paper) => ownsPaper(member, paper) && paper.title.toLowerCase().includes(query))
        .map((paper) => ({ id: paper.id, title: paper.title }));
      const matchedFields: string[] = [];
      if (member.name.toLowerCase().includes(query)) {
        matchedFields.push("name");
      }
      if (branch.toLowerCase().includes(query)) {
        matchedFields.push("research branch");
      }
      if (topics.some((topic) => topic.toLowerCase().includes(query))) {
        matchedFields.push("research topics");
      }
      if (projects.length) {
        matchedFields.push("open project");
      }
      if (!matchedFields.length) {
        return [];
      }
      // Never spread a roster record: this discovery view is equally narrow for admins.
      return [
        {
          id: member.id,
          name: member.name,
          research_branch: branch,
          research_topics: topics,
          projects,
          matched_fields: matchedFields,
        },
      ];
    })
    .toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return {
    ok: true as const,
    status: 200,
    payload: { members: matches.slice(0, 20), truncated: matches.length > 20 },
  };
}
