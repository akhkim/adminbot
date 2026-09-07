import { afterEach, describe, expect, it, vi } from "vitest";
import { LabSharingDirectory } from "./lab-sharing-directory.ts";
const payload = { projects: [{ id: "p1", title: "Synthetic project" }], requests: [] };
// The UI lane runs with `isolate: false`, so one jsdom -- and one customElements registry -- is
// shared across every test file while each file still gets its own module graph. A second
// evaluation of lab-sharing-directory.ts therefore produces a second class, which the name guard
// around its `customElements.define` then declines to register, and `new` on that unregistered
// class throws "the constructor is not part of the custom element registry". Going through the
// registry always yields whichever class actually got defined.
//
// This only bites once enough files load the module for it to be evaluated twice, so it was
// latent until the Lab Sharing tabs grew a fourth test file -- which is the worst shape for a
// bug like this, because the file that breaks is never the file that changed.
function createDirectory(): LabSharingDirectory {
  return document.createElement("lab-sharing-directory") as LabSharingDirectory;
}

async function settle(el: LabSharingDirectory) {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  await el.updateComplete;
}
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
describe("live directory", () => {
  it("saves input and renders the server result", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => payload })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ...payload,
          requests: [
            {
              paper_id: "p1",
              title: "Synthetic project",
              description: "Review traces",
              tags: [],
              owner_name: "Member",
              members_needed: 1,
              hours_per_week: 2,
              timeline: "",
              status: "open",
              can_manage: true,
            },
          ],
        }),
      });
    vi.stubGlobal("fetch", fetcher);
    const el = createDirectory();
    el.baseUrl = "http://lab.test";
    el.sessionToken = "synthetic";
    document.body.append(el);
    await settle(el);
    expect(el.textContent).toContain("No projects are asking");
    const select = el.querySelector("form select")!;
    select.value = "p1";
    select.dispatchEvent(new Event("change"));
    const area = el.querySelector("textarea")!;
    area.value = "Review traces";
    area.dispatchEvent(new Event("input"));
    el.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await settle(el);
    expect(fetcher.mock.calls[1][0]).toBe("http://lab.test/lab-sharing/requests/p1");
    expect(JSON.parse(fetcher.mock.calls[1][1].body).description).toBe("Review traces");
    expect(el.querySelector('[data-project="p1"]')?.textContent).toContain("Review traces");
  });
  it("can retry a failed read", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new Error("Offline"))
        .mockResolvedValueOnce({ ok: true, json: async () => payload }),
    );
    const el = createDirectory();
    el.sessionToken = "synthetic";
    document.body.append(el);
    await settle(el);
    expect(el.querySelector('[role="alert"]')?.textContent).toBe("Offline");
    el.querySelector("button")!.click();
    await settle(el);
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(el.textContent).toContain("No projects are asking");
  });
  it("discards late data after signing out", async () => {
    let finish!: (value: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const el = createDirectory();
    el.sessionToken = "old";
    document.body.append(el);
    await settle(el);
    el.sessionToken = "";
    await settle(el);
    finish({ ok: true, json: async () => payload });
    await settle(el);
    expect(el.textContent).toContain("Sign in");
    expect(el.textContent).not.toContain("Synthetic project");
  });
  it("keeps a failed save as a draft without claiming it was published", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => payload })
        .mockResolvedValueOnce({
          ok: false,
          json: async () => ({ error: { message: "Permission changed" } }),
        }),
    );
    const el = createDirectory();
    el.sessionToken = "synthetic";
    document.body.append(el);
    await settle(el);
    const select = el.querySelector("form select")!;
    select.value = "p1";
    select.dispatchEvent(new Event("change"));
    const area = el.querySelector("textarea")!;
    area.value = "Keep this draft";
    area.dispatchEvent(new Event("input"));
    el.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await settle(el);
    expect(el.querySelector('[role="alert"]')?.textContent).toBe("Permission changed");
    expect(el.querySelector("textarea")?.value).toBe("Keep this draft");
    expect(el.textContent).not.toContain("Help request saved");
  });
  it("retains a failed offer draft and withdraws a saved offer with POST", async () => {
    const interest = {
      paper_id: "p1",
      title: "Synthetic project",
      member_name: "Reader",
      hours_per_week: 2,
      note: "Saved note",
      status: "active",
      updated_at: "2026-09-06",
      is_own: true,
    };
    const data = {
      projects: [],
      requests: [
        {
          paper_id: "p1",
          title: "Synthetic project",
          owner_name: "Owner",
          description: "Tasks",
          tags: [],
          members_needed: 1,
          hours_per_week: 2,
          timeline: "",
          status: "open",
          can_manage: false,
        },
      ],
      interests: [interest],
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => data })
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ...data, interests: [{ ...interest, status: "withdrawn" }] }),
      });
    vi.stubGlobal("fetch", fetcher);
    const el = createDirectory();
    el.sessionToken = "synthetic";
    document.body.append(el);
    await settle(el);
    const note = el.querySelector("textarea")!;
    note.value = "My retained draft";
    note.dispatchEvent(new Event("input"));
    await settle(el);
    el.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await settle(el);
    expect(el.querySelector("textarea")!.value).toBe("My retained draft");
    expect(el.textContent).not.toContain("Offer saved.");
    const withdraw = [...el.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Withdraw offer"),
    )!;
    withdraw.click();
    await settle(el);
    expect(fetcher.mock.calls[2][0]).toContain("/interest/withdraw");
    expect(fetcher.mock.calls[2][1].method).toBe("POST");
    expect(el.textContent).toContain("Offer withdrawn.");
    el.sessionToken = "";
    await settle(el);
    expect(el.textContent).not.toContain("Saved note");
    expect(el.textContent).not.toContain("My retained draft");
  });
});

