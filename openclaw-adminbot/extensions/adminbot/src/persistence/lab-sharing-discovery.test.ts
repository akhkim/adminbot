import {discoverMemoryHelpRequests} from "./lab-sharing-discovery-memory.js";
import { DatabaseSync } from "node:sqlite";
import {expect, it} from "vitest";
import {discoverHelpRequests} from "./lab-sharing-discovery.js";
import {ensureLabSharingSchema, saveHelpRequest, listHelpRequests} from "./lab-sharing.js";
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
  expect(discoverMemoryHelpRequests(listHelpRequests(db), () => ({title:"Agents"}), () => ({name:"Élodie"}), query)).toEqual(first);
  expect(first[0].paper_id).toBe("p01");
  const last = first[9];
  const second = discoverHelpRequests(db, query, {title:last.title, hours:last.hours_per_week, paperId:last.paper_id});
  expect(second[0].paper_id).toBe("p11");
  expect(discoverMemoryHelpRequests(listHelpRequests(db), () => ({title:"Agents"}), () => ({name:"Élodie"}), query, {title:last.title,hours:last.hours_per_week,paperId:last.paper_id})).toEqual(second);
  expect(discoverHelpRequests(db, {...query,maxHours:1})).toEqual([]);
  expect(discoverHelpRequests(db, {...query,terms:["%"]})).toEqual([]);
 } finally {db.close();}
});

it("walks every hours-sorted page exactly once with missing owners and orphan requests", () => {
 const db = new DatabaseSync(":memory:");
 try {
  ensureLabSharingSchema(db);
  db.exec("CREATE TABLE adminbot_papers(id TEXT PRIMARY KEY, payload_json TEXT); CREATE TABLE adminbot_lab_members(id TEXT PRIMARY KEY, payload_json TEXT)");
  const expected: {id: string; title: string; hours: number}[] = [];
  for (let i=0;i<41;i++) {
   const id = `p${String(i).padStart(2,"0")}`, title = i % 2 ? "Beta" : "Alpha", hours = i % 3 + 1;
   if (i !== 40) db.prepare("INSERT INTO adminbot_papers VALUES (?, ?)").run(id, JSON.stringify({title}));
   saveHelpRequest(db, {paper_id:id, owner_id:"missing", description:"Task", tags:[], members_needed:1, hours_per_week:hours, timeline:"", status:i===0?"closed":"open", created_at:"now", updated_at:"now"});
   if(i !== 0 && i !== 40) expected.push({id,title,hours});
  }
  expected.sort((a,b)=>a.hours-b.hours || Buffer.compare(Buffer.from(a.title),Buffer.from(b.title)) || Buffer.compare(Buffer.from(a.id),Buffer.from(b.id)));
  const query = {query:"", terms:[], maxHours:null, sort:"hours" as const, limit:7};
  let after: {title:string; hours:number; paperId:string} | undefined;
  const seen: string[] = [];
  for(let page=0;page<10;page++) {
   const rows = discoverHelpRequests(db,query,after);
   expect(rows.length).toBeLessThanOrEqual(8);
   const visible = rows.slice(0,query.limit);
   seen.push(...visible.map(r=>r.paper_id));
   expect(visible.every(r=>r.owner_name === "Lab member")).toBe(true);
   if(rows.length<=query.limit) break;
   const last=visible.at(-1)!;
   after={title:last.title,hours:last.hours_per_week,paperId:last.paper_id};
  }
  expect(seen).toEqual(expected.map(r=>r.id));
  expect(new Set(seen).size).toBe(seen.length);
 } finally {db.close();}
});
