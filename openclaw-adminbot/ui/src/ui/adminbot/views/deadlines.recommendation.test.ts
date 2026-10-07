import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DeadlineRecommendation } from "./deadlines.recommendation.ts";
const dialogMethods = ["showModal", "close"] as const;
let originalDialogMethods: Array<PropertyDescriptor | undefined>;
let element: DeadlineRecommendation;
beforeEach(async () => {
  originalDialogMethods = dialogMethods.map((name) =>
    Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name),
  );
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  element = document.createElement("deadline-recommendation") as DeadlineRecommendation;
  element.memberId = "ada";
  element.deadlineId = "venue";
  element.venueName = "Example Workshop";
  element.directory = {
    members: [
      { id: "ada", name: "Ada", slack_linked: true },
      { id: "bea", name: "Bea", slack_linked: true },
    ],
    papers: [],
    recommendations: [],
  };
  document.body.append(element);
  await element.updateComplete;
});
afterEach(() => {
  element?.remove();
  // UI test files share a realm; do not leak dialog stubs into other views.
  dialogMethods.forEach((name, index) => {
    const descriptor = originalDialogMethods[index];
    if (descriptor) {
      Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    } else {
      delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>)[name];
    }
  });
});
const buttons = () => [...element.shadowRoot!.querySelectorAll<HTMLButtonElement>("button")];
async function click(text: string) {
  await vi.waitFor(() => {
    const target = buttons().find(
      (button) =>
        button.textContent?.trim() === text ||
        (text === "Recommend" &&
          button.getAttribute("aria-label") === "Recommend Example Workshop to a member"),
    );
    expect(target?.disabled).toBe(false);
  });
  buttons()
    .find(
      (button) =>
        button.textContent?.trim() === text ||
        (text === "Recommend" &&
          button.getAttribute("aria-label") === "Recommend Example Workshop to a member"),
    )!
    .click();
  await element.updateComplete;
}
it("requires preview before sending and sends the exact server preview", async () => {
  const preview = {
    id: "draft",
    payload_hash: "hash",
    message: "Reviewed text",
    recommender_name: "Ada",
    recipient_name: "Bea",
    status: "pending" as const,
  };
  const store = {
    list: vi.fn(async () => element.directory!),
    preview: vi.fn(async () => preview),
    send: vi.fn(async () => ({ ...preview, status: "sent" as const })),
  };
  element.store = store;
  await click("Recommend");
  const select = element.shadowRoot!.querySelector("select")!;
  select.value = "bea";
  select.dispatchEvent(new Event("change"));
  await element.updateComplete;
  expect(store.send).not.toHaveBeenCalled();
  await click("Preview");
  await vi.waitFor(() => expect(element.shadowRoot!.textContent).toContain("Reviewed text"));
  expect(store.send).not.toHaveBeenCalled();
  await click("Send in Slack");
  await vi.waitFor(() => expect(store.send).toHaveBeenCalledWith(preview));
  expect(element.shadowRoot!.textContent).toContain("Recommended to Bea");
});
it("shows recommendations as recommendations, not confirmed submissions", async () => {
  element.directory = {
    ...element.directory!,
    recommendations: [
      { deadline_id: "venue", recipient_member_id: "bea", recommender_member_id: "ada" },
    ],
  };
  await element.updateComplete;
  expect(element.shadowRoot!.querySelector('[aria-label="Recommended to Bea"]')).not.toBeNull();
  expect(element.shadowRoot!.textContent).not.toContain("Submitting");
});

