import type {LabSharingDiscoveryQuery} from "../contracts/lab-sharing-discovery.js";
import type {DiscoveryPosition} from "../contracts/lab-sharing-discovery-cursor.js";
import type {DiscoveredHelpRequest} from "./lab-sharing-discovery.js";
import type {LabHelpRequest} from "../contracts/lab-sharing.js";

/** SQLite BINARY compares UTF-8 bytes, not locale-sensitive display order. */
export function discoverMemoryHelpRequests(requests: LabHelpRequest[], paper: (id: string) => {title: string} | undefined, member: (id: string) => {name: string} | undefined, query: LabSharingDiscoveryQuery, after?: DiscoveryPosition): DiscoveredHelpRequest[] {
 const compare = (a: DiscoveryPosition, b: DiscoveryPosition) =>
   (query.sort === "hours" ? a.hours - b.hours : 0) || Buffer.compare(Buffer.from(a.title), Buffer.from(b.title)) || Buffer.compare(Buffer.from(a.paperId), Buffer.from(b.paperId));
 const position = (row: DiscoveredHelpRequest) => ({title: row.title, hours: row.hours_per_week, paperId: row.paper_id});
 return requests.flatMap(request => {
   const project = paper(request.paper_id);
   if (!project || request.status !== "open") return [];
   const owner = member(request.owner_id);
   const text = `${project.title} ${owner?.name ?? ""} ${request.description} ${request.tags.join(" ")} ${request.timeline}`.toLowerCase();
   if (query.maxHours !== null && request.hours_per_week > query.maxHours || !query.terms.every(term => text.includes(term))) return [];
   const row = {...request, title: project.title, owner_name: owner?.name ?? "Lab member"};
   return after && compare(position(row),after) <= 0 ? [] : [row];
 }).sort((a,b) => compare(position(a),position(b))).slice(0,query.limit+1);
}
