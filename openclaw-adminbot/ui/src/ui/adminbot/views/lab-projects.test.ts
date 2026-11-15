import { afterEach, expect, it, vi } from "vitest";
import { canAccessTab } from "../access.ts";
import { labProjectMatches, type LabProject, LabProjectsView } from "./lab-projects.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function project(fields: Partial<LabProject> & { paper_id: string }): LabProject {
  return {
    title: `Synthetic ${fields.paper_id}`,
    current_step: "overleaf_writing",
    venue_targets: [],
    provided_count: 0,
    required_count: 0,
    lanes: {} as LabProject["lanes"],
    todos: [],
    status: "active",
    tags: [],
    members: [],
    authors: [],
    last_update_at: "2026-10-30T00:00:00Z",
    links: { primary: null, github: null, slack_channel: null, slides: null, poster: null },
    ...fields,
  };
}

const ROWS: LabProject[] = [
  project({
    paper_id: "causal",
    title: "Synthetic Causal Paper",
    alias: "scp",
    topic: "causal discovery",
    members: [{ member_id: "m-ada", name: "Ada Synthetic" }],
    last_weekly_update: {
      week_start: "2026-10-26",
      member_id: "m-ada",
      name: "Ada Synthetic",
      updated_at: "2026-10-30T00:00:00Z",
    },
    links: {
      primary: { kind: "arxiv", url: "https://arxiv.org/abs/2601.00001" },
      github: { url: "https://github.com/example/scp" },
      slack_channel: "proj-scp",
      slides: { url: "https://docs.google.com/presentation/d/synthetic" },
      poster: null,
    },
  }),
  project({
    paper_id: "robots",
    title: "Synthetic Robotics Paper",
    status: "dormant",
    tags: ["control"],
    members: [{ member_id: "m-ben", name: "Ben Synthetic" }],
  }),
];

async function mount(response: Response) {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  const onOpen = vi.fn();
  const el = new LabProjectsView();
  el.baseUrl = "http://localhost:8765/";
  el.sessionToken = "synthetic";
  el.onOpen = onOpen;
  document.body.append(el);
  await el.updateComplete;
  await vi.waitFor(() => expect(el.shadowRoot!.querySelector(".skeleton")).toBeNull());
  await el.updateComplete;
  return { el, fetchMock, onOpen };
}

it("is offered to admins only", () => {
  expect(canAccessTab("adminbotLabProjects", "admin")).toBe(true);
  expect(canAccessTab("adminbotLabProjects", "member")).toBe(false);
  expect(canAccessTab("adminbotLabProjects", "anonymous")).toBe(false);
});

it("matches on title, member, topic and tag, every word", () => {
  const [causal, robots] = ROWS as [LabProject, LabProject];
  expect(labProjectMatches(causal, "ada")).toBe(true);
  expect(labProjectMatches(causal, "causal discovery")).toBe(true);
  expect(labProjectMatches(causal, "SCP")).toBe(true);
  expect(labProjectMatches(robots, "control")).toBe(true);
  expect(labProjectMatches(robots, "ada")).toBe(false);
  expect(labProjectMatches(causal, "ada robotics")).toBe(false);
});

it("lists every project with its links and slots, and opens the project page on click", async () => {
  const { el, fetchMock, onOpen } = await mount(Response.json({ projects: ROWS }));
  expect(fetchMock).toHaveBeenCalledWith("http://localhost:8765/lab/projects", expect.anything());
  const root = el.shadowRoot!;
  const causal = root.querySelector('[data-testid="lab-project-causal"]')!;
  expect(causal.textContent).toContain("causal discovery");
  expect(causal.textContent).toContain("Ada Synthetic");
  expect(causal.textContent).toContain("Active");
  expect(causal.textContent).toContain("Slack #proj-scp");
  expect(causal.textContent).toContain("week of 2026-10-26");
  expect(causal.querySelector<HTMLAnchorElement>("a.primary")?.href).toBe(
    "https://arxiv.org/abs/2601.00001",
  );
  expect(causal.textContent).toContain("Poster: not yet");
  expect(root.querySelector('[data-testid="lab-project-robots"]')?.textContent).toContain(
    "No paper, repo or doc linked yet",
  );

  causal.querySelector<HTMLButtonElement>("button.title")!.click();
  expect(onOpen).toHaveBeenCalledWith("causal");
});

it("filters by the search box", async () => {
  const { el } = await mount(Response.json({ projects: ROWS }));
  const input = el.shadowRoot!.querySelector<HTMLInputElement>('input[type="search"]')!;
  input.value = "ben";
  input.dispatchEvent(new Event("input"));
  await el.updateComplete;
  const ids = [...el.shadowRoot!.querySelectorAll("li")].map((row) => row.dataset.testid);
  expect(ids).toEqual(["lab-project-robots"]);
});

it("says so, and shows no rows, when the service refuses a non-admin", async () => {
  const { el } = await mount(
    Response.json({ error: { message: "insufficient privileges" } }, { status: 403 }),
  );
  expect(el.shadowRoot!.querySelector('[role="alert"]')?.textContent).toContain("for admins");
  expect(el.shadowRoot!.querySelectorAll("li")).toHaveLength(0);
});

it("draws the list from the last visit at once, keeps it through the refresh, then shows the new one", async () => {
  // The service tags its answers, which is what lets the session keep one to draw from.
  const tagged = (projects: LabProject[]) =>
    new Response(JSON.stringify({ projects }), {
      status: 200,
      headers: { "Content-Type": "application/json", ETag: `"${projects.length}"` },
    });
  const first = await mount(tagged(ROWS));
  first.el.remove();

  // The second visit's request is held open: whatever is on screen now came from the first.
  let land: (response: Response) => void = () => undefined;
  const fetchMock = vi.fn(() => new Promise<Response>((resolve) => (land = resolve)));
  vi.stubGlobal("fetch", fetchMock);
  const el = new LabProjectsView();
  el.baseUrl = "http://localhost:8765/";
  el.sessionToken = "synthetic";
  document.body.append(el);
  await el.updateComplete;
  expect(el.shadowRoot!.querySelectorAll("li")).toHaveLength(ROWS.length);
  expect(el.shadowRoot!.querySelector(".skeleton")).toBeNull();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

  land(tagged(ROWS.slice(0, 1)));
  await vi.waitFor(() => expect(el.shadowRoot!.querySelectorAll("li")).toHaveLength(1));

  // Another session never starts from this one's list.
  const other = new LabProjectsView();
  other.baseUrl = "http://localhost:8765/";
  other.sessionToken = "someone-else";
  document.body.append(other);
  await other.updateComplete;
  expect(other.shadowRoot!.querySelectorAll("li")).toHaveLength(0);
  expect(other.shadowRoot!.querySelector(".skeleton")).not.toBeNull();
});
