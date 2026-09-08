import {afterEach, expect, it, vi} from "vitest";
import type {LabSharingDirectory} from "./lab-sharing-directory.ts";
import "./lab-sharing-directory.ts";
const project = (id = "p1") => ({paper_id:id,title:`Project ${id}`,owner_name:"Member",description:"Review traces",tags:["qa"],members_needed:1,hours_per_week:2,timeline:"September",status:"open",can_manage:true});
const mine = {projects:[{id:"p1",title:"Project p1"}],requests:[project()],interests:[]};
const response = (data: unknown) => ({ok:true,json:async()=>data});
async function mount(fetcher = vi.fn(async (url: string) => response(url.includes("/discover?") ? {requests:[project()],next_cursor:null} : mine))) {
 vi.useFakeTimers(); vi.stubGlobal("fetch",fetcher);
 const el=document.createElement("lab-sharing-directory") as LabSharingDirectory;
 el.baseUrl="http://lab.test";el.sessionToken="synthetic";document.body.append(el);
 await vi.advanceTimersByTimeAsync(0); await el.updateComplete;
 return {el,fetcher};
}
afterEach(()=>{document.body.replaceChildren();vi.unstubAllGlobals();vi.useRealTimers();});
it("loads private management separately and appends a bounded next page",async()=>{
 const fetcher=vi.fn(async(url:string)=>response(url.includes("/discover?") ? {requests:[project(url.includes("cursor=")?"p2":"p1")],next_cursor:url.includes("cursor=")?null:"next"} : mine));
 const {el}=await mount(fetcher);
 expect(fetcher.mock.calls.some(([url])=>url.endsWith("/mine"))).toBe(true);
 expect(fetcher.mock.calls.some(([url])=>url==="http://lab.test/lab-sharing")).toBe(false);
 [...el.querySelectorAll("button")].find(b=>b.textContent?.includes("Show more"))!.click();
 await vi.advanceTimersByTimeAsync(0);await el.updateComplete;
 expect(el.querySelectorAll("[data-project]")).toHaveLength(2);
 expect(fetcher.mock.calls.some(([url])=>url.includes("cursor=next"))).toBe(true);
});
it("debounces server filters and discards a stale page after logout",async()=>{
 let finish:((value:unknown)=>void)|undefined;
 const fetcher=vi.fn(async(url:string)=>url.includes("q=agents")?new Promise(resolve=>{finish=resolve;}):response(url.includes("/discover?")?{requests:[project()],next_cursor:null}:mine));
 const {el}=await mount(fetcher);
 const search=el.querySelector<HTMLInputElement>('input[type="search"]')!;
 search.value="agents";search.dispatchEvent(new Event("input"));
 await vi.advanceTimersByTimeAsync(250);
 el.sessionToken="";await el.updateComplete;
 finish!(response({requests:[project("private")],next_cursor:null}));
 await vi.advanceTimersByTimeAsync(0);await el.updateComplete;
 expect(el.querySelectorAll("[data-project]")).toHaveLength(0);
 expect(el.textContent).not.toContain("private");
});
it("keeps a failed save draft and refreshes managed/discovery state after retry",async()=>{
 let rejectSave=true;
 const fetcher=vi.fn(async(url:string,init?:RequestInit)=>{
  if(init?.method==="PUT") {if(rejectSave) throw new Error("Offline"); return response(mine);}
  return response(url.includes("/discover?")?{requests:[project()],next_cursor:null}:mine);
 });
 const {el}=await mount(fetcher);
 const select=el.querySelector<HTMLSelectElement>("form select")!;select.value="p1";select.dispatchEvent(new Event("change"));
 const note=el.querySelector<HTMLTextAreaElement>("form textarea")!;note.value="Retained draft";note.dispatchEvent(new Event("input"));
 el.querySelector("form")!.dispatchEvent(new Event("submit",{cancelable:true}));
 await vi.advanceTimersByTimeAsync(0);await el.updateComplete;
 expect(note.value).toBe("Retained draft");expect(el.textContent).toContain("Offline");
 rejectSave=false;el.querySelector("form")!.dispatchEvent(new Event("submit",{cancelable:true}));
 await vi.advanceTimersByTimeAsync(0);await el.updateComplete;
 expect(el.textContent).toContain("Help request saved");
 expect(fetcher.mock.calls.some(([url,init])=>url.endsWith("/requests/p1")&&init?.method==="PUT")).toBe(true);
});
it("retrieves an off-page project directly and focuses its card",async()=>{
 const {el,fetcher}=await mount(vi.fn(async(url:string)=>response(url.includes("/projects/")?{request:project("p99")}:url.includes("/discover?")?{requests:[project()],next_cursor:null}:mine)));
 const original=HTMLElement.prototype.scrollIntoView;HTMLElement.prototype.scrollIntoView=vi.fn();
 try {await el.showProject("p99");expect(document.activeElement).toBe(el.querySelector('[data-project="p99"]'));expect(fetcher.mock.calls.some(([url])=>url.endsWith("/projects/p99"))).toBe(true);}finally{HTMLElement.prototype.scrollIntoView=original;}
});
it("retains loaded cards when the next page fails and permits retry",async()=>{
 let offline=true;
 const {el}=await mount(vi.fn(async(url:string)=>{
 if(url.includes("cursor=")){if(offline)throw new Error("Offline");return response({requests:[project("p2")],next_cursor:null});}
 return response(url.includes("/discover?")?{requests:[project()],next_cursor:"next"}:mine);
 }));
 const more=()=>[...el.querySelectorAll("button")].find(b=>b.textContent?.includes("Show more"))!;
 more().click();await vi.advanceTimersByTimeAsync(0);await el.updateComplete;
 expect(el.querySelectorAll("[data-project]")).toHaveLength(1);expect(more().disabled).toBe(false);
 offline=false;more().click();await vi.advanceTimersByTimeAsync(0);await el.updateComplete;
 expect(el.querySelectorAll("[data-project]")).toHaveLength(2);
});

