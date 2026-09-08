import { DatabaseSync } from "node:sqlite";
import {expect, it} from "vitest";
import {discoverHelpRequests} from "./lab-sharing-discovery.js";
import {ensureLabSharingSchema, saveHelpRequest} from "./lab-sharing.js";
it("bounds rows and pages tied titles while excluding closed requests", () => {
 const db = new DatabaseSync(":memory:");
 try {
  ensureLabSharingSchema(db);
  db.exec("CREATE TABLE adminbot_papers(id TEXT PRIMARY KEY, payload_json TEXT); CREATE TABLE adminbot_lab_members(id TEXT PRIMARY KEY, payload_json TEXT)");
  db.prepare("INSERT INTO adminbot_lab_members VALUES (?, ?)").run("m", JSON.stringify({name:"Élodie"}));
  for (let i=0;i<30;i++) {
   const id = `p${String(i).padStart(2,"0")}`;
   db.prepare("INSERT INTO adminbot_papers VALUES (?, ?)").run(id, JSON.stringify({title:"Agents"}));
   saveHelpRequest(db, {paper_id:id, owner_id:"m", description:"Review", tags:["qa"], members_needed:1, hours_per_week:2, timeline:"September", status:i===0?"closed":"open", created_at:"now", updated_at:"now"});
  }
  const query = {query:"élodie qa", terms:["élodie","qa"], maxHours:3, sort:"title" as const, limit:10};
  const first = discoverHelpRequests(db, query);
  expect(first).toHaveLength(11);
  expect(first[0].paper_id).toBe("p01");
  const last = first[9];
  const second = discoverHelpRequests(db, query, {title:last.title, hours:last.hours_per_week, paperId:last.paper_id});
  expect(second[0].paper_id).toBe("p11");
  expect(discoverHelpRequests(db, {...query,maxHours:1})).toEqual([]);
  expect(discoverHelpRequests(db, {...query,terms:["%"]})).toEqual([]);
 } finally {db.close();}
});
