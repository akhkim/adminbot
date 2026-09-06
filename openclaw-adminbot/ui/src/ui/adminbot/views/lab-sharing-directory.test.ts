import { afterEach, describe, expect, it, vi } from "vitest";
import { LabSharingDirectory } from "./lab-sharing-directory.ts";
const payload = { projects: [{ id: "p1", title: "Synthetic project" }], requests: [] };
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
    const el = new LabSharingDirectory();
    el.baseUrl = "http://lab.test";
    el.sessionToken = "synthetic";
    document.body.append(el);
    await settle(el);
    expect(el.textContent).toContain("No projects are asking");
    const select = el.querySelector("select")!;
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
    const el = new LabSharingDirectory();
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
    const el = new LabSharingDirectory();
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
    const el = new LabSharingDirectory();
    el.sessionToken = "synthetic";
    document.body.append(el);
    await settle(el);
    const select = el.querySelector("select")!;
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
    const el = new LabSharingDirectory();
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
  const el = new LabSharingDirectory();
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