it("keeps an offer draft after failure and withdraws a private saved offer",async()=>{
 const own={paper_id:"p1",title:"Project p1",member_name:"Member",hours_per_week:2,note:"Saved",status:"active",updated_at:"today",is_own:true};
 const fetcher=vi.fn(async(url:string,init?:RequestInit)=>{
  if(init?.method==="PUT")throw new Error("Offline offer");
  return response(url.includes("/discover?")?{requests:[{...project(),can_manage:false}],next_cursor:null}:{...mine,projects:[],requests:[],interests:[own]});
 });
 const {el}=await mount(fetcher);
 const form=el.querySelector<HTMLFormElement>('form[aria-label="Offer for Project p1"]')!;
 const note=form.querySelector("textarea")!;note.value="Keep my offer";note.dispatchEvent(new Event("input"));
 form.dispatchEvent(new Event("submit",{cancelable:true}));await vi.advanceTimersByTimeAsync(0);await el.updateComplete;
 expect(note.value).toBe("Keep my offer");expect(el.textContent).toContain("Offline offer");
 const withdraw=[...el.querySelectorAll("button")].find(b=>b.textContent?.includes("Withdraw"))!;withdraw.click();
 await vi.advanceTimersByTimeAsync(0);await el.updateComplete;
 expect(fetcher.mock.calls.some(([url,init])=>url.endsWith("/interest/withdraw")&&init?.method==="POST")).toBe(true);
});

it("does not report a saved change as failed when management refresh fails",async()=>{
 let saved=false;
 const fetcher=vi.fn(async(url:string,init?:RequestInit)=>{
  if(init?.method==="PUT"){saved=true;return response(mine);}
  if(saved && url.endsWith("/mine"))throw new Error("Offline refresh");
  return response(url.includes("/discover?")?{requests:[project()],next_cursor:null}:mine);
 });
 const {el}=await mount(fetcher);
 const select=el.querySelector<HTMLSelectElement>("form select")!;select.value="p1";select.dispatchEvent(new Event("change"));
 const note=el.querySelector<HTMLTextAreaElement>("form textarea")!;note.value="Saved text";note.dispatchEvent(new Event("input"));
 el.querySelector("form")!.dispatchEvent(new Event("submit",{cancelable:true}));
 await vi.advanceTimersByTimeAsync(0);await el.updateComplete;
 expect(el.textContent).toContain("Help request saved");
 expect(el.textContent).toContain("Your change was saved, but the page could not refresh");
 expect(note.value).toBe("Saved text");
 expect(el.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
 expect(fetcher.mock.calls.filter(([,init])=>init?.method==="PUT")).toHaveLength(1);
});
