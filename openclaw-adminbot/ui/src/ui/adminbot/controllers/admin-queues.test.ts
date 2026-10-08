import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import type { UiSettings } from "../../storage.ts";
import { saveStoredMemberSession } from "../auth/session.ts";
import { renderQueueMore } from "../views/queue-more.ts";
import {
  adminQueueTotal,
  forgetAdminQueues,
  loadAdminQueues,
  loadMoreAdminQueue,
} from "./admin-queues.ts";
import { type AdminBotHost, createEmptyAdminBotDashboardData } from "./admin.ts";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

function host(): AdminBotHost {
  return {
    adminBotData: createEmptyAdminBotDashboardData(),
    settings: { adminBotUrl: "http://127.0.0.1:8765" } as UiSettings,
  } as AdminBotHost;
}

const session = { sessionToken: "tok", baseUrl: "http://127.0.0.1:8765" };

function proposal(id: string) {
  return { id, summary: id, approvals: [], approval_requirement: { min_approvals: 1 } };
}

describe("paged admin queues", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reads one page, counts the whole queue and appends the next page once", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/settings")) {
        return json({});
      }
      return url.includes("offset=25")
        ? // Overlaps the first page by one, as it does after an approval shifts the queue.
          json({ proposals: [proposal("p-24"), proposal("p-25")], total: 26 })
        : json({
            proposals: Array.from({ length: 25 }, (_, i) => proposal(`p-${i}`)),
            total: 26,
            next_offset: 25,
          });
    });
    const target = host();
    target.adminBotData.queueCounts = { pendingProposals: 0, emailReviews: 0 };
    forgetAdminQueues(target);

    await loadAdminQueues(target, session, { tab: "dashboard", refresh: false });
    await loadAdminQueues(target, session, { tab: "adminbotPapers", refresh: false });
    expect(urls.some((url) => url.includes("/proposals/pending?view=summary&limit=25"))).toBe(true);
    expect(target.adminBotData.proposals).toHaveLength(25);
    expect(target.adminBotData.queuePages?.proposals).toEqual({ total: 26, next: 25 });
    expect(adminQueueTotal(target.adminBotData, "proposals")).toBe(26);

    await loadMoreAdminQueue(target, "proposals");
    expect(urls.some((url) => url.includes("limit=25&offset=25"))).toBe(true);
    expect(target.adminBotData.proposals.map((row) => row.id).slice(-2)).toEqual(["p-24", "p-25"]);
    expect(target.adminBotData.proposals).toHaveLength(26);
    expect(target.adminBotData.queuePages?.proposals).toEqual({ total: 26 });
    // Nothing further to read: a second press is a no-op.
    const before = urls.length;
    await loadMoreAdminQueue(target, "proposals");
    expect(urls).toHaveLength(before);
  });

  it("reads an older service's whole queue as its own total and offers no more", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).includes("/settings")
        ? json({})
        : String(input).includes("/papers/nudges")
          ? json({ nudges: [{ paper_id: "a", type: "author_nudge", step: "x" }] })
          : json({ proposals: [proposal("p-1"), proposal("p-2")] }),
    );
    const target = host();
    forgetAdminQueues(target);
    await loadAdminQueues(target, session, { tab: "chat", refresh: false });
    expect(target.adminBotData.queuePages?.proposals).toEqual({ total: 2 });
    expect(adminQueueTotal(target.adminBotData, "nudges")).toBe(1);

    const container = document.createElement("div");
    render(
      renderQueueMore(target.adminBotData.queuePages?.proposals, 2, () => {}),
      container,
    );
    expect(container.querySelector("button")).toBeNull();
  });

  it("drops a page that a refresh overtook instead of appending it to the new list", async () => {
    let releaseMore: (response: Response) => void = () => {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/settings")) {
        return json({});
      }
      if (url.includes("offset=")) {
        return new Promise<Response>((resolve) => {
          releaseMore = resolve;
        });
      }
      return json({ reviews: [{ message_id: "m-1" }], total: 3, next_offset: 1 });
    });
    const target = host();
    forgetAdminQueues(target);
    await loadAdminQueues(target, session, { tab: "adminbot", refresh: false });
    const more = loadMoreAdminQueue(target, "emailReview");
    expect(target.adminBotData.queuePages?.emailReview?.loading).toBe(true);
    await loadAdminQueues(target, session, { tab: "adminbot", refresh: true });
    releaseMore(json({ reviews: [{ message_id: "m-2" }], total: 3, next_offset: 2 }));
    await more;
    expect(target.adminBotData.emailReviews?.map((row) => row.message_id)).toEqual(["m-1"]);
    expect(target.adminBotData.queuePages?.emailReview).toEqual({ total: 3, next: 1 });
  });

  it("draws the Meetings-style button with what is left to read", () => {
    const container = document.createElement("div");
    const onMore = vi.fn();
    render(renderQueueMore({ total: 30, next: 25 }, 25, onMore), container);
    const button = container.querySelector("button");
    expect(button?.className).toBe("btn meetings__more");
    expect(button?.textContent?.trim()).toBe("Show 5 more");
    button?.click();
    expect(onMore).toHaveBeenCalledOnce();

    render(renderQueueMore({ total: 30, next: 25, loading: true }, 25, onMore), container);
    expect(container.querySelector("button")?.disabled).toBe(true);
  });
});
