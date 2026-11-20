/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { FinancialNeedsSection, fromDrafts, toDrafts } from "./financial-needs.ts";

afterEach(() => document.body.replaceChildren());

const blank = {
  category: "other" as const,
  amount: "",
  currency: "",
  description: "",
  pi_permission: "",
};

describe("financial support drafts", () => {
  it("drops an untouched row and stores typed rows in the service's shape", () => {
    const result = fromDrafts([
      blank,
      {
        category: "ai_subscription",
        amount: " 240 ",
        currency: "usd",
        description: " Agent API credits ",
        pi_permission: "Yes, expense it",
      },
      { ...blank, category: "travel", description: "Train to the workshop" },
    ]);
    expect(result).toEqual({
      ok: true,
      entries: [
        {
          category: "ai_subscription",
          amount: 240,
          currency: "USD",
          description: "Agent API credits",
          pi_permission: "Yes, expense it",
        },
        { category: "travel", description: "Train to the workshop" },
      ],
    });
  });

  it("refuses a row with no description, a bad amount or a bad currency", () => {
    expect(fromDrafts([{ ...blank, amount: "50" }]).ok).toBe(false);
    expect(fromDrafts([{ ...blank, description: "x", amount: "-1" }]).ok).toBe(false);
    expect(fromDrafts([{ ...blank, description: "x", currency: "dollars" }]).ok).toBe(false);
    // An amount needs its currency: the sheet totals per currency and never converts.
    expect(fromDrafts([{ ...blank, description: "x", amount: "5" }]).ok).toBe(false);
  });

  it("round-trips stored entries and ignores junk", () => {
    expect(toDrafts("nope")).toEqual([]);
    expect(toDrafts([null, { category: "travel", amount: 12.5, description: "Bus" }])).toEqual([
      { category: "travel", amount: "12.5", currency: "", description: "Bus", pi_permission: "" },
    ]);
  });
});

describe("<adminbot-financial-needs>", () => {
  async function mount(onSave: (entries: unknown) => Promise<boolean>) {
    const element = new FinancialNeedsSection();
    element.entries = [{ category: "travel", description: "Bus", amount: 20, currency: "CAD" }];
    element.onSave = onSave;
    document.body.append(element);
    await element.updateComplete;
    return element;
  }
  const root = (element: FinancialNeedsSection) => element.shadowRoot!;
  const buttons = (element: FinancialNeedsSection) =>
    [...root(element).querySelectorAll("button")].map((b) => b.textContent?.trim());

  const click = async (element: FinancialNeedsSection, label: string) => {
    const button = [...root(element).querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === label,
    );
    expect(button, label).toBeTruthy();
    button!.click();
    await element.updateComplete;
  };

  it("shows saved entries as read-only lines with a total, and no form until asked", async () => {
    const element = await mount(async () => true);
    expect(root(element).querySelector("form, select, input")).toBeNull();
    const row = root(element).querySelector('[data-testid="financial-need-row"]');
    expect(row?.textContent).toContain("Bus");
    expect(row?.textContent).toContain("Travel");
    expect(buttons(element)).toEqual(["Edit", "Add an expense"]);
  });

  it("shows only the heading and an add button when there is nothing yet", async () => {
    const element = new FinancialNeedsSection();
    element.entries = [];
    document.body.append(element);
    await element.updateComplete;
    expect(root(element).querySelector("ol")).toBeNull();
    expect(buttons(element)).toEqual(["Add an expense"]);
  });

  it("adds an entry, saves the whole list, and keeps the form open if the save is refused", async () => {
    const onSave = vi.fn(async () => false);
    const element = await mount(onSave);
    await click(element, "Add an expense");
    expect(root(element).querySelectorAll('[data-testid="financial-need-form"]')).toHaveLength(1);
    const description = root(element).querySelector<HTMLInputElement>('input[name="description"]')!;
    description.value = "Chat plan";
    description.dispatchEvent(new Event("input"));
    await element.updateComplete;

    await click(element, "Add");
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toEqual([
      { category: "travel", amount: 20, currency: "CAD", description: "Bus" },
      { category: "ai_subscription", currency: "USD", description: "Chat plan" },
    ]);
    await element.updateComplete;
    expect(root(element).querySelector('[role="alert"]')?.textContent).toContain("Not saved");
    expect(root(element).querySelector<HTMLInputElement>('input[name="description"]')?.value).toBe(
      "Chat plan",
    );
  });

  it("closes the form once saved and shows the new line", async () => {
    const onSave = vi.fn(async () => true);
    const element = await mount(onSave);
    await click(element, "Edit");
    const description = root(element).querySelector<HTMLInputElement>('input[name="description"]')!;
    description.value = "Bus pass";
    description.dispatchEvent(new Event("input"));
    await element.updateComplete;
    await click(element, "Save");
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await element.updateComplete;
    expect(root(element).querySelector('[data-testid="financial-need-form"]')).toBeNull();
    expect(root(element).textContent).toContain("Bus pass");
  });

  it("removes an entry from its edit form, and Cancel leaves the list as it was", async () => {
    const onSave = vi.fn(async () => true);
    const element = await mount(onSave);
    await click(element, "Add an expense");
    await click(element, "Cancel");
    expect(onSave).not.toHaveBeenCalled();
    expect(root(element).querySelectorAll('[data-testid="financial-need-row"]')).toHaveLength(1);

    await click(element, "Edit");
    await click(element, "Remove");
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith([]));
    await element.updateComplete;
    expect(root(element).querySelector("ol")).toBeNull();
  });

  it("still detaches with Element.remove(), which Lit uses when the page drops the section", async () => {
    const element = await mount(async () => true);
    element.remove();
    expect(element.isConnected).toBe(false);
  });
});