it("shows an existing recommendation without offering another send", async () => {
  const sent = {
    id: "existing",
    payload_hash: "hash",
    message: "Earlier recommendation",
    recommender_name: "Ada",
    recipient_name: "Bea",
    status: "sent" as const,
  };
  const store = {
    list: vi.fn(async () => element.directory!),
    preview: vi.fn(async () => sent),
    send: vi.fn(),
  };
  element.store = store;
  await click("Recommend");
  const select = element.shadowRoot!.querySelector("select")!;
  select.value = "bea";
  select.dispatchEvent(new Event("change"));
  await element.updateComplete;
  await click("Preview");
  await vi.waitFor(() => expect(element.shadowRoot!.textContent).toContain("already sent"));
  expect(buttons().some((button) => button.textContent?.trim() === "Send in Slack")).toBe(false);
  expect(store.send).not.toHaveBeenCalled();
});

it("previews several papers and clears the selection when the recipient changes", async () => {
  element.directory = {
    ...element.directory!,
    papers: [
      { id: "one", title: "First paper", author_member_ids: ["bea"] },
      { id: "two", title: "Second paper", author_member_ids: ["bea"] },
    ],
  };
  const store = {
    list: vi.fn(async () => element.directory!),
    preview: vi.fn(async () => ({
      id: "draft",
      payload_hash: "hash",
      message: "Two papers",
      recommender_name: "Ada",
      recipient_name: "Bea",
      status: "pending" as const,
    })),
    send: vi.fn(),
  };
  element.store = store;
  await click("Recommend");
  const select = element.shadowRoot!.querySelector("select")!;
  select.value = "bea";
  select.dispatchEvent(new Event("change"));
  await element.updateComplete;
  const search = element.shadowRoot!.querySelector<HTMLInputElement>("#paper-search")!;
  search.focus();
  await vi.waitFor(() =>
    expect(element.shadowRoot!.querySelectorAll('[role="option"]')).toHaveLength(2),
  );
  for (const option of element.shadowRoot!.querySelectorAll<HTMLElement>('[role="option"]')) {
    option.click();
  }
  await element.updateComplete;
  expect(search.placeholder).toBe("2 papers selected");
  expect(search.getAttribute("aria-expanded")).toBe("true");
  search.value = "Second";
  search.dispatchEvent(new Event("input"));
  await element.updateComplete;
  expect(element.shadowRoot!.querySelectorAll('[role="option"]')).toHaveLength(1);
  expect(element.shadowRoot!.querySelector('[role="option"]')?.getAttribute("aria-selected")).toBe(
    "true",
  );
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await element.updateComplete;
  expect(search.getAttribute("aria-expanded")).toBe("false");
  expect(element.shadowRoot!.querySelector("dialog")!.open).toBe(true);
  await click("Preview");
  await vi.waitFor(() =>
    expect(store.preview).toHaveBeenCalledWith(
      expect.objectContaining({ paper_ids: ["one", "two"] }),
    ),
  );
  await click("Edit");
  const currentSelect = element.shadowRoot!.querySelector("select")!;
  currentSelect.value = "";
  currentSelect.dispatchEvent(new Event("change"));
  await element.updateComplete;
  expect(element.shadowRoot!.querySelector<HTMLInputElement>("#paper-search")!.placeholder).toBe(
    "Search linked papers…",
  );
});

it("retains the approved preview after failed delivery and retries that preview", async () => {
  const preview = {
    id: "draft",
    payload_hash: "hash",
    message: "Exact preview",
    recommender_name: "Ada",
    recipient_name: "Bea",
    status: "pending" as const,
  };
  const store = {
    list: vi.fn(async () => element.directory!),
    preview: vi.fn(async () => preview),
    send: vi
      .fn()
      .mockRejectedValueOnce(new Error("Delivery failed. Try again."))
      .mockResolvedValueOnce({ ...preview, status: "sent" }),
  };
  element.store = store;
  await click("Recommend");
  const select = element.shadowRoot!.querySelector("select")!;
  select.value = "bea";
  select.dispatchEvent(new Event("change"));
  await element.updateComplete;
  await click("Preview");
  await vi.waitFor(() => expect(element.shadowRoot!.textContent).toContain("Exact preview"));
  await click("Send in Slack");
  await vi.waitFor(() =>
    expect(element.shadowRoot!.querySelector('[role="alert"]')?.textContent).toContain(
      "Delivery failed",
    ),
  );
  expect(element.shadowRoot!.querySelector("dialog")!.open).toBe(true);
  await click("Send in Slack");
  await vi.waitFor(() => expect(store.send).toHaveBeenCalledTimes(2));
  expect(store.send.mock.calls.map(([value]) => value)).toEqual([preview, preview]);
  expect(store.preview).toHaveBeenCalledTimes(1);
});