it("reveals a project hidden by the directory filter and focuses its card", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        projects: [],
        requests: [
          {
            paper_id: "p1",
            title: "Synthetic project",
            description: "Review traces",
            tags: [],
            owner_name: "Member",
            members_needed: 1,
            hours_per_week: 2,
            timeline: "",
            status: "open",
            can_manage: false,
          },
        ],
      }),
    }),
  );
  const el = createDirectory();
  el.sessionToken = "synthetic";
  document.body.append(el);
  await settle(el);
  const input = el.querySelector<HTMLInputElement>('input[type="search"]')!;
  input.value = "no match";
  input.dispatchEvent(new Event("input"));
  await el.updateComplete;
  expect(el.querySelector('[data-project="p1"]')).toBeNull();
  const scroll = vi.fn();
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scroll;
  try {
    await el.showProject("p1");
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(el.querySelector('[data-project="p1"]'));
    expect(scroll).toHaveBeenCalled();
  } finally {
    HTMLElement.prototype.scrollIntoView = original;
  }
});

it("narrows a large directory by multiple terms and weekly hours", async () => {
  const requests = Array.from({ length: 25 }, (_, i) => ({
    paper_id: `p${i}`, title: `Project ${String(i).padStart(2, "0")}`, owner_name: "Ravi",
    description: "Review traces", tags: ["agents"], members_needed: 1,
    hours_per_week: i + 1, timeline: "September", status: "open", can_manage: false,
  }));
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ projects: [], requests }) })));
  const el = createDirectory();
  el.sessionToken = "synthetic";
  document.body.append(el);
  await settle(el);
  expect(el.querySelectorAll("[data-project]")).toHaveLength(10);
  const more = [...el.querySelectorAll("button")].find(b => b.textContent?.includes("Show 10 more"))!;
  more.click();
  await el.updateComplete;
  expect(el.querySelectorAll("[data-project]")).toHaveLength(20);
  const search = el.querySelector('input[type="search"]') as HTMLInputElement;
  search.value = "Ravi agents September";
  search.dispatchEvent(new Event("input"));
  const hours = el.querySelector('input[placeholder="Any"]') as HTMLInputElement;
  hours.value = "3";
  hours.dispatchEvent(new Event("input"));
  await el.updateComplete;
  expect(el.querySelectorAll("[data-project]")).toHaveLength(3);
  expect(el.textContent).toContain("3 of 25 open projects match");
  search.value = "unmatched";
  search.dispatchEvent(new Event("input"));
  await el.updateComplete;
  expect(el.querySelectorAll("[data-project]")).toHaveLength(0);
});