it("loads members only on open and ignores a late picker response after an identity change", async () => {
  let resolve!: (value: NonNullable<DeadlineRecommendation["directory"]>) => void;
  const list = vi.fn(
    () =>
      new Promise<NonNullable<DeadlineRecommendation["directory"]>>((done) => {
        resolve = done;
      }),
  );
  element.store = { list, preview: vi.fn(), send: vi.fn() };
  await element.updateComplete;
  expect(list).not.toHaveBeenCalled();
  await click("Recommend");
  await vi.waitFor(() =>
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ mode: "members", offset: 0 })),
  );
  element.memberId = "other";
  element.directory = { members: [], papers: [], recommendations: [] };
  await element.updateComplete;
  resolve({
    members: [{ id: "late", name: "Late private member", slack_linked: true }],
    papers: [],
    recommendations: [],
  });
  await Promise.resolve();
  await element.updateComplete;
  expect(element.shadowRoot!.textContent).not.toContain("Late private member");
  expect(element.shadowRoot!.querySelector("dialog")!.open).toBe(false);
});

it("selects papers with the keyboard and dismisses the popup when focus leaves", async () => {
  element.directory = {
    ...element.directory!,
    papers: [{ id: "one", title: "Paper one", author_member_ids: ["bea"] }],
  };
  element.store = { list: vi.fn(async () => element.directory!), preview: vi.fn(), send: vi.fn() };
  await click("Recommend");
  const select = element.shadowRoot!.querySelector("select")!;
  select.value = "bea";
  select.dispatchEvent(new Event("change"));
  await element.updateComplete;
  const search = element.shadowRoot!.querySelector<HTMLInputElement>("#paper-search")!;
  search.focus();
  await vi.waitFor(() =>
    expect(element.shadowRoot!.querySelector('[role="option"]')).not.toBeNull(),
  );
  element.shadowRoot!.querySelector<HTMLElement>('[role="option"]')!.scrollIntoView = vi.fn();
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
  await element.updateComplete;
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await element.updateComplete;
  expect(element.shadowRoot!.querySelector('[role="option"]')!.getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(search.placeholder).toBe("1 paper selected");
  element.shadowRoot!.querySelector("textarea")!.focus();
  await element.updateComplete;
  expect(search.getAttribute("aria-expanded")).toBe("false");
});

it("shows one picker error and recovers independently of an unavailable summary", async () => {
  const list = vi
    .fn()
    .mockRejectedValueOnce(
      new Error("Deadline recommendations are unavailable. Please try again later."),
    )
    .mockResolvedValue({
      members: [{ id: "bea", name: "Bea", slack_linked: true }],
      papers: [],
      recommendations: [],
    });
  element.directory = undefined;
  element.store = { list, preview: vi.fn(), send: vi.fn() };
  await element.updateComplete;
  await click("Recommend");
  await vi.waitFor(() =>
    expect(element.shadowRoot!.querySelectorAll('[role="alert"]')).toHaveLength(1),
  );
  expect(element.shadowRoot!.textContent).not.toContain("not found");
  await click("Retry");
  await vi.waitFor(() =>
    expect(element.shadowRoot!.querySelector("select")?.textContent).toContain("Bea"),
  );
  expect(element.shadowRoot!.querySelector('[role="alert"]')).toBeNull();
  expect(element.shadowRoot!.textContent).not.toContain("Loading members…");
});
